import MetaTrader5 as mt5
from logger import log
from config import settings


def _balance_scale_factor(balance):
    """Return a lot-size multiplier based on account balance tier.
    Allows small accounts to trade proportionally smaller positions
    rather than being stuck at the broker minimum floor.
    """
    if balance < 500:
        return 0.10   # 10x smaller — micro accounts
    elif balance < 1000:
        return 0.25   # 4x smaller
    elif balance < 2000:
        return 0.50   # 2x smaller
    elif balance < 5000:
        return 0.75   # 1.33x smaller
    else:
        return 1.00   # full size


def calculate_lot(symbol, sl_distance, manager=None, channel_risk_mult=1.0):
    """
    Calculate the position size (lot) based on:
      1. Account balance
      2. Base risk % (from config / .env BASE_RISK_PERCENT)
      3. Per-symbol streak multiplier (from manager — win/loss streak)
      4. Per-channel risk multiplier (passed in from executor)
      5. Balance-tier scaling (small accounts get proportionally smaller lots)

    The final risk % is capped between 0.1% and 1.5% so no multiplier
    combination can ever expose you to more than 1.5R per trade.

    Balance tiers (applied before broker volume_min floor):
        $0    - $499  : 0.10x  (10x smaller)
        $500  - $999  : 0.25x  (4x smaller)
        $1000 - $1999 : 0.50x  (2x smaller)
        $2000 - $4999 : 0.75x  (1.33x smaller)
        $5000+        : 1.00x  (full size)
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

    sl_ticks  = sl_distance / tick_size
    ideal_lot = risk_amount / (sl_ticks * tick_value)

    # -------------------------------------------------------
    # STEP 6 — Balance-tier scaling
    # Applied before volume_min floor so small accounts can trade
    # sub-minimum lots on symbols that support it (confirmed for stock CFDs)
    # -------------------------------------------------------
    scale = _balance_scale_factor(balance)
    scaled_lot = ideal_lot * scale

    # -------------------------------------------------------
    # STEP 7 — Round to lot step; do NOT enforce volume_min floor;
    #           cap at volume_max
    # -------------------------------------------------------
    lot_step = info.volume_step if info.volume_step > 0 else 0.01
    lot = round(scaled_lot / lot_step) * lot_step
    if lot <= 0:
        lot = lot_step   # at least one micro-step
    lot = min(lot, info.volume_max)
    lot = round(lot, 8)

    tier_label = "x{:.0f}".format(1.0 / scale) if scale < 1.0 else "full"
    log(
        f"[LOT] {symbol}: balance={balance:.2f} [{tier_label}] risk={risk_percent:.2f}% "
        f"risk_amt={risk_amount:.2f} sl_dist={sl_distance:.5f} "
        f"ideal={ideal_lot:.4f} scaled={scaled_lot:.4f} → lot={lot}",
        "INFO"
    )
    return lot
