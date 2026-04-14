import MetaTrader5 as mt5
import pandas as pd


def initialize():
    if not mt5.initialize():
        raise RuntimeError(f'MT5 init failed: {mt5.last_error()}')


def get_data(symbol, timeframe_minutes, bars=500):
    tf_map = {1: mt5.TIMEFRAME_M1, 5: mt5.TIMEFRAME_M5,
              15: mt5.TIMEFRAME_M15, 60: mt5.TIMEFRAME_H1,
              1440: mt5.TIMEFRAME_D1}
    tf = tf_map.get(timeframe_minutes)
    if tf is None:
        raise ValueError(f'Unknown timeframe: {timeframe_minutes}')
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, bars)
    if rates is None or len(rates) == 0:
        raise RuntimeError(f'No data for {symbol} TF={timeframe_minutes}')
    df = pd.DataFrame(rates)
    df['time'] = pd.to_datetime(df['time'], unit='s')
    return df


def get_daily_atr(symbol, period=14):
    df = get_data(symbol, 1440, bars=period + 5)
    df['prev_close'] = df['close'].shift(1)
    df['tr'] = df.apply(
        lambda x: max(
            x['high'] - x['low'],
            abs(x['high'] - x['prev_close']) if pd.notna(x['prev_close']) else 0,
            abs(x['low']  - x['prev_close']) if pd.notna(x['prev_close']) else 0,
        ), axis=1
    )
    return df['tr'].rolling(period).mean().iloc[-1]
