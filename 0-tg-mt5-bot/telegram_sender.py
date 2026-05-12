"""
telegram_sender.py - Outbound Telegram Notifications

Wraps all outgoing messages so the rest of the bot never has to
deal with Telegram API details directly.

Methods:
    send_execution(data)        - trade opened/pending confirmation
    send_close_trade(data)      - trade closed with result/profit/source
    send_report(data)           - general status / daily loss progress
    send_partial_close(data)    - partial close notification
    send_kill_switch_alert(n)   - daily loss limit hit warning
    send_daily_report(report)   - full end-of-day P&L summary
"""

from config import settings
from logger import log

# Friendly names for known channels — shown in open/close alerts
CHANNEL_NAMES = {
    "-1003523601209": "CryptoNite Free Signals",
    "-1003700973551": "CryptoNite MT5 Premium",
    "-1002717527369": "Free Tag Signals",
    "-1003271148230": "Limitless Discussion",
    "-1003882026187": "Limitless Abundance 2.0",
    "-1003889406756": "Limitless VIP",
    "-1003731092037": "Limitless Free",
}


def _channel_label(source_channel: str) -> str:
    if not source_channel:
        return "Unknown"
    return CHANNEL_NAMES.get(str(source_channel), str(source_channel))


def _clean(symbol: str) -> str:
    """Strip broker suffix — XAUUSD.pro -> XAUUSD."""
    return symbol.split(".")[0] if "." in symbol else symbol


def _fmt(v: float) -> str:
    """Smart decimals: forex (<=10) gets 5dp, everything else 2dp."""
    return f"{v:.5f}" if v <= 10 else f"{v:.2f}"


def _now_utc() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


class TelegramSender:
    def __init__(self, client):
        self.client = client

    # ─────────────────────────────────────────────────────────────────
    async def send_execution(self, data: dict):
        try:
            symbol    = _clean(data.get("symbol", "?"))
            side      = data.get("side", "?").upper()
            entry     = data.get("entry", 0)
            sl        = data.get("sl", 0)
            tp_levels = data.get("tp_levels", [])
            lot       = data.get("lot", 0)
            order_type = data.get("order_type", "MARKET")
            src       = _channel_label(data.get("source_channel", ""))
            dir_icon  = "📈" if side == "BUY" else "📉"

            tp_lines = "\n".join(
                f"🎯 TP{i+1}:    {_fmt(tp)}"
                for i, tp in enumerate(tp_levels)
            ) if tp_levels else "🎯 TP:     N/A"

            msg = (
                f"🚨 <b>Trade Opened</b>\n"
                f"📡 {src}\n"
                f"\n"
                f"{dir_icon} <b>{symbol} | {side}</b> ({order_type})\n"
                f"⏰ {_now_utc()}\n"
                f"\n"
                f"📍 Entry:  {_fmt(entry)}\n"
                f"🛑 SL:     {_fmt(sl)}\n"
                f"{tp_lines}\n"
                f"📦 Lot:    {lot}"
            )

            if settings.execution_channel_id:
                await self.client.send_message(
                    int(settings.execution_channel_id), msg, parse_mode="html"
                )
        except Exception as e:
            log(f"[TG ERROR] Execution send failed: {e}", "ERROR")

    # ─────────────────────────────────────────────────────────────────
    async def send_close_trade(self, data: dict):
        try:
            symbol      = _clean(data.get("symbol", "?"))
            side        = data.get("side", "?").upper()
            entry       = data.get("entry", 0)
            exit_price  = data.get("exit", 0)
            profit      = data.get("profit", 0.0)
            result      = data.get("result", "CLOSED")
            rr          = data.get("rr", "")
            exit_type   = data.get("exit_type", "")
            be_buffer   = data.get("be_buffer", 0)
            src         = _channel_label(data.get("source_channel", ""))
            daily_loss  = data.get("daily_loss", 0)
            daily_limit = data.get("daily_loss_limit", 0)

            icon     = "✅" if result == "WIN" else ("❌" if result == "LOSS" else "➡️")
            dir_icon = "📈" if side == "BUY" else "📉"
            pnl_sign = "+" if profit >= 0 else ""
            rr_line  = f"📊 Result: <b>{rr}</b>\n" if rr else ""
            exit_line = f"🔖 Exit type: {exit_type}\n" if exit_type else ""
            be_line   = f"🛡️ BE buffer: {be_buffer:.1f} pts\n" if be_buffer and result in ("WIN", "BE") else ""

            msg = (
                f"{icon} <b>Trade Closed — {result}</b>\n"
                f"📡 {src}\n"
                f"\n"
                f"{dir_icon} <b>{symbol} | {side}</b>\n"
                f"⏰ {_now_utc()}\n"
                f"\n"
                f"📍 Entry: {_fmt(entry)}\n"
                f"🏁 Exit:  {_fmt(exit_price)}\n"
                f"{rr_line}"
                f"{exit_line}"
                f"{be_line}"
                f"💰 P/L:   <b>{pnl_sign}{profit:.2f}</b>\n"
                f"\n"
                f"📉 Losses today: {daily_loss}/{daily_limit}"
            )

            target = settings.execution_channel_id or settings.report_channel_id
            if target:
                await self.client.send_message(int(target), msg, parse_mode="html")
        except Exception as e:
            log(f"[TG ERROR] Close trade send failed: {e}", "ERROR")

    # ─────────────────────────────────────────────────────────────────
    async def send_partial_close(self, data: dict):
        try:
            symbol        = _clean(data.get("symbol", "?"))
            side          = data.get("side", "?").upper()
            tp_hit        = data.get("tp_hit", 0)
            closed_lot    = data.get("closed_lot", 0)
            remaining_lot = data.get("remaining_lot", 0)
            new_sl        = data.get("new_sl", 0)
            next_tp       = data.get("next_tp")
            src           = _channel_label(data.get("source_channel", ""))
            dir_icon      = "📈" if side == "BUY" else "📉"
            next_tp_line  = f"🎯 Next TP:   {_fmt(next_tp)}" if next_tp else "🎯 Next TP:   Final target hit"

            msg = (
                f"🔀 <b>Partial Close</b>\n"
                f"📡 {src}\n"
                f"\n"
                f"{dir_icon} <b>{symbol} | {side}</b>\n"
                f"⏰ {_now_utc()}\n"
                f"\n"
                f"🎯 TP hit:     {_fmt(tp_hit)}\n"
                f"📦 Closed:     {closed_lot} lots\n"
                f"📦 Remaining:  {remaining_lot} lots\n"
                f"🛑 SL → BE:   {_fmt(new_sl)}\n"
                f"{next_tp_line}"
            )

            if settings.execution_channel_id:
                await self.client.send_message(
                    int(settings.execution_channel_id), msg, parse_mode="html"
                )
        except Exception as e:
            log(f"[TG ERROR] Partial close send failed: {e}", "ERROR")

    # ─────────────────────────────────────────────────────────────────
    async def send_report(self, data: dict):
        try:
            event      = data.get("event", "REPORT")
            daily_loss = data.get("daily_loss", 0)
            limit      = data.get("daily_loss_limit", 0)

            msg = (
                f"📋 <b>Status Update</b>\n"
                f"\n"
                f"Event: {event}\n"
                f"Daily losses: {daily_loss}/{limit}"
            )

            if settings.report_channel_id:
                await self.client.send_message(
                    int(settings.report_channel_id), msg, parse_mode="html"
                )
        except Exception as e:
            log(f"[TG ERROR] Report send failed: {e}", "ERROR")

    # ─────────────────────────────────────────────────────────────────
    async def send_kill_switch_alert(self, loss_count: int):
        try:
            limit = settings.max_daily_loss_trades

            msg = (
                f"⛔ <b>Kill Switch Triggered</b>\n"
                f"\n"
                f"Daily loss limit reached: <b>{loss_count}/{limit}</b> losing trades.\n"
                f"Bot is <b>PAUSED</b> for the rest of today.\n"
                f"\n"
                f"Trading resumes automatically at midnight UTC.\n"
                f"Use /resume to override manually."
            )

            target = settings.report_channel_id or settings.execution_channel_id
            if target:
                await self.client.send_message(int(target), msg, parse_mode="html")
        except Exception as e:
            log(f"[TG ERROR] Kill switch alert failed: {e}", "ERROR")

    # ─────────────────────────────────────────────────────────────────
    async def send_daily_report(self, report: dict):
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
            pnl_icon = "✅" if total_pnl >= 0 else "❌"

            lines = [
                f"📊 <b>Daily Report — {date}</b>",
                f"",
                f"Trades:   <b>{total_trades}</b>  ({wins}W / {losses}L)",
                f"Win rate: <b>{win_rate:.0f}%</b>",
                f"P&L:      <b>{pnl_sign}{total_pnl:.2f}</b> {pnl_icon}",
            ]
            if avg_rr:
                lines.append(f"Avg R:    <b>{avg_rr}</b>")
            if best_trade:
                lines.append(f"Best:     {best_trade}")
            if worst_trade:
                lines.append(f"Worst:    {worst_trade}")
            if trade_lines:
                lines.append("")
                lines.append("<b>— Trades —</b>")
                lines.extend(trade_lines)
            lines += [
                "",
                "<b>— Account —</b>",
                f"Balance:  {balance:.2f}",
                f"Equity:   {equity:.2f}",
            ]

            msg = "\n".join(lines)
            target = settings.report_channel_id or settings.execution_channel_id
            if target:
                await self.client.send_message(int(target), msg, parse_mode="html")
        except Exception as e:
            log(f"[TG ERROR] Daily report send failed: {e}", "ERROR")


    async def send_alert(self, message: str):
        """Generic alert — used by drawdown, profit target, session brief, stale order."""
        try:
            target = settings.report_channel_id or settings.execution_channel_id
            if target:
                await self.client.send_message(int(target), message, parse_mode="html")
        except Exception as e:
            log(f"[TG ERROR] Alert send failed: {e}", "ERROR")

# ── Standalone send_status ─────────────────────────────────────────────────────
# Used by main.py on ONLINE / STOPPED events.
# Runs synchronously via requests so it works even before/after the async loop.
def send_status(strategy: str, event: str, detail: str = "") -> None:
    """Fire a one-shot status message via the Bot Token (no Telethon client needed)."""
    import os, requests
    token   = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("EXECUTION_CHANNEL_ID", "") or (
              settings.execution_channel_id if hasattr(settings, "execution_channel_id") else "")
    if not token or not chat_id:
        log("[send_status] BOT_TOKEN or EXECUTION_CHANNEL_ID not set — skipping", "WARNING")
        return
    icon        = "\U0001f7e2" if event == "ONLINE" else "\U0001f534"
    detail_line = f"\n\u26a0\ufe0f {detail}" if detail else ""
    msg = (
        f"{icon} <b>Bot {event}</b>\n"
        f"\U0001f4e1 {strategy}\n"
        f"\u23f0 {_now_utc()}"
        f"{detail_line}"
    )
    try:
        requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": msg, "parse_mode": "HTML"},
            timeout=10,
        )
    except Exception as e:
        log(f"[send_status] Failed: {e}", "WARNING")
