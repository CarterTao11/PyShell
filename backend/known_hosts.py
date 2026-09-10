import logging
from datetime import datetime, timezone
from models import db, KnownHost

logger = logging.getLogger(__name__)


def _format_fingerprint(key):
    """Generate a human-readable fingerprint from a paramiko PKey."""
    import hashlib
    import base64
    key_bytes = key.__str__().encode("utf-8") if hasattr(key, "__str__") else key.get_base64()
    if isinstance(key_bytes, str):
        key_bytes = key_bytes.encode("utf-8")
    digest = hashlib.md5(key_bytes).hexdigest()
    return ":".join(digest[i:i+2] for i in range(0, len(digest), 2))


def check_host_key(host: str, port: int, key) -> str:
    """
    Check if a host key is known.
    Returns: "unknown" / "known" / "changed"
    """
    key_type = key.get_name()
    key_data = key.get_base64()

    host_spec = f"[{host}]:{port}" if port != 22 else host

    record = KnownHost.query.filter_by(host=host_spec, key_type=key_type).first()

    if record is None:
        return "unknown"

    if record.key_data == key_data:
        # Update last_seen
        record.last_seen = datetime.now(timezone.utc)
        db.session.commit()
        return "known"
    else:
        return "changed"


def accept_host_key(host: str, port: int, key):
    """Save or update a host key."""
    key_type = key.get_name()
    key_data = key.get_base64()
    fingerprint = _format_fingerprint(key)
    host_spec = f"[{host}]:{port}" if port != 22 else host

    now = datetime.now(timezone.utc)

    existing = KnownHost.query.filter_by(host=host_spec, key_type=key_type).first()
    if existing:
        existing.key_data = key_data
        existing.fingerprint = fingerprint
        existing.last_seen = now
    else:
        record = KnownHost(
            host=host_spec,
            key_type=key_type,
            key_data=key_data,
            fingerprint=fingerprint,
            first_seen=now,
            last_seen=now,
        )
        db.session.add(record)

    db.session.commit()
    return fingerprint


def get_known_hosts():
    """Get list of all known hosts."""
    records = KnownHost.query.order_by(KnownHost.last_seen.desc()).all()
    return [r.to_dict() for r in records]


def remove_host_key(record_id: int):
    """Remove a known host key by ID."""
    record = KnownHost.query.get(record_id)
    if record:
        db.session.delete(record)
        db.session.commit()
        return True
    return False