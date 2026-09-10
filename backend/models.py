from datetime import datetime, timezone
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class Session(db.Model):
    __tablename__ = "sessions"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name = db.Column(db.String(255), nullable=False, default="")
    host = db.Column(db.String(255), nullable=False)
    port = db.Column(db.Integer, nullable=False, default=22)
    username = db.Column(db.String(255), nullable=False, default="root")
    auth_type = db.Column(db.String(32), nullable=False, default="password")  # password / key / keyboard-interactive
    group_name = db.Column(db.String(255), nullable=False, default="")
    tags = db.Column(db.String(512), nullable=False, default="")
    remark = db.Column(db.Text, nullable=False, default="")
    sort_order = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc),
                           onupdate=lambda: datetime.now(timezone.utc))

    credentials = db.relationship("Credential", backref="session", lazy=True, cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "host": self.host,
            "port": self.port,
            "username": self.username,
            "auth_type": self.auth_type,
            "group_name": self.group_name,
            "tags": self.tags.split(",") if self.tags else [],
            "remark": self.remark,
            "sort_order": self.sort_order,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Credential(db.Model):
    __tablename__ = "credentials"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    session_id = db.Column(db.Integer, db.ForeignKey("sessions.id"), nullable=False)
    credential_type = db.Column(db.String(32), nullable=False)  # password / key / passphrase
    encrypted_data = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))


class KnownHost(db.Model):
    __tablename__ = "known_hosts"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    host = db.Column(db.String(255), nullable=False)
    key_type = db.Column(db.String(64), nullable=False)
    key_data = db.Column(db.Text, nullable=False)
    fingerprint = db.Column(db.String(255), nullable=False)
    first_seen = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    last_seen = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

    def to_dict(self):
        return {
            "id": self.id,
            "host": self.host,
            "key_type": self.key_type,
            "key_data": self.key_data[:64] + "..." if len(self.key_data) > 64 else self.key_data,
            "fingerprint": self.fingerprint,
            "first_seen": self.first_seen.isoformat() if self.first_seen else None,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
        }


class Setting(db.Model):
    __tablename__ = "settings"

    key = db.Column(db.String(255), primary_key=True)
    value = db.Column(db.Text, nullable=False, default="")


class ScheduledTask(db.Model):
    __tablename__ = "scheduled_tasks"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name = db.Column(db.String(255), nullable=False, default="")
    session_id = db.Column(db.Integer, db.ForeignKey("sessions.id"), nullable=False)
    command = db.Column(db.Text, nullable=False, default="")
    # 'interval' = 每隔 interval_seconds 执行一次; 'daily' = 每天 daily_time 执行
    schedule_type = db.Column(db.String(16), nullable=False, default="interval")
    interval_seconds = db.Column(db.Integer, nullable=True)
    daily_time = db.Column(db.String(5), nullable=True)  # 'HH:MM'
    timeout_seconds = db.Column(db.Integer, nullable=False, default=300)
    enabled = db.Column(db.Boolean, nullable=False, default=True)
    # 本地时间记录的最近一次执行结果
    last_run = db.Column(db.DateTime, nullable=True)
    last_status = db.Column(db.String(16), nullable=True)  # ok / error / timeout
    last_exit_code = db.Column(db.Integer, nullable=True)
    last_output = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

    session = db.relationship("Session")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "session_id": self.session_id,
            "session_name": self.session.name if self.session else "(会话已删除)",
            "host": f"{self.session.username}@{self.session.host}:{self.session.port}" if self.session else "",
            "command": self.command,
            "schedule_type": self.schedule_type,
            "interval_seconds": self.interval_seconds,
            "daily_time": self.daily_time,
            "timeout_seconds": self.timeout_seconds,
            "enabled": self.enabled,
            "last_run": self.last_run.isoformat(sep=" ", timespec="seconds") if self.last_run else None,
            "last_status": self.last_status,
            "last_exit_code": self.last_exit_code,
            "last_output": self.last_output,
        }