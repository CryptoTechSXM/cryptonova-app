"""
bot_commands.py — Telegram Bot Command Interface

This module runs a SECOND Telegram client alongside the signal listener.
While the main client logs in as YOUR USER to read signal channels,
this client logs in as a BOT (using a bot token from BotFather).

You message your bot from Telegram and it controls the trading engine live.

Available commands:
  /status   — Is trading on or off? Daily loss count, open trades, time filter
  /pause    — Stop accepting new signals (open trades stay open)
  /resume   — Re-enable signal processing
  /stats    — Today's P&L, balance, equity, win/loss count
  /trades   — List every currently open position with live P&L
  /risk [n] — Temporarily change base risk % (e.g. /risk 0.3)
  /help     — Show all commands

SECURITY: Only messages from TELEGRAM_CONTROL_CHAT_ID are acted on.
All other senders get silently ignored. This prevents anyone else
from being able to control your bot.

SETUP:
  1. Message @BotFather in Telegram → /newbot → follow prompts → copy token
  2. Add to your .env:
       TELEGRAM_BOT_TOKEN=your_token_here
       TELEGRAM_CONTROL_CHAT_ID=your_telegram_user_id
       BOT_COMMANDS_ENABLED=true
  3. To find your user ID: message @userinfobot in Telegram
"""

from datetime import date

from telethon import TelegramClient, events
from telethon.sessions import StringSession

from config import settings
from logger import log
from time_filter import current_session_label


# =========================
# BOT COMMAND HANDLER
# =========================
class BotCommandHandler:

    def __init__(self, manager):
        self.manager = manager
        self.bot_client = None

        # Runtime risk override — None means "use config value"
        # /risk command sets this; it resets to None on bot restart
        self._risk_override = None

    # =========================
    async def start(self):
        """
        Create and start the bot client.
        Uses the bot token from .env — completely separate from the user client.
        """
        if not settings.bot_commands_enabled:
            log("[BOT CMD] Bot commands disabled in config", "INFO")
            return

        if not settings.telegram_bot_token:
            log("[BOT CMD] No TELEGRAM_BOT_TOKEN set — bot commands unavailable", "INFO")
            return

        if not settings.control_chat_id:
            log("[BOT CMD] No TELEGRAM_CONTROL_CHAT_ID set — bot commands unavailable", "INFO")
            return

        # The bot client uses a simple string session named after the token
        # so it doesn't clash with the main user session file.
        self.bot_client = TelegramClient(
            "bot_commands_session",
            settings.telegram_api_id,
            settings.telegram_api_hash,
        )

        await self.bot_client.start(bot_token=settings.telegram_bot_token)

        log("[BOT CMD] Bot command client started", "INFO")
        log(f"[BOT CMD] Accepting commands from chat ID: {settings.control_chat_id}", "INFO")

        # Register all command handlers
        self._register_handlers()

        # Send a startup notification so you know the bot is live
        await self._send(
            "🤖 CryptoNite Bot is ONLINE\n\n"
            "Send /help to see available commands."
        )

    # =========================
    def _register_handlers(self):
        """Attach event handlers for each command."""

        @self.bot_client.on(events.NewMessage(pattern=r"^/help"))
        async def cmd_help(event):
            if not self._is_authorised(event):
                return
            await self._send(self._help_text())

        @self.bot_client.on(events.NewMessage(pattern=r"^/status"))
        async def cmd_status(event):
            if not self._is_authorised(event):
                return
            await self._send(self._build_status())

        @self.bot_client.on(events.NewMessage(pattern=r"^/pause"))
        async def cmd_pause(event):
            if not self._is_authorised(event):
                return
            self.manager.pause_trading()
            await self._send(
                "⏸ Trading PAUSED\n\n"
                "No new signals will be executed.\n"
                "Open trades are unaffected.\n\n"
                "Send /resume to re-enable."
            )

        @self.bot_client.on(events.NewMessage(pattern=r"^/resume"))
        async def cmd_resume(event):
            if not self._is_authorised(event):
                return
            self.manager.resume_trading()
            await self._send(
                "▶️ Trading RESUMED\n\n"
                "Bot is now accepting signals again."
            )

        @self.bot_client.on(events.NewMessage(pattern=r"^/stats"))
        async def cmd_stats(event):
            if not self._is_authorised(event):
                return
            await self._send(self._build_stats())

        @self.bot_client.on(events.NewMessage(pattern=r"^/trades"))
        async def cmd_trades(event):
            if not self._is_authorised(event):
                return
            await self._send(self._build_trades())

        @self.bot_client.on(events.NewMessage(pattern=r"^/risk"))
        async def cmd_risk(event):
            if not self._is_authorised(event):
                return
            await self._handle_risk(event.raw_text)

        @self.bot_client.on(events.NewMessage(pattern=r"^/daily"))
        async def cmd_daily(event):
            if not self._is_authorised(event):
                return
            await self._send(self._build_daily())

        @self.bot_client.on(events.NewMessage(pattern=r"^/weekly"))
        async def cmd_weekly(event):
            if not self._is_authorised(event):
                return
            await self._send(self._build_weekly())

        @self.bot_client.on(events.NewMessage(pattern=r"^/monthly"))
        async def cmd_monthly(event):
            if not self._is_authorised(event):
                return
            await self._send(self._build_monthly())

    # =========================
    # SECURITY CHECK
    # Only process commands from the configured control chat.
    # =========================
    def _is_authorised(self, event) -> bool:
        # Accept from the control group chat OR from a DM by the same ID.
        chat_id   = str(event.chat_id)
        sender_id = str(getattr(event, "sender_id", ""))
        control   = str(settings.control_chat_id)

        authorised = (chat_id == control) or (sender_id == control)

        if not authorised:
            log(
                f"[BOT CMD] Ignored command from unauthorised source: "
                f"chat={chat_id} sender={sender_id}",
                "DEBUG"
            )

        return authorised

    # =========================
    # COMMAND BUILDERS
    # Each returns a formatted string for the Telegram message.
    # =========================

    def _help_text(self) -> str:
        return (
            "📋 CryptoNite Bot Commands\n\n"
            "/status  — Bot state, W/L/BE results, open trades\n"
            "/pause   — Stop accepting new signals\n"
            "/resume  — Re-enable signal processing\n"
            "/daily   — Today's full P&L and W/L/BE breakdown\n"
            "/weekly  — Last 7 days W/L/BE and P&L from MT5 history\n"
            "/monthly — Month-to-date P&L and W/L/BE from MT5 history\n"
            "/stats   — Today's P&L, W/L/BE, balance, equity\n"
            "/trades  — All open positions with live P&L\n"
            "/risk N  — Set base risk % (e.g. /risk 0.3)\n"
            "           Use /risk reset to restore config value\n"
            "/help    — Show this message"
        )

    def _build_daily(self) -> str:
        """Today's W/L/BE/P&L — mirrors /stats with a daily label."""
        try:
            stats = self.manager.get_stats()
            pnl_emoji = "📈" if stats["today_pnl"] >= 0 else "📉"
            pnl_sign  = "+" if stats["today_pnl"] >= 0 else ""
            if stats["win_streak"] >= 2:
                streak = "🔥 W{}".format(stats["win_streak"])
            elif stats["loss_streak"] >= 2:
                streak = "❄️ L{}".format(stats["loss_streak"])
            else:
                streak = "—"
            closed_label = "{} closed".format(stats["daily_total"]) if stats["daily_total"] else "no trades yet"
            today_str = date.today().isoformat()
            return (
                f"📊 Daily Summary — {today_str}\n\n"
                f"Results:  ✅ {stats['daily_wins']} W  |  ❌ {stats['daily_losses']} L  |  ➡️ {stats['daily_be']} BE  ({closed_label})\n"
                f"Win rate: {stats['daily_win_rate']}%  |  Streak: {streak}\n"
                f"Loss cap: {stats['daily_losses']}/{stats['daily_loss_limit']}\n\n"
                f"P&L:     {pnl_emoji} {pnl_sign}{stats['today_pnl']:.2f}\n"
                f"Balance: ${stats['balance']:,.2f}\n"
                f"Equity:  ${stats['equity']:,.2f}\n"
                f"Open:    {stats['open_trades']} position(s)"
            )
        except Exception as e:
            return f"❌ Daily error: {e}"

    def _build_weekly(self) -> str:
        """Last 7 calendar days computed from MT5 deal history."""
        try:
            import MetaTrader5 as mt5
            from datetime import datetime, date, timezone, timedelta
            today = date.today()
            start_dt = datetime.combine(today - timedelta(days=6), datetime.min.time()).replace(tzinfo=timezone.utc)
            end_dt   = datetime.now(timezone.utc)
            deals = mt5.history_deals_get(start_dt, end_dt) or []
            wins = losses = be = 0
            total_pnl = 0.0
            for d in deals:
                if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
                    continue
                if d.entry != mt5.DEAL_ENTRY_OUT:
                    continue
                pnl = d.profit
                total_pnl += pnl
                if pnl > 0.5:
                    wins += 1
                elif pnl < -0.5:
                    losses += 1
                else:
                    be += 1
            total = wins + losses + be
            wr = round(wins / total * 100) if total > 0 else 0
            pnl_emoji = "📈" if total_pnl >= 0 else "📉"
            pnl_sign  = "+" if total_pnl >= 0 else ""
            acc = mt5.account_info()
            balance = acc.balance if acc else 0.0
            equity  = acc.equity  if acc else 0.0
            date_range = f"{(today - timedelta(days=6)).isoformat()} → {today.isoformat()}"
            closed_label = f"{total} closed" if total else "no trades"
            return (
                f"📅 Weekly Summary\n"
                f"{date_range}\n\n"
                f"Results:  ✅ {wins} W  |  ❌ {losses} L  |  ➡️ {be} BE  ({closed_label})\n"
                f"Win rate: {wr}%\n\n"
                f"P&L:     {pnl_emoji} {pnl_sign}{total_pnl:.2f}\n"
                f"Balance: ${balance:,.2f}\n"
                f"Equity:  ${equity:,.2f}"
            )
        except Exception as e:
            return f"❌ Weekly error: {e}"

    def _build_monthly(self) -> str:
        """Month-to-date computed from MT5 deal history."""
        try:
            import MetaTrader5 as mt5
            from datetime import datetime, date, timezone
            today = date.today()
            month_start = datetime(today.year, today.month, 1, tzinfo=timezone.utc)
            end_dt = datetime.now(timezone.utc)
            deals = mt5.history_deals_get(month_start, end_dt) or []
            wins = losses = be = 0
            total_pnl = 0.0
            for d in deals:
                if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
                    continue
                if d.entry != mt5.DEAL_ENTRY_OUT:
                    continue
                pnl = d.profit
                total_pnl += pnl
                if pnl > 0.5:
                    wins += 1
                elif pnl < -0.5:
                    losses += 1
                else:
                    be += 1
            total = wins + losses + be
            wr = round(wins / total * 100) if total > 0 else 0
            pnl_emoji = "📈" if total_pnl >= 0 else "📉"
            pnl_sign  = "+" if total_pnl >= 0 else ""
            acc = mt5.account_info()
            balance = acc.balance if acc else 0.0
            equity  = acc.equity  if acc else 0.0
            month_label = today.strftime("%B %Y")
            closed_label = f"{total} closed" if total else "no trades"
            return (
                f"📆 Monthly Summary — {month_label}\n\n"
                f"Results:  ✅ {wins} W  |  ❌ {losses} L  |  ➡️ {be} BE  ({closed_label})\n"
                f"Win rate: {wr}%\n\n"
                f"P&L:     {pnl_emoji} {pnl_sign}{total_pnl:.2f}\n"
                f"Balance: ${balance:,.2f}\n"
                f"Equity:  ${equity:,.2f}"
            )
        except Exception as e:
            return f"❌ Monthly error: {e}"

    def _build_status(self) -> str:
        stats = self.manager.get_stats()

        trading_status = "✅ ACTIVE" if stats["trading_enabled"] else "⏸ PAUSED"

        session = current_session_label()
        tf_status = (
            f"{'✅' if settings.time_filter_enabled else '🔓'} "
            f"{session} "
            f"({'within' if settings.time_filter_enabled else 'filter off'} "
            f"{settings.time_filter_start_hour}:00–{settings.time_filter_end_hour}:00 UTC)"
        )

        risk_note = ""
        if self._risk_override is not None:
            risk_note = f"\nRisk override: {self._risk_override:.2f}% (config: {settings.base_risk_pct:.2f}%)"

        return (
            "📡 Bot Status\n\n"
            f"Trading:  {trading_status}\n"
            f"Results:  ✅ {stats['daily_wins']} W  |  ❌ {stats['daily_losses']} L  |  ➡️ {stats['daily_be']} BE\n"
            f"Loss cap: {stats['daily_losses']}/{stats['daily_loss_limit']}\n"
            f"Open:     {stats['open_trades']} position(s)\n\n"
            f"Session:  {tf_status}\n"
            f"Base risk: {settings.base_risk_pct:.2f}%"
            f"{risk_note}"
        )

    def _build_stats(self) -> str:
        stats = self.manager.get_stats()

        pnl_emoji = "📈" if stats["today_pnl"] >= 0 else "📉"
        pnl_sign  = "+" if stats["today_pnl"] >= 0 else ""

        if stats["win_streak"] >= 2:
            streak = "🔥 W{}".format(stats["win_streak"])
        elif stats["loss_streak"] >= 2:
            streak = "❄️ L{}".format(stats["loss_streak"])
        else:
            streak = "—"

        closed_label = "{} closed".format(stats["daily_total"]) if stats["daily_total"] else "no trades yet"

        return (
            "📊 Today's Stats\n\n"
            f"Results:  ✅ {stats['daily_wins']} W  |  ❌ {stats['daily_losses']} L  |  ➡️ {stats['daily_be']} BE  ({closed_label})\n"
            f"Win rate: {stats['daily_win_rate']}%  |  Streak: {streak}\n"
            f"Loss cap: {stats['daily_losses']}/{stats['daily_loss_limit']}\n\n"
            f"P&L:     {pnl_emoji} {pnl_sign}{stats['today_pnl']:.2f}\n"
            f"Balance: ${stats['balance']:,.2f}\n"
            f"Equity:  ${stats['equity']:,.2f}\n"
            f"Open:    {stats['open_trades']} position(s)"
        )

    def _build_trades(self) -> str:
        trades = self.manager.get_open_trades_summary()

        if not trades:
            return "📭 No open positions right now."

        lines = [f"📂 Open Positions ({len(trades)})\n"]

        for t in trades:
            pnl_sign  = "+" if t["pnl"] >= 0 else ""
            pnl_emoji = "🟢" if t["pnl"] >= 0 else "🔴"

            lines.append(
                f"{pnl_emoji} {t['symbol']} {t['side']}\n"
                f"   Entry: {t['entry']:.5f}  Now: {t['current']:.5f}\n"
                f"   SL: {t['sl']:.5f}  TP: {t['tp']:.5f}\n"
                f"   Lot: {t['lot']}  P&L: {pnl_sign}{t['pnl']:.2f}\n"
                f"   Ticket: #{t['ticket']}"
            )

        return "\n".join(lines)

    async def _handle_risk(self, raw_text: str):
        """
        /risk 0.3   → set risk to 0.3% for the rest of this session
        /risk reset → go back to config value
        """
        parts = raw_text.strip().split()

        if len(parts) < 2:
            await self._send(
                "Usage:\n"
                "  /risk 0.3     → set base risk to 0.3%\n"
                "  /risk reset   → restore config value"
            )
            return

        arg = parts[1].lower()

        if arg == "reset":
            self._risk_override = None
            settings.base_risk_pct = float(settings.base_risk_pct)  # re-read from config

            # Re-load from .env
            import os
            original = float(os.getenv("BASE_RISK_PERCENT", "0.5"))
            settings.base_risk_pct = original

            await self._send(
                f"✅ Risk reset to config value: {settings.base_risk_pct:.2f}%"
            )
            return

        try:
            new_risk = float(arg)
        except ValueError:
            await self._send(f"❌ Invalid value: {arg!r}. Use a number like 0.3")
            return

        # Safety guard — don't let commands set a dangerous risk level
        if new_risk <= 0 or new_risk > 3.0:
            await self._send(
                f"❌ Risk must be between 0.01% and 3.0%.\n"
                f"You entered: {new_risk}%"
            )
            return

        self._risk_override = new_risk
        settings.base_risk_pct = new_risk

        await self._send(
            f"✅ Base risk changed to {new_risk:.2f}%\n\n"
            f"This applies to all new trades until /risk reset or bot restart."
        )
        log(f"[BOT CMD] Risk changed to {new_risk:.2f}% via command", "INFO")

    # =========================
    # SEND HELPER
    # Centralises all message sending so we have one place to handle errors.
    # =========================
    async def _send(self, text: str):
        try:
            await self.bot_client.send_message(settings.control_chat_id, text)
        except Exception as e:
            log(f"[BOT CMD] Failed to send message: {e}", "ERROR")

    # =========================
    async def run(self):
        """Keep the bot client alive. Called in asyncio.gather() from main.py."""
        if self.bot_client:
            try:
                await self.bot_client.run_until_disconnected()
            except Exception as e:
                log(f"[BOT CMD] Client disconnected unexpectedly: {e}", "ERROR")

    async def stop(self):
        """Clean shutdown — notify the user the bot is going offline."""
        if self.bot_client:
            try:
                await self._send("🔴 CryptoNite Bot is going OFFLINE.")
            except Exception:
                pass
            await self.bot_client.disconnect()
