import os
import json
import uuid
import base64
import logging
import threading
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, Response, stream_with_context

from models import db, Session, Credential, Setting
from credential_store import save_credential, get_credential, delete_credential as delete_creds
from known_hosts import check_host_key, accept_host_key, get_known_hosts, remove_host_key
from terminal_manager import ConnectionManager
from ssh_client import HostKeyUnknown

logger = logging.getLogger(__name__)
api_bp = Blueprint("api", __name__)
conn_mgr = ConnectionManager()

# Lock for SSE output to prevent overlapping reads
_sse_locks = {}


def _generate_conn_id():
    return uuid.uuid4().hex[:12]


# ============================================================
# Session Management
# ============================================================

@api_bp.route("/api/sessions", methods=["GET"])
def list_sessions():
    sessions = Session.query.order_by(Session.sort_order.asc(), Session.name.asc()).all()
    return jsonify([s.to_dict() for s in sessions])


@api_bp.route("/api/sessions", methods=["POST"])
def create_session():
    data = request.get_json(force=True)
    session = Session(
        name=data.get("name", ""),
        host=data.get("host", ""),
        port=int(data.get("port", 22)),
        username=data.get("username", "root"),
        auth_type=data.get("auth_type", "password"),
        group_name=data.get("group_name", ""),
        tags=",".join(data.get("tags", [])) if isinstance(data.get("tags"), list) else data.get("tags", ""),
        remark=data.get("remark", ""),
        sort_order=int(data.get("sort_order", 0)),
    )
    db.session.add(session)
    db.session.commit()

    # Save password/key if provided
    password = data.get("password")
    if password:
        save_credential(session.id, "password", password)
    private_key = data.get("private_key")
    if private_key:
        save_credential(session.id, "key", private_key)
    passphrase = data.get("passphrase")
    if passphrase:
        save_credential(session.id, "passphrase", passphrase)

    return jsonify(session.to_dict()), 201


@api_bp.route("/api/sessions/<int:session_id>", methods=["PUT"])
def update_session(session_id):
    session = Session.query.get_or_404(session_id)
    data = request.get_json(force=True)

    session.name = data.get("name", session.name)
    session.host = data.get("host", session.host)
    session.port = int(data.get("port", session.port))
    session.username = data.get("username", session.username)
    session.auth_type = data.get("auth_type", session.auth_type)
    session.group_name = data.get("group_name", session.group_name)
    tags = data.get("tags")
    if tags is not None:
        session.tags = ",".join(tags) if isinstance(tags, list) else tags
    session.remark = data.get("remark", session.remark)
    session.sort_order = int(data.get("sort_order", session.sort_order))

    db.session.commit()

    # Update credentials if provided
    password = data.get("password")
    if password is not None:
        save_credential(session.id, "password", password)
    private_key = data.get("private_key")
    if private_key is not None:
        save_credential(session.id, "key", private_key)
    passphrase = data.get("passphrase")
    if passphrase is not None:
        save_credential(session.id, "passphrase", passphrase)

    return jsonify(session.to_dict())


@api_bp.route("/api/sessions/<int:session_id>", methods=["DELETE"])
def delete_session(session_id):
    session = Session.query.get_or_404(session_id)
    delete_creds(session_id)
    db.session.delete(session)
    db.session.commit()
    return jsonify({"success": True})


# ============================================================
# SSH Connection
# ============================================================

@api_bp.route("/api/ssh/connect", methods=["POST"])
def ssh_connect():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    host = data.get("host", "")
    port = int(data.get("port", 22))
    username = data.get("username", "root")
    auth_type = data.get("auth_type", "password")
    password = data.get("password", "")
    private_key = data.get("private_key", "")
    passphrase = data.get("passphrase", "")

    # If session_id provided, load credentials from DB
    if session_id and not password and not private_key:
        password = get_credential(session_id, "password")
        private_key = get_credential(session_id, "key")
        passphrase = get_credential(session_id, "passphrase")

    conn_id = _generate_conn_id()

    config = {
        "host": host,
        "port": port,
        "username": username,
        "auth_type": auth_type,
        "password": password,
        "private_key": private_key,
        "passphrase": passphrase,
        "keepalive_interval": 30,
    }
    try:
        skip_key = data.get("skip_host_key", False)
        if skip_key:
            client = conn_mgr.create_connection(conn_id, config, skip_host_key=True)
        else:
            client = conn_mgr.create_connection(conn_id, config)

        # Open terminal
        rows = int(data.get("rows", 40))
        cols = int(data.get("cols", 120))
        conn_mgr.create_terminal(conn_id, rows=rows, cols=cols)

        return jsonify({
            "success": True,
            "conn_id": conn_id,
        })
    except HostKeyUnknown as e:
        logger.warning(f"Host key unknown: {e.host} {e.fingerprint}")
        return jsonify({
            "success": False,
            "host_key_unknown": True,
            "host": e.host,
            "fingerprint": e.fingerprint,
            "key_type": e.key_type,
            "error": f"主机 '{e.host}' 的密钥指纹未知，请确认后重试",
        }), 200
    except Exception as e:
        logger.error(f"SSH connect failed: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/api/ssh/input/<conn_id>", methods=["POST"])
def ssh_input(conn_id):
    """Send input to terminal. Body is raw text."""
    try:
        terminal = conn_mgr.get_terminal(conn_id)
        data = request.get_data(as_text=True)
        terminal.write(data)
        return jsonify({"success": True})
    except Exception as e:
        logger.error(f"SSH input failed: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/api/ssh/resize", methods=["POST"])
def ssh_resize():
    data = request.get_json(force=True)
    conn_id = data.get("conn_id", "")
    rows = int(data.get("rows", 40))
    cols = int(data.get("cols", 120))
    try:
        terminal = conn_mgr.get_terminal(conn_id)
        terminal.resize(rows, cols)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/api/ssh/disconnect", methods=["POST"])
def ssh_disconnect():
    data = request.get_json(force=True)
    conn_id = data.get("conn_id", "")
    try:
        conn_mgr.remove_connection(conn_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/api/ssh/output/<conn_id>")
def ssh_output(conn_id):
    """SSE endpoint for streaming terminal output."""
    def generate():
        try:
            terminal = conn_mgr.get_terminal(conn_id)
        except KeyError:
            yield "event: error\ndata: Connection not found\n\n"
            return
        except Exception as e:
            yield f"event: error\ndata: {str(e)}\n\n"
            return

        # Send initial connected event
        yield "event: connected\ndata: ok\n\n"

        while True:
            try:
                data = terminal.read_output(timeout=0.5)
                if data:
                    yield f"data: {base64.b64encode(data).decode('ascii')}\n\n"
                elif terminal.closed:
                    # SSH channel has ended and all output was drained;
                    # tell the client and stop streaming.
                    yield "event: closed\ndata: ok\n\n"
                    break
                else:
                    # Send heartbeat to keep connection alive
                    yield ": heartbeat\n\n"
            except GeneratorExit:
                break
            except Exception as e:
                logger.error(f"SSE error [{conn_id}]: {e}")
                break

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ============================================================
# SFTP
# ============================================================

@api_bp.route("/api/sftp/list/<conn_id>", methods=["GET"])
def sftp_list(conn_id):
    path = request.args.get("path", ".")
    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()
        from sftp_handler import SFTPHandler
        handler = SFTPHandler(sftp)
        items = handler.list_dir(path)
        return jsonify({"success": True, "items": items, "path": path})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/api/sftp/upload/<conn_id>", methods=["POST"])
def sftp_upload(conn_id):
    remote_path = request.form.get("path", ".")
    file = request.files.get("file")
    if not file:
        return jsonify({"success": False, "error": "No file provided"}), 400

    # Sanitize the filename: strip any directory components
    filename = os.path.basename(file.filename.replace("\\", "/")).strip()
    if not filename or filename in (".", ".."):
        return jsonify({"success": False, "error": "Invalid filename"}), 400

    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()
        remote_file = f"{remote_path}/{filename}".replace("//", "/")
        # Stream directly from the request body to SFTP — no temp file,
        # which also avoids Windows file-locking issues.
        sftp.putfo(file.stream, remote_file)
        return jsonify({"success": True, "file": filename, "path": remote_file})
    except Exception as e:
        logger.exception(f"SFTP upload failed [{conn_id}] -> {remote_file}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/api/sftp/download/<conn_id>", methods=["GET"])
def sftp_download(conn_id):
    remote_path = request.args.get("path", "")
    if not remote_path:
        return jsonify({"success": False, "error": "No path provided"}), 400
    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()
        import io
        f = io.BytesIO()
        sftp.getfo(remote_path, f)
        f.seek(0)
        filename = remote_path.split("/")[-1]
        return Response(
            f.getvalue(),
            mimetype="application/octet-stream",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# 上限：在线编辑仅支持不超过 2 MB 的 UTF-8 文本文件
MAX_EDIT_SIZE = 2 * 1024 * 1024


def _fmt_size(n):
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{int(n)} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


@api_bp.route("/api/sftp/read/<conn_id>", methods=["GET", "POST"])
def sftp_read(conn_id):
    """Read a small UTF-8 text file for in-browser editing.

    POST (JSON body) is preferred: it avoids every query-string encoding
    pitfall (`+` -> space, percent-escaping, unicode edge cases).
    """
    if request.method == "POST":
        data = request.get_json(force=True)
        remote_path = data.get("path", "")
    else:
        remote_path = request.args.get("path", "")
    if not remote_path:
        return jsonify({"success": False, "error": "No path provided"}), 400
    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()

        # lstat: don't follow symlinks while inspecting the entry itself
        try:
            lst = sftp.lstat(remote_path)
        except Exception as e:
            return jsonify({
                "success": False,
                "error": f"文件不存在或无法访问（服务器: {e}）。请求路径: {remote_path}",
            }), 400

        import stat as stat_mod
        if stat_mod.S_ISLNK(lst.st_mode):
            # symlink: resolve the target; a broken link can't be edited
            try:
                st = sftp.stat(remote_path)
            except Exception:
                return jsonify({
                    "success": False,
                    "error": f"符号链接目标不存在或无法访问: {remote_path}",
                }), 400
        else:
            st = lst

        if stat_mod.S_ISDIR(st.st_mode):
            return jsonify({
                "success": False,
                "error": f"这是一个目录，无法编辑: {remote_path}",
            }), 400

        if st.st_size > MAX_EDIT_SIZE:
            return jsonify({
                "success": False,
                "error": f"文件过大（{_fmt_size(st.st_size)}），"
                         f"在线编辑仅支持不超过 {_fmt_size(MAX_EDIT_SIZE)} 的文本文件: {remote_path}",
            }), 400

        with sftp.open(remote_path, "rb") as f:
            raw = f.read()
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            return jsonify({
                "success": False,
                "error": f"文件不是有效的 UTF-8 文本（可能是二进制文件），无法在线编辑: {remote_path}",
            }), 400
        return jsonify({
            "success": True,
            "path": remote_path,
            "size": st.st_size,
            "content": content,
        })
    except Exception as e:
        logger.exception(f"SFTP read failed [{conn_id}]: {remote_path}")
        return jsonify({"success": False, "error": f"{e}（路径: {remote_path}）"}), 500


@api_bp.route("/api/sftp/write/<conn_id>", methods=["POST"])
def sftp_write(conn_id):
    """Overwrite a remote file with the provided text content (UTF-8)."""
    data = request.get_json(force=True)
    remote_path = data.get("path", "")
    content = data.get("content", "")
    if not remote_path:
        return jsonify({"success": False, "error": "No path provided"}), 400
    raw = content.encode("utf-8")
    if len(raw) > MAX_EDIT_SIZE:
        return jsonify({
            "success": False,
            "error": f"内容超过 {_fmt_size(MAX_EDIT_SIZE)}，无法保存",
        }), 400
    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()
        # "wb" opens with CREATE|TRUNC: existing files are overwritten
        with sftp.open(remote_path, "wb") as f:
            f.write(raw)
        return jsonify({"success": True, "path": remote_path, "size": len(raw)})
    except Exception as e:
        logger.exception(f"SFTP write failed [{conn_id}]: {remote_path}")
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/api/sftp/delete/<conn_id>", methods=["POST"])
def sftp_delete(conn_id):
    data = request.get_json(force=True)
    path = data.get("path", "")
    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()
        if data.get("is_dir", False):
            from sftp_handler import SFTPHandler
            handler = SFTPHandler(sftp)
            handler.remove(path)
        else:
            sftp.remove(path)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


def _sftp_mkdir_p(sftp, path):
    """mkdir -p: create the path and any missing parents.

    Directories that already exist are left untouched (idempotent), so
    re-uploading into an existing folder never fails.
    """
    parts = [p for p in str(path).replace("\\", "/").split("/") if p]
    current = ""
    for part in parts:
        current += "/" + part
        try:
            sftp.stat(current)
        except OSError:
            # missing -> create it; if mkdir still fails, re-verify so a
            # race (dir created meanwhile) is not reported as an error
            try:
                sftp.mkdir(current)
            except OSError:
                sftp.stat(current)


@api_bp.route("/api/sftp/mkdir/<conn_id>", methods=["POST"])
def sftp_mkdir(conn_id):
    data = request.get_json(force=True)
    path = data.get("path", "")
    recursive = bool(data.get("recursive", False))
    if not path:
        return jsonify({"success": False, "error": "No path provided"}), 400
    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()
        if recursive:
            _sftp_mkdir_p(sftp, path)
        else:
            sftp.mkdir(path)
        return jsonify({"success": True, "path": path})
    except Exception as e:
        logger.exception(f"SFTP mkdir failed [{conn_id}]: {path}")
        return jsonify({"success": False, "error": str(e)}), 500


# ============================================================
# Known Hosts
# ============================================================

@api_bp.route("/api/known-hosts", methods=["GET"])
def list_known_hosts():
    hosts = get_known_hosts()
    return jsonify(hosts)


@api_bp.route("/api/known-hosts", methods=["POST"])
def add_known_host():
    data = request.get_json(force=True)
    host = data.get("host", "")
    port = int(data.get("port", 22))
    key_type = data.get("key_type", "")
    key_data = data.get("key_data", "")

    try:
        # Reconstruct key object from stored data
        import paramiko
        key = paramiko.RSAKey(data=base64.b64decode(key_data))
        fingerprint = accept_host_key(host, port, key)
        return jsonify({"success": True, "fingerprint": fingerprint})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/api/known-hosts/<int:host_id>", methods=["DELETE"])
def delete_known_host(host_id):
    if remove_host_key(host_id):
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "Not found"}), 404


# ============================================================
# Credentials
# ============================================================

@api_bp.route("/api/credentials", methods=["GET"])
def list_credentials():
    """List credential records (without exposing encrypted data)."""
    creds = Credential.query.all()
    result = []
    for c in creds:
        result.append({
            "id": c.id,
            "session_id": c.session_id,
            "credential_type": c.credential_type,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        })
    return jsonify(result)


@api_bp.route("/api/credentials/<int:cred_id>", methods=["DELETE"])
def delete_credential_item(cred_id):
    cred = Credential.query.get_or_404(cred_id)
    db.session.delete(cred)
    db.session.commit()
    return jsonify({"success": True})


# ============================================================
# System
# ============================================================

@api_bp.route("/api/status", methods=["GET"])
def system_status():
    active = conn_mgr.get_active_count()
    session_count = Session.query.count()
    return jsonify({
        "active_connections": active["connections"],
        "active_terminals": active["terminals"],
        "total_sessions": session_count,
        "status": "running",
    })


@api_bp.route("/api/settings", methods=["GET"])
def get_settings():
    settings = Setting.query.all()
    result = {}
    for s in settings:
        result[s.key] = s.value
    return jsonify(result)


@api_bp.route("/api/settings", methods=["PUT"])
def update_settings():
    data = request.get_json(force=True)
    for key, value in data.items():
        setting = Setting.query.get(key)
        if setting:
            setting.value = str(value)
        else:
            setting = Setting(key=key, value=str(value))
            db.session.add(setting)
    db.session.commit()
    return jsonify({"success": True})