"""页面在线状态：判断"是不是已经有一个 PyShell 页面开着"。

背景：每次执行 `python backend/app.py`，只要端口上已有实例，程序都会再
`webbrowser.open()` 一次 —— 每重启/重复启动一次就多一个标签页。Chrome 里
一个标签 ≈ 一个 renderer 进程（几十 MB 起步），标签越堆越多，看着就像
"开个 pyshell 就十几个浏览器进程、一个多 G"。

做法：前端每 20 秒 PUT 一次心跳（任何 API 请求也算），时间戳落到
data/ui_last_seen（写盘节流 10 秒，不为了心跳去磨硬盘）。启动时若发现
30 秒内还有页面在活动，就不再开新标签页；页面侧如果连续两次心跳失败
（说明服务重启过、自己已经和后台失联）会自行 reload 一次，重新接上。
"""

import os
import threading
import time

from config import Config

# 页面活着 = 30 秒内还有请求打进来（心跳 20s 一次，留 1 个周期余量）
PRESENCE_WINDOW = 30
# 写盘节流：心跳再密也最多 10 秒写一次文件
WRITE_INTERVAL = 10

STAMP_FILE = os.path.join(Config.DATA_DIR, "ui_last_seen")

_lock = threading.Lock()
_mem_last_seen = 0.0
_mem_last_write = 0.0


def _read_stamp() -> float:
    try:
        with open(STAMP_FILE, "r", encoding="utf-8") as f:
            return float((f.read() or "0").strip() or "0")
    except Exception:
        return 0.0


def _write_stamp(ts: float):
    try:
        os.makedirs(os.path.dirname(STAMP_FILE), exist_ok=True)
        tmp = STAMP_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("%f" % ts)
        os.replace(tmp, STAMP_FILE)
    except Exception:
        pass   # 写不了就算了，退回只按内存判断


def touch():
    """记录一次页面活动（来自前端的任何 HTTP 请求都算）"""
    global _mem_last_seen, _mem_last_write
    now = time.time()
    with _lock:
        _mem_last_seen = now
        if now - _mem_last_write >= WRITE_INTERVAL:
            _mem_last_write = now
            should_write = True
        else:
            should_write = False
    if should_write:
        _write_stamp(now)


def last_seen() -> float:
    """最近一次页面活动时间（内存和落盘取较大值，跨进程重启也认）"""
    return max(_mem_last_seen, _read_stamp())


def seen_recently(window: float = PRESENCE_WINDOW) -> bool:
    ts = last_seen()
    return ts > 0 and (time.time() - ts) < window


def reset():
    """测试用：清空内存状态与落盘时间戳"""
    global _mem_last_seen, _mem_last_write
    with _lock:
        _mem_last_seen = 0.0
        _mem_last_write = 0.0
    try:
        if os.path.exists(STAMP_FILE):
            os.remove(STAMP_FILE)
    except Exception:
        pass
