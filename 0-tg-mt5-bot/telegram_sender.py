"""
telegram_sender.py - Outbound Telegram Notifications

Wraps all outgoing messages so the rest of the bot never has to
deal with Telegram API details directly.

Methods:
    send_execution(data)        - trade opened/pending confirmation
    send_report(data)           - general status / daily loss progress
    send_partial_close(data)    - partial close notification
    send_kill_switch_alert(n)   - daily loss limit hit warning
    send_daily_report(report)   - full end-of-day P&L summary
"""

from config import settings
from logger import log


class TelegramSender:
    def __init__(self, client):
        """
        client - the authenticated Telethon TelegramClient (user session).
        """
        self.client = client

    # =========================
    async def send_execution(self, data: dict):
        """
        Sent when a trade is opened or a pending order is placed.

        data keys: symbol, side, entry, sl, tp_levels, lot, order_type, source_channel
        """
        try:
            symbol    = data.get("symbol", "?")
            side      = data.get("side", "?").upper()
            entry     = data.get("entry", 0)
            sl        = data.get("sl", 0)
            tp_levels = data.get("tp_levels", [])
            lot       = data.get("lot", 0)
            order_type = data.get("order_type", "MARKET")

            emoji = "BUY" if side == "BUY" else "SELL"

            # Format TP list
            if tp_levels:
                tp_lines = "\n".join(
                    f"  TP{i+1}: {tp:.5f}" for i, tp in enumerate(tp_levels)
                )
            else:
                tp_lines = "  TP: N/A"

            msg = (
                f"TRADE OPENED\n"
                f"{emoji} {symbol} {side} ({order_type})\n"
                f"\n"
                f"  Entry : {entry:.5f}\n"
                f"  SL    : {sl:.5f}\n"
                f"{tp_lines}\n"
                f"  Lot   : {lot}\n"
                f"\n"
                f"Partial close enabled at each TP level."
            )

            if settings.execution_channel_id:
                await self.client.send_message(int(settings.execution_channel_id), msg)

        except Exception as e:
            log(f"[TG ERROR] Execution send failed: {e}", "ERROR")

    # =========================
    async def send_report(self, data: dict):
        """
        General status report - used for daily loss progress alerts.

        data keys: event, daily_loss, daily_loss_limit
        """
        try:
            event      = data.get("event", "REPORT")
            daily_loss = data.get("daily_loss", 0)
            limit      = data.get("daily_loss_limit", 0)

            msg = (
                f"STATUS UPDATE\n"
                f"Event: {event}\n"
                f"Daily losses: {daily_loss}/{limit}"
            )

            if settings.report_channel_id:
                await self.client.send_message(int(settings.report_channel_id), msg)

        except Exception as e:
            log(f"[TG ERROR] Report send failed: {e}", "ERROR")

    # =========================
    async def send_partial_close(self, data: dict):
        """
        Sent when a partial close fires at a TP level.

        data keys: symbol, side, tp_hit, closed_lot, remaining_lot, new_sl, next_tp
        """
        try:
            symbol        = data.get("symbol", "?")
            side          = data.get("side", "?").upper()
            tp_hit        = data.get("tp_hit", 0)
            closed_lot    = data.get("closed_lot", 0)
            remaining_lot = data.get("remaining_lot", 0)
            new_sl        = data.get("new_sl", 0)
            next_tp       = data.get("next_tp")

            next_tp_line = f"  Next TP : {next_tp:.5f}" if next_tp else "  Next TP : Final target hit"

            msg = (
                f"PARTIAL CLOSE\n"
                f"{symbol} {side}\n"
                f"\n"
                f"  TP Hit    : {tp_hit:.5f}\n"
                f"  Closed    : {closed_lot} lots\n"
                f"  Remaining : {remaining_lot} lots\n"
                f"  SL -> BE  : {new_sl:.5f}\n"
                f"{next_tp_line}"
            )

            if settings.execution_channel_id:
                await self.client.send_message(int(settings.execution_channel_id), msg)

        except Exception as e:
            log(f"[TG ERROR] Partial close send failed: {e}", "ERROR")

    # =========================
    async def send_kill_switch_alert(self, loss_count: int):
        """
        Sent when the daily loss limit is hit.
        Trading is paused for the rest of the day.
        """
        try:
            limit = settings.max_daily_loss_trades

            msg = (
                f"KILL SWITCH TRIGGERED\n"
                f"\n"
                f"Daily loss limit reached: {loss_count}/{limit} losing trades.\n"
                f"Bot is PAUSED for the rest of today.\n"
                f"\n"
                f"Trading resumes automatically at midnight UTC.\n"
                f"Use /resume to override manually."
            )

            target = settings.report_channel_id or settings.execution_channel_id
            if target:
                await self.client.send_message(int(target), msg)

        except Exception as e:
            log(f"[TG ERROR] Kill switch alert failed: {e}", "ERROR")

    # =========================
    async def send_daily_report(self, report: dict):
        """
        Full end-of-day P&L summary.

        report keys: date, total_trades, wins, losses, win_rate,
                     total_pnl, best_trade, worst_trade, avg_rr,
                     trade_lines, balance, equity
        """
        try:
            date         = report.get("date", "")
            total_trades = report.get("total_trades", 0)
            wins         = report.get("wins", 0)
            losses       = report.get("losses", 0)
            win_rate     = report.get("win_rate", 0.0)
            total_pnl    = report.get("total_pnl", 0.0)
            best_trade   = report.get("best_trade")
            worst_trade  = report.get("worst_trade")
            avg_rr       = report.get("avg_rr", "")
            trade_lines  = report.get("trade_lines", [])
            balance      = report.get("balance", 0.0)
            equity       = report.get("equity", 0.0)

            pnl_sign = "+" if total_pnl >= 0 else ""
            header   = f"DAILY REPORT - {date}"

            lines = [
                header,
                "=" * len(header),
                "",
                f"Trades : {total_trades}  ({wins}W / {losses}L)",
                f"Win %  : {win_rate:.0f}%",
                f"P&L    : {pnl_sign}{total_pnl:.2f}",
            ]

            if avg_rr:
                lines.append(f"Avg R  : {avg_rr}")

            if best_trade:
                lines.append(f"Best   : {best_trade}")

            if worst_trade:
                lines.append(f"Worst  : {worst_trade}")

            if trade_lines:
                lines.append("")
                lines.append("--- Trades ---")
                lines.extend(trade_lines)

            lines += [
                "",
                "--- Account ---",
                f"Balance : {balance:.2f}",
                f"Equity  : {equity:.2f}",
            ]

            msg = "\n".join(lines)

            target = settings.report_channel_id or settings.execution_channel_id
            if target:
                await self.client.send_message(int(target), msg)

        except Exception as e:
            log(f"[TG ERROR] Daily report send failed: {e}", "ERROR")
