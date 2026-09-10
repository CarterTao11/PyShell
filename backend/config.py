import os
import sys


def _app_base_dir() -> str:
    """Directory that holds (or should hold) the application's writable data.

    - Frozen exe (PyInstaller): the directory containing the exe, so the
      user's data (sqlite db, sessions, host keys) lives next to it.
    - Source run: the project root (parent of backend/).
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _web_dir() -> str:
    """Directory of the bundled frontend (web/).

    - Frozen exe: PyInstaller unpacks --add-data files under sys._MEIPASS.
    - Source run: project root /web.
    """
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidate = os.path.join(meipass, "web")
            if os.path.isdir(candidate):
                return candidate
        # --onedir builds keep data files next to the exe
        base = os.path.dirname(os.path.abspath(sys.executable))
        return os.path.join(base, "web")
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


# Writable data lives next to the exe (frozen) or in the project root (source)
BASE_DIR = _app_base_dir()
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# Frontend assets (index.html, js/, css/, vendor/)
WEB_DIR = _web_dir()

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "pyshell-secret-key")
    # Absolute path so the DB always resolves to <data>/pyshell.db,
    # regardless of the working directory or flask-sqlalchemy's instance path.
    SQLALCHEMY_DATABASE_URI = os.getenv(
        "DATABASE_URL",
        "sqlite:///" + os.path.join(DATA_DIR, "pyshell.db").replace("\\", "/"),
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    HOST = "127.0.0.1"
    PORT = int(os.getenv("PORT", 0))  # 0 = 随机端口
    # SSH 保活间隔(秒)
    KEEPALIVE_INTERVAL = 30
