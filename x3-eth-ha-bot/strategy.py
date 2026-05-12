"""
strategy.py — Basic HA Strategy (M1)
Rules 1-9: HA candles, EMA100, direction, market structure,
clean pullback, high-volume doji, doji-wick SL, 1:1 TP.
Enter as soon as doji candle closes.
"""

import os
from datetime import datetime, timezone
from indicators import *

SILENT = os.getenv("SILENT_MODE", "false").lower() == "true"

def _session_close_ok(config):
    """Block new entries within SESSION_CLOSE_BUFFER minutes of London (16:00)
    or NY (19:00) close to avoid stop-hunts and low-liquidity traps."""
    buf   = getattr(config, 'SESSION_CLOSE_BUFFER', 30)
    now   = datetime.now(timezone.utc)
    total = now.hour * 60 + now.minute
    for end in [16 * 60, 19 * 60]:
        if end - buf <= total < end:
            if not SILENT:
                print('Session close buffer: {}min to {:02d}:00 UTC -- skipping'.format(
                    end - total, end // 60))
            return False
    return True




def check_signal(df_m1, df_m5, df_h1, config):
    df_m1 = heikin_ashi(df_m1)
    df_m1['ema'] = ema(df_m1, config.EMA_PERIOD)
    df_m5_ha = heikin_ashi(df_m5)
    df_m5_ha['atr'] = atr(df_m5_ha, config.ATR_PERIOD)
    df_m5_ha['ema'] = ema(df_m5_ha, config.EMA_PERIOD)
    current_atr = df_m5_ha['atr'].iloc[-2]
    m5_ema      = df_m5_ha['ema'].iloc[-2]
    m5_price    = df_m5_ha['close'].iloc[-2]

    current_m1 = df_m1.iloc[-1]
    doji       = df_m1.iloc[-2]
    price      = current_m1['close']
    ema_val    = current_m1['ema']

    if not SILENT:
        print(f'Price: {price:.5f} | EMA100: {ema_val:.5f} | ATR: {current_atr:.5f}')

    if pd.isna(current_atr) or current_atr < config.MIN_ATR:
        if not SILENT: print('ATR too low - skipping')
        return None

    if price > ema_val:
        trend = 'BUY'
        if m5_price < m5_ema:
            if not SILENT: print('M5 EMA conflict: below M5 EMA for BUY - skipping')
            return None
    elif price < ema_val:
        trend = 'SELL'
        if m5_price > m5_ema:
            if not SILENT: print('M5 EMA conflict: above M5 EMA for SELL - skipping')
            return None
    else:
        return None
    if not SILENT: print(f'Trend: {trend}')

    if trend == 'BUY' and doji['ha_low'] < ema_val * 0.999:
        if not SILENT: print('Market structure fail - skipping')
        return None
    if trend == 'SELL' and doji['ha_high'] > ema_val * 1.001:
        if not SILENT: print('Market structure fail - skipping')
        return None
    if not SILENT: print('Market structure OK')

    if not has_clean_pullback(df_m1, trend, n=2, doji_pos=2):
        if not SILENT: print('No clean pullback - skipping')
        return None

    if not is_doji(doji, threshold=config.DOJI_THRESHOLD):
        if not SILENT: print('No doji - skipping')
        return None

    if not is_high_volume_doji(df_m1, lookback=3, doji_pos=2):
        if not SILENT: print('Doji too small - skipping')
        return None
    if not SILENT: print('Doji OK')

    sl_dist = current_atr * config.ATR_MULTIPLIER
    tp_dist = current_atr * getattr(config, 'TP_ATR_MULTIPLIER', 1.5)
    if trend == 'BUY':
        sl = price - sl_dist
        tp = price + tp_dist
    else:
        sl = price + sl_dist
        tp = price - tp_dist

    if sl_dist <= 0:
        return None

    rr = tp_dist / sl_dist if sl_dist > 0 else 0
    print(f'[{config.SYMBOL}] SIGNAL: {trend} | Entry={price:.5f} SL={sl:.5f} TP={tp:.5f} | R:R=1:{rr:.1f}')
    return {'type': trend, 'sl': float(sl), 'tp': float(tp)}
