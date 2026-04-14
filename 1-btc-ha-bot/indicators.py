import pandas as pd


def heikin_ashi(df):
    """
    Converts regular OHLC candles into Heikin-Ashi candles.
    HA candles smooth out noise — a solid green candle with no lower wick
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
    """
    Exponential Moving Average — gives more weight to recent prices.
    We use EMA100 as a trend filter: price above = bullish bias, below = bearish.
    """
    return df['close'].ewm(span=period).mean()


def atr(df, period=14):
    """
    Average True Range — measures how much BTC typically moves per candle.
    We use ATR to set SL and TP distances that adapt to current volatility
    instead of fixed pip values that go stale.
    """
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
    """
    A doji is a candle where buyers and sellers are in balance — neither side won.
    It signals indecision and often appears right before a decisive move.
    threshold=0.15 means the body must be less than 15% of the total candle range.
    """
    body   = abs(candle['ha_close'] - candle['ha_open'])
    range_ = candle['ha_high'] - candle['ha_low']
    if range_ == 0:
        return False
    ratio = body / range_
    print(f"🧪 Doji → Body:{body:.2f} Range:{range_:.2f} Ratio:{ratio:.4f} (max:{threshold})")
    return ratio < threshold


def is_high_volume_doji(df_m1, lookback=3):
    """
    The doji's range (ha_high - ha_low) must be >= the average range of the
    previous `lookback` candles. This confirms the doji formed with meaningful
    market participation, not in a dead/thin market.

    Strategy rule: "High volume = larger or same size as last 1-3 candles"

    In strategy.py the doji sits at df_m1.iloc[-3] (prev_m1), so the
    comparison window is df_m1.iloc[-(lookback+3):-3].
    """
    if len(df_m1) < lookback + 3:
        return False

    doji        = df_m1.iloc[-3]
    doji_range  = doji['ha_high'] - doji['ha_low']

    recent      = df_m1.iloc[-(lookback + 3):-3]
    avg_range   = (recent['ha_high'] - recent['ha_low']).mean()

    if avg_range == 0:
        return False

    result = doji_range >= avg_range * 0.85   # 15% tolerance
    pct    = doji_range / avg_range * 100
    print(f"📊 Doji size: {doji_range:.2f} vs avg {avg_range:.2f} ({pct:.0f}%) — "
          f"{'✅ high-vol' if result else '❌ low-vol'}")
    return result


def has_clean_pullback(df_m1, trend, n=2):
    """
    Requires at least `n` clean opposite-color HA candles BEFORE the doji.

    Strategy rule:
      "At least 2 clean opposite-color candles in pullback direction.
       Clean = no wicks on top for buys / no wicks on bottom for sells."

    For BUY: the n candles before the doji must be bearish (ha_close < ha_open)
             with no significant upper wick (sellers fully in control).
    For SELL: the n candles before the doji must be bullish (ha_close > ha_open)
              with no significant lower wick (buyers fully in control).

    In strategy.py the doji is at df_m1.iloc[-3], so pullback candles are
    at df_m1.iloc[-(n+3):-3].
    """
    if len(df_m1) < n + 3:
        return False

    pullback = df_m1.iloc[-(n + 3):-3]
    clean_count = 0

    for _, c in pullback.iterrows():
        candle_range = c['ha_high'] - c['ha_low']
        if candle_range == 0:
            continue

        if trend == 'BUY':
            # Pullback candle must be bearish with no upper wick
            is_bearish   = c['ha_close'] < c['ha_open']
            upper_wick   = c['ha_high'] - c['ha_open']
            wick_clean   = (upper_wick / candle_range) <= 0.05   # <5% wick tolerance
            if is_bearish and wick_clean:
                clean_count += 1

        else:  # SELL
            # Pullback candle must be bullish with no lower wick
            is_bullish   = c['ha_close'] > c['ha_open']
            lower_wick   = c['ha_open'] - c['ha_low']
            wick_clean   = (lower_wick / candle_range) <= 0.05
            if is_bullish and wick_clean:
                clean_count += 1

    result = clean_count >= n
    print(f"📉 Pullback check ({trend}): {clean_count}/{n} clean candles — "
          f"{'✅' if result else '❌'}")
    return result


def bullish_candle(candle):
    """
    A 'perfect' bullish HA candle: closes higher than it opened AND has no lower wick.
    No lower wick means sellers never pushed price down during this candle — pure buying.
    """
    return (candle['ha_close'] > candle['ha_open'] and
            candle['ha_low'] == min(candle['ha_open'], candle['ha_close']))


def bearish_candle(candle):
    """
    A 'perfect' bearish HA candle: closes lower than it opened AND has no upper wick.
    No upper wick means buyers never pushed price up during this candle — pure selling.
    """
    return (candle['ha_close'] < candle['ha_open'] and
            candle['ha_high'] == max(candle['ha_open'], candle['ha_close']))


def h1_trend(df_h1):
    """
    Higher timeframe trend filter using H1 Heikin-Ashi candles.
    We require TWO consecutive H1 candles pointing the same way before we trust the trend.
    One candle can be a fluke — two in a row is conviction.
    Returns 'BUY', 'SELL', or None (unclear/mixed).
    """
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
    """
    Returns the current spread (ask - bid).
    Used to offset break-even SL so we don't stop out at a tiny loss
    when the market is actually at our entry price.
    """
    return symbol_info_tick.ask - symbol_info_tick.bid
