import MetaTrader5 as mt5
from logger import log
from config import settings


def calculate_lot(symbol, sl_distance, manager=None, channel_risk_mult=1.0):
    """
    Calculate the position size (lot) based on:
      1. Account balance
      2. Base risk % (from config / .env BASE_RISK_PERCENT)
      3. Per-symbol streak multiplier (from manager — win/loss streak)
      4. Per-channel risk multiplier (passed in from executor)

    The final risk % is capped between 0.1% and 1.5% so no multiplier
    combination can ever expose you to more than 1.5R per trade.
    """
    account = mt5.account_info()
    if not account:
        log("[LOT] No account info — fallback to 0.01", "ERROR")
        return 0.01

    if sl_distance is None or sl_distance <= 0:
        log("[LOT] Invalid SL distance — fallback to 0.01", "ERROR")
        return 0.01

    balance = account.balance

    # -------------------------------------------------------
    # STEP 1 — Base risk from config
    # -------------------------------------------------------
    base_risk = settings.base_risk_pct   # e.g. 0.5%

    # -------------------------------------------------------
    # STEP 2 — Streak multiplier (win streak → more, loss streak → less)
    # -------------------------------------------------------
    streak_mult = 1.0
    if manager:
        try:
            streak_mult = manager.get_risk_multiplier(symbol)
        except Exception as e:
            log(f"[LOT] Streak multiplier fallback: {e}", "ERROR")

    # -------------------------------------------------------
    # STEP 3 — Per-channel multiplier (clamp to safe range)
    # -------------------------------------------------------
    channel_risk_mult = max(0.1, min(channel_risk_mult, 2.0))

    # -------------------------------------------------------
    # STEP 4 — Combine and hard-cap the final risk %
    # -------------------------------------------------------
    risk_percent = base_risk * streak_mult * channel_risk_mult
    risk_percent = max(0.1, min(risk_percent, 1.5))

    risk_amount = balance * (risk_percent / 100.0)

    # -------------------------------------------------------
    # STEP 5 — Convert risk amount to lot size using tick data
    # lot = risk_amount / (sl_distance_in_ticks × tick_value_per_lot)
    # -------------------------------------------------------
    info = mt5.symbol_info(symbol)
    if not info:
        log(f"[LOT] No symbol info for {symbol} — fallback to 0.01", "ERROR")
        return 0.01

    tick_value = info.trade_tick_value   # account currency value of 1 tick, per 1 lot
    tick_size  = info.trade_tick_size    # price units per 1 tick

    if tick_size <= 0 or tick_value <= 0:
        log(f"[LOT] Invalid tick data for {symbol} (tv={tick_value} ts={tick_size}) — fallback to 0.01", "ERROR")
        return 0.01

    sl_ticks = sl_distance / tick_size
    raw_lot  = risk_amount / (sl_ticks * tick_value)

    # -------------------------------------------------------
    # STEP 6 — Round to nearest lot step and clamp to broker min/max
    # -------------------------------------------------------
    lot_step = info.volume_step
    lot = round(raw_lot / lot_step) * lot_step
    lot = max(info.volume_min, min(lot, info.volume_max))

    log(
        f"[LOT] {symbol}: balance={balance:.2f} risk={risk_percent:.2f}% "
        f"risk_amt={risk_amount:.2f} sl_dist={sl_distance:.5f} → lot={lot:.2f}",
        "INFO"
    )
    return lot
