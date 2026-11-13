# -*- coding: utf-8 -*-
import re

fp = r'D:\work\pyshell\backend\app.py'
with open(fp, 'r', encoding='utf-8') as f:
    c = f.read()

# Replace the splash section
old = '''# ── 启动画面 ─────────────────────────────────────────────
_splash = None


def _show_splash():
    """显示启动画面"""
    if not getattr(sys, "frozen", False):
        return
    try:
        import tkinter as tk
        root = tk.Tk()
        root.title("PyShell")
        root.overrideredirect(True)
        root.configure(bg="#1a1a2e")
        root.lift()
        root.attributes("-topmost", True)
        w, h = 400, 260
        sw = root.winfo_screenwidth()
        sh = root.winfo_screenheight()
        root.geometry(f"{w}x{h}+{(sw-w)//2}+{(sh-h)//2}")
        root.update()
        canvas = tk.Canvas(root, width=w, height=h, bg="#1a1a2e", highlightthickness=0)
        canvas.pack()
        canvas.create_oval(160, 20, 240, 100, outline="#00d4aa", width=3)
        canvas.create_text(200, 60, text="PS", font=("Segoe UI", 28, "bold"), fill="#00d4aa")
        canvas.create_text(w // 2, 130, text="PyShell", font=("Segoe UI", 24, "bold"), fill="#00d4aa")
        canvas.create_text(w // 2, 160, text="SSH 客户端", font=("Segoe UI", 13), fill="#8899bb")
        text_id = canvas.create_text(w // 2, 200, text="正在启动", font=("Segoe UI", 11), fill="#556677")
        root.update()
        global _splash
        _splash = root
        def poll():
            dots = 0
            while _splash is not None:
                try:
                    dots = (dots + 1) % 4
                    canvas.itemconfig(text_id, text="正在启动" + "." * dots)
                    root.update()
                except tk.TclError:
                    break
                time.sleep(0.3)
        threading.Thread(target=poll, daemon=True).start()
    except Exception as e:
        logger.warning(f"启动画面显示失败: {e}")


def _close_splash():
    global _splash
    if _splash is not None:
        try:
            _splash.update()
            _splash.destroy()
        except Exception:
            pass
        _splash = None'''

# Try both combinations
patterns = [
    (old.replace('\n', '\r\n'), None),
    (old.replace('\r\n', '\n'), None),
]

for pattern, _ in patterns:
    if pattern in c:
        break
    print(f'Trying different line endings...')

# Use threading.Event approach
new = '''# ── 启动画面 ─────────────────────────────────────────────
_splash_shutdown = threading.Event()


def _show_splash():
    """显示启动画面"""
    if not getattr(sys, "frozen", False):
        return
    try:
        import tkinter as tk
        root = tk.Tk()
        root.title("PyShell")
        root.overrideredirect(True)
        root.configure(bg="#1a1a2e")
        root.lift()
        root.attributes("-topmost", True)
        w, h = 400, 260
        sw = root.winfo_screenwidth()
        sh = root.winfo_screenheight()
        root.geometry(f"{w}x{h}+{(sw-w)//2}+{(sh-h)//2}")
        canvas = tk.Canvas(root, width=w, height=h, bg="#1a1a2e", highlightthickness=0)
        canvas.pack()
        canvas.create_oval(160, 20, 240, 100, outline="#00d4aa", width=3)
        canvas.create_text(200, 60, text="PS", font=("Segoe UI", 28, "bold"), fill="#00d4aa")
        canvas.create_text(w // 2, 130, text="PyShell", font=("Segoe UI", 24, "bold"), fill="#00d4aa")
        canvas.create_text(w // 2, 160, text="SSH 客户端", font=("Segoe UI", 13), fill="#8899bb")
        text_id = canvas.create_text(w // 2, 200, text="正在启动", font=("Segoe UI", 11), fill="#556677")
        root.update()

        def animate():
            dots = 0
            try:
                while not _splash_shutdown.is_set():
                    dots = (dots + 1) % 4
                    canvas.itemconfig(text_id, text="正在启动" + "." * dots)
                    root.update()
                    time.sleep(0.3)
            except Exception:
                pass
            try:
                root.destroy()
            except Exception:
                pass

        _splash_shutdown.clear()
        threading.Thread(target=animate, daemon=True).start()
    except Exception as e:
        logger.warning(f"启动画面显示失败: {e}")


def _close_splash():
    _splash_shutdown.set()'''

if pattern in c:
    c = c.replace(pattern, new)
    with open(fp, 'w', encoding='utf-8') as f:
        f.write(c)
    print('OK - replaced')
else:
    print('Pattern not found, checking actual content...')
    # Print the actual section
    idx = c.find('── 启动画面')
    if idx >= 0:
        print(repr(c[idx:idx+200]))