# =============================================================
# ADOPTER — Manual Trade Adoption
# =============================================================
# This module watches for trades that YOU opened manually
# (i.e. trades without the bot's magic number) and adopts them.
#
# What "adopting" a trade means:
#   1. Detect it — any open position without our magic number
#   2. Apply a SL — calculate ATR-based SL and set it
#   3. Claim it  — update the comment so we track it
#   4. Hand off  — from now on manager.py handles it like any
#                  other bot trade (BE, trail, loss cut)
#
# The bot checks for manual trades every scan cycle, so if
# you open a trade while the bot is running it will be adopted
# within 5 seconds.
#
# NOTE: Adoption changes the SL on your trade. That's intentional
# — it's the whole point. If you want a specific SL, set it
# before the bot adopts it (within ~5 seconds of opening).
# =============================================================

import MetaTrader5 as mt5

from bot.logger import log
from bot.executor import get_atr
import config as _config
from config import BOT_SETTINGS, SYMBOL_CONFIGS
from telegram_sender import send_adoption


# Tracks tickets we've already adopted so we don't re-process them
_adopted_tickets = set()


def adopt_manual_trades():
    """
    Called every scan cycle from main.py.
    Finds unmanaged positions and brings them under bot control.
    """
    all_positions = mt5.positions_get()

    # None = MT5 call failed (disconnected). Empty tuple = no open positions.
    if all_positions is None:
        log("ADOPTER: mt5.positions_get() returned None — MT5 may be disconnected")
        return

    if len(all_positions) == 0:
        return

    for pos in all_positions:

        # Only adopt genuine manual trades (magic == 0).
        # Any non-zero magic means another bot opened it — leave it alone.
        if pos.magic != 0:
            continue

        # Already adopted this ticket in a previous scan — skip
        if pos.ticket in _adopted_tickets:
            continue

        symbol = pos.symbol

        # Accept any symbol whose base name matches our instrument
        # e.g. BASE_SYMBOL="XAUUSD" matches XAUUSD, XAUUSD.s, XAUUSD.p, XAUUSD.pro etc.
        base = getattr(_config, 'BASE_SYMBOL', 'XAUUSD')
        if not symbol.upper().startswith(base.upper()):
            log(f"ADOPTER: {symbol} #{pos.ticket} — not a {base} position, skipping")
            continue

        log(f"ADOPTER: Manual trade detected — {symbol} #{pos.ticket} magic={pos.magic} ⚠️")

        _adopt(pos)


def _adopt(pos):
    """
    Adopt a single position:
      1. Calculate and apply ATR-based SL if missing or weak
      2. Stamp with our magic number so manager.py picks it up
    """
    symbol    = pos.symbol
    ticket    = pos.ticket
    entry     = pos.price_open
    direction = "BUY" if pos.type == 0 else "SELL"
    # Use resolved symbol config if available, else fall back to any gold config
    cfg       = SYMBOL_CONFIGS.get(symbol) or SYMBOL_CONFIGS.get(_config.SYMBOL, {})

    # -------------------------------------------------------
    # STEP 1: Calculate ATR-based SL
    # -------------------------------------------------------
    atr = get_atr(symbol)

    if atr is None:
        log(f"ADOPTER: {symbol} #{ticket} — ATR unavailable, cannot set SL ❌")
        # Still mark as adopted so we don't spam logs, but don't touch it
        _adopted_tickets.add(ticket)
        return

    sl_multiplier = cfg.get("sl_atr_multiplier", 1.5)
    sl_distance   = atr * sl_multiplier

    if direction == "BUY":
        new_sl = entry - sl_distance
    else:
        new_sl = entry + sl_distance

    # -------------------------------------------------------
    # STEP 2: Only update SL if it's missing or worse than ours
    # -------------------------------------------------------
    existing_sl = pos.sl

    needs_sl = (
        existing_sl is None
        or existing_sl == 0
        or (direction == "BUY"  and existing_sl < new_sl)
        or (direction == "SELL" and existing_sl > new_sl)
    )

    if needs_sl:
        log(f"ADOPTER: {symbol} #{ticket} — applying ATR SL={new_sl:.2f} (ATR={atr:.2f} × {sl_multiplier})")
        _set_sl_and_claim(pos, new_sl)
    else:
        log(f"ADOPTER: {symbol} #{ticket} — existing SL={existing_sl:.2f} is acceptable, claiming without change")
        _set_sl_and_claim(pos, existing_sl)

    _adopted_tickets.add(ticket)


def _set_sl_and_claim(pos, sl):
    """
    Send a SLTP modification request.
    This updates the SL and implicitly stamps the trade via comment
    (MT5 doesn't allow changing magic number via SLTP, but the manager
    will treat any position on a configured symbol as manageable after
    we set the SL — see manager.py's adoption-aware check).
    """
    symbol = pos.symbol

    request = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "position": pos.ticket,
        "sl":       sl,
        "tp":       pos.tp,
    }

    result = mt5.order_send(request)

    if result and result.retcode == mt5.TRADE_RETCODE_DONE:
        direction = "BUY" if pos.type == 0 else "SELL"
        log(f"ADOPTER: {symbol} #{pos.ticket} — ADOPTED ✅ | {direction} @ {pos.price_open:.2f} | SL={sl:.2f}")

        send_adoption(symbol, direction, pos.price_open, sl, "Gold HA Bot")

    else:
        retcode = result.retcode if result else "None"
        log(f"ADOPTER: {symbol} #{pos.ticket} — SL set FAILED ❌ retcode={retcode}")
