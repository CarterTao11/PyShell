import os
import stat
import logging

logger = logging.getLogger(__name__)


class SFTPHandler:
    """SFTP operations wrapper."""

    def __init__(self, sftp_client):
        self.sftp = sftp_client

    def list_dir(self, path: str = ".") -> list:
        """List directory contents with details."""
        items = []
        for entry in self.sftp.listdir_attr(path):
            items.append({
                "name": entry.filename,
                "size": entry.st_size,
                "mode": entry.st_mode,
                "uid": entry.st_uid,
                "gid": entry.st_gid,
                "mtime": entry.st_mtime,
                "is_dir": stat.S_ISDIR(entry.st_mode),
            })
        return items

    def upload(self, local_path: str, remote_path: str):
        """Upload a file to remote."""
        self.sftp.put(local_path, remote_path)

    def download(self, remote_path: str, local_path: str):
        """Download a file from remote."""
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        self.sftp.get(remote_path, local_path)

    def remove(self, path: str):
        """Remove a file or directory."""
        try:
            self.sftp.remove(path)
        except (IOError, PermissionError):
            self._rmtree(path)

    def _rmtree(self, path: str):
        """Recursively remove a directory."""
        try:
            for entry in self.sftp.listdir(path):
                entry_path = f"{path}/{entry}"
                try:
                    self.sftp.remove(entry_path)
                except (IOError, PermissionError):
                    self._rmtree(entry_path)
            self.sftp.rmdir(path)
        except:
            pass

    def rename(self, old: str, new: str):
        """Rename a file or directory."""
        self.sftp.rename(old, new)

    def mkdir(self, path: str):
        """Create a directory."""
        self.sftp.mkdir(path)

    def stat(self, path: str) -> dict:
        """Get file/directory stats."""
        try:
            attr = self.sftp.stat(path)
            return {
                "size": attr.st_size,
                "mode": attr.st_mode,
                "uid": attr.st_uid,
                "gid": attr.st_gid,
                "mtime": attr.st_mtime,
                "is_dir": stat.S_ISDIR(attr.st_mode),
            }
        except FileNotFoundError:
            return None

    def close(self):
        """Close SFTP client."""
        try:
            self.sftp.close()
        except:
            pass