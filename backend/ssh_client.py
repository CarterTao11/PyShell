import io
import os
import logging
import paramiko
from paramiko import RSAKey, Ed25519Key, ECDSAKey
from known_hosts import check_host_key, accept_host_key

logger = logging.getLogger(__name__)


class KnownHostsPolicy(paramiko.MissingHostKeyPolicy):
    """Custom host key policy that checks our known_hosts database."""

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.received_key = None

    def missing_host_key(self, client, hostname, key):
        self.received_key = key
        result = check_host_key(self.host, self.port, key)
        if result == "known":
            return  # known key, allow connection
        elif result == "changed":
            raise paramiko.SSHException(
                "主机密钥已变更！\n"
                "可能的原因：\n"
                "1. 服务器系统重装\n"
                "2. 中间人攻击\n"
                "请联系服务器管理员确认后再连接。"
            )
        else:
            # unknown host key - auto-accept for first connection
            # The fingerprint will be shown for user confirmation
            fingerprint = key.get_fingerprint().hex()
            fp_formatted = ":".join(fingerprint[i:i+2] for i in range(0, len(fingerprint), 2))
            raise paramiko.SSHException(
                f"HOST_KEY_UNKNOWN|{fp_formatted}|{hostname}|{key.get_name()}"
            )


class PySSHClient:
    """Wrapper around paramiko.SSHClient for managing SSH connections."""

    def __init__(self):
        self.client = paramiko.SSHClient()
        self._sftp_client = None
        self._transport = None
        self.policy = None

    def dial(self, config: dict):
        host = config["host"]
        port = int(config.get("port", 22))
        username = config.get("username", "root")
        auth_type = config.get("auth_type", "password")
        keepalive = config.get("keepalive_interval", 30)

        self.policy = KnownHostsPolicy(host, port)
        self.client.set_missing_host_key_policy(self.policy)

        connect_kwargs = {
            "hostname": host,
            "port": port,
            "username": username,
            "timeout": 15,
            "look_for_keys": False,
            "allow_agent": False,
        }

        if auth_type == "password":
            connect_kwargs["password"] = config.get("password", "")
        elif auth_type == "key":
            private_key_content = config.get("private_key", "")
            passphrase = config.get("passphrase", None) or None
            pkey = self._parse_private_key(private_key_content, passphrase)
            if pkey is None:
                raise ValueError("无法解析私钥，请检查私钥内容")
            connect_kwargs["pkey"] = pkey
            if passphrase:
                connect_kwargs["password"] = passphrase
        elif auth_type == "keyboard-interactive":
            connect_kwargs["password"] = config.get("password", "")
            connect_kwargs["allow_agent"] = True
            connect_kwargs["look_for_keys"] = True

        try:
            self.client.connect(**connect_kwargs)
        except paramiko.SSHException as e:
            err_str = str(e)
            if err_str.startswith("HOST_KEY_UNKNOWN|"):
                parts = err_str.split("|")
                fingerprint = parts[1]
                hostname = parts[2] if len(parts) > 2 else host
                key_type = parts[3] if len(parts) > 3 else "unknown"
                raise HostKeyUnknown(hostname, fingerprint, key_type)
            raise

        self._transport = self.client.get_transport()
        if self._transport:
            self._transport.set_keepalive(keepalive)
            self._transport.window_size = 2147483647
            self._transport.packetizer.REKEY_BYTES = pow(2, 40)
            self._transport.packetizer.REKEY_PACKETS = pow(2, 40)

        # Auto-save host key if it was unknown
        if self.policy and self.policy.received_key:
            accept_host_key(host, port, self.policy.received_key)

        # Get fingerprint
        host_key = self._transport.get_remote_server_key()
        fingerprint = host_key.get_fingerprint().hex()
        formatted_fp = ":".join(fingerprint[i:i+2] for i in range(0, len(fingerprint), 2))
        return formatted_fp

    def dial_with_accepted_key(self, config: dict):
        """Connect after user has accepted the host key."""
        # Temporarily skip host key check by auto-adding
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        host = config["host"]
        port = int(config.get("port", 22))
        username = config.get("username", "root")
        auth_type = config.get("auth_type", "password")
        keepalive = config.get("keepalive_interval", 30)

        connect_kwargs = {
            "hostname": host,
            "port": port,
            "username": username,
            "timeout": 15,
            "look_for_keys": False,
            "allow_agent": False,
        }

        if auth_type == "password":
            connect_kwargs["password"] = config.get("password", "")
        elif auth_type == "key":
            private_key_content = config.get("private_key", "")
            passphrase = config.get("passphrase", None) or None
            pkey = self._parse_private_key(private_key_content, passphrase)
            if pkey is None:
                raise ValueError("无法解析私钥")
            connect_kwargs["pkey"] = pkey

        self.client.connect(**connect_kwargs)

        self._transport = self.client.get_transport()
        if self._transport:
            self._transport.set_keepalive(keepalive)

        # Save host key
        host_key = self._transport.get_remote_server_key()
        accept_host_key(host, port, host_key)

        fingerprint = host_key.get_fingerprint().hex()
        return ":".join(fingerprint[i:i+2] for i in range(0, len(fingerprint), 2))

    def _parse_private_key(self, key_content, passphrase=None):
        if not key_content:
            return None
        key_file = io.StringIO(key_content)
        for key_class in [RSAKey, Ed25519Key, ECDSAKey]:
            try:
                key_file.seek(0)
                return key_class.from_private_key(key_file, password=passphrase)
            except (paramiko.SSHException, ValueError):
                continue
        if passphrase is None:
            for key_class in [RSAKey, Ed25519Key, ECDSAKey]:
                try:
                    key_file.seek(0)
                    return key_class.from_private_key(key_file, password="")
                except (paramiko.SSHException, ValueError):
                    continue
        return None

    def get_sftp_client(self):
        if self._sftp_client is None or self._sftp_client.sock.closed:
            self._sftp_client = self.client.open_sftp()
        return self._sftp_client

    def close(self):
        try:
            if self._sftp_client:
                self._sftp_client.close()
        except:
            pass
        try:
            if self._transport:
                self._transport.close()
        except:
            pass
        try:
            self.client.close()
        except:
            pass

    def is_connected(self):
        if self._transport is None:
            return False
        return self._transport.is_active()

    def get_transport(self):
        return self._transport


class HostKeyUnknown(Exception):
    """Raised when the host key is unknown and user needs to confirm."""

    def __init__(self, host, fingerprint, key_type):
        self.host = host
        self.fingerprint = fingerprint
        self.key_type = key_type
        super().__init__(f"主机密钥未知: {host} ({key_type}) {fingerprint}")