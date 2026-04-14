from indicators import *


def check_signal(df_m1, df_m5, df_h1, config):
    df_m1 = heikin_ashi(df_m1)
    df_m5 = heikin_ashi(df_m5)
    df_m1['ema'] = ema(df_m1, config.EMA_PERIOD)
    df_m5['atr'] = atr(df_m5, config.ATR_PERIOD)
    current_m1 = df_m1.iloc[-1]
    closed_m1  = df_m1.iloc[-2]
    prev_m1    = df_m1.iloc[-3]
    closed_m5  = df_m5.iloc[-2]
    price       = current_m1['close']
    ema_value   = current_m1['ema']
    current_atr = closed_m5['atr']
    print(f'Price: {price:.2f} | EMA{config.EMA_PERIOD}: {ema_value:.2f} | ATR: {current_atr:.2f}')

    # -- Rule: ATR floor - skip dead/choppy markets
    if current_atr < config.MIN_ATR:
        print(f'ATR {current_atr:.2f} < {config.MIN_ATR} - skipping')
        return None

    # -- Rule: H1 trend filter
    h1_direction = h1_trend(df_h1)
    if h1_direction is None:
        print('H1 unclear - skipping')
        return None
    print(f'H1: {h1_direction}')

    # -- Rule 2: Market structure - price vs 100 EMA
    if price > ema_value:
        trend = 'BUY'
    elif price < ema_value:
        trend = 'SELL'
    else:
        return None
    print(f'EMA trend: {trend}')

    if not (trend == h1_direction):
        print(f'Conflict EMA={trend} H1={h1_direction} - skipping')
        return None

    # -- Rule 4: Doji entry signal
    if not is_doji(prev_m1, threshold=config.DOJI_THRESHOLD):
        print('No doji - skipping')
        return None
    print('Doji detected')

    # -- Rule 4: High-volume doji (same or larger range than recent candles)
    if not is_high_volume_doji(df_m1, lookback=3):
        print('Doji volume too low - skipping')
        return None

    # -- Rule 3: Clean pullback - 2 opposite-color no-wick candles before doji
    if not has_clean_pullback(df_m1, trend, n=2):
        print('No clean pullback - skipping')
        return None

    # -- M5 direction confirmation
    if trend == 'BUY':
        if closed_m5['ha_close'] <= closed_m5['ha_open']:
            print('M5 not bullish - skipping')
            return None
        print('M5 bullish (closed)')
    if trend == 'SELL':
        if closed_m5['ha_close'] >= closed_m5['ha_open']:
            print('M5 not bearish - skipping')
            return None
        print('M5 bearish (closed)')

    # -- M1 confirmation candle (strong no-wick candle after doji)
    if trend == 'BUY':
        if not bullish_candle(closed_m1):
            print('M1 not strong bullish - skipping')
            return None
        print('M1 bullish confirmed')
    if trend == 'SELL':
        if not bearish_candle(closed_m1):
            print('M1 not strong bearish - skipping')
            return None
        print('M1 bearish confirmed')

    # -- Rule 5 & 6: SL and TP
    sl_dist = current_atr * config.ATR_MULTIPLIER
    tp_dist = current_atr * config.TP_ATR_MULTIPLIER
    if trend == 'BUY':
        sl = price - sl_dist
        tp = price + tp_dist
    else:
        sl = price + sl_dist
        tp = price - tp_dist

    print(f'Signal: {trend} SL={sl:.2f} TP={tp:.2f}')
    return {'type': trend, 'sl': float(sl), 'tp': float(tp)}
