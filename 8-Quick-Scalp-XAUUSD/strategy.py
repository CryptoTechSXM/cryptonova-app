from datetime import timedelta
from patterns import is_bull_engulf, is_bear_engulf


def get_opening_range(df_15m, session_hour, session_minute):
    """
    Return (box_high, box_low, open_time) for the first 15M candle
    at or after the session open, or None if not found.
    """
    mask = df_15m['time'].apply(
        lambda t: t.hour == session_hour and t.minute >= session_minute
    )
    candles = df_15m[mask]
    if len(candles) == 0:
        return None
    first = candles.iloc[0]
    return first['high'], first['low'], first['time']


def validate_liquidity_candle(box_high, box_low, daily_atr, min_pct=0.22, max_pct=0.38):
    """
    Opening range must be within min_pct-max_pct of the 14-period daily ATR.
    Gold default: 22-38% (slightly wider than indices).
    Below min = dead open, above max = too explosive to trade.
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
    RR default 2:1 (backtest: 66% WR, +0.98R expectancy on XAUUSD).
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
