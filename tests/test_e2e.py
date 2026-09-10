"""
End-to-end test for PyShell terminal + SFTP flow.

Starts a mock SSH server (paramiko, with shell echo + file-backed SFTP
subsystem) on 127.0.0.1:2299, then drives the running PyShell backend
(default http://127.0.0.1:5173) through:
  connect -> SSE output (banner) -> input echo -> resize
  -> SFTP upload / list / download / delete -> disconnect

Usage:
    .venv/Scripts/python.exe tests/test_e2e.py
"""
import base64
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import paramiko

BASE = "http://127.0.0.1:5173"
MOCK_HOST, MOCK_PORT = "127.0.0.1", 2299

failures = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" -- {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# ---------------------------------------------------------------- mock sshd
host_key = paramiko.RSAKey.generate(2048)
# NOTE: SFTP root must be a plain os.makedirs() directory inside the project
# workspace — sandbox policies may deny file creation inside
# tempfile.mkdtemp() dirs and platform temp dirs alike.
_DATA_DIR = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "data"))
SFTP_ROOT = os.path.join(_DATA_DIR, "sftp_test")
shutil.rmtree(SFTP_ROOT, ignore_errors=True)
os.makedirs(SFTP_ROOT, exist_ok=True)


class FileSFTPHandle(paramiko.SFTPHandle):
    """SFTP handle backed by an os-level file descriptor."""

    def __init__(self, fd):
        super().__init__()
        self._fd = fd
        self._closed = False

    def read(self, offset, length):
        try:
            os.lseek(self._fd, offset, os.SEEK_SET)
            return os.read(self._fd, length)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def write(self, offset, data):
        try:
            os.lseek(self._fd, offset, os.SEEK_SET)
            os.write(self._fd, data)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def stat(self):
        try:
            return paramiko.SFTPAttributes.from_stat(os.fstat(self._fd))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def close(self):
        if not self._closed:
            self._closed = True
            try:
                os.close(self._fd)
            except OSError:
                pass
        return paramiko.SFTP_OK


class FileSFTPInterface(paramiko.SFTPServerInterface):
    """Minimal file-backed SFTP server interface rooted at SFTP_ROOT."""

    def __init__(self, server, *args, **kwargs):
        # NOTE: don't forward extra kwargs (e.g. root=) to the parent chain —
        # ServerInterface/object.__init__ doesn't accept them.
        self._root = kwargs.get("root", os.getcwd())

    def _map(self, path):
        rel = str(path).lstrip("/").replace("\\", "/").strip()
        if not rel:
            return self._root
        return os.path.normpath(os.path.join(self._root, *rel.split("/")))

    def canonicalize(self, path):
        return self._map(path).replace("\\", "/")

    def list_folder(self, path):
        p = self._map(path)
        try:
            names = os.listdir(p)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        out = []
        for name in names:
            try:
                st = os.stat(os.path.join(p, name))
                out.append(paramiko.SFTPAttributes.from_stat(st, name))
            except OSError:
                continue
        return out

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(os.stat(self._map(path)))
        except OSError as e:
            print(f"MOCK sftp stat FAILED: path={self._map(path)!r} err={e!r}", flush=True)
            return paramiko.SFTPServer.convert_errno(e.errno)

    def lstat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(os.lstat(self._map(path)))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def open(self, path, flags, attr):
        p = self._map(path)
        # Windows: always force binary mode, otherwise os.write/read
        # translates \n <-> \r\n and corrupts transferred data.
        flags |= getattr(os, "O_BINARY", 0)
        try:
            fd = os.open(p, flags, 0o666)
        except OSError as e:
            print(f"MOCK sftp open FAILED: path={p!r} flags={flags:#x} "
                  f"err={e!r}", flush=True)
            return paramiko.SFTPServer.convert_errno(e.errno)
        return FileSFTPHandle(fd)

    def remove(self, path):
        try:
            os.remove(self._map(path))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def rename(self, oldpath, newpath):
        try:
            os.rename(self._map(oldpath), self._map(newpath))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def mkdir(self, path, attr):
        try:
            os.mkdir(self._map(path))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def rmdir(self, path):
        try:
            os.rmdir(self._map(path))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def chattr(self, path, attr):
        return paramiko.SFTP_OP_UNSUPPORTED

    def readlink(self, path):
        return paramiko.SFTP_OP_UNSUPPORTED

    def symlink(self, targetPath, path):
        return paramiko.SFTP_OP_UNSUPPORTED

    def posix_rename(self, oldpath, newpath):
        return paramiko.SFTP_OP_UNSUPPORTED


class MockServer(paramiko.ServerInterface):
    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED

    def check_auth_password(self, username, password):
        if username == "test" and password == "test":
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_shell_request(self, channel):
        return True

    def check_channel_pty_request(self, channel, term, width, height,
                                  pixelwidth, pixelheight, modes):
        return True


def handle(conn):
    transport = None
    try:
        transport = paramiko.Transport(conn)
        transport.set_subsystem_handler(
            "sftp", paramiko.SFTPServer, FileSFTPInterface, root=SFTP_ROOT)
        transport.add_server_key(host_key)
        transport.start_server(server=MockServer())
        chan = transport.accept(20)
        if chan is None:
            return
        chan.send("Welcome to MockSSH!\r\n")
        while True:
            got = False
            while chan.recv_ready():
                data = chan.recv(4096)
                if not data:
                    break
                chan.send(b"echo:" + data)
                got = True
            if chan.closed or not transport.is_active():
                break
            if not got:
                time.sleep(0.02)
        chan.close()
    except Exception as e:
        print("mock sshd handler error:", e)
    finally:
        if transport:
            transport.close()


def serve_mock():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((MOCK_HOST, MOCK_PORT))
    sock.listen(5)
    print(f"mock sshd listening on {MOCK_HOST}:{MOCK_PORT} "
          f"(sftp root: {SFTP_ROOT})", flush=True)
    while True:
        conn, _ = sock.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


# ---------------------------------------------------------------- http utils
def _raise_with_body(e):
    """Re-raise HTTPError after printing the JSON error body."""
    try:
        print("HTTP error body:", e.read().decode("utf-8", "replace"))
    except Exception:
        pass
    raise e


def post_json(path, obj, timeout=15):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(obj).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        _raise_with_body(e)


def post_raw(path, data, timeout=15):
    req = urllib.request.Request(BASE + path, data=data, method="POST")
    req.add_header("Content-Type", "text/plain")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def get_json(path, timeout=15):
    """GET JSON; on HTTP error return the parsed JSON error body instead of
    raising, so error-path assertions can inspect `success`/`error`."""
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            _raise_with_body(e)


def upload_file(conn_id, name, content, remote_path="/"):
    boundary = "----pyshelle2eboundary"
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="path"\r\n\r\n',
        remote_path.encode() + b"\r\n",
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'.encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        content,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    req = urllib.request.Request(
        f"{BASE}/api/sftp/upload/{conn_id}", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        _raise_with_body(e)


def download_file(conn_id, path):
    url = f"{BASE}/api/sftp/download/{conn_id}?path={urllib.parse.quote(path)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


# ---------------------------------------------------------------- test flow
def main():
    threading.Thread(target=serve_mock, daemon=True).start()
    time.sleep(0.3)

    # 0. backend reachable
    status = get_json("/api/status")
    check("backend /api/status reachable", status.get("status") == "running", str(status))

    # 0b. Remove stale known-host entries for the mock server (its key is
    # regenerated on every run, which would trigger a "host key changed" error)
    try:
        for h in get_json("/api/known-hosts"):
            hhost = (h.get("host") or "")
            if MOCK_HOST in hhost and str(MOCK_PORT) in hhost:
                req = urllib.request.Request(
                    f"{BASE}/api/known-hosts/{h['id']}", method="DELETE")
                urllib.request.urlopen(req, timeout=5)
                print(f"cleaned stale known-host #{h['id']} ({hhost})")
    except Exception as e:
        print("known-host cleanup warning:", e)

    # 1. connect (first attempt returns host_key_unknown, like the real UI)
    payload = {
        "host": MOCK_HOST, "port": MOCK_PORT,
        "username": "test", "auth_type": "password", "password": "test",
        "rows": 30, "cols": 100,
    }
    res = post_json("/api/ssh/connect", payload)
    if res.get("host_key_unknown"):
        check("first connect asks for host-key confirmation",
              bool(res.get("fingerprint")), str(res))
        payload["skip_host_key"] = True
        res = post_json("/api/ssh/connect", payload)
    check("POST /api/ssh/connect success", res.get("success") is True, str(res))
    conn_id = res.get("conn_id")
    check("connect returns conn_id", bool(conn_id), str(res))

    # 2. SSE stream: collect events in a reader thread
    events = []
    stop = threading.Event()

    def sse_reader():
        req = urllib.request.Request(f"{BASE}/api/ssh/output/{conn_id}")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                cur_event = "message"
                for raw in r:
                    if stop.is_set():
                        break
                    line = raw.decode("utf-8", "replace").rstrip("\r\n")
                    if line == "":
                        cur_event = "message"
                        continue
                    if line.startswith("event:"):
                        cur_event = line.split(":", 1)[1].strip()
                    elif line.startswith("data:"):
                        events.append((cur_event, line.split(":", 1)[1].strip()))
        except Exception as e:
            if not stop.is_set():
                print("sse reader error:", e)

    t = threading.Thread(target=sse_reader, daemon=True)
    t.start()
    time.sleep(2.0)  # allow banner to arrive

    kinds = {ev for ev, _ in events}
    check("SSE emits 'connected' event", "connected" in kinds, str(events[:5]))

    text = b"".join(
        base64.b64decode(d) for ev, d in events if ev == "message")
    check("SSE delivers SSH banner", b"Welcome to MockSSH!" in text, repr(text[:120]))

    # 3. input -> echo
    res3 = post_raw(f"/api/ssh/input/{conn_id}", b"hello\n")
    check("POST /api/ssh/input success", res3.get("success") is True, str(res3))
    time.sleep(1.5)
    text = b"".join(
        base64.b64decode(d) for ev, d in events if ev == "message")
    check("typed input echoed back via SSE", b"echo:hello" in text, repr(text[-120:]))

    # 4. resize
    res4 = post_json("/api/ssh/resize", {"conn_id": conn_id, "rows": 25, "cols": 80})
    check("POST /api/ssh/resize success", res4.get("success") is True, str(res4))

    # 5. concurrent request while SSE is open (must not be blocked)
    t0 = time.time()
    res5 = get_json("/api/status")
    dt = time.time() - t0
    check("API responsive while SSE stream is open", dt < 3.0, f"{dt:.2f}s")

    # 5b. SFTP: upload -> list -> download -> mkdir -> delete
    content = ("hello pyshell upload test\r\n" * 200).encode("utf-8")
    up = upload_file(conn_id, "e2e_upload.txt", content)
    check("SFTP upload success", up.get("success") is True, str(up))

    lst = get_json(f"/api/sftp/list/{conn_id}?path=/")
    names = [it["name"] for it in lst.get("items", [])]
    check("uploaded file listed", "e2e_upload.txt" in names, str(lst)[:300])

    item = next((it for it in lst.get("items", []) if it["name"] == "e2e_upload.txt"), None)
    check("listed size matches upload", item is not None and item["size"] == len(content),
          str(item))

    dl = download_file(conn_id, "/e2e_upload.txt")
    check("downloaded content matches", dl == content, f"len={len(dl)} vs {len(content)}")

    mk = post_json(f"/api/sftp/mkdir/{conn_id}", {"path": "/e2e_dir"})
    check("SFTP mkdir success", mk.get("success") is True, str(mk))
    lst2 = get_json(f"/api/sftp/list/{conn_id}?path=/")
    names2 = [it["name"] for it in lst2.get("items", [])]
    check("created dir listed", "e2e_dir" in names2, str(names2))

    dele = post_json(f"/api/sftp/delete/{conn_id}", {"path": "/e2e_upload.txt"})
    check("SFTP delete success", dele.get("success") is True, str(dele))
    lst3 = get_json(f"/api/sftp/list/{conn_id}?path=/")
    names3 = [it["name"] for it in lst3.get("items", [])]
    check("file gone after delete", "e2e_upload.txt" not in names3, str(names3))

    # 5c. recursive mkdir (folder upload support) + overwrite semantics
    mk2 = post_json(f"/api/sftp/mkdir/{conn_id}",
                    {"path": "/e2e_dir/nested/deeper", "recursive": True})
    check("SFTP mkdir -p creates nested dirs", mk2.get("success") is True, str(mk2))
    lst4 = get_json(f"/api/sftp/list/{conn_id}?path=/e2e_dir/nested")
    names4 = [it["name"] for it in lst4.get("items", [])]
    check("nested dir visible", "deeper" in names4, str(names4))
    mk3 = post_json(f"/api/sftp/mkdir/{conn_id}",
                    {"path": "/e2e_dir/nested", "recursive": True})
    check("mkdir -p idempotent on existing", mk3.get("success") is True, str(mk3))

    up2 = upload_file(conn_id, "e2e_upload.txt", content,
                      remote_path="/e2e_dir/nested")
    check("upload into nested dir", up2.get("success") is True, str(up2))
    over = content + b"OVERWRITTEN-PAYLOAD"
    up3 = upload_file(conn_id, "e2e_upload.txt", over,
                      remote_path="/e2e_dir/nested")
    check("re-upload overwrites existing file", up3.get("success") is True, str(up3))
    dl2 = download_file(conn_id, "/e2e_dir/nested/e2e_upload.txt")
    check("overwritten content matches", dl2 == over,
          f"len={len(dl2)} vs {len(over)}")

    # 5d. in-browser text editing: read -> write -> verify
    edit_path = "/e2e_dir/nested/e2e_upload.txt"
    rd = get_json(f"/api/sftp/read/{conn_id}?path={urllib.parse.quote(edit_path)}")
    check("read file for editing", rd.get("success") is True, str(rd)[:200])
    check("read content matches", rd.get("content") == over.decode("utf-8"))
    edited = over.decode("utf-8") + "\n# edited by pyshell\n"
    wr = post_json(f"/api/sftp/write/{conn_id}",
                   {"path": edit_path, "content": edited})
    check("write edited content", wr.get("success") is True, str(wr))
    dl3 = download_file(conn_id, edit_path)
    check("download reflects edit", dl3 == edited.encode("utf-8"),
          f"len={len(dl3)} vs {len(edited)}")

    # binary file must be rejected for editing
    bin_payload = bytes(range(256)) * 4
    bup = upload_file(conn_id, "e2e_binary.bin", bin_payload)
    check("upload binary file", bup.get("success") is True, str(bup))
    rdb = get_json(f"/api/sftp/read/{conn_id}?path={urllib.parse.quote('/e2e_binary.bin')}")
    check("read rejects binary file",
          rdb.get("success") is False and "UTF-8" in (rdb.get("error") or ""),
          str(rdb)[:200])

    # oversize file must be rejected for editing (limit 2 MB)
    big = b"A" * (2 * 1024 * 1024 + 1)
    bigup = upload_file(conn_id, "e2e_big.txt", big)
    check("upload oversize file", bigup.get("success") is True, str(bigup)[:120])
    rdbig = get_json(f"/api/sftp/read/{conn_id}?path={urllib.parse.quote('/e2e_big.txt')}")
    check("read rejects oversize file",
          rdbig.get("success") is False and "过大" in (rdbig.get("error") or ""),
          str(rdbig)[:200])

    # 5e. special-characters filename: upload -> POST read roundtrip
    # (multipart headers can't carry double quotes, so use the characters
    #  that actually break query strings: & + % spaces and unicode)
    tricky_name = 'e2e & file (1) + 50% 中文.txt'
    tricky_body = "hello 特殊字符 & <tag>\n"
    tup = upload_file(conn_id, tricky_name, tricky_body.encode("utf-8"))
    check("upload tricky filename", tup.get("success") is True, str(tup)[:200])
    trd = post_json(f"/api/sftp/read/{conn_id}",
                    {"path": f"/{tricky_name}"})
    check("POST read handles special-char path",
          trd.get("success") is True and trd.get("content") == tricky_body,
          str(trd)[:200])

    # 6. disconnect -> SSE 'closed' event
    res6 = post_json("/api/ssh/disconnect", {"conn_id": conn_id})
    check("POST /api/ssh/disconnect success", res6.get("success") is True, str(res6))
    time.sleep(1.5)
    kinds = {ev for ev, _ in events}
    check("SSE ends with 'closed' event after disconnect", "closed" in kinds,
          str(events[-5:]))

    stop.set()
    try:
        shutil.rmtree(SFTP_ROOT, ignore_errors=True)
    except Exception:
        pass
    print()
    if failures:
        print(f"RESULT: {len(failures)} FAILED -> {failures}")
        sys.exit(1)
    print("RESULT: ALL PASSED")


if __name__ == "__main__":
    main()
