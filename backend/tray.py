"""System tray icon for PyShell (optional feature).

Requires pystray + Pillow. When either is unavailable the tray is disabled
and the app keeps running as before (graceful degradation).
"""
import logging
import os
import sys

logger = logging.getLogger(__name__)

try:
    import pystray
    TRAY_AVAILABLE = True
except ImportError:
    pystray = None
    TRAY_AVAILABLE = False


def _icon_file():
    """Locate a bundled pyshell.ico (works in onefile via _MEIPASS)."""
    candidates = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidates.append(os.path.join(meipass, "pyshell.ico"))
        candidates.append(os.path.join(
            os.path.dirname(os.path.abspath(sys.executable)), "pyshell.ico"))
    else:
        candidates.append(os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "pyshell.ico"))
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def _make_icon_image():
    """Use the bundled pyshell.ico when available; otherwise draw a simple
    terminal icon (dark rounded body, green ">" prompt, cursor block)."""
    from PIL import Image, ImageDraw
    # ico_path = _icon_file()
    # if ico_path:
    #     try:
    #         img = Image.open(ico_path)
    #         img.load()
    #         return img.convert("RGBA") if img.mode != "RGBA" else img
    #     except Exception as e:
    #         logger.warning(f"Failed to load {ico_path}: {e}")
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # terminal body
    d.rounded_rectangle([2, 2, 62, 62], radius=10, fill=(24, 26, 34, 255),
                        outline=(70, 150, 255, 255), width=2)
    # title bar
    d.rectangle([4, 4, 60, 15], fill=(46, 52, 66, 255))
    for x in (8, 14, 20):  # window dots
        d.ellipse([x, 7, x + 4, 11], fill=(90, 96, 112, 255))
    # green ">" prompt
    d.line([12, 24, 22, 34], fill=(120, 220, 120, 255), width=4)
    d.line([22, 34, 12, 44], fill=(120, 220, 120, 255), width=4)
    # cursor block
    d.rectangle([28, 42, 52, 47], fill=(225, 225, 225, 255))
    return img


class TrayController:
    """Runs the tray icon on the calling (main) thread until exit."""

    def __init__(self, url):
        self.url = url
        self.icon = None

    def _on_open(self, icon, item):
        import webbrowser
        logger.info(f"Tray: open UI {self.url}")
        webbrowser.open(self.url)

    def _on_quit(self, icon, item):
        logger.info("Tray: exit requested")
        try:
            icon.stop()
        finally:
            os._exit(0)

    def run_blocking(self):
        """Show the tray and block. Returns False when the tray is not
        available (caller should keep serving in the foreground instead)."""
        if not TRAY_AVAILABLE:
            logger.info("pystray not installed - tray disabled")
            return False
        try:
            self.icon = pystray.Icon(
                "PyShell", _make_icon_image(), "PyShell - Web SSH 客户端",
                menu=pystray.Menu(
                    pystray.MenuItem("打开界面", self._on_open, default=True),
                    pystray.MenuItem("退出", self._on_quit),
                ))
            logger.info("Tray icon started")
            self.icon.run()
            return True
        except Exception as e:
            logger.warning(f"Tray unavailable, falling back: {e}")
            return False
