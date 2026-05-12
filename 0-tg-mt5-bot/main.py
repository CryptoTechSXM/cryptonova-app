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
from telegram_sender import send_status


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
    _mt5_was_down = False

    while True:
        # MT5 health check — detect broker disconnect and reinitialise
        try:
            if not mt5.terminal_info():
                if not _mt5_was_down:
                    log("[MT5] Connection lost — attempting reinitialise...", "WARNING")
                    _mt5_was_down = True
                mt5.shutdown()
                try:
                    await asyncio.sleep(5)
                except asyncio.CancelledError:
                    raise  # don't swallow shutdown signal during reconnect wait
                if mt5.initialize():
                    log("[MT5] Reconnected successfully", "INFO")
                    _mt5_was_down = False
                else:
                    log("[MT5] Reinitialise failed — will retry in 10s", "WARNING")
                    try:
                        await asyncio.sleep(10)
                    except asyncio.CancelledError:
                        raise  # don't swallow shutdown signal during reconnect wait
                continue
            elif _mt5_was_down:
                log("[MT5] Connection restored", "INFO")
                _mt5_was_down = False
        except asyncio.CancelledError:
            raise  # always propagate cancellation out of the health check block
        except Exception as e:
            log(f"mt5 health check error: {e}", "ERROR")

        # 0. Live adoption scan — picks up manual trades opened while the bot
        #    is running. Runs before everything else so newly adopted positions
        #    are tracked before check_trades, partial close, and trail fire.
        try:
            manager.adopt_open_positions()
        except Exception as e:
            log(f"adopt error: {e}", "ERROR")

        # 1. Check for newly closed positions and update win/loss streaks
        try:
            manager.check_trades()
        except Exception as e:
            log(f"check_trades error: {e}", "ERROR")

        # 1b. Drain outbound notification queue (close alerts, kill-switch, etc.)
        # Using a queue instead of asyncio.create_task() in sync code ensures
        # notifications always fire — even on Python 3.12+ where create_task
        # from sync context can silently fail if the loop yields before the task runs.
        if manager._tg_queue and manager.tg:
            for _kind, _data in list(manager._tg_queue):
                try:
                    if _kind == 'close_trade':
                        await manager.tg.send_close_trade(_data)
                    elif _kind == 'kill_switch':
                        await manager.tg.send_kill_switch_alert(_data)
                    elif _kind == 'alert':
                        await manager.tg.send_alert(_data)
                    elif _kind == 'partial_close':
                        await manager.tg.send_partial_close(_data)
                except Exception as _e:
                    log(f"tg_queue drain error ({_kind}): {_e}", "ERROR")
            manager._tg_queue.clear()

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

        # 5. Session close guard — close unprotected profitable positions at END_HOUR
        try:
            manager.session_close_guard()
        except Exception as e:
            log(f"session_close error: {e}", "ERROR")

        # 6. Session open snapshot — fires once at session start
        try:
            manager.session_open_brief()
        except Exception as e:
            log(f"session_brief error: {e}", "ERROR")

        # 7. Drawdown alert
        try:
            manager.check_drawdown_alert()
        except Exception as e:
            log(f"drawdown_alert error: {e}", "ERROR")

        # 8. Daily profit target alert
        try:
            manager.check_profit_target()
        except Exception as e:
            log(f"profit_target error: {e}", "ERROR")

        # 9. Pre-news cleanup — close unprotected positions ahead of events
        try:
            if getattr(settings, 'news_filter_enabled', False):
                from news_filter import get_positions_to_close_before_news
                all_pos = mt5.positions_get() or []
                managed = {
                    t: d for t, d in manager.active_trades.items()
                    if mt5.positions_get(ticket=t)
                }
                to_close = get_positions_to_close_before_news(
                    settings, all_pos, manager.active_trades
                )
                for pos in to_close:
                    tick = mt5.symbol_info_tick(pos.symbol)
                    if not tick:
                        continue
                    close_price = tick.bid if pos.type == 0 else tick.ask
                    req = {
                        'action':       mt5.TRADE_ACTION_DEAL,
                        'symbol':       pos.symbol,
                        'volume':       pos.volume,
                        'type':         mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY,
                        'position':     pos.ticket,
                        'price':        close_price,
                        'deviation':    30,
                        'magic':        settings.mt5_magic_number,
                        'comment':      'news pre-close',
                        'type_time':    mt5.ORDER_TIME_GTC,
                        'type_filling': mt5.ORDER_FILLING_IOC,
                    }
                    res = mt5.order_send(req)
                    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
                        log(f"[NEWS] Pre-closed ticket={pos.ticket} {pos.symbol} "
                            f"pnl={pos.profit:+.2f} @ {close_price}", "WARNING")
                        if manager.tg:
                            await manager.tg.send_alert(
                                f"⚠️ <b>Pre-News Close</b>\n"
                                f"Closed {pos.symbol} ticket={pos.ticket} "
                                f"(unprotected, news imminent)\n"
                                f"P/L: <b>{pos.profit:+.2f}</b>"
                            )
                    else:
                        code = res.retcode if res else "no response"
                        log(f"[NEWS] Pre-close FAILED ticket={pos.ticket} code={code}", "ERROR")
        except Exception as e:
            log(f"news_pre_close error: {e}", "ERROR")

        try:
            import time as _t
            open('heartbeat.txt', 'w').write(str(_t.time()))
        except Exception:
            pass

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
        send_status("CryptoNite Signal Bot", "ONLINE")

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

        # Diagnostic wrapper — logs which task exits and why so we can identify
        # the root cause if the bot exits unexpectedly.
        async def _guarded(coro, name):
            try:
                await coro
                log(f"[GATHER] '{name}' returned (exited cleanly) — this causes bot restart", "WARNING")
            except asyncio.CancelledError:
                log(f"[GATHER] '{name}' cancelled (normal shutdown)", "INFO")
                raise
            except Exception as e:
                log(f"[GATHER] '{name}' raised exception: {e}", "ERROR")
                raise

        try:
            await asyncio.gather(
                _guarded(client.run_until_disconnected(), "TG signal client"),
                _guarded(manager_loop(manager),           "Manager loop"),
                _guarded(bot_cmd.run(),                   "Bot commands"),
                _guarded(daily_reporter.run(),            "Daily reporter"),
            )
        except asyncio.CancelledError:
            pass  # normal Ctrl+C shutdown — suppress traceback

    finally:
        # =========================
        # CLEAN SHUTDOWN
        # Notify via bot that we're going offline, then disconnect everything.
        # =========================
        try:
            await bot_cmd.stop()
        except Exception:
            pass

        try:
            await client.disconnect()
        except Exception:
            pass

        # Cancel any lingering tasks created during this run (e.g. stray
        # asyncio.create_task calls) so they don't accumulate across restarts
        # on the same event loop inside main_with_restart().
        _current = asyncio.current_task()
        _pending = [t for t in asyncio.all_tasks() if t is not _current and not t.done()]
        if _pending:
            log(f"[SHUTDOWN] Cancelling {len(_pending)} lingering task(s)...", "INFO")
            for _t in _pending:
                _t.cancel()
            await asyncio.gather(*_pending, return_exceptions=True)

        send_status("CryptoNite Signal Bot", "STOPPED")
        mt5.shutdown()
        log("MT5 shutdown complete.", "INFO")


async def main_with_restart():
    """Outer restart loop — if the bot crashes or the broker drops Telegram,
    wait 30 seconds and restart automatically instead of staying dead."""
    restart_count = 0
    while True:
        try:
            await run()
            log("[RESTART] Bot exited cleanly. Restarting in 30s...", "WARNING")
        except asyncio.CancelledError:
            # Ctrl+C or external shutdown — exit the restart loop cleanly.
            log("[RESTART] Shutdown signal received — stopping.", "INFO")
            return
        except Exception as e:
            log(f"[RESTART] Bot crashed: {e}. Restarting in 30s...", "ERROR")
        restart_count += 1
        log(f"[RESTART] Attempt #{restart_count} in 30 seconds...", "INFO")
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            log("[RESTART] Shutdown during restart wait — stopping.", "INFO")
            return


if __name__ == "__main__":
    # Telethon requires SelectorEventLoop on Windows — ProactorEventLoop (the default
    # in Python 3.8+ on Windows) causes random connection drops and task cancellations.
    import sys
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(main_with_restart())
    except KeyboardInterrupt:
        pass  # suppress the traceback — shutdown message already logged above
