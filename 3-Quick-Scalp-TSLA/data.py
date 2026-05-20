import time as _time
import MetaTrader5 as mt5
import pandas as pd


_SYMBOL_CANDIDATES = {
    'XAUUSD': ['XAUUSD', 'XAUUSD.s', 'XAUUSDm', 'XAUUSD.a', 'GOLD'],
    'GER40':  ['GER40', 'GER40.s', 'GER40m', 'DAX40', 'DE40'],
    'NAS100': ['NAS100', 'NAS100.s', 'NAS100m', 'NASDAQ', 'US100'],
}

_resolved = {}   # cache so we only resolve once per session


def _resolve(symbol):
    if symbol in _resolved:
        return _resolved[symbol]
    available = {s.name for s in (mt5.symbols_get() or [])}
    base = symbol.replace('.s', '').replace('m', '').upper()
    candidates = _SYMBOL_CANDIDATES.get(base, [symbol])
    for c in candidates:
        if c in available:
            mt5.symbol_select(c, True)
            _resolved[symbol] = c
            return c
    _resolved[symbol] = symbol
    return symbol


def initialize():
    if not mt5.initialize():
        raise RuntimeError(f'MT5 init failed: {mt5.last_error()}')


def get_data(symbol, timeframe_minutes, bars=500):
    symbol = _resolve(symbol)
    tf_map = {1: mt5.TIMEFRAME_M1, 5: mt5.TIMEFRAME_M5,
              15: mt5.TIMEFRAME_M15, 60: mt5.TIMEFRAME_H1,
              240: mt5.TIMEFRAME_H4, 1440: mt5.TIMEFRAME_D1}
    tf = tf_map.get(timeframe_minutes)
    if tf is None:
        raise ValueError(f'Unknown timeframe: {timeframe_minutes}')
    # Ensure symbol is subscribed in Market Watch before requesting data.
    # symbol_select is idempotent — safe to call every time.  After a fresh
    # subscription MT5 may need a moment to load bars, so retry up to 3x.
    mt5.symbol_select(symbol, True)
    for attempt in range(3):
        rates = mt5.copy_rates_from_pos(symbol, tf, 0, bars)
        if rates is not None and len(rates) > 0:
            df = pd.DataFrame(rates)
            df['time'] = pd.to_datetime(df['time'], unit='s')
            return df
        if attempt < 2:
            _time.sleep(2)
    raise RuntimeError(f'No data for {symbol} TF={timeframe_minutes}')


def get_daily_atr(symbol, period=14):
    """
    Calculate ATR using daily (D1) bars.
    Falls back through H4 -> H1 -> M15 when higher timeframes are
    unavailable — common for stock CFDs where brokers only carry intraday bars.
    Retries the full chain up to 3 times (5s apart) to handle MT5
    data-sync delay after a fresh symbol_select subscription.
    """
    def _compress(df, bars_per_day):
        df = df.copy()
        df['date'] = df['time'].dt.date
        daily = df.groupby('date').agg(
            open=('open', 'first'),
            high=('high', 'max'),
            low=('low', 'min'),
            close=('close', 'last')
        ).reset_index()
        return daily.tail(period + 5).reset_index(drop=True)

    df = None
    for outer_attempt in range(3):
        for tf, bars_per_day, label in [
            (1440, 1,  'D1'),
            (240,  6,  'H4'),
            (60,   24, 'H1'),
            (15,   32, 'M15'),
        ]:
            try:
                raw = get_data(symbol, tf, bars=max(period + 5, (period + 2) * bars_per_day))
                if raw is not None and len(raw) > period:
                    df = raw if tf == 1440 else _compress(raw, bars_per_day)
                    break
            except RuntimeError:
                continue
        if df is not None:
            break
        if outer_attempt < 2:
            _time.sleep(5)

    if df is None:
        raise RuntimeError(f"No data available for {symbol} on any timeframe for ATR calculation")

    df['prev_close'] = df['close'].shift(1)
    df['tr'] = df.apply(
        lambda x: max(
            x['high'] - x['low'],
            abs(x['high'] - x['prev_close']) if pd.notna(x['prev_close']) else 0,
            abs(x['low']  - x['prev_close']) if pd.notna(x['prev_close']) else 0,
        ), axis=1
    )
    return df['tr'].rolling(period).mean().iloc[-1]
