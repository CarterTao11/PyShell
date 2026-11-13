import logging
import threading
import paramiko
from ssh_client import PySSHClient

logger = logging.getLogger(__name__)


class TerminalSession:
    """Represents a single terminal session (channel)."""

    # 浏览器消费不过来的保护线：
    #   MAX_OUTPUT_BUFFER 未读输出上限（超了就丢最旧的，保住最新的）
    #   READ_CHUNK 单次交给 SSE 的最大字节数（把"一条命令刷屏"合并成大块，
    #   否则每个 64KB recv 都变成一次 SSE 事件，浏览器被几千次/秒的事件压垮）
    MAX_OUTPUT_BUFFER = 8 * 1024 * 1024
    READ_CHUNK = 128 * 1024

    def __init__(self, conn_id: str, ssh_client: PySSHClient):
        self.conn_id = conn_id
        self.ssh_client = ssh_client
        self.channel = None
        self._out_buf = bytearray()
        self._out_lock = threading.Lock()
        self._out_ready = threading.Condition(self._out_lock)
        self.dropped_bytes = 0      # 因为消费端跟不上而丢掉的字节数
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
        """Continuously read from channel and append to the bounded output buffer."""
        import time
        while self._running:
            try:
                if self.channel and self.channel.recv_ready():
                    data = self.channel.recv(65536)
                    if data:
                        self._append_output(data)
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
        with self._out_ready:
            self._out_ready.notify_all()

    def _append_output(self, data: bytes):
        """Append output with a hard cap; drop the oldest bytes when over the cap.

        不做无界队列：`docker logs -f` 这类命令一秒能产生几十 MB，SSE 端根本
        追不上，无界队列会先把后端内存吃光，再把浏览器的 xterm 写队列一起拖爆。
        丢最旧的、留最新的 —— 用户盯的是尾部。
        """
        with self._out_ready:
            self._out_buf.extend(data)
            if len(self._out_buf) > self.MAX_OUTPUT_BUFFER:
                # 一次多丢一些（回到半水位），否则每来一个 64KB 就要整体搬 8MB
                # 内存、白白烧 CPU；按块批量截断后摊销成本可以忽略
                trim = len(self._out_buf) - self.MAX_OUTPUT_BUFFER // 2
                del self._out_buf[:trim]
                self.dropped_bytes += trim
            self._out_ready.notify_all()

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
        """Take up to READ_CHUNK bytes.

        阻塞到有数据或超时；有数据就一次给一大块（把突发输出合并成少量 SSE 事件）。
        """
        with self._out_ready:
            if not self._out_buf and not self.closed:
                self._out_ready.wait(timeout)
            if not self._out_buf:
                return b""
            data = bytes(self._out_buf[:self.READ_CHUNK])
            del self._out_buf[:self.READ_CHUNK]
            return data

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