import asyncio
import MetaTrader5 as mt5
from telethon import TelegramClient, events

from config import settings
from signal_parser import parse_signal_by_source
from executor import TradeExecutor
from manager import TradeManager
from bot_commands import BotCommandHandler
from daily_report import DailyReporter
from time_filter import allow_trade, current_session_label
from logger import log


# =========================
# INIT TELEGRAM CLIENT
# =========================
client = TelegramClient(
    settings.telegram_session_name,
    settings.telegram_api_id,
    settings.telegram_api_hash
)


# =========================
# MESSAGE HANDLER FACTORY
# =========================
def create_message_handler(executor):
    async def handle_message(event):
        try:
            chat_id = str(event.chat_id)
            text = event.raw_text

            log(f"[RAW MESSAGE] From: {chat_id}", "INFO")
            log(text, "INFO")

            # =========================
            # TIME FILTER CHECK
            # If we're outside the allowed trading window, ignore all signals.
            # This prevents trading the thin Asian session, news spikes, etc.
            # =========================
            if not allow_trade():
                session = current_session_label()
                log(f"[TIME FILTER] Signal blocked - outside trading hours ({session} UTC)", "INFO")
                return

            signal = parse_signal_by_source(chat_id, text)

            if not signal:
                log("Message ignored (not a valid signal)", "INFO")
                return

            log(f"Parsed signal: {signal}", "INFO")

            result = executor.execute_signal(signal)

            log(f"Execution result: {result}", "INFO")

        except Exception as e:
            log(f"Signal error: {e}", "ERROR")

    return handle_message


# =========================
# MANAGER LOOP
# Runs every 2 seconds in the background.
# Checks for closed trades, updates trailing stops, cancels stale orders.
# =========================
async def manager_loop(manager):
    while True:
        # 1. Check for newly closed positions and update win/loss streaks
        try:
            manager.check_trades()
        except Exception as e:
            log(f"check_trades error: {e}", "ERROR")

        # 2. Partial close - check if any open position has hit a TP level
        try:
            manager.check_partial_close()
        except Exception as e:
            log(f"partial_close error: {e}", "ERROR")

        # 3. Trailing stop - move SL behind winning trades
        try:
            manager.apply_trailing_stop()
        except Exception as e:
            log(f"trailing error: {e}", "ERROR")

        # 4. Cancel stale pending orders
        try:
            manager.cancel_expired_orders()
        except Exception as e:
            log(f"cancel error: {e}", "ERROR")

        await asyncio.sleep(2)


# =========================
# MAIN RUNNER
# =========================
async def run():
    log("=" * 50, "INFO")
    log("CryptoNite Bot starting...", "INFO")
    log("=" * 50, "INFO")

    # =========================
    # VALIDATE CONFIG FIRST
    # Catches missing .env values before we waste time connecting to MT5/Telegram.
    # =========================
    try:
        settings.validate()
        log("[CONFIG] All required settings present", "INFO")
    except EnvironmentError as e:
        log(str(e), "ERROR")
        log("Fix your .env file and restart.", "ERROR")
        return

    # =========================
    # INIT MT5
    # =========================
    if not mt5.initialize():
        log("MT5 initialization failed - is MetaTrader 5 running?", "ERROR")
        return

    log("MT5 initialized", "INFO")

    try:
        # =========================
        # START TELEGRAM
        # =========================
        await client.start()
        log("Telegram client started", "INFO")

        # =========================
        # INIT MANAGER + EXECUTOR
        # =========================
        manager = TradeManager()
        manager.initialize()

        executor = TradeExecutor(manager)

        from telegram_sender import TelegramSender

        tg_sender = TelegramSender(client)

        manager.tg = tg_sender
        executor.tg = tg_sender

        # =========================
        # START BOT COMMAND HANDLER
        # This is the second Telegram client - runs as a bot, not as your user.
        # It accepts /commands from your configured control chat ID.
        # If no bot token is set in .env, this step is safely skipped.
        # =========================
        bot_cmd = BotCommandHandler(manager)
        await bot_cmd.start()

        # =========================
        # INIT DAILY REPORTER
        # Fires once per day at DAILY_REPORT_HOUR (UTC) with a full P&L summary.
        # Safe to create even if daily reports are disabled - the run() method
        # exits immediately in that case.
        # =========================
        daily_reporter = DailyReporter(manager, tg_sender)

        # =========================
        # RESOLVE CHANNEL ENTITIES
        # =========================
        valid_entities = []

        for ch in settings.get_channel_ids():
            try:
                entity = await client.get_entity(int(ch))
                log(f"[TG] Bound to channel: {ch}", "INFO")
                valid_entities.append(entity)
            except Exception as e:
                log(f"[TG ERROR] Cannot bind {ch}: {e}", "ERROR")

        if not valid_entities:
            log("No valid channels found. Check CHANNEL_IDS in your .env. Exiting.", "ERROR")
            return

        log(f"Listening to {len(valid_entities)} channel(s)", "INFO")
        log(f"Time filter: {'ON' if settings.time_filter_enabled else 'OFF'} | "
            f"Window: {settings.time_filter_start_hour}:00 - {settings.time_filter_end_hour}:00 UTC", "INFO")
        log(f"Daily loss limit: {settings.max_daily_loss_trades} trades", "INFO")
        log(f"Daily report: {'ON' if settings.daily_report_enabled else 'OFF'} | "
            f"Fires at {settings.daily_report_hour:02d}:00 UTC", "INFO")
        log(f"Partial close: {'ON' if settings.partial_close_enabled else 'OFF'} | "
            f"{settings.partial_close_percent:.0f}% at each TP", "INFO")

        # =========================
        # LOG CHANNEL ROUTING TABLE
        # Print a clear summary of which channels map to which parser mode
        # and risk multiplier, so you can confirm settings at a glance.
        # =========================
        log("Channel routing:", "INFO")
        for ch_id in settings.get_channel_ids():
            mode = settings.get_parser_mode(str(ch_id))
            risk = settings.get_channel_risk(str(ch_id))
            risk_note = f"  (risk x{risk})" if risk != 1.0 else ""
            log(f"  {ch_id} -> mode: {mode}{risk_note}", "INFO")

        log("Bot is LIVE", "INFO")
        log("=" * 50, "INFO")

        # =========================
        # REGISTER HANDLER
        # =========================
        handler = create_message_handler(executor)

        client.add_event_handler(
            handler,
            events.NewMessage(chats=valid_entities)
        )

        # =========================
        # RUN BOT (all loops in parallel)
        # Four coroutines run at the same time:
        #   1. Signal client   - listens to signal channels, parses + executes trades
        #   2. Manager loop    - checks trades, partial close, trailing stop every 2s
        #   3. Bot commands    - listens for /commands from you via Telegram bot
        #   4. Daily reporter  - fires end-of-day summary at configured UTC hour
        # =========================
        await asyncio.gather(
            client.run_until_disconnected(),
            manager_loop(manager),
            bot_cmd.run(),
            daily_reporter.run(),
        )

    finally:
        # =========================
        # CLEAN SHUTDOWN
        # Notify via bot that we're going offline, then disconnect everything.
        # =========================
        try:
            await bot_cmd.stop()
        except Exception:
            pass

        mt5.shutdown()
        log("MT5 shutdown complete", "INFO")


# =========================
# ENTRY POINT
# =========================
if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log("Bot stopped manually", "INFO")
