import pandas as pd


def heikin_ashi(df):
    """
    Converts regular OHLC candles into Heikin-Ashi candles.
    HA candles smooth out noise -- a solid green candle with no lower wick
    means strong buying pressure, no ambiguity.
    """
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
    return df['close'].ewm(span=period).mean()


def atr(df, period=14):
    df = df.copy()
    df['prev_close'] = df['close'].shift(1)
    df['tr'] = df.apply(
        lambda x: max(
            x['high'] - x['low'],
            abs(x['high'] - x['prev_close']) if pd.notna(x['prev_close']) else 0,
            abs(x['low']  - x['prev_close']) if pd.notna(x['prev_close']) else 0
        ),
        axis=1
    )
    return df['tr'].rolling(period).mean()


def is_doji(candle, threshold=0.15):
    body   = abs(candle['ha_close'] - candle['ha_open'])
    range_ = candle['ha_high'] - candle['ha_low']
    if range_ == 0:
        return False
    ratio = body / range_
    print(f"Doji check: Body={body:.2f} Range={range_:.2f} Ratio={ratio:.4f} (max:{threshold})")
    return ratio < threshold


def is_high_volume_doji(df_m1, lookback=3, doji_pos=2):
    """
    Doji range must be >= average range of previous `lookback` candles.
    doji_pos=4 when 2 M1 confirmation candles sit between doji and current.
    """
    if len(df_m1) < lookback + doji_pos:
        return False
    doji       = df_m1.iloc[-doji_pos]
    doji_range = doji['ha_high'] - doji['ha_low']
    recent     = df_m1.iloc[-(lookback + doji_pos):-doji_pos]
    avg_range  = (recent['ha_high'] - recent['ha_low']).mean()
    if avg_range == 0:
        return False
    result = doji_range >= avg_range * 0.85
    pct    = doji_range / avg_range * 100
    print(f"Doji size: {doji_range:.2f} vs avg {avg_range:.2f} ({pct:.0f}%) -- {'OK' if result else 'LOW VOL'}")
    return result


def has_clean_pullback(df_m1, trend, n=2, doji_pos=2):
    """
    Requires n clean opposite-color HA candles before the doji.
    BUY:  n bearish candles with no upper wick before doji.
    SELL: n bullish candles with no lower wick before doji.
    doji_pos=4 when 2 M1 confirmation candles sit between doji and current.
    """
    if len(df_m1) < n + doji_pos:
        return False
    pullback    = df_m1.iloc[-(n + doji_pos):-doji_pos]
    clean_count = 0
    for _, c in pullback.iterrows():
        candle_range = c['ha_high'] - c['ha_low']
        if candle_range == 0:
            continue
        if trend == 'BUY':
            is_bearish  = c['ha_close'] < c['ha_open']
            upper_wick  = c['ha_high'] - c['ha_open']
            wick_clean  = (upper_wick / candle_range) <= 0.15  # was 0.05 — too strict, rejected most valid pullbacks
            if is_bearish and wick_clean:
                clean_count += 1
        else:
            is_bullish  = c['ha_close'] > c['ha_open']
            lower_wick  = c['ha_open'] - c['ha_low']
            wick_clean  = (lower_wick / candle_range) <= 0.15  # was 0.05 — too strict, rejected most valid pullbacks
            if is_bullish and wick_clean:
                clean_count += 1
    result = clean_count >= n
    print(f"Pullback ({trend}): {clean_count}/{n} clean -- {'OK' if result else 'FAIL'}")
    return result


def bullish_candle(candle):
    return (candle['ha_close'] > candle['ha_open'] and
            candle['ha_low'] == min(candle['ha_open'], candle['ha_close']))


def bearish_candle(candle):
    return (candle['ha_close'] < candle['ha_open'] and
            candle['ha_high'] == max(candle['ha_open'], candle['ha_close']))


def h1_trend(df_h1):
    ha   = heikin_ashi(df_h1)
    last = ha.iloc[-1]
    prev = ha.iloc[-2]
    last_bull = last['ha_close'] > last['ha_open']
    prev_bull = prev['ha_close'] > prev['ha_open']
    if last_bull and prev_bull:
        return 'BUY'
    elif not last_bull and not prev_bull:
        return 'SELL'
    else:
        return None


def get_spread(symbol_info_tick):
    return symbol_info_tick.ask - symbol_info_tick.bid
