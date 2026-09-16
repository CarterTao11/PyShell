import os
import sys
import json
import socket
import time
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

# 打包为无控制台窗口的 exe 时，日志写入文件以便排查问题
if getattr(sys, "frozen", False):
    try:
        os.makedirs(Config.DATA_DIR, exist_ok=True)
        _fh = logging.FileHandler(
            os.path.join(Config.DATA_DIR, "pyshell.log"), encoding="utf-8")
        _fh.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"))
        logging.getLogger().addHandler(_fh)
    except OSError as e:
        print(f"log file setup failed: {e}")

logger = logging.getLogger(__name__)

# ── 启动画面 ─────────────────────────────────────────────
_splash = None
_splash_progress = None  # 进度条信息


def _show_splash():
    """显示启动画面（简洁可靠版本）"""
    # 非打包模式或 macOS 系统不显示启动画面
    if not getattr(sys, "frozen", False):
        return
    if sys.platform == "darwin":
        return
    try:
        import tkinter as tk

        # ---------- 配色 ----------
        BG      = "#1a1a2e"   # 深色背景
        ACCENT  = "#00d4aa"   # 品牌绿
        TEXT    = "#e6f1ff"   # 白色文字
        TEXT_DIM = "#7a8aa3"  # 灰色文字

        W, H = 520, 360

        # DPI 感知
        try:
            if sys.platform == "win32":
                from ctypes import windll
                windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass

        root = tk.Tk()
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.configure(bg=BG)

        # 居中
        try:
            if sys.platform == "win32":
                from ctypes import windll
                sw = windll.user32.GetSystemMetrics(0)
                sh = windll.user32.GetSystemMetrics(1)
            else:
                sw = root.winfo_screenwidth()
                sh = root.winfo_screenheight()
        except Exception:
            sw = root.winfo_screenwidth()
            sh = root.winfo_screenheight()

        x = (sw - W) // 2
        y = (sh - H) // 2
        root.geometry(f"{W}x{H}+{x}+{y}")

        # 圆角
        try:
            if sys.platform == "win32":
                hwnd = windll.user32.GetParent(root.winfo_id())
                rgn = windll.gdi32.CreateRoundRectRgn(0, 0, W+1, H+1, 20, 20)
                windll.user32.SetWindowRgn(hwnd, rgn, True)
        except Exception:
            pass

        # ---------- 内容 ----------
        canvas = tk.Canvas(root, width=W, height=H, bg=BG,
                           highlightthickness=0, bd=0)
        canvas.pack()

        # Logo 文字
        canvas.create_text(W//2, 70, text="🚀 PyShell",
                           font=("Microsoft YaHei UI", 22, "bold"), fill=TEXT)

        # 分隔线
        canvas.create_line(W//2 - 40, 95, W//2 + 120, 95,
                           fill=ACCENT, width=2)

        # 副标题
        canvas.create_text(W//2, 120, text="SSH 客户端",
                           font=("Microsoft YaHei UI", 13), fill=TEXT_DIM)

        # 进度条背景
        bar_w, bar_h = 240, 6
        bar_x = (W - bar_w) // 2
        bar_y = 165
        canvas.create_rectangle(bar_x, bar_y, bar_x + bar_w, bar_y + bar_h,
                                fill="#2a2a4a", outline="")

        # 进度条（从 0 开始）
        progress = canvas.create_rectangle(bar_x, bar_y, bar_x, bar_y + bar_h,
                                           fill=ACCENT, outline="")

        # 状态文字
        status = canvas.create_text(W//2, 195, text="正在启动...",
                                    font=("Microsoft YaHei UI", 11), fill=TEXT_DIM)

        # 版本信息
        canvas.create_text(W//2, 250, text="v1.0.0",
                           font=("Consolas", 9), fill=TEXT_DIM)

        root.update()
        global _splash
        _splash = root

        # 保存进度条 ID 供后续更新（包含 canvas 引用）
        global _splash_progress
        _splash_progress = {"canvas": canvas, "progress": progress, "status": status, "bar_x": bar_x, "bar_w": bar_w}

    except Exception as e:
        logger.warning(f"启动画面显示失败: {e}")


def _update_splash(progress: int, status: str):
    """更新启动画面进度（0-100）"""
    global _splash, _splash_progress

    # 写日志
    def _log(msg):
        try:
            log_dir = os.path.join(os.path.dirname(sys.executable), "logs")
            os.makedirs(log_dir, exist_ok=True)
            with open(os.path.join(log_dir, "splash.log"), "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
        except Exception:
            pass

    if _splash is None:
        _log(f"_splash is None, progress={progress}")
        return
    if _splash_progress is None:
        _log(f"_splash_progress is None, progress={progress}")
        return
    try:
        p = _splash_progress
        canvas = p["canvas"]
        # 更新进度条宽度
        new_w = p["bar_x"] + int(p["bar_w"] * progress / 100)
        canvas.coords(p["progress"], p["bar_x"], 170, new_w, 170 + 6)
        # 更新状态文字
        canvas.itemconfig(p["status"], text=status)
        # 多次调用 update 确保界面刷新
        for _ in range(3):
            _splash.update()
            time.sleep(0.01)
        _log(f"Updated: {progress}% - {status}")
    except Exception as e:
        _log(f"Update error: {e}")

def _close_splash():
    global _splash, _splash_progress
    if _splash is not None:
        try:
            _splash.update()
            _splash.destroy()
        except Exception:
            pass
        _splash = None
        _splash_progress = None


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
        if os.environ.get("PYSHELL_NO_BROWSER") != "1":
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

    @app.route("/favicon.ico")
    def favicon():
        # 必须显式提供，否则会被下面的 SPA 兜底路由用 index.html 顶掉
        return send_from_directory(web_dir, "favicon.ico")

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
    _show_splash()
    _update_splash(10, "检查实例...")

    # 单实例检查（锁文件快速路径）
    if ensure_single_instance():
        _close_splash()
        return  # 已有实例运行，直接退出

    _update_splash(30, "初始化应用...")
    app = create_app()

    _update_splash(50, "创建数据库...")
    with app.app_context():
        db.create_all()
        logger.info("数据库就绪")

    _update_splash(70, "启动定时任务...")
    # 定时任务后台调度线程
    from task_scheduler import start_scheduler
    start_scheduler(app)

    _update_splash(80, "检查端口...")
    port = Config.PORT
    host = Config.HOST
    if not port and getattr(sys, "frozen", False):
        port = _find_free_port(5173)
    if not port:
        port = _find_free_port(49152)

    # 防双监听：Windows 下 SO_REUSEADDR 允许两个进程绑同一端口（请求随机
    # 分流，极端隐蔽）。启动前主动探测目标端口：
    # 1) 已有 PyShell 实例（任何安装位置）→ 打开它的界面并退出；
    # 2) 端口被其他程序占用 → 换下一个空闲端口。
    if port and _port_alive(host, port):
        url = f"http://{host}:{port}"
        logger.info(f"检测到 {url} 已有 PyShell 实例在运行，打开界面后退出")
        _close_splash()
        if os.environ.get("PYSHELL_NO_BROWSER") != "1":
            try:
                webbrowser.open(url)
            except Exception as e:
                logger.warning(f"打开浏览器失败: {e}")
        return
    if port:
        occupied = False
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
            except OSError:
                occupied = True
        if occupied:
            new_port = _find_free_port(port + 1)
            logger.warning(f"端口 {port} 被其他程序占用，改用 {new_port}")
            port = new_port
            if not port:
                logger.error("无可用端口，退出")
                return

    # 写入锁文件（启动后）
    _write_lock(port)
    _update_splash(90, "启动服务...")

    no_browser = os.environ.get("PYSHELL_NO_BROWSER") == "1"

    def open_browser():
        time.sleep(1.5)
        url = f"http://{host}:{port}"
        try:
            webbrowser.open(url)
            logger.info(f"浏览器已打开: {url}")
        except Exception as e:
            logger.warning(f"打开浏览器失败: {e}")
        _close_splash()

    if not no_browser:
        threading.Thread(target=open_browser, daemon=True).start()

    _update_splash(100, "准备就绪!")
    logger.info(f"PyShell 启动 → http://{host}:{port}")
    try:
        # 托盘模式（仅打包 exe 且未指定 --no-tray）：
        # 主线程跑托盘消息循环，Flask 服务放在后台线程
        use_tray = getattr(sys, "frozen", False) \
            and os.environ.get("PYSHELL_NO_TRAY") != "1" \
            and "--no-tray" not in sys.argv
        if use_tray:
            from tray import TrayController

            def _serve_in_thread():
                try:
                    app.run(host=host, port=port, debug=False,
                            use_reloader=False, threaded=True)
                except OSError as e:
                    logger.error(f"服务启动失败: {e}")
                    os._exit(1)

            threading.Thread(target=_serve_in_thread, daemon=True).start()
            time.sleep(1.0)  # 给服务一点启动时间
            _close_splash()  # 托盘已就绪，关闭启动画面
            # 用户点"退出"时 _on_quit 直接 os._exit(0)；run_blocking 只要
            # 返回（包括托盘消息循环异常终止）就降级为前台服务，保证
            # Web 服务始终可用。
            TrayController(f"http://{host}:{port}").run_blocking()
            logger.info("托盘已停止，转为前台服务模式")
        app.run(host=host, port=port, debug=False, use_reloader=False, threaded=True)
    finally:
        _close_splash()
        _remove_lock()


if __name__ == "__main__":
    main()