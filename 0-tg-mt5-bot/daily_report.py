"""
daily_report.py — End-of-Day Summary Report

Runs as a background loop inside the bot. Once per day, at a configured
UTC hour (default 22:00 = end of NY session), it:

  1. Pulls all closed trades from MT5 history for today
  2. Calculates win rate, total P&L, best/worst trade, avg R:R
  3. Adds account balance and equity snapshot
  4. Sends the full report to your Telegram report channel

Configure in .env:
  DAILY_REPORT_ENABLED=true
  DAILY_REPORT_HOUR=22        ← UTC hour to fire (22 = 10pm UTC)
"""

import asyncio
from datetime import datetime, date

import MetaTrader5 as mt5

from config import settings
from logger import log


class DailyReporter:

    def __init__(self, manager, tg_sender):
        self.manager   = manager
        self.tg        = tg_sender
        self._last_sent_date = None   # track which date we last sent a report

    # =========================
    async def run(self):
        """
        Background loop — wakes every 60 seconds and checks whether it's
        time to send the daily report. Fires once per calendar day at the
        configured hour, then goes back to sleep.
        """
        if not settings.daily_report_enabled:
            log("[REPORT] Daily report disabled in config", "INFO")
            return

        log(
            f"[REPORT] Daily report enabled — fires at "
            f"{settings.daily_report_hour:02d}:00 UTC each day",
            "INFO"
        )

        while True:
            await asyncio.sleep(60)   # check every minute

            now  = datetime.utcnow()
            today = date.today()

            # Fire if: correct hour, and we haven't sent one today yet
            if now.hour == settings.daily_report_hour and self._last_sent_date != today:
                log("[REPORT] Sending daily report...", "INFO")
                await self._send_report()
                self._last_sent_date = today

    # =========================
    async def _send_report(self):
        """Build and send the full end-of-day report."""
        try:
            trades  = self.manager.get_daily_trade_history()
            account = mt5.account_info()
            report  = self._build_report(trades, account)

            await self.tg.send_daily_report(report)
            log(f"[REPORT] Daily report sent ({len(trades)} trades)", "INFO")

        except Exception as e:
            log(f"[REPORT] Failed to send daily report: {e}", "ERROR")

    # =========================
    def _build_report(self, trades, account):
        """
        Crunch the numbers from today's trade list and account snapshot.
        Returns a dict that telegram_sender.send_daily_report() will format.
        """
        today_str = datetime.utcnow().strftime("%A %d %B %Y")   # e.g. "Saturday 11 April 2026"

        if not trades:
            return {
                "date":         today_str,
                "total_trades": 0,
                "wins":         0,
                "losses":       0,
                "win_rate":     0.0,
                "total_pnl":    0.0,
                "best_trade":   None,
                "worst_trade":  None,
                "avg_rr":       None,
                "balance":      round(account.balance, 2) if account else 0.0,
                "equity":       round(account.equity,  2) if account else 0.0,
                "daily_losses": self.manager.daily_loss,
                "limit_hit":    not self.manager.trading_enabled,
                "trade_lines":  [],
            }

        wins   = [t for t in trades if t["profit"] > 0]
        losses = [t for t in trades if t["profit"] <= 0]

        total_pnl = sum(t["profit"] for t in trades)
        win_rate  = (len(wins) / len(trades) * 100) if trades else 0.0

        best_trade  = max(trades, key=lambda t: t["profit"])
        worst_trade = min(trades, key=lambda t: t["profit"])

        # R:R ratio — only meaningful for trades where we know entry/exit/sl
        # We approximate it from profit sign and magnitude where we can
        rr_values = []
        for t in trades:
            risk   = abs(t["entry"] - t.get("sl", t["entry"]))
            reward = abs(t["exit"]  - t["entry"])
            if risk > 0:
                rr_values.append(reward / risk)

        avg_rr = round(sum(rr_values) / len(rr_values), 2) if rr_values else None

        # Build one line per trade for the detailed breakdown section
        trade_lines = []
        for t in trades:
            emoji  = "✅" if t["profit"] > 0 else "❌"
            sign   = "+" if t["profit"] > 0 else ""
            trade_lines.append(
                f"{emoji} {t['symbol']} {t['side']}  "
                f"{sign}{t['profit']:.2f}  "
                f"({t['open_time']}→{t['close_time']})"
            )

        return {
            "date":         today_str,
            "total_trades": len(trades),
            "wins":         len(wins),
            "losses":       len(losses),
            "win_rate":     round(win_rate, 1),
            "total_pnl":    round(total_pnl, 2),
            "best_trade":   best_trade,
            "worst_trade":  worst_trade,
            "avg_rr":       avg_rr,
            "balance":      round(account.balance, 2) if account else 0.0,
            "equity":       round(account.equity,  2) if account else 0.0,
            "daily_losses": self.manager.daily_loss,
            "limit_hit":    not self.manager.trading_enabled,
            "trade_lines":  trade_lines,
        }
