"""Scheduled task execution (定时任务).

Connects to a saved session's machine via SSH exec (no PTY), runs the
command, records the result. A background thread checks due tasks every
TICK seconds and runs them serially.
"""
import re
import time
import logging
from datetime import datetime

from models import db, Session, ScheduledTask
from credential_store import get_credential
from ssh_client import PySSHClient, HostKeyUnknown

logger = logging.getLogger(__name__)

TICK_SECONDS = 20
MAX_OUTPUT_BYTES = 16 * 1024  # stored in DB per run


def _build_config(session: Session) -> dict:
    """Build the SSH connect config from a saved session + its credentials."""
    return {
        "host": session.host,
        "port": session.port,
        "username": session.username,
        "auth_type": session.auth_type,
        "password": get_credential(session.id, "password"),
        "private_key": get_credential(session.id, "key"),
        "passphrase": get_credential(session.id, "passphrase"),
        "keepalive_interval": 30,
    }


def _exec_command(config: dict, command: str, timeout_seconds: int) -> dict:
    """Run `command` on the remote host via SSH exec channel (no PTY).

    Returns {exit_code, output, stderr, timed_out}.
    """
    client = PySSHClient()
    try:
        client.dial(config)
        transport = client.get_transport()
        chan = transport.open_session()
        chan.settimeout(2.0)
        chan.exec_command(command)

        deadline = time.time() + max(5, int(timeout_seconds or 300))
        out = bytearray()
        err = bytearray()
        timed_out = False

        while True:
            while chan.recv_ready():
                out += chan.recv(65536)
            while chan.recv_stderr_ready():
                err += chan.recv_stderr(65536)
            if chan.exit_status_ready() and not chan.recv_ready() \
                    and not chan.recv_stderr_ready():
                break
            if time.time() > deadline:
                timed_out = True
                break
            time.sleep(0.1)

        if timed_out:
            chan.close()
            return {
                "exit_code": None,
                "output": bytes(out).decode("utf-8", "replace"),
                "stderr": bytes(err).decode("utf-8", "replace"),
                "timed_out": True,
            }

        exit_code = chan.recv_exit_status()
        # drain anything left in the buffers
        while chan.recv_ready():
            out += chan.recv(65536)
        while chan.recv_stderr_ready():
            err += chan.recv_stderr(65536)
        chan.close()
        return {
            "exit_code": exit_code,
            "output": bytes(out).decode("utf-8", "replace"),
            "stderr": bytes(err).decode("utf-8", "replace"),
            "timed_out": False,
        }
    finally:
        client.close()


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_BYTES:
        return text
    return text[:MAX_OUTPUT_BYTES] + f"\n...（输出过长，已截断，共 {len(text)} 字节）"


def run_task(task: ScheduledTask) -> dict:
    """Execute one scheduled task and persist the result on it."""
    result = {
        "status": "error",
        "exit_code": None,
        "output": "",
        "message": "",
    }
    try:
        session = Session.query.get(task.session_id)
        if session is None:
            result["message"] = f"会话不存在（id={task.session_id}），无法执行"
            return result

        config = _build_config(session)
        try:
            exec_res = _exec_command(config, task.command, task.timeout_seconds)
        except HostKeyUnknown:
            result["message"] = (
                f"主机 {session.host} 的密钥未确认，"
                "请先手动连接一次该会话以确认主机密钥")
            return result

        combined = exec_res["output"]
        if exec_res["stderr"]:
            combined += ("\n[stderr]\n" + exec_res["stderr"])
        result["exit_code"] = exec_res["exit_code"]
        result["output"] = combined

        if exec_res["timed_out"]:
            result["status"] = "timeout"
            result["message"] = f"执行超时（>{task.timeout_seconds}s），已中断"
        elif exec_res["exit_code"] == 0:
            result["status"] = "ok"
        else:
            result["status"] = "error"
            result["message"] = f"命令退出码 {exec_res['exit_code']}"
        return result
    except Exception as e:  # connection errors etc.
        logger.exception(f"Scheduled task {task.id} run failed")
        result["message"] = str(e)
        return result
    finally:
        task.last_run = datetime.now()
        task.last_status = result["status"]
        task.last_exit_code = result["exit_code"]
        task.last_output = _truncate(result["output"] or result["message"])
        db.session.commit()


_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def _to_local(dt):
    """created_at is stored as naive UTC; last_run is naive local. Unify."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone()
    return dt + datetime.now().astimezone().utcoffset()


def compute_due(schedule_type, interval_seconds, daily_time, last_run, enabled,
                now=None, created_at=None):
    """Pure due-check — easy to unit test.

    - interval: due when (now - last_run) >= interval_seconds; a never-run
      task becomes due one interval after its creation time
    - daily: due once per day, at/after HH:MM local time; the creation day
      does not count as a catch-up day if the task time had already passed
      when the task was created
    """
    if not enabled:
        return False
    now = now or datetime.now()
    if schedule_type == "interval":
        if not interval_seconds or interval_seconds < 10:
            return False
        if last_run is not None:
            return (now - last_run).total_seconds() >= interval_seconds
        # Never run: the first automatic run is due one interval after
        # the task was created (manual "run now" still works anytime).
        if created_at is None:
            return False
        created_local = _to_local(created_at)
        return (now - created_local).total_seconds() >= interval_seconds
    if schedule_type == "daily":
        if not daily_time or not _TIME_RE.match(daily_time):
            return False
        m = _TIME_RE.match(daily_time)
        hh, mm = int(m.group(1)), int(m.group(2))
        if last_run is not None and last_run.date() >= now.date():
            return False
        if (now.hour, now.minute) < (hh, mm):
            return False
        if created_at is not None:
            created_local = _to_local(created_at)
            if created_local.date() == now.date() and \
                    (created_local.hour, created_local.minute) > (hh, mm):
                return False
        return True
    return False


def scheduler_loop(app):
    """Background loop: run due tasks serially. Runs inside app context."""
    with app.app_context():
        logger.info(f"Scheduler started (tick {TICK_SECONDS}s)")
        while True:
            try:
                tasks = ScheduledTask.query.filter_by(enabled=True).all()
                for task in tasks:
                    if compute_due(task.schedule_type, task.interval_seconds,
                                   task.daily_time, task.last_run, task.enabled,
                                   created_at=task.created_at):
                        logger.info(f"Scheduler running task {task.id} "
                                    f"({task.name or task.command[:30]})")
                        res = run_task(task)
                        logger.info(f"Task {task.id} finished: {res['status']}")
            except Exception:
                logger.exception("Scheduler tick error")
            time.sleep(TICK_SECONDS)


def start_scheduler(app):
    import threading
    t = threading.Thread(target=scheduler_loop, args=(app,), daemon=True)
    t.start()
    return t
