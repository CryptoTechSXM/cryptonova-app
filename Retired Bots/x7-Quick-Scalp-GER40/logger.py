"""
logger.py — Trade Journal + Events Log
trade_log.csv : one row per completed trade with full details
events.log    : timestamped activity log (signals, decisions, errors)
"""
import csv
import os
from datetime import datetime

CSV_FILE   = "trade_log.csv"
EVENT_FILE = "events.log"
MAX_LINES  = 2000

FIELDNAMES = [
    "date", "time", "symbol", "type",
    "entry", "sl", "tp", "exit",
    "lot", "result", "profit", "rr", "duration_min",
]


def init_log():
    """Create trade_log.csv with header if it does not exist."""
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, mode='w', newline='', encoding='utf-8') as f:
            csv.DictWriter(f, fieldnames=FIELDNAMES).writeheader()


def log_trade(symbol, direction, entry, sl, tp, exit_price, lot, profit, open_time=None):
    """
    Append one completed trade row to trade_log.csv.
    Args:
        symbol      : instrument name e.g. 'BTCUSD'
        direction   : 'BUY' or 'SELL'  (original position direction, NOT closing deal direction)
        entry       : fill price
        sl          : stop-loss price at open
        tp          : take-profit price at open (0 if removed)
        exit_price  : closing price
        lot         : position size
        profit      : realised P&L in account currency
        open_time   : datetime the position opened (for duration calculation)
    """
    try:
        now    = datetime.now()
        result = "WIN" if profit > 0 else ("LOSS" if profit < 0 else "BE")
        risk   = abs(entry - sl) if sl else 0
        reward = abs(exit_price - entry) if exit_price and entry else 0
        rr     = round(reward / risk, 2) if risk > 0 else ""
        duration_min = ""
        if open_time:
            try:
                duration_min = round((now - open_time).total_seconds() / 60, 1)
            except Exception:
                pass
        row = {
            "date":         now.strftime("%Y-%m-%d"),
            "time":         now.strftime("%H:%M:%S"),
            "symbol":       symbol,
            "type":         direction,
            "entry":        round(entry, 5) if entry else "",
            "sl":           round(sl, 5) if sl else "",
            "tp":           round(tp, 5) if tp else "",
            "exit":         round(exit_price, 5) if exit_price else "",
            "lot":          lot,
            "result":       result,
            "profit":       round(profit, 2),
            "rr":           rr,
            "duration_min": duration_min,
        }
        file_exists = os.path.isfile(CSV_FILE)
        with open(CSV_FILE, mode='a', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            if not file_exists:
                writer.writeheader()
            writer.writerow(row)
    except Exception as e:
        print("[TRADE LOGGER] Failed to write row: {}".format(e))


def log_event(msg: str) -> None:
    """Write a timestamped line to events.log AND print to console."""
    import sys
    now  = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = "[{}] {}".format(now, msg)
    print(line)
    try:
        with open(EVENT_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        _rotate_events()
    except Exception as e:
        print("[LOGGER ERROR] {}".format(e), file=sys.stderr)


def _rotate_events() -> None:
    """Trim events.log to the last MAX_LINES lines to prevent unbounded growth."""
    try:
        with open(EVENT_FILE, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
        if len(lines) > MAX_LINES:
            with open(EVENT_FILE, "w", encoding="utf-8") as f:
                f.writelines(lines[-MAX_LINES:])
    except FileNotFoundError:
        pass
