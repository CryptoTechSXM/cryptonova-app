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
from telegram_sender import send_close as _tg_close, send_close

# Stores the ORIGINAL SL per ticket before breakeven modifies it.
# Without this, risk=0 after BE fires and the trail never runs.
_orig_sl = {}

# Consecutive loss tracking — kill switch mirrors the other bots
_consec_losses   = 0
_consec_date     = None
MAX_CONSEC_LOSSES = 3


def _recover_orig_sl(ticket, current_sl, entry, symbol=None):
    """
    Return the original SL for a ticket.

    Priority:
      1. If current SL != entry it hasn't been moved to BE yet — use it directly.
      2. Otherwise look through MT5 order history for the FIRST order on this
         position (which has the original SL before any modifications).
      3. ATR-based fallback using the symbol so trail still functions.
      4. Return current SL as last resort (trail disabled for this trade).
    """
    # SL not yet at breakeven — this IS the original
    if abs(current_sl - entry) > 0.01:
        return current_sl

    # SL is at (or very near) entry — it was already moved. Dig into history.
    try:
        orders = mt5.history_orders_get(datetime(2000, 1, 1), datetime.now())
        if orders:
            for order in orders:           # chronological → oldest first = original
                if order.position_id == ticket and order.sl and order.sl > 0:
                    if abs(order.sl - entry) > 0.01:   # skip if already at entry
                        return order.sl
    except Exception:
        pass

    # ATR-based fallback — at least gives trail something to work with
    if symbol:
        try:
            atr = get_atr(symbol)
            if atr and atr > 0:
                return entry - atr * 1.5   # approximate original SL distance
        except Exception:
            pass

    return current_sl   # genuinely cannot recover


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
        sl        = pos.sl           # current SL (may be at BE after modification)
        direction = "BUY" if pos.type == 0 else "SELL"

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            continue

        price = tick.bid if direction == "BUY" else tick.ask

        # Need a valid SL to calculate R:R
        if not sl or sl == 0:
            log(f"{symbol} #{ticket}: no SL set — skipping management ⚠️")
            continue

        # Store original SL on first encounter.
        # We MUST use original SL for risk calculation — after BE fires pos.sl == entry
        # which makes risk=0 and kills the trail permanently.
        # On restart the SL may already be at BE, so we look up order history first.
        if ticket not in _orig_sl:
            recovered = _recover_orig_sl(ticket, sl, entry, symbol)
            _orig_sl[ticket] = recovered
            log(f"{symbol} #{ticket}: original SL locked at {recovered:.2f}"
                + (" (recovered from history)" if recovered != sl else ""))

        orig_sl = _orig_sl[ticket]
        risk    = abs(entry - orig_sl)
        if risk <= 0:
            continue

        # R:R ratio using original risk so it stays consistent after BE
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
        # ATR-BASED TRAIL — aggressive scalp lock
        # Fires when profit >= TRAIL_ATR_TRIGGER × current ATR
        # SL trails TRAIL_ATR_BUFFER × ATR behind price
        # Adapts to volatility — tight on quiet markets, wider on active
        # TP removed on first fire (Rule 10)
        # -------------------------------------------------------
        atr_val      = get_atr(symbol) or (risk * 2)   # fallback to 2R if ATR unavailable
        trig_mult    = BOT_SETTINGS.get("trail_atr_trigger", 0.30)
        buf_mult     = BOT_SETTINGS.get("trail_atr_buffer",  0.15)
        trigger_dist = atr_val * trig_mult
        buffer_dist  = atr_val * buf_mult

        profit = (price - entry) if direction == "BUY" else (entry - price)

        if profit >= trigger_dist > 0:
            be_buf = BOT_SETTINGS.get("be_buffer_pts", 8.0)
            if direction == "BUY":
                new_sl = max(entry + be_buf, price - buffer_dist)
                if new_sl > sl:
                    sl_past_entry = new_sl > entry
                    new_tp = 0.0 if sl_past_entry else pos.tp
                    res = mt5.order_send({
                        "action": mt5.TRADE_ACTION_SLTP, "symbol": pos.symbol,
                        "position": ticket, "sl": new_sl, "tp": new_tp,
                    })
                    if res and res.retcode in (mt5.TRADE_RETCODE_DONE, 10009):
                        tp_note = "TP removed" if sl_past_entry else f"TP kept at {new_tp:.2f}"
                        log(f"{symbol} #{ticket}: TRAIL → SL={new_sl:.2f} "
                            f"profit={profit:.2f} trigger={trigger_dist:.2f} {tp_note}")
            else:
                new_sl = min(entry - be_buf, price + buffer_dist)
                if sl == 0 or new_sl < sl:
                    sl_past_entry = new_sl < entry and new_sl > 0
                    new_tp = 0.0 if sl_past_entry else pos.tp
                    res = mt5.order_send({
                        "action": mt5.TRADE_ACTION_SLTP, "symbol": pos.symbol,
                        "position": ticket, "sl": new_sl, "tp": new_tp,
                    })
                    if res and res.retcode in (mt5.TRADE_RETCODE_DONE, 10009):
                        tp_note = "TP removed" if sl_past_entry else f"TP kept at {new_tp:.2f}"
                        log(f"{symbol} #{ticket}: TRAIL → SL={new_sl:.2f} "
                            f"profit={profit:.2f} trigger={trigger_dist:.2f} {tp_note}")

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

        entry    = position.price_open
        sl       = position.sl
        orig_sl  = _orig_sl.pop(position.ticket, sl)  # get then remove

        if orig_sl and orig_sl != 0:
            risk = abs(entry - orig_sl)
            rr   = (price - entry) / risk if position.type == 0 else (entry - price) / risk
        else:
            rr = 0

        outcome = "WIN" if rr > 0 else "LOSS"

        # Consecutive loss kill switch
        global _consec_losses, _consec_date
        today = datetime.utcnow().date()
        if _consec_date != today:
            _consec_date   = today
            _consec_losses = 0
        if outcome == "WIN":
            _consec_losses = 0
        else:
            _consec_losses += 1
            if _consec_losses >= MAX_CONSEC_LOSSES:
                log(f"{symbol}: ⛔ {_consec_losses} consecutive losses — trading PAUSED for today")
                _daily_pnl[symbol] = -9999  # force daily loss limit hit

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
        send_close(symbol, "BUY" if position.type == 0 else "SELL",
                   entry, price, rr, "Gold HA Bot", position.profit)

    else:
        log(f"{symbol} #{position.ticket}: CLOSE FAILED ❌")


# =========================
# SESSION CLOSE GUARD
# Fires once per day at 19:00 UTC.
# Closes any open position in profit whose SL hasn't yet been moved
# above entry — they still carry full downside risk into the fakeout window.
# =========================
_session_guard_fired_date = None

def session_close_guard(sym):
    global _session_guard_fired_date
    from datetime import datetime, timezone
    now  = datetime.now(timezone.utc)
    if now.hour < 19:
        return
    today = now.date()
    if _session_guard_fired_date == today:
        return
    _session_guard_fired_date = today

    positions = mt5.positions_get(symbol=sym)
    if not positions:
        return

    for pos in positions:
        if pos.profit <= 0:
            continue
        entry    = pos.price_open
        sl       = pos.sl
        direction = "BUY" if pos.type == 0 else "SELL"
        eps      = 0.01

        sl_unprotected = (
            (direction == "BUY"  and (sl == 0 or sl < entry - eps)) or
            (direction == "SELL" and (sl == 0 or sl > entry + eps))
        )
        if not sl_unprotected:
            log(f"{sym} #{pos.ticket}: session guard — SL protected at {sl:.2f}, leaving for trail")
            continue

        close_position(pos, "SESSION_GUARD")
        log(f"{sym} #{pos.ticket}: session guard — closed unprotected profit={pos.profit:.2f} at 19:00 UTC")


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
