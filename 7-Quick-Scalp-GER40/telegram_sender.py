"""
telegram_sender.py  —  CryptoNite shared Telegram notifier
===========================================================
All bots use this same file. Messages use HTML formatting.

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


def _clean_symbol(symbol: str) -> str:
    """Strip broker suffix — XAUUSD.pro -> XAUUSD."""
    return symbol.split(".")[0] if "." in symbol else symbol


def _fmt(v: float) -> str:
    """Smart decimal formatting: forex (<=10) gets 5dp, everything else 2dp."""
    return f"{v:.5f}" if v <= 10 else f"{v:.2f}"


def send_signal(symbol: str, direction: str, entry: float,
                sl: float, tp: float, strategy: str,
                rr: float = 1.5) -> None:
    now      = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    sym      = _clean_symbol(symbol)
    tp_str   = _fmt(tp) if tp and tp != 0.0 else "Trailing"
    dir_icon = "📈" if direction == "BUY" else "📉"
    msg = (
        f"🚨 <b>CryptoNite Signal</b>\n"
        f"📡 {strategy}\n"
        f"\n"
        f"{dir_icon} <b>{sym} | {direction}</b>\n"
        f"⏰ {now}\n"
        f"\n"
        f"📍 Entry:  {_fmt(entry)}\n"
        f"🛑 SL:     {_fmt(sl)}\n"
        f"🎯 TP:     {tp_str}"
    )
    _post(msg, SIGNAL_CHAT)


def send_close(symbol: str, direction: str, entry: float,
               exit_price: float, result_r: float,
               strategy: str, profit_usd: float = None) -> None:
    now      = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    sym      = _clean_symbol(symbol)
    outcome  = "WIN" if result_r >= 0 else "LOSS"
    icon     = "✅" if result_r >= 0 else "❌"
    dir_icon = "📈" if direction == "BUY" else "📉"
    pnl_line = f"\n💰 P/L:    <b>{profit_usd:+.2f}</b>" if profit_usd is not None else ""
    msg = (
        f"{icon} <b>Trade Closed — {outcome}</b>\n"
        f"📡 {strategy}\n"
        f"\n"
        f"{dir_icon} <b>{sym} | {direction}</b>\n"
        f"⏰ {now}\n"
        f"\n"
        f"📍 Entry: {_fmt(entry)}\n"
        f"🏁 Exit:  {_fmt(exit_price)}\n"
        f"📊 Result: <b>{result_r:+.2f}R</b>{pnl_line}"
    )
    _post(msg, SIGNAL_CHAT)


def send_adoption(symbol: str, direction: str, entry: float,
                  sl: float, strategy: str) -> None:
    now      = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    sym      = _clean_symbol(symbol)
    dir_icon = "📈" if direction == "BUY" else "📉"
    msg = (
        f"📎 <b>Trade Adopted</b>\n"
        f"📡 {strategy}\n"
        f"\n"
        f"{dir_icon} <b>{sym} | {direction}</b>\n"
        f"⏰ {now}\n"
        f"\n"
        f"📍 Entry: {_fmt(entry)}\n"
        f"🛑 SL:    {_fmt(sl)}  (ATR-based)\n"
        f"\n"
        f"🤖 Now managed by bot"
    )
    _post(msg, SIGNAL_CHAT)


def send_status(strategy: str, event: str, detail: str = "") -> None:
    """Bot lifecycle alert — ONLINE, STOPPED, or custom event."""
    now      = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    icon     = "🟢" if event == "ONLINE" else "🔴"
    detail_line = f"\n⚠️ {detail}" if detail else ""
    msg = (
        f"{icon} <b>Bot {event}</b>\n"
        f"📡 {strategy}\n"
        f"⏰ {now}"
        f"{detail_line}"
    )
    _post(msg, SIGNAL_CHAT)
