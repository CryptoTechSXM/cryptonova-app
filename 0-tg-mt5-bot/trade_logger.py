"""
trade_logger.py - CSV Trade Journal

Appends one row per completed trade to trades.csv in the bot's folder.
Every column you'd want for later analysis is included.

You can open trades.csv in Excel, Google Sheets, or any analytics tool
to review your performance, win rate, best symbols, etc.

Columns:
  date, time, ticket, symbol, side, entry, exit, sl, tp,
  lot, result, profit, rr, source_channel, mode, duration_min
"""

import csv
import os
from datetime import datetime

CSV_FILE = "trades.csv"

FIELDNAMES = [
    "date",
    "time",
    "ticket",
    "symbol",
    "side",
    "entry",
    "exit",
    "sl",
    "tp",
    "lot",
    "result",
    "profit",
    "rr",
    "source_channel",
    "mode",
    "duration_min",
]


def log_closed_trade(ticket, trade: dict, profit: float, exit_price: float = None):
    """
    Called by manager.py when a position closes.

    Args:
        ticket       - MT5 order/position ticket number
        trade        - the dict stored in manager.active_trades (has entry, sl, tp, etc.)
        profit       - realised P&L from MT5 history deals
        exit_price   - closing price (optional; used for R:R calculation)
    """
    try:
        now    = datetime.now()
        result = "WIN" if profit > 0 else "LOSS"

        entry  = trade.get("entry", 0)
        sl     = trade.get("sl", 0)
        tp     = trade.get("tp", 0)
        side   = trade.get("side", "")

        # R:R - how many R the trade made/lost relative to its SL distance
        risk   = abs(entry - sl) if sl and sl > 0 else 0
        reward = abs((exit_price or tp) - entry) if entry else 0
        rr     = round(reward / risk, 2) if risk > 0 else ""

        # Approximate trade duration (minutes) if we have open time recorded
        open_time    = trade.get("open_time")
        duration_min = ""
        if open_time:
            try:
                duration_min = round((now - open_time).total_seconds() / 60, 1)
            except Exception:
                pass

        row = {
            "date":           now.strftime("%Y-%m-%d"),
            "time":           now.strftime("%H:%M:%S"),
            "ticket":         ticket,
            "symbol":         trade.get("symbol", ""),
            "side":           side,
            "entry":          round(entry, 5) if entry else "",
            "exit":           round(exit_price, 5) if exit_price else "",
            "sl":             round(sl, 5) if sl else "",
            "tp":             round(tp, 5) if tp else "",
            "lot":            trade.get("lot", ""),
            "result":         result,
            "profit":         round(profit, 2),
            "rr":             rr,
            "source_channel": trade.get("source_channel", ""),
            "mode":           trade.get("mode", ""),
            "duration_min":   duration_min,
        }

        file_exists = os.path.isfile(CSV_FILE)

        with open(CSV_FILE, mode="a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)

            if not file_exists:
                writer.writeheader()

            writer.writerow(row)

    except Exception as e:
        # Never let a logging failure crash the bot
        print(f"[TRADE LOGGER] Failed to write CSV row: {e}")


def log_opened_trade(ticket, trade: dict):
    """
    Optional: log a row when a trade OPENS (status = OPEN).
    Useful for tracking trades that might not close cleanly.
    """
    try:
        now = datetime.now()

        row = {
            "date":           now.strftime("%Y-%m-%d"),
            "time":           now.strftime("%H:%M:%S"),
            "ticket":         ticket,
            "symbol":         trade.get("symbol", ""),
            "side":           trade.get("side", ""),
            "entry":          round(trade.get("entry", 0), 5),
            "exit":           "",
            "sl":             round(trade.get("sl", 0), 5),
            "tp":             round(trade.get("tp", 0), 5),
            "lot":            trade.get("lot", ""),
            "result":         "OPEN",
            "profit":         "",
            "rr":             "",
            "source_channel": trade.get("source_channel", ""),
            "mode":           trade.get("mode", ""),
            "duration_min":   "",
        }

        file_exists = os.path.isfile(CSV_FILE)

        with open(CSV_FILE, mode="a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)

            if not file_exists:
                writer.writeheader()

            writer.writerow(row)

    except Exception as e:
        print(f"[TRADE LOGGER] Failed to write open row: {e}")
