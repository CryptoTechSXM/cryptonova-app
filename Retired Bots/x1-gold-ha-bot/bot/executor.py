# =============================================================
# BOT HELPERS — ATR calculation + position check
# =============================================================

import MetaTrader5 as mt5
import pandas as pd

from bot.logger import log


def get_atr(symbol, timeframe=mt5.TIMEFRAME_M5, period=14):
    """
    ATR (Average True Range) measures how much Gold moves per candle on average.
    We use it to set a stop loss that gives the trade room to breathe.

    A larger ATR = more volatile market = wider stop loss needed.
    """
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, 100)

    if rates is None or len(rates) < period + 2:
        log(f"{symbol}: not enough data for ATR ❌")
        return None

    df = pd.DataFrame(rates)

    df["high_low"]    = df["high"] - df["low"]
    df["high_close"]  = abs(df["high"] - df["close"].shift())
    df["low_close"]   = abs(df["low"]  - df["close"].shift())
    df["tr"]          = df[["high_low", "high_close", "low_close"]].max(axis=1)

    atr = df["tr"].rolling(period).mean().iloc[-1]
    return atr


def has_open_position(symbol):
    """
    Returns True if there is already a live position on this symbol.
    The bot should never open a second position on top of an existing one.
    """
    positions = mt5.positions_get(symbol=symbol)

    if positions is None:
        return False

    valid = [p for p in positions if p.volume > 0]
    return len(valid) > 0
