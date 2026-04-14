# =============================================================
# EXECUTOR — Trade Execution
# =============================================================
# This file takes a signal ("BUY" or "SELL") and places the
# actual order on MetaTrader 5.
#
# Before placing any order it runs through a checklist:
#   1. Has the bot fully started up? (startup delay)
#   2. Was the last trade too recent? (cooldown)
#   3. Is there already an open position? (no doubling up)
#   4. Is the spread acceptable? (no trading in bad conditions)
#   5. Is the ATR available? (need it to calculate SL)
#   6. Is ATR above the minimum? (no trading in dead market)
#
# Only if ALL checks pass does it place the trade.
# =============================================================

import MetaTrader5 as mt5
import time

from bot.logger import log, log_trade
from bot.lot import calculate_lot_size
from bot.executor import get_atr, has_open_position
from config import BOT_SETTINGS
from telegram_sender import send_signal as _tg_send_signal

STRATEGY_NAME = "Gold HA Bot"

def send_telegram_message(symbol, direction, entry, sl, tp):
    from telegram_sender import _post, SIGNAL_CHAT
    from datetime import datetime
    icon = "🟢" if direction == "BUY" else "🔴"
    tp_str = f"{round(tp, 2)}" if tp and tp != 0.0 else "Trailing (ATR)"
    msg = (
        f"🚨 <b>CryptoNite Signal</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"📌 Strategy: {STRATEGY_NAME}\n"
        f"📈 Asset: {symbol}\n"
        f"{icon} Direction: <b>{direction}</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"💰 Entry: {round(entry, 2)}\n"
        f"🛑 SL:    {round(sl, 2)}\n"
        f"🎯 TP:    {tp_str}\n"
        f"⚖️  R:R:   1:1.5\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"🕐 {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC"
    )
    _post(msg, SIGNAL_CHAT)
from datetime import datetime


# Global state — persists for the life of the bot process
last_trade_time   = {}
bot_start_time    = None
startup_finished  = False
daily_trade_count = {}   # symbol -> int  (resets at midnight UTC)
daily_trade_date  = {}   # symbol -> date (tracks which day count belongs to)


def execute_trade(symbol, signal, cfg):

    global bot_start_time, startup_finished

    now = time.time()

    # -------------------------------------------------------
    # 1. STARTUP DELAY
    # Gives MT5 time to fully load data after launch.
    # -------------------------------------------------------
    if bot_start_time is None:
        bot_start_time = now

    since_start = now - bot_start_time
    startup_delay = BOT_SETTINGS.get("startup_delay_seconds", 60)

    if since_start < startup_delay:
        remaining = int(startup_delay - since_start)
        log(f"{symbol}: startup delay — {remaining}s remaining ⏳")
        return "STARTUP"

    if not startup_finished:
        log(f"{symbol}: startup complete ✅ — trading enabled")
        startup_finished = True

    # -------------------------------------------------------
    # 2. TRADE COOLDOWN
    # Prevents re-entering too quickly after the last trade.
    # -------------------------------------------------------
    cooldown = BOT_SETTINGS.get("cooldown_seconds", 300)

    if symbol in last_trade_time:
        elapsed = now - last_trade_time[symbol]
        if elapsed < cooldown:
            remaining = int(cooldown - elapsed)
            log(f"{symbol}: cooldown — {remaining}s remaining ⏳")
            return "COOLDOWN"

    # -------------------------------------------------------
    # 3. EXISTING POSITION CHECK
    # Never open a second position on top of an existing one.
    # -------------------------------------------------------
    if has_open_position(symbol):
        log(f"{symbol}: position already open — skipping ⚠️")
        return "IN_POSITION"

    # -------------------------------------------------------
    # 3b. DAILY TRADE LIMIT
    # Enforces the "2-3 quality trades per day" target in code.
    # Resets automatically at midnight UTC.
    # -------------------------------------------------------
    today = datetime.utcnow().date()
    if daily_trade_date.get(symbol) != today:
        daily_trade_date[symbol]  = today
        daily_trade_count[symbol] = 0

    max_daily = BOT_SETTINGS.get("max_trades_per_day", 5)
    if daily_trade_count.get(symbol, 0) >= max_daily:
        log(f"{symbol}: daily trade limit reached ({max_daily}) — no more entries today 💤")
        return "DAILY_LIMIT"

    # -------------------------------------------------------
    # 4. GET PRICE
    # -------------------------------------------------------
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        log(f"{symbol}: tick unavailable ❌")
        return None

    price = tick.ask if signal == "BUY" else tick.bid

    # -------------------------------------------------------
    # 5. SPREAD FILTER
    # High spread = broker widening the market = bad conditions.
    # FIXED: compare in POINTS (ticks), not raw price units.
    # The old code compared a dollar value (e.g. 0.35) against
    # 60 (points), so 0.35 > 60 was always False — filter never fired.
    # -------------------------------------------------------
    info = mt5.symbol_info(symbol)
    if info is None:
        log(f"{symbol}: symbol info unavailable ❌")
        return None

    spread_points = (tick.ask - tick.bid) / info.point
    max_spread    = cfg.get("max_spread", 60)

    if spread_points > max_spread:
        log(f"{symbol}: spread too high ({spread_points:.0f} pts > {max_spread}) — skipping ❌")
        return "SKIPPED"

    log(f"{symbol}: spread OK ({spread_points:.0f} pts)")

    # -------------------------------------------------------
    # 6. ATR — STOP LOSS CALCULATION
    # -------------------------------------------------------
    atr = get_atr(symbol)

    if atr is None:
        log(f"{symbol}: ATR unavailable ❌")
        return None

    min_atr = cfg.get("min_atr", 1.0)
    if atr < min_atr:
        log(f"{symbol}: ATR too low ({atr:.2f} < {min_atr}) — market too quiet, skipping ❌")
        return "SKIPPED"

    sl_multiplier = cfg.get("sl_atr_multiplier", 1.5)
    sl_distance   = atr * sl_multiplier

    if signal == "BUY":
        sl         = price - sl_distance
        order_type = mt5.ORDER_TYPE_BUY
    else:
        sl         = price + sl_distance
        order_type = mt5.ORDER_TYPE_SELL

    log(f"{symbol}: ATR={atr:.2f} | SL distance={sl_distance:.2f} | SL={sl:.2f}")

    # -------------------------------------------------------
    # 7. LOT SIZE
    # -------------------------------------------------------
    lot = calculate_lot_size(symbol, sl_distance, cfg)

    if lot <= 0:
        log(f"{symbol}: lot size is zero or invalid ❌")
        return None

    # -------------------------------------------------------
    # 8. PLACE THE ORDER
    # -------------------------------------------------------
    request = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       lot,
        "type":         order_type,
        "price":        price,
        "sl":           sl,
        "tp":           0.0,          # no fixed TP — manager trails it
        "deviation":    10,
        "magic":        BOT_SETTINGS["magic_number"],
        "comment":      "Gold HA V2",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)

    if result is None:
        log(f"{symbol}: order_send returned None ❌")
        return None

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log(f"{symbol}: ORDER FAILED ❌ | retcode={result.retcode} | {result.comment}")
        return None

    # -------------------------------------------------------
    # 9. SUCCESS — log and notify
    # -------------------------------------------------------
    ticket = result.order
    log(f"{symbol}: ORDER PLACED ✅ | {signal} @ {price:.2f} | SL={sl:.2f} | lot={lot} | ticket={ticket}")

    last_trade_time[symbol]   = time.time()
    daily_trade_count[symbol] = daily_trade_count.get(symbol, 0) + 1

    # Log to trades.csv
    log_trade({
        "time":      datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "symbol":    symbol,
        "direction": signal,
        "entry":     round(price, 2),
        "sl":        round(sl, 2),
        "lot":       lot,
        "ticket":    ticket,
        "exit":      "",
        "rr":        "",
        "outcome":   "OPEN",
    })

    # Telegram signal notification (no fixed TP — manager trails)
    send_telegram_message(symbol, signal, price, sl, 0.0)

    return ticket
