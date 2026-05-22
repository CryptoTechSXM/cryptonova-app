"""
watchdog.py — CryptoNite Bot Health Monitor
============================================
Run this script alongside your bots (in a separate terminal or as a scheduled
task). It checks each bot's heartbeat.txt file every POLL_INTERVAL seconds.

  • If a heartbeat is older than the bot's TIMEOUT, it sends a Telegram alert.
  • When the bot recovers (heartbeat refreshes), it sends a recovery message.
  • If heartbeat.txt doesn't exist yet (bot not started), it's silently ignored.

Usage:
    python watchdog.py

Setup:
    Copy your Telegram credentials from any bot's .env — the watchdog needs:
        TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, SIGNAL_CHAT_ID

    Either set them as environment variables or create a watchdog.env file in
    the same folder as this script with the same KEY=VALUE format.
"""

import os
import time
import asyncio
from datetime import datetime, timezone
from pathlib import Path

# ── Telegram credentials ──────────────────────────────────────────────────────
# Loaded from environment or watchdog.env (same folder as this script)
def _load_env(envfile="watchdog.env"):
    p = Path(__file__).parent / envfile
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

_load_env()

API_ID   = int(os.getenv("TELEGRAM_API_ID",  "0"))
API_HASH = os.getenv("TELEGRAM_API_HASH", "")
SESSION  = os.getenv("TELEGRAM_SESSION",  "watchdog_session")
CHAT_ID  = int(os.getenv("SIGNAL_CHAT_ID", "0"))   # same chat the bots use

# ── Bot registry ──────────────────────────────────────────────────────────────
# name        : display name in Telegram messages
# heartbeat   : absolute path to the bot's heartbeat.txt
# timeout     : seconds before the bot is considered frozen
# active_hours: (start_utc, end_utc) — only alert during these UTC hours.
#               None = alert 24/7 (crypto bots, 247-bot, etc.)
BASE = Path(__file__).parent.parent   # C:\CryptoNite-MT5-Bots\

BOTS = [
    # ── HA bots ───────────────────────────────────────────────────────────────
    {
        "name":         "Gold HA Bot",
        "heartbeat":    BASE / "1-gold-ha-bot"   / "heartbeat.txt",
        "timeout":      90,
        "active_hours": (6, 20),    # London + NY sessions
    },
    {
        "name":         "BTC HA Bot",
        "heartbeat":    BASE / "2-btc-ha-bot"    / "heartbeat.txt",
        "timeout":      90,
        "active_hours": None,       # crypto — 24/7
    },
    {
        "name":         "ETH HA Bot",
        "heartbeat":    BASE / "3-eth-ha-bot"    / "heartbeat.txt",
        "timeout":      90,
        "active_hours": None,
    },
    {
        "name":         "NAS100 HA Bot",
        "heartbeat":    BASE / "4-nas100-ha-bot" / "heartbeat.txt",
        "timeout":      90,
        "active_hours": (12, 22),   # NY session
    },
    {
        "name":         "EURUSD HA Bot",
        "heartbeat":    BASE / "5-eurusd-ha-bot" / "heartbeat.txt",
        "timeout":      90,
        "active_hours": (6, 18),    # London + NY overlap
    },

    # ── QFS bots ──────────────────────────────────────────────────────────────
    {
        "name":         "QFS NAS100",
        "heartbeat":    BASE / "6-Quick-Scalp-NAS100" / "heartbeat.txt",
        "timeout":      90,
        "active_hours": (12, 22),
    },
    {
        "name":         "QFS GER40",
        "heartbeat":    BASE / "7-Quick-Scalp-GER40"  / "heartbeat.txt",
        "timeout":      90,
        "active_hours": (6, 18),
    },
    {
        "name":         "QFS XAUUSD",
        "heartbeat":    BASE / "8-Quick-Scalp-XAUUSD" / "heartbeat.txt",
        "timeout":      90,
        "active_hours": (6, 20),
    },
    {
        "name":         "QFS NFLX",
        "heartbeat":    BASE / "9-Quick-Scalp-NFLX"   / "heartbeat.txt",
        "timeout":      90,
        "active_hours": (13, 21),   # US market hours
    },

    # ── Signal bot (tg-mt5-bot) ───────────────────────────────────────────────
    {
        "name":         "CryptoNite Signal Bot",
        "heartbeat":    BASE / "0-tg-mt5-bot" / "heartbeat.txt",
        "timeout":      30,         # manager_loop runs every 2s — alert fast
        "active_hours": None,
    },

    # ── 247 signal listener ───────────────────────────────────────────────────
    {
        "name":         "CryptoNite 247",
        "heartbeat":    BASE / "0-mt5-247-bot" / "heartbeat.txt",
        "timeout":      180,        # manager_loop backs off to 60s when MT5 is down
        "active_hours": None,
    },
]

# ── Settings ──────────────────────────────────────────────────────────────────
POLL_INTERVAL = 30   # seconds between watchdog checks

# ── State ─────────────────────────────────────────────────────────────────────
_alerted = {}   # bot name -> True once freeze alert has been sent


def _in_active_window(hours):
    """True if the current UTC hour falls inside the bot's active window."""
    if hours is None:
        return True
    now_h = datetime.now(timezone.utc).hour
    start, end = hours
    if start <= end:
        return start <= now_h < end
    return now_h >= start or now_h < end   # wraps midnight


def _now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


async def _send(client, message: str):
    if not CHAT_ID:
        return
    try:
        await client.send_message(CHAT_ID, message, parse_mode="html")
    except Exception as e:
        print(f"[watchdog] Telegram send failed: {e}")


async def watch_loop(client):
    print(f"[watchdog] Monitoring {len(BOTS)} bots every {POLL_INTERVAL}s  (Ctrl+C to stop)")
    while True:
        for bot in BOTS:
            name = bot["name"]
            hb   = Path(bot["heartbeat"])
            tmo  = bot["timeout"]

            if not _in_active_window(bot.get("active_hours")):
                # Outside session — clear stale alert so we don't false-alarm
                # when the bot's session opens next time.
                _alerted[name] = False
                continue

            if not hb.exists():
                continue   # bot not started yet — ignore silently

            try:
                age = time.time() - hb.stat().st_mtime
            except OSError:
                continue

            if age > tmo:
                if not _alerted.get(name):
                    mins    = int(age // 60)
                    secs    = int(age % 60)
                    age_str = f"{mins}m {secs}s" if mins else f"{secs}s"
                    msg = (
                        f"\U0001f534 <b>Bot FROZEN</b>\n"
                        f"\U0001f4e1 {name}\n"
                        f"⏰ {_now_utc()}\n"
                        f"⚠️ No heartbeat for {age_str} (limit: {tmo}s)\n"
                        f"\U0001f4a1 Check the terminal — bot may have crashed or hung."
                    )
                    await _send(client, msg)
                    _alerted[name] = True
                    print(f"[watchdog] ALERT: {name} frozen ({age_str})")
            else:
                if _alerted.get(name):
                    msg = (
                        f"\U0001f7e2 <b>Bot RECOVERED</b>\n"
                        f"\U0001f4e1 {name}\n"
                        f"⏰ {_now_utc()}\n"
                        f"✅ Heartbeat restored — bot is running again."
                    )
                    await _send(client, msg)
                    _alerted[name] = False
                    print(f"[watchdog] RECOVERED: {name}")

        await asyncio.sleep(POLL_INTERVAL)


async def main_async():
    if not API_ID or not API_HASH or not CHAT_ID:
        print("[watchdog] ERROR: TELEGRAM_API_ID, TELEGRAM_API_HASH, SIGNAL_CHAT_ID must be set.")
        print("  Create watchdog.env next to watchdog.py with those values, e.g.:")
        print("    TELEGRAM_API_ID=12345678")
        print("    TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890")
        print("    SIGNAL_CHAT_ID=-1001234567890")
        return

    try:
        from telethon import TelegramClient
    except ImportError:
        print("[watchdog] ERROR: telethon not installed.  Run: pip install telethon")
        return

    session_path = str(Path(__file__).parent / SESSION)
    async with TelegramClient(session_path, API_ID, API_HASH) as client:
        print("[watchdog] Telegram connected.")
        await watch_loop(client)


def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\n[watchdog] Stopped.")


if __name__ == "__main__":
    main()
