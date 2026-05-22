import MetaTrader5 as mt5
import pandas as pd


def initialize():
    if not mt5.initialize():
        raise Exception("MT5 Initialization Failed")


def get_data(symbol, timeframe, bars=200):
    tf_map = {
        1: mt5.TIMEFRAME_M1,
        5: mt5.TIMEFRAME_M5,
        60: mt5.TIMEFRAME_H1
    }

    rates = mt5.copy_rates_from_pos(symbol, tf_map[timeframe], 0, bars)
    df = pd.DataFrame(rates)

    df['time'] = pd.to_datetime(df['time'], unit='s')

    return df