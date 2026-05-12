from datetime import timedelta, datetime, timezone
from patterns import is_bull_engulf, is_bear_engulf


def get_opening_range(df_15m, session_hour, session_minute):
    """
    Return (box_high, box_low, open_time) for the first 15M candle
    at or after the session open, or None if not found.

    Auto-detects broker server time offset vs UTC by comparing the most
    recent bar's timestamp against the current UTC time.  This makes the
    search robust whether the broker stores bar times in UTC or in a local
    server timezone (e.g. UTC+2, UTC+3).
    """
    if df_15m is None or len(df_15m) == 0:
        return None

    # -- detect broker offset vs UTC (rounded to nearest 15-min slot) --
    now_utc    = datetime.now(timezone.utc)
    latest     = df_15m['time'].iloc[-1]
    utc_slot   = (now_utc.hour * 60 + now_utc.minute) // 15 * 15
    bar_slot   = (latest.hour   * 60 + latest.minute)  // 15 * 15
    raw_offset = bar_slot - utc_slot
    if raw_offset >  720: raw_offset -= 1440   # normalise to ±12 h
    if raw_offset < -720: raw_offset += 1440

    # session open expressed in broker time
    open_mins   = (session_hour * 60 + session_minute + raw_offset) % 1440
    open_bkr_h  = open_mins // 60
    open_bkr_m  = open_mins % 60

    # "today" anchored to the broker's own date (avoids UTC date-boundary issues)
    today = latest.date()

    mask = df_15m['time'].apply(
        lambda t: t.date() == today
                  and t.hour == open_bkr_h
                  and t.minute >= open_bkr_m
    )
    candles = df_15m[mask]
    if len(candles) == 0:
        return None
    first = candles.iloc[0]
    return first['high'], first['low'], first['time']


def validate_liquidity_candle(box_high, box_low, daily_atr, min_pct=0.15, max_pct=0.50):
    """
    Opening range must be min_pct–max_pct of the 14-period daily ATR.
    Below min_pct = dead open. Above max_pct = too explosive to trade.
    """
    box_range = box_high - box_low
    pct = box_range / daily_atr if daily_atr > 0 else 0
    return min_pct <= pct <= max_pct, round(pct * 100, 1)


def scan_for_signal(df_5m, box_high, box_low, open_time, window_minutes,
                    rr=2.0):
    """
    Scan 5M candles within the window for ENGULFING patterns outside the box.
    Patterns traded:
        bull_engulf  ->  BUY  stop above prev bearish candle open
        bear_engulf  ->  SELL stop below prev bullish candle open
    RR default 2:1 (backtest: 63% WR, +0.87R expectancy).
    Returns signal dict or None.
    """
    cutoff = open_time + timedelta(minutes=window_minutes)
    window = df_5m[
        (df_5m['time'] >= open_time) & (df_5m['time'] < cutoff)
    ].reset_index(drop=True)

    for i in range(1, len(window)):
        c = window.iloc[i]
        p = window.iloc[i - 1]

        # -- BELOW the box: look for BUY engulfing --------
        if c['high'] < box_low:
            if is_bull_engulf(c, p):
                entry = p['open']
                sl    = c['low']
                sl_d  = entry - sl
                return {
                    'type': 'BUY', 'pattern': 'bull_engulf',
                    'entry': entry, 'sl': sl,
                    'tp': entry + sl_d * rr,
                    'rr': rr,
                    'bar': i,
                }

        # -- ABOVE the box: look for SELL engulfing -------
        elif c['low'] > box_high:
            if is_bear_engulf(c, p):
                entry = p['open']
                sl    = c['high']
                sl_d  = sl - entry
                return {
                    'type': 'SELL', 'pattern': 'bear_engulf',
                    'entry': entry, 'sl': sl,
                    'tp': entry - sl_d * rr,
                    'rr': rr,
                    'bar': i,
                }

    return None
