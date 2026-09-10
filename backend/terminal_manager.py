import queue
import logging
import threading
import paramiko
from ssh_client import PySSHClient

logger = logging.getLogger(__name__)


class TerminalSession:
    """Represents a single terminal session (channel)."""

    def __init__(self, conn_id: str, ssh_client: PySSHClient):
        self.conn_id = conn_id
        self.ssh_client = ssh_client
        self.channel = None
        self.output_queue = queue.Queue()
        self._reader_thread = None
        self._running = False
        self.closed = False  # True once the SSH channel has ended
        self._lock = threading.Lock()

    def open(self, rows: int = 40, cols: int = 120):
        """Open a terminal channel."""
        transport = self.ssh_client.get_transport()
        if transport is None:
            raise RuntimeError("SSH transport not available")

        self.channel = transport.open_session()
        self.channel.get_pty(term="xterm-256color", width=cols, height=rows)
        self.channel.invoke_shell()
        self.channel.setblocking(0)

        self._running = True
        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

    def _reader_loop(self):
        """Continuously read from channel and put into queue."""
        import time
        while self._running:
            try:
                if self.channel and self.channel.recv_ready():
                    data = self.channel.recv(65536)
                    if data:
                        self.output_queue.put(data)
                elif self.channel and self.channel.exit_status_ready():
                    break
                else:
                    time.sleep(0.01)
            except Exception as e:
                if self._running:
                    logger.error(f"Reader error [{self.conn_id}]: {e}")
                break

        self._running = False
        self.closed = True
        self.output_queue.put(None)  # Sentinel

    def write(self, data: str):
        """Send input to the terminal."""
        if self.channel and self.channel.closed is False:
            self.channel.send(data)
        else:
            raise RuntimeError("Channel is closed")

    def resize(self, rows: int, cols: int):
        """Resize terminal."""
        if self.channel and self.channel.closed is False:
            self.channel.resize_pty(width=cols, height=rows)

    def read_output(self, timeout: float = 0.1) -> bytes:
        """Read one chunk of output from queue."""
        try:
            data = self.output_queue.get(timeout=timeout)
            if data is None:
                return b""
            return data
        except queue.Empty:
            return b""

    def close(self):
        """Close the terminal session."""
        self._running = False
        self.closed = True
        try:
            if self.channel:
                self.channel.close()
        except:
            pass


class ConnectionManager:
    """Singleton manager for all active SSH connections."""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance.connections = {}
                    cls._instance.terminals = {}
        return cls._instance

    def create_connection(self, conn_id: str, config: dict, skip_host_key: bool = False) -> PySSHClient:
        """Create and dial a new SSH connection."""
        client = PySSHClient()
        if skip_host_key:
            fingerprint = client.dial_with_accepted_key(config)
        else:
            fingerprint = client.dial(config)
        self.connections[conn_id] = client
        return client

    def get_connection(self, conn_id: str) -> PySSHClient:
        """Get an existing SSH connection."""
        client = self.connections.get(conn_id)
        if client is None:
            raise KeyError(f"Connection '{conn_id}' not found")
        if not client.is_connected():
            self.remove_connection(conn_id)
            raise ConnectionError(f"Connection '{conn_id}' is no longer active")
        return client

    def remove_connection(self, conn_id: str):
        """Remove and close a connection."""
        client = self.connections.pop(conn_id, None)
        terminal = self.terminals.pop(conn_id, None)
        if terminal:
            try:
                terminal.close()
            except:
                pass
        if client:
            try:
                client.close()
            except:
                pass

    def create_terminal(self, conn_id: str, rows: int = 40, cols: int = 120) -> TerminalSession:
        """Create a terminal session for a connection."""
        client = self.get_connection(conn_id)
        terminal = TerminalSession(conn_id, client)
        terminal.open(rows=rows, cols=cols)
        self.terminals[conn_id] = terminal
        return terminal

    def get_terminal(self, conn_id: str) -> TerminalSession:
        """Get an existing terminal session."""
        terminal = self.terminals.get(conn_id)
        if terminal is None:
            raise KeyError(f"Terminal '{conn_id}' not found")
        return terminal

    def close_all(self):
        """Close all connections and terminals."""
        for conn_id in list(self.terminals.keys()):
            try:
                self.terminals[conn_id].close()
            except:
                pass
        self.terminals.clear()

        for conn_id in list(self.connections.keys()):
            try:
                self.connections[conn_id].close()
            except:
                pass
        self.connections.clear()

    def get_active_count(self) -> dict:
        """Get counts of active connections and terminals."""
        return {
            "connections": len(self.connections),
            "terminals": len(self.terminals),
        }