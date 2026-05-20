"""
daily_report.py — End-of-Day Summary Report

Runs as a background loop inside the bot. Once per day, at a configured
UTC hour (default 22:00 = end of NY session), reads trades.csv and sends
a per-channel breakdown report to your Telegram report channel.

Configure in .env:
  DAILY_REPORT_ENABLED=true
  DAILY_REPORT_HOUR=22        ← UTC hour to fire (22 = 10pm UTC)
"""

import asyncio
import csv
import os
from collections import defaultdict
from datetime import datetime, date, timedelta

import MetaTrader5 as mt5

from config import settings
from logger import log


# ── Channel names (keep in sync with bot_commands.py) ─────────────────────
CHANNEL_NAME_MAP = {
    "-1003523601209": "CryptoNite Free Signals",
    "-1002717527369": "Free Tag Signals",
    "-1003882026187": "Limitless Abundance 2.0",
    "-1003889406756": "Limitless Abundance VIP",
    "-1003628454081": "XFUSION SIGNALS",
}

_CSV_PATH = os.path.join(os.path.dirname(__file__), "trades.csv")


def _read_trades_csv(date_list: list) -> list:
    """Return closed-trade rows from trades.csv for the given date strings."""
    rows = []
    if not os.path.exists(_CSV_PATH):
        return rows
    date_set = set(date_list)
    try:
        with open(_CSV_PATH, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row.get("date", "") in date_set and row.get("result", "") != "OPEN":
                    rows.append(row)
    except Exception as e:
        log(f"[REPORT] CSV read error: {e}", "ERROR")
    return rows


def _channel_breakdown(rows: list, header: str) -> str:
    """Build per-channel W/L/BE+/BE report string."""
    channels = defaultdict(lambda: {
        "trades": 0, "wins": 0, "losses": 0, "be_plus": 0, "be": 0,
        "profit": 0.0, "sum_win": 0.0, "sum_loss": 0.0, "sum_be_plus": 0.0,
    })
    for row in rows:
        ch     = str(row.get("source_channel", "") or "unknown")
        result = row.get("result", "")
        try:
            profit = float(row.get("profit", 0) or 0)
        except Exception:
            profit = 0.0
        b = channels[ch]
        b["trades"] += 1
        b["profit"] += profit
        if result == "WIN":
            b["wins"]    += 1; b["sum_win"]    += profit
        elif result == "LOSS":
            b["losses"]  += 1; b["sum_loss"]   += profit
        elif result == "BE+":
            b["be_plus"] += 1; b["sum_be_plus"] += profit
        else:
            b["be"]      += 1

    acc = mt5.account_info()
    balance = acc.balance if acc else 0.0
    equity  = acc.equity  if acc else 0.0

    lines = [f"<b>{header}</b>", ""]

    if not channels:
        lines.append("No closed trades recorded.")
        lines.append("")
        lines.append(f"Balance: <b>{balance:.2f}</b>  |  Equity: <b>{equity:.2f}</b>")
        return "\n".join(lines)

    items = sorted(channels.items(), key=lambda kv: kv[1]["profit"], reverse=True)

    total_pnl = sum(b["profit"]  for _, b in items)
    total_t   = sum(b["trades"]  for _, b in items)
    total_w   = sum(b["wins"]    for _, b in items)
    total_l   = sum(b["losses"]  for _, b in items)
    total_bep = sum(b["be_plus"] for _, b in items)
    total_be  = sum(b["be"]      for _, b in items)
    total_wr  = round(total_w / (total_w + total_l) * 100, 1) if (total_w + total_l) > 0 else 0.0
    pnl_sign  = "+" if total_pnl >= 0 else ""

    lines.append(
        f"Overall: <b>{total_t}t</b> | {total_w}W/{total_l}L/{total_bep}BE+/{total_be}BE"
        f" | WR <b>{total_wr:.0f}%</b> | P&amp;L <b>{pnl_sign}{total_pnl:.2f}</b>"
    )
    lines.append("")

    for cid, b in items:
        cname  = CHANNEL_NAME_MAP.get(cid, cid)
        wins   = b["wins"];   losses = b["losses"]
        bep    = b["be_plus"]; be    = b["be"]
        trades = b["trades"]; profit = b["profit"]
        denom  = wins + losses
        wr     = round(wins / denom * 100, 1) if denom > 0 else 0.0
        avg_w  = round(b["sum_win"]  / wins,   2) if wins   > 0 else 0.0
        avg_l  = round(b["sum_loss"] / losses, 2) if losses > 0 else 0.0

        line2  = (f"P/L={profit:+.2f} | {trades}t | "
                  f"{wins}W/{losses}L/{bep}BE+/{be}BE | WR={wr:.0f}%")
        if wins   > 0: line2 += f" | avgW={avg_w:+.2f}"
        if losses > 0: line2 += f" | avgL={avg_l:+.2f}"
        if bep    > 0: line2 += f" | BE+={b['sum_be_plus']:+.2f}"

        lines.append(f"• <b>{cname}</b>")
        lines.append(line2)
        lines.append("")

    lines.append(f"Balance: <b>{balance:.2f}</b>  |  Equity: <b>{equity:.2f}</b>")
    return "\n".join(lines).rstrip()


class DailyReporter:

    def __init__(self, manager, tg_sender):
        self.manager  = manager
        self.tg       = tg_sender
        self._last_sent_date = None

    async def run(self):
        if not settings.daily_report_enabled:
            log("[REPORT] Daily report disabled in config", "INFO")
            return
        log(f"[REPORT] Daily report enabled — fires at {settings.daily_report_hour:02d}:00 UTC", "INFO")
        while True:
            await asyncio.sleep(60)
            now   = datetime.utcnow()
            today = date.today()
            if now.hour == settings.daily_report_hour and self._last_sent_date != today:
                log("[REPORT] Sending daily channel report...", "INFO")
                await self._send_report(today)
                self._last_sent_date = today

    async def _send_report(self, report_date: date):
        try:
            # Report on yesterday if we fire just after midnight, else today
            day_str = report_date.isoformat()
            rows    = _read_trades_csv([day_str])
            today_label = report_date.strftime("%A %d %B %Y")
            msg = _channel_breakdown(rows, f"📊 Daily Report — {today_label}")
            target = settings.report_channel_id or settings.execution_channel_id
            if target:
                await self.tg.client.send_message(int(target), msg, parse_mode="html")
                log(f"[REPORT] Daily report sent ({len(rows)} trades)", "INFO")
        except Exception as e:
            log(f"[REPORT] Failed to send daily report: {e}", "ERROR")
