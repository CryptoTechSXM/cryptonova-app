import os
import pandas as pd

SILENT = os.getenv("SILENT_MODE", "false").lower() == "true"


def heikin_ashi(df):
    ha = df.copy()
    ha['ha_close'] = (df['open'] + df['high'] + df['low'] + df['close']) / 4
    ha_open = [(df['open'].iloc[0] + df['close'].iloc[0]) / 2]
    for i in range(1, len(df)):
        ha_open.append((ha_open[i - 1] + ha['ha_close'].iloc[i - 1]) / 2)
    ha['ha_open'] = ha_open
    ha['ha_high'] = ha[['high', 'ha_open', 'ha_close']].max(axis=1)
    ha['ha_low']  = ha[['low',  'ha_open', 'ha_close']].min(axis=1)
    return ha

def ema(df, period):
    return df['close'].ewm(span=period, adjust=False).mean()

def atr(df, period=14):
    df = df.copy()
    df['prev_close'] = df['close'].shift(1)
    df['tr'] = df.apply(
        lambda x: max(
            x['high'] - x['low'],
            abs(x['high'] - x['prev_close']) if pd.notna(x['prev_close']) else 0,
            abs(x['low']  - x['prev_close']) if pd.notna(x['prev_close']) else 0
        ), axis=1
    )
    return df['tr'].rolling(period).mean()

def is_doji(candle, threshold=0.15):
    body   = abs(candle['ha_close'] - candle['ha_open'])
    range_ = candle['ha_high'] - candle['ha_low']
    if range_ == 0:
        return False
    return (body / range_) < threshold

def is_high_volume_doji(df_m1, lookback=3, doji_pos=2):
    if len(df_m1) < lookback + doji_pos:
        return False
    doji       = df_m1.iloc[-doji_pos]
    doji_range = doji['ha_high'] - doji['ha_low']
    recent     = df_m1.iloc[-(lookback + doji_pos):-doji_pos]
    avg_range  = (recent['ha_high'] - recent['ha_low']).mean()
    if avg_range == 0:
        return False
    result = doji_range >= avg_range * 0.85
    if not SILENT:
        print(f"Doji size: {doji_range:.5f} ({doji_range/avg_range*100:.0f}%) {'OK' if result else 'LOW VOL'}")
    return result

def has_clean_pullback(df_m1, trend, n=2, doji_pos=2):
    if len(df_m1) < n + doji_pos:
        return False
    pullback    = df_m1.iloc[-(n + doji_pos):-doji_pos]
    clean_count = 0
    for _, c in pullback.iterrows():
        rng = c['ha_high'] - c['ha_low']
        if rng == 0:
            continue
        if trend == 'BUY':
            if c['ha_close'] < c['ha_open'] and (c['ha_high'] - c['ha_open']) / rng <= 0.05:
                clean_count += 1
        else:
            if c['ha_close'] > c['ha_open'] and (c['ha_open'] - c['ha_low']) / rng <= 0.05:
                clean_count += 1
    result = clean_count >= n
    if not SILENT:
        print(f"Pullback ({trend}): {clean_count}/{n} {'OK' if result else 'FAIL'}")
    return result

def bullish_candle(candle):
    return (candle['ha_close'] > candle['ha_open'] and
            candle['ha_low'] == min(candle['ha_open'], candle['ha_close']))

def bearish_candle(candle):
    return (candle['ha_close'] < candle['ha_open'] and
            candle['ha_high'] == max(candle['ha_open'], candle['ha_close']))

def h1_trend(df_h1):
    ha   = heikin_ashi(df_h1)
    last = ha.iloc[-1]; prev = ha.iloc[-2]
    if last['ha_close'] > last['ha_open'] and prev['ha_close'] > prev['ha_open']:
        return 'BUY'
    elif last['ha_close'] < last['ha_open'] and prev['ha_close'] < prev['ha_open']:
        return 'SELL'
    return None

def get_spread(tick):
    return tick.ask - tick.bid
