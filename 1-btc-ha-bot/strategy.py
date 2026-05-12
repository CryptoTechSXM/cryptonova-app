"""
strategy.py -- Basic HA Strategy (M1)
Rules 1-9: HA candles, EMA100, direction, market structure,
clean pullback, high-volume doji, ATR-based SL, 1:1 TP.

Entry filters:
  - MIN_ATR < ATR < MAX_ATR  : blocks quiet AND news/volatility entries
  - SESSION_CLOSE_BUFFER     : no new entries within N min of London/NY close
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
    # Apply HA transform and EMA to M1
    df_m1 = heikin_ashi(df_m1)
    df_m1['ema'] = ema(df_m1, config.EMA_PERIOD)

    # ATR from M5 for volatility checks and SL calculation
    df_m5_ha = heikin_ashi(df_m5)
    df_m5_ha['atr'] = atr(df_m5_ha, config.ATR_PERIOD)
    df_m5_ha['ema'] = ema(df_m5_ha, config.EMA_PERIOD)
    current_atr = df_m5_ha['atr'].iloc[-2]
    m5_ema      = df_m5_ha['ema'].iloc[-2]
    m5_price    = df_m5_ha['close'].iloc[-2]

    # ------------------------------------------------------------------
    # Candle references
    # Doji at [-2] -- signal fires as soon as doji closes
    # Pullback candles at [-4:-2]
    # ------------------------------------------------------------------
    current_m1 = df_m1.iloc[-1]   # live forming candle
    doji       = df_m1.iloc[-2]   # doji -- entry trigger on close

    price   = current_m1['close']
    ema_val = current_m1['ema']

    if not SILENT:
        print('Price: {:.2f} | EMA100: {:.2f} | ATR: {:.2f}'.format(price, ema_val, current_atr))

    # ------------------------------------------------------------------
    # ATR floor -- skip dead/choppy market
    # ------------------------------------------------------------------
    if pd.isna(current_atr) or current_atr < config.MIN_ATR:
        if not SILENT: print('ATR too low -- skipping')
        return None

    # ------------------------------------------------------------------
    # ATR ceiling -- skip news spikes / extreme volatility
    # BTC normal M5 ATR: 100-800 pts. > 3000 = news event, avoid.
    # ------------------------------------------------------------------
    max_atr = getattr(config, 'MAX_ATR', 3000.0)
    if current_atr > max_atr:
        if not SILENT:
            print('ATR too high ({:.2f} > {:.2f}) -- news spike, skipping'.format(
                current_atr, max_atr))
        return None

    # ------------------------------------------------------------------
    # Session close buffer -- no entries near London/NY close
    # ------------------------------------------------------------------
    if not _session_close_ok(config):
        return None

    # ------------------------------------------------------------------
    # Rules 2/3/4: Direction -- price above/below M1 EMA100
    # M5 EMA must also agree -- prevents BUY below M5 EMA and vice versa
    # ------------------------------------------------------------------
    if price > ema_val:
        trend = 'BUY'
        if m5_price < m5_ema:
            if not SILENT: print('M5 EMA conflict: price below M5 EMA for BUY -- skipping')
            return None
    elif price < ema_val:
        trend = 'SELL'
        if m5_price > m5_ema:
            if not SILENT: print('M5 EMA conflict: price above M5 EMA for SELL -- skipping')
            return None
    else:
        return None
    if not SILENT: print('Trend: {}'.format(trend))

    # ------------------------------------------------------------------
    # Rules 3/4: Market structure
    # BUY:  doji low must be above EMA (higher low above EMA)
    # SELL: doji high must be below EMA (lower high below EMA)
    # ------------------------------------------------------------------
    if trend == 'BUY' and doji['ha_low'] < ema_val * 0.999:
        if not SILENT: print('Market structure fail: doji below EMA -- skipping')
        return None
    if trend == 'SELL' and doji['ha_high'] > ema_val * 1.001:
        if not SILENT: print('Market structure fail: doji above EMA -- skipping')
        return None
    if not SILENT: print('Market structure OK')

    # ------------------------------------------------------------------
    # Rule 5: Clean pullback -- 2 clean no-wick opposite-color candles
    # (doji_pos=2 since doji is at iloc[-2])
    # ------------------------------------------------------------------
    if not has_clean_pullback(df_m1, trend, n=2, doji_pos=2):
        if not SILENT: print('No clean pullback -- skipping')
        return None

    # ------------------------------------------------------------------
    # Rule 6: Doji -- body/range < threshold (color irrelevant)
    # ------------------------------------------------------------------
    if not is_doji(doji, threshold=config.DOJI_THRESHOLD):
        if not SILENT: print('No doji -- skipping')
        return None

    # Rule 6: High-volume doji -- same or larger than last 1-3 candles
    if not is_high_volume_doji(df_m1, lookback=3, doji_pos=2):
        if not SILENT: print('Doji too small -- skipping')
        return None
    if not SILENT: print('Doji OK')

    # ------------------------------------------------------------------
    # Rule 7: SL = ATR x ATR_MULTIPLIER
    # Rule 8: TP = ATR x TP_ATR_MULTIPLIER
    # ------------------------------------------------------------------
    sl_dist = current_atr * config.ATR_MULTIPLIER
    tp_dist = current_atr * getattr(config, 'TP_ATR_MULTIPLIER', 1.5)

    if sl_dist <= 0:
        if not SILENT: print('Zero SL distance -- skipping')
        return None

    if trend == 'BUY':
        sl = price - sl_dist
        tp = price + tp_dist
    else:
        sl = price + sl_dist
        tp = price - tp_dist

    rr = tp_dist / sl_dist if sl_dist > 0 else 0
    print('[{}] SIGNAL: {} | Entry={:.2f} SL={:.2f} TP={:.2f} | R:R=1:{:.1f}'.format(
        config.SYMBOL, trend, price, sl, tp, rr))
    return {'type': trend, 'sl': float(sl), 'tp': float(tp)}
