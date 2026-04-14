"""
telegram_sender.py  —  CryptoNite shared Telegram notifier
===========================================================
Signal format (matches ANALYZER_ENGINE_RE in 0-mt5-247-bot):

  🚨 CryptoNite {strategy} Signals

  Time: 2026-04-14 23:09:00
  Asset: ETHUSD
  Direction: BUY

  Entry: 1234.56
  SL:    1200.56
  TP:    1280.56

env vars required:
  BOT_TOKEN      — Telegram bot token
  SIGNAL_CHAT_ID — channel for trade signals + closes
"""

import os
import json
import urllib.request
from datetime import datetime

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

BOT_TOKEN   = os.getenv("BOT_TOKEN",      "")
SIGNAL_CHAT = os.getenv("SIGNAL_CHAT_ID", "")


def _post(message: str, chat_id: str) -> None:
    if not BOT_TOKEN or not chat_id:
        return
    url     = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": message}
    data    = json.dumps(payload).encode("utf-8")
    req     = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    for _ in range(2):
        try:
            urllib.request.urlopen(req, timeout=8)
            return
        except Exception:
            pass


def _heading(strategy: str) -> str:
    label = strategy.replace(" Bot", "").strip()
    return f"🚨 CryptoNite {label} Signals"


def send_signal(symbol: str, direction: str, entry: float,
                sl: float, tp: float, strategy: str,
                rr: float = 1.5) -> None:
    now    = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    tp_str = str(round(tp, 5)) if tp and tp != 0.0 else "Trailing"
    msg = (
        f"{_heading(strategy)}\n"
        f"\n"
        f"Time: {now}\n"
        f"Asset: {symbol}\n"
        f"Direction: {direction}\n"
        f"\n"
        f"Entry: {round(entry, 5)}\n"
        f"SL: {round(sl, 5)}\n"
        f"TP: {tp_str}"
    )
    _post(msg, SIGNAL_CHAT)


def send_close(symbol: str, direction: str, entry: float,
               exit_price: float, result_r: float,
               strategy: str) -> None:
    now     = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    outcome = "WIN" if result_r >= 0 else "LOSS"
    icon    = "✅" if result_r >= 0 else "❌"
    label   = strategy.replace(" Bot", "").strip()
    msg = (
        f"{icon} CryptoNite {label} — {outcome}\n"
        f"\n"
        f"Time: {now}\n"
        f"Asset: {symbol}\n"
        f"Direction: {direction}\n"
        f"\n"
        f"Entry: {round(entry, 5)}\n"
        f"Exit: {round(exit_price, 5)}\n"
        f"Result: {result_r:+.2f}R"
    )
    _post(msg, SIGNAL_CHAT)
