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
                "INFO"
            )

        return authorised

    # =========================
    # COMMAND BUILDERS
    # Each returns a formatted string for the Telegram message.
    # =========================

    def _help_text(self) -> str:
        return (
            "📋 CryptoNite Bot Commands\n\n"
            "/status  — Bot state, daily losses, open trades\n"
            "/pause   — Stop accepting new signals\n"
            "/resume  — Re-enable signal processing\n"
            "/stats   — Today's P&L, balance, equity\n"
            "/trades  — List all open positions with live P&L\n"
            "/risk N  — Set base risk % (e.g. /risk 0.3)\n"
            "           Use /risk reset to go back to config value\n"
            "/help    — Show this message"
        )

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
            f"Trading: {trading_status}\n"
            f"Daily losses: {stats['daily_losses']}/{stats['daily_loss_limit']}\n"
            f"Open trades: {stats['open_trades']}\n\n"
            f"Session: {tf_status}\n"
            f"Partial close: {'✅' if settings.partial_close_enabled else '❌'} "
            f"({settings.partial_close_percent:.0f}%)\n"
            f"Base risk: {settings.base_risk_pct:.2f}%"
            f"{risk_note}"
        )

    def _build_stats(self) -> str:
        stats = self.manager.get_stats()

        pnl_emoji = "📈" if stats["today_pnl"] >= 0 else "📉"
        pnl_sign  = "+" if stats["today_pnl"] >= 0 else ""

        return (
            "📊 Today's Stats\n\n"
            f"P&L: {pnl_emoji} {pnl_sign}{stats['today_pnl']:.2f}\n"
            f"Losses today: {stats['daily_losses']}/{stats['daily_loss_limit']}\n"
            f"Open trades: {stats['open_trades']}\n\n"
            f"Balance: ${stats['balance']:,.2f}\n"
            f"Equity:  ${stats['equity']:,.2f}"
        )

    def _build_trades(self) -> str:
        trades = self.manager.get_open_trades_summary()

        if not trades:
            return "📭 No open trades right now."

        lines = [f"📂 Open Trades ({len(trades)})\n"]

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
