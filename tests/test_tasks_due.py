"""Unit tests for task_scheduler.compute_due (no Flask app needed).

Usage: .\\.venv\\Scripts\\python.exe tests\\test_tasks_due.py
"""
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

# Import only the pure function; task_scheduler imports models/db which need
# flask_sqlalchemy — available in the venv, no app context required for import.
from task_scheduler import compute_due  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + ("" if cond else f" -- {detail}"))
    if not cond:
        failures += 1


now = datetime(2026, 9, 10, 12, 0, 0)

# interval: never run, created recently (created_at is naive UTC; local is
# UTC+8, so local now=12:00 == UTC 04:00). created 30s ago (UTC 03:59:30 ->
# local 11:59:30), interval 60 -> 30s < 60 -> not due
check("interval never run, created recently -> not due",
      compute_due("interval", 60, None, None, True, now,
                  created_at=datetime(2026, 9, 10, 3, 59, 30)) is False)
# interval: never run, created 2 minutes ago (UTC 03:58 -> local 11:58),
# interval 60 -> 120s >= 60 -> due (first automatic run)
check("interval never run, past first interval -> due",
      compute_due("interval", 60, None, None, True, now,
                  created_at=datetime(2026, 9, 10, 3, 58, 0)) is True)
# interval: never run and no created_at info -> cannot schedule, not due
check("interval never run without created_at -> not due",
      compute_due("interval", 60, None, None, True, now) is False)
# interval: ran 30s ago, interval 60 -> not due
check("interval not elapsed -> not due",
      compute_due("interval", 60, None, now - timedelta(seconds=30), True, now) is False)
# interval: ran 60s ago -> due
check("interval elapsed -> due",
      compute_due("interval", 60, None, now - timedelta(seconds=60), True, now) is True)
# interval: disabled -> never due
check("interval disabled -> not due",
      compute_due("interval", 60, None, now - timedelta(seconds=999), False, now) is False)
# interval: below minimum -> never due
check("interval <10s invalid -> not due",
      compute_due("interval", 5, None, now - timedelta(seconds=999), True, now) is False)

# daily: today already run -> not due
check("daily already ran today -> not due",
      compute_due("daily", None, "09:00", now.replace(hour=9), True, now) is False)
# daily: ran yesterday, time reached -> due
check("daily ran yesterday, time reached -> due",
      compute_due("daily", None, "09:00", now - timedelta(days=1), True, now) is True)
# daily: manual test run EARLIER than task time today -> still due at HH:MM
# (user case: task 18:52, manual run at 18:43, now 18:53 -> must run)
evening = now.replace(hour=18, minute=53)
check("daily manual run before task time -> still due",
      compute_due("daily", None, "18:52", evening.replace(hour=18, minute=43),
                  True, evening) is True)
# daily: ran today AFTER task time -> done for today
check("daily ran after task time today -> not due",
      compute_due("daily", None, "18:52", evening.replace(hour=18, minute=55),
                  True, evening) is False)
# daily: ran yesterday, time NOT reached yet -> not due
check("daily time not reached -> not due",
      compute_due("daily", None, "18:00", now - timedelta(days=1), True, now) is False)
# NOTE: created_at is stored as naive UTC (models default). Local time here
# is UTC+8, so local 12:00 == UTC 04:00 on the same date.
# daily: never run, created yesterday (local 10:00 = UTC 02:00) -> due now
check("daily never run, created before task time on earlier day -> due",
      compute_due("daily", None, "09:00", None, True, now,
                  created_at=datetime(2026, 9, 9, 2, 0)) is True)
# daily: never run, created today local 10:00 (UTC 02:00), task at 09:00
# -> task time had already passed at creation -> skip today
check("daily created today after task time -> not due",
      compute_due("daily", None, "09:00", None, True, now,
                  created_at=datetime(2026, 9, 10, 2, 0)) is False)
# daily: created today local 08:00 (UTC 00:00), task at 09:00 -> due
check("daily created today before task time -> due",
      compute_due("daily", None, "09:00", None, True, now,
                  created_at=datetime(2026, 9, 10, 0, 0)) is True)
# daily: no created_at info -> falls back to due-when-time-reached
check("daily never run (no created_at) -> due",
      compute_due("daily", None, "09:00", None, True, now) is True)
# daily: bad time format -> never due
check("daily bad time -> not due",
      compute_due("daily", None, "9am", None, True, now) is False)

# unknown type
check("unknown type -> not due",
      compute_due("weekly", 60, None, now - timedelta(days=9), True, now) is False)

print()
if failures:
    print(f"RESULT: {failures} FAILED")
    sys.exit(1)
print("RESULT: ALL PASSED")
