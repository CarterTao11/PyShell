"""邮件通知模块 - SMTP 发送执行结果"""

import os
import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime
from models import db, Setting

logger = logging.getLogger(__name__)

# 邮件配置 Key 常量
KEY_SMTP_SERVER = "smtp_server"
KEY_SMTP_PORT = "smtp_port"
KEY_SMTP_USER = "smtp_user"
KEY_SMTP_PASS = "smtp_pass"
KEY_SMTP_SENDER = "smtp_sender"
KEY_SMTP_RECIPIENTS = "smtp_recipients"
KEY_SMTP_ENABLED = "smtp_enabled"
KEY_SMTP_USE_SSL = "smtp_use_ssl"


def get_setting(key: str, default: str = "") -> str:
    """从数据库读取设置项"""
    record = Setting.query.get(key)
    if record is None:
        return default
    return record.value or default


def save_setting(key: str, value: str):
    """保存设置项到数据库"""
    record = Setting.query.get(key)
    if record is None:
        record = Setting(key=key, value=value)
        db.session.add(record)
    else:
        record.value = value
    db.session.commit()


def get_email_config() -> dict:
    """读取邮件配置"""
    return {
        "server": get_setting(KEY_SMTP_SERVER),
        "port": int(get_setting(KEY_SMTP_PORT, "465")),
        "user": get_setting(KEY_SMTP_USER),
        "password": get_setting(KEY_SMTP_PASS),
        "sender": get_setting(KEY_SMTP_SENDER),
        "recipients": get_setting(KEY_SMTP_RECIPIENTS),
        "enabled": get_setting(KEY_SMTP_ENABLED, "0") == "1",
        "use_ssl": get_setting(KEY_SMTP_USE_SSL, "1") == "1",
    }


def send_email(subject: str, body: str, body_html: str = "") -> dict:
    """
    发送邮件。
    返回 {"success": True} 或 {"success": False, "error": "..."}
    """
    cfg = get_email_config()
    if not cfg["enabled"]:
        return {"success": False, "error": "邮件通知未启用"}

    server = cfg["server"]
    port = cfg["port"]
    user = cfg["user"]
    password = cfg["password"]
    sender = cfg["sender"] or user
    recipients = [r.strip() for r in cfg["recipients"].split(";") if r.strip()]

    if not server or not user or not recipients:
        return {"success": False, "error": "邮件配置不完整"}

    try:
        msg = MIMEMultipart("alternative")
        msg["From"] = sender
        msg["To"] = ", ".join(recipients)
        msg["Subject"] = subject

        # 纯文本版本
        msg.attach(MIMEText(body, "plain", "utf-8"))

        # HTML 版本（如果有）
        if body_html:
            msg.attach(MIMEText(body_html, "html", "utf-8"))

        # 发送
        if cfg["use_ssl"]:
            with smtplib.SMTP_SSL(server, port, timeout=10) as s:
                if user:
                    s.login(user, password)
                s.sendmail(sender, recipients, msg.as_string())
        else:
            with smtplib.SMTP(server, port, timeout=10) as s:
                s.starttls()
                if user:
                    s.login(user, password)
                s.sendmail(sender, recipients, msg.as_string())

        logger.info(f"邮件发送成功 → {cfg['recipients']}: {subject}")
        return {"success": True}

    except Exception as e:
        logger.exception(f"邮件发送失败: {e}")
        return {"success": False, "error": str(e)}


def notify_task_result(task_name: str, command: str, session_name: str,
                       status: str, exit_code: int, output: str) -> dict:
    """
    任务执行完成后发送通知邮件。
    """
    if not get_setting(KEY_SMTP_ENABLED, "0") == "1":
        return {"success": False, "error": "未启用"}

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    status_map = {
        "ok": "✅ 成功",
        "error": "❌ 失败",
        "timeout": "⏰ 超时",
    }
    status_label = status_map.get(status, status)

    # 裁剪过长的输出
    if len(output) > 2000:
        output = output[:2000] + "\n...（输出过长已截断）"

    subject = f"[PyShell] 任务执行{status_label} - {task_name or command[:30]}"

    body = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PyShell 定时任务执行结果通知
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  任务名称: {task_name or '(未命名)'}
  执行时间: {now_str}
  执行状态: {status_label}
  退出代码: {exit_code if exit_code is not None else 'N/A'}
  目标会话: {session_name}
  执行命令: {command}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  执行输出:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{output}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PyShell - SSH 客户端
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

    return send_email(subject, body)