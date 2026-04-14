"""
telegram_sender.py  —  CryptoNite shared Telegram notifier
===========================================================
Reads credentials from environment variables (set in .env).
Never crashes the bot — all errors are silently swallowed.

env vars required:
  BOT_TOKEN      — Telegram bot token
  SIGNAL_CHAT_ID — channel/group for trade signals + closes
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
    """Fire-and-forget HTTP post. Retries once on failure."""
    if not BOT_TOKEN or not chat_id:
        return
    url     = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": message, "parse_mode": "HTML"}
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


def send_signal(symbol: str, direction: str, entry: float,
                sl: float, tp: float, strategy: str,
                rr: float = 1.5) -> None:
    """Send a new trade signal to the signal channel."""
    icon = "🟢" if direction == "BUY" else "🔴"
    msg = (
        f"🚨 <b>CryptoNite Signal</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"📌 Strategy: {strategy}\n"
        f"📈 Asset: {symbol}\n"
        f"{icon} Direction: <b>{direction}</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"💰 Entry: {round(entry, 5)}\n"
        f"🛑 SL:    {round(sl, 5)}\n"
        f"🎯 TP:    {round(tp, 5)}\n"
        f"⚖️  R:R:   1:{rr:.1f}\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"🕐 {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC"
    )
    _post(msg, SIGNAL_CHAT)


def send_close(symbol: str, direction: str, entry: float,
               exit_price: float, result_r: float,
               strategy: str) -> None:
    """Send a trade close notification to the signal channel."""
    if result_r >= 0:
        icon    = "✅"
        outcome = f"WIN  +{result_r:.2f}R"
    else:
        icon    = "❌"
        outcome = f"LOSS {result_r:.2f}R"
    msg = (
        f"{icon} <b>Trade Closed</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"📌 Strategy: {strategy}\n"
        f"📈 Asset: {symbol}\n"
        f"{'🟢' if direction == 'BUY' else '🔴'} Direction: {direction}\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"💰 Entry:  {round(entry, 5)}\n"
        f"🏁 Exit:   {round(exit_price, 5)}\n"
        f"📊 Result: <b>{outcome}</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"🕐 {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC"
    )
    _post(msg, SIGNAL_CHAT)
