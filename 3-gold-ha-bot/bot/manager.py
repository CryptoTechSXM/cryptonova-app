# =============================================================
# MANAGER — Position Management
# =============================================================
# Once a trade is open, this module looks after it every scan.
#
# Rules (in order of priority):
#
#   LOSS CUT at -0.5R:
#     If the trade has moved 50% of the initial risk against us,
#     close it immediately. This is a safety net — the SL would
#     catch it anyway, but this exits a little earlier to avoid
#     slippage on fast moves.
#
#   BREAK-EVEN at +1.0R:
#     Once the trade is 1× the risk in profit, move the SL to
#     the entry price. Now the trade cannot lose money.
#     (Changed from 0.3R — too early, kept getting stopped out)
#
#   TRAILING STOP at +1.5R:
#     Once in significant profit, trail the SL so it follows
#     the price and locks in gains. Trail distance = 50% of ATR.
#
#   REVERSAL CLOSE:
#     If the H1 trend signal flips (e.g. we're in a BUY but
#     signal turns SELL), and we're already in profit (>+0.5R),
#     close the trade and take the money.
# =============================================================

import MetaTrader5 as mt5
from datetime import datetime

from bot.logger import log, log_trade
from bot.executor import get_atr
from config import BOT_SETTINGS
from telegram_sender import send_close as _tg_close

def send_telegram_message(msg, message_type="report"):
    # legacy wrapper — manager close messages forwarded via send_close
    from telegram_sender import _post, SIGNAL_CHAT
    _post(msg, SIGNAL_CHAT)


# -------------------------------------------------------
# DAILY LOSS TRACKING
# Tracks realised P&L per symbol per day (in USD).
# Used to enforce the max_daily_loss_percent limit.
# -------------------------------------------------------
_daily_pnl      = {}   # symbol -> float  (USD, realised today)
_daily_pnl_date = {}   # symbol -> date   (which UTC day)


def _reset_daily_if_needed(symbol):
    today = datetime.utcnow().date()
    if _daily_pnl_date.get(symbol) != today:
        _daily_pnl_date[symbol] = today
        _daily_pnl[symbol]      = 0.0


def is_daily_loss_limit_hit(symbol):
    """
    Returns True if realised losses today have reached the configured
    max_daily_loss_percent threshold. Called before managing positions
    so the bot stops opening new management actions on a blown day.
    (New entries are blocked separately in executor.py via daily_trade_count.)
    """
    _reset_daily_if_needed(symbol)

    max_loss_pct = BOT_SETTINGS.get("max_daily_loss_percent", 3.0)
    account      = mt5.account_info()

    if account is None:
        return False

    max_loss_usd = account.balance * (max_loss_pct / 100)
    todays_pnl   = _daily_pnl.get(symbol, 0.0)

    if todays_pnl <= -max_loss_usd:
        log(f"{symbol}: ⛔ Daily loss limit hit (${todays_pnl:.2f} / -${max_loss_usd:.2f}) — no new entries today")
        return True

    return False


def manage_positions(signal_map):
    from bot.adopter import _adopted_tickets

    positions = mt5.positions_get()

    if not positions:
        return

    for pos in positions:
        # Check daily loss limit — if hit, skip new management actions
        # (existing SL will still close the trade via MT5 server-side)
        if is_daily_loss_limit_hit(pos.symbol):
            continue

        # Manage if opened by this bot OR manually adopted
        is_ours    = pos.magic == BOT_SETTINGS["magic_number"]
        is_adopted = pos.ticket in _adopted_tickets

        if not is_ours and not is_adopted:
            continue

        symbol    = pos.symbol
        ticket    = pos.ticket
        entry     = pos.price_open
        sl        = pos.sl
        direction = "BUY" if pos.type == 0 else "SELL"

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            continue

        price = tick.bid if direction == "BUY" else tick.ask

        # Need a valid SL to calculate R:R
        if not sl or sl == 0:
            log(f"{symbol} #{ticket}: no SL set — skipping management ⚠️")
            continue

        risk = abs(entry - sl)
        if risk <= 0:
            continue

        # R:R ratio — how many times the initial risk are we up/down?
        if direction == "BUY":
            rr = (price - entry) / risk
        else:
            rr = (entry - price) / risk

        log(f"{symbol} #{ticket}: {direction} | RR={rr:.2f} | price={price:.2f} | sl={sl:.2f}")

        # -------------------------------------------------------
        # LOSS CUT at -0.5R
        # -------------------------------------------------------
        if rr <= -0.5:
            log(f"{symbol} #{ticket}: LOSS CUT at {rr:.2f}R ❌")
            close_position(pos, "LOSS_CUT")
            continue

        # -------------------------------------------------------
        # BREAK-EVEN at +1.0R
        # -------------------------------------------------------
        if rr >= 1.0:
            be_price = entry

            if direction == "BUY" and sl < be_price:
                modify_sl(pos, be_price)
                log(f"{symbol} #{ticket}: BREAK-EVEN set at {be_price:.2f} ✅")

            elif direction == "SELL" and sl > be_price:
                modify_sl(pos, be_price)
                log(f"{symbol} #{ticket}: BREAK-EVEN set at {be_price:.2f} ✅")

        # -------------------------------------------------------
        # TRAILING STOP at +1.5R
        # -------------------------------------------------------
        if rr >= 1.5:
            atr = get_atr(symbol)
            if atr:
                trail_distance = atr * 0.5

                if direction == "BUY":
                    new_sl = price - trail_distance
                    if new_sl > sl:
                        modify_sl(pos, new_sl)
                        log(f"{symbol} #{ticket}: TRAIL → SL={new_sl:.2f}")

                else:
                    new_sl = price + trail_distance
                    if new_sl < sl:
                        modify_sl(pos, new_sl)
                        log(f"{symbol} #{ticket}: TRAIL → SL={new_sl:.2f}")

        # -------------------------------------------------------
        # REVERSAL CLOSE — signal flipped and we're in profit
        # -------------------------------------------------------
        current_signal = signal_map.get(symbol)

        if current_signal and rr >= 0.5:
            if direction == "BUY" and current_signal == "SELL":
                log(f"{symbol} #{ticket}: REVERSAL CLOSE (signal flipped SELL) 🔄")
                close_position(pos, "REVERSAL")
                continue

            if direction == "SELL" and current_signal == "BUY":
                log(f"{symbol} #{ticket}: REVERSAL CLOSE (signal flipped BUY) 🔄")
                close_position(pos, "REVERSAL")
                continue


def close_position(position, reason="MANUAL"):
    symbol = position.symbol

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        log(f"{symbol}: tick unavailable for close ❌")
        return

    close_type = mt5.ORDER_TYPE_SELL if position.type == 0 else mt5.ORDER_TYPE_BUY
    price      = tick.bid if position.type == 0 else tick.ask

    request = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       position.volume,
        "type":         close_type,
        "position":     position.ticket,
        "price":        price,
        "deviation":    10,
        "magic":        BOT_SETTINGS["magic_number"],
        "comment":      f"close:{reason}",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)

    if result and result.retcode == mt5.TRADE_RETCODE_DONE:

        entry = position.price_open
        sl    = position.sl

        if sl and sl != 0:
            risk = abs(entry - sl)
            rr   = (price - entry) / risk if position.type == 0 else (entry - price) / risk
        else:
            rr = 0

        outcome = "WIN" if rr > 0 else "LOSS"

        # Update daily P&L tracker using MT5's realised profit figure.
        # position.profit is the unrealised P&L just before we closed,
        # which equals the realised P&L at the close price.
        _reset_daily_if_needed(symbol)
        _daily_pnl[symbol] = _daily_pnl.get(symbol, 0.0) + position.profit
        log(f"{symbol}: today's P&L = ${_daily_pnl[symbol]:.2f}")

        log(f"{symbol} #{position.ticket}: CLOSED ✅ | {reason} | RR={rr:.2f} | {outcome}")

        log_trade({
            "time":      datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "symbol":    symbol,
            "direction": "BUY" if position.type == 0 else "SELL",
            "entry":     round(entry, 2),
            "sl":        round(sl, 2) if sl else "",
            "lot":       position.volume,
            "ticket":    position.ticket,
            "exit":      round(price, 2),
            "rr":        round(rr, 2),
            "outcome":   outcome,
        })

        # Telegram notification
        emoji = "✅" if outcome == "WIN" else "❌"
        msg = (
            f"<b>Gold HA Bot V2</b>\n"
            f"{emoji} <b>CLOSED</b> {symbol} ({reason})\n"
            f"Entry: {round(entry,2)} → Exit: {round(price,2)}\n"
            f"RR: <b>{round(rr,2)}</b>  |  {outcome}"
        )
        send_telegram_message(msg, message_type="report")

    else:
        log(f"{symbol} #{position.ticket}: CLOSE FAILED ❌")


def modify_sl(position, new_sl):
    request = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "position": position.ticket,
        "sl":       new_sl,
        "tp":       position.tp,
    }

    result = mt5.order_send(request)

    if result and result.retcode == mt5.TRADE_RETCODE_DONE:
        log(f"{position.symbol} #{position.ticket}: SL updated to {new_sl:.2f} ✅")
    else:
        log(f"{position.symbol} #{position.ticket}: SL modify failed ❌")
