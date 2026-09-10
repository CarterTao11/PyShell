import base64
import sys
import logging
from models import db, Credential

logger = logging.getLogger(__name__)

# Attempt to use Windows DPAPI via pycryptodome
_USE_DPAPI = False
_crypt_protect = None
_crypt_unprotect = None

if sys.platform == "win32":
    try:
        from Cryptodome.Protocol.KDF import HKDF
        from Cryptodome.Cipher import AES
        import struct
        # We'll use pywin32 directly for DPAPI
        import win32crypt
        _USE_DPAPI = True
        _crypt_protect = win32crypt.CryptProtectData
        _crypt_unprotect = win32crypt.CryptUnprotectData
        logger.info("Windows DPAPI credential encryption enabled")
    except ImportError:
        logger.warning("win32crypt not available, falling back to base64 encoding")
        _USE_DPAPI = False


def _encrypt(plain_text: str) -> str:
    """Encrypt plain text using DPAPI or fallback to base64."""
    if not plain_text:
        return ""
    if _USE_DPAPI:
        try:
            data_bytes = plain_text.encode("utf-16-le")
            encrypted_blob = _crypt_protect(data_bytes, None, None, None, None, 0)
            return base64.b64encode(encrypted_blob).decode("ascii")
        except Exception as e:
            logger.error(f"DPAPI encryption failed: {e}")
            return base64.b64encode(plain_text.encode("utf-8")).decode("ascii")
    else:
        # Fallback: base64 encode (not secure, but functional)
        return base64.b64encode(plain_text.encode("utf-8")).decode("ascii")


def _decrypt(encrypted_data: str) -> str:
    """Decrypt data using DPAPI or fallback to base64."""
    if not encrypted_data:
        return ""
    if _USE_DPAPI:
        try:
            encrypted_blob = base64.b64decode(encrypted_data)
            decrypted_bytes, _ = _crypt_unprotect(encrypted_blob, None, None, None, 0)
            return decrypted_bytes.decode("utf-16-le")
        except Exception as e:
            logger.error(f"DPAPI decryption failed: {e}")
            try:
                return base64.b64decode(encrypted_data).decode("utf-8")
            except:
                return ""
    else:
        try:
            return base64.b64decode(encrypted_data).decode("utf-8")
        except:
            return ""


def save_credential(session_id: int, cred_type: str, plain_text: str):
    """Save or update a credential for a session."""
    existing = Credential.query.filter_by(
        session_id=session_id, credential_type=cred_type
    ).first()
    encrypted = _encrypt(plain_text)
    if existing:
        existing.encrypted_data = encrypted
    else:
        cred = Credential(
            session_id=session_id,
            credential_type=cred_type,
            encrypted_data=encrypted,
        )
        db.session.add(cred)
    db.session.commit()


def get_credential(session_id: int, cred_type: str) -> str:
    """Retrieve a decrypted credential."""
    cred = Credential.query.filter_by(
        session_id=session_id, credential_type=cred_type
    ).first()
    if cred:
        return _decrypt(cred.encrypted_data)
    return ""


def delete_credential(session_id: int):
    """Delete all credentials for a session."""
    Credential.query.filter_by(session_id=session_id).delete()
    db.session.commit()