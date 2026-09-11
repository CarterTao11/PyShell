import os
import sys
import json
import socket
import logging
import threading
import webbrowser

from flask import Flask, send_from_directory
from flask_cors import CORS

from config import Config
from models import db
from api import api_bp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── 单实例锁 ─────────────────────────────────────────────
LOCK_FILE = os.path.join(Config.DATA_DIR, "pyshell.port")


def _read_lock() -> int | None:
    """读取锁文件中的端口号，文件不存在或内容无效返回 None"""
    try:
        with open(LOCK_FILE, "r") as f:
            port = int(f.read().strip())
            return port
    except (FileNotFoundError, ValueError, OSError):
        return None


def _write_lock(port: int):
    """把当前端口写入锁文件"""
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    with open(LOCK_FILE, "w") as f:
        f.write(str(port))


def _remove_lock():
    """删除锁文件"""
    try:
        os.remove(LOCK_FILE)
    except FileNotFoundError:
        pass


def _port_alive(host: str, port: int) -> bool:
    """通过 /api/status 检测端口上是否还有活着的 PyShell 实例"""
    try:
        import http.client
        conn = http.client.HTTPConnection(host, port, timeout=2)
        conn.request("GET", "/api/status")
        resp = conn.getresponse()
        alive = resp.status == 200
        conn.close()
        return alive
    except Exception:
        return False


def _find_free_port(start: int, attempts: int = 50) -> int:
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((Config.HOST, port))
                return port
            except OSError:
                continue
    return 0


def ensure_single_instance():
    """
    单实例守卫：
    1. 锁文件存在且端口存活 → 打开浏览器，直接退出
    2. 锁文件存在但端口已死 → 删除锁文件，继续启动
    3. 锁文件不存在 → 继续启动

    返回 True 表示当前进程应该退出（已有实例在运行）；
    返回 False 表示当前进程应该继续启动新实例。
    """
    port = _read_lock()
    if port is not None and _port_alive(Config.HOST, port):
        url = f"http://{Config.HOST}:{port}"
        logger.info(f"检测到已在运行的实例 ({url})，打开浏览器后退出")
        try:
            webbrowser.open(url)
        except Exception as e:
            logger.warning(f"打开浏览器失败: {e}")
        return True  # 告诉调用方退出

    if port is not None:
        logger.info("锁文件存在但实例已死，删除锁文件后重新启动")
        _remove_lock()

    return False  # 继续启动


# ── 应用工厂 ──────────────────────────────────────────────

def create_app():
    app = Flask(__name__, static_folder=None)
    app.config.from_object(Config)
    CORS(app)
    db.init_app(app)
    app.register_blueprint(api_bp)

    web_dir = Config.WEB_DIR

    @app.route("/")
    def index():
        return send_from_directory(web_dir, "index.html")

    @app.route("/css/<path:filename>")
    def css_files(filename):
        return send_from_directory(os.path.join(web_dir, "css"), filename)

    @app.route("/js/<path:filename>")
    def js_files(filename):
        return send_from_directory(os.path.join(web_dir, "js"), filename)

    @app.route("/vendor/<path:filename>")
    def vendor_files(filename):
        return send_from_directory(os.path.join(web_dir, "vendor"), filename)

    @app.route("/<path:path>")
    def spa_fallback(path):
        if path.startswith("api/"):
            return {"error": "Not found"}, 404
        return send_from_directory(web_dir, "index.html")

    return app


# ── 主入口 ────────────────────────────────────────────────

def main():
    # 单实例检查
    if ensure_single_instance():
        return  # 已有实例运行，直接退出

    app = create_app()

    with app.app_context():
        db.create_all()
        logger.info("数据库就绪")

    port = Config.PORT
    host = Config.HOST
    if not port and getattr(sys, "frozen", False):
        port = _find_free_port(5173)
    if not port:
        port = _find_free_port(49152)

    # 写入锁文件（启动后）
    _write_lock(port)

    def open_browser():
        import time
        time.sleep(1.5)
        url = f"http://{host}:{port}"
        try:
            webbrowser.open(url)
            logger.info(f"浏览器已打开: {url}")
        except Exception as e:
            logger.warning(f"打开浏览器失败: {e}")

    threading.Thread(target=open_browser, daemon=True).start()

    logger.info(f"PyShell 启动 → http://{host}:{port}")
    try:
        app.run(host=host, port=port, debug=False, use_reloader=False, threaded=True)
    finally:
        _remove_lock()


if __name__ == "__main__":
    main()