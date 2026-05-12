"""
logger.py - Trade and Event Logging

Two log files:
  trade_log.csv  -- one row per completed trade (entry, exit, profit)
  events.log     -- timestamped record of every bot decision:
                    box evaluations, signal scans, skips, orders, errors.
                    Capped at 2000 lines to prevent unbounded growth.
"""

import csv
import os
from datetime import datetime, timezone

TRADE_FILE = "trade_log.csv"
EVENT_FILE = "events.log"
MAX_LINES  = 2000


def log_event(msg: str) -> None:
    """Write a timestamped line to events.log AND print to console."""
    now  = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    line = "[{}] {}".format(now, msg)
    print(line)
    try:
        with open(EVENT_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        _rotate_events()
    except Exception as e:
        print("[LOGGER ERROR] {}".format(e))


def _rotate_events() -> None:
    try:
        with open(EVENT_FILE, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
        if len(lines) > MAX_LINES:
            with open(EVENT_FILE, "w", encoding="utf-8") as f:
                f.writelines(lines[-MAX_LINES:])
    except FileNotFoundError:
        pass


def init_log() -> None:
    if not os.path.exists(TRADE_FILE):
        with open(TRADE_FILE, mode="w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["date", "time", "symbol", "type",
                             "entry", "sl", "tp", "close_price", "profit", "lot"])


def log_trade(trade_type, entry, sl, close_price, profit,
              symbol="XAUUSD", tp=None, lot=None) -> None:
    now = datetime.now(timezone.utc)
    with open(TRADE_FILE, mode="a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            now.strftime("%Y-%m-%d"), now.strftime("%H:%M:%S"), symbol, trade_type,
            round(entry, 4)       if entry       else "",
            round(sl, 4)          if sl          else "",
            round(tp, 4)          if tp          else "",
            round(close_price, 4) if close_price else "",
            round(profit, 2)      if profit is not None else "",
            lot or "",
        ])
