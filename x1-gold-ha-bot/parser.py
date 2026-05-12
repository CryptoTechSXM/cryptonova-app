# =============================================================
# PARSER — Signal Generation
# =============================================================
# This is the brain of the bot.
#
# STRATEGY LOGIC (3 steps must ALL be true to get a signal):
#
#   Step 1 — TREND (H1 chart):
#     Calculate EMA-100 on the 1-hour chart.
#     If price is above EMA  → we only look for BUY signals.
#     If price is below EMA  → we only look for SELL signals.
#     This keeps us trading WITH the trend, not against it.
#
#   Step 2 — PULLBACK (M5 chart):
#     Wait for price to pull back CLOSE to the EMA-100 on M5.
#     This means we're entering at a better price, not chasing.
#     "Close" is defined by pullback_threshold in config.py.
#
#   Step 3 — CONFIRMATION (M5 chart):
#     Wait for the M5 candle to CLOSE back in the trend direction
#     after the pullback. This is the "bounce" — evidence that
#     the trend is resuming before we enter.
#
# Why this is better than the old version:
#   The old bot entered the moment price was above EMA — that
#   means it would buy at the TOP of a move. This version waits
#   for a dip back toward the EMA, then a bounce, which gives
#   a much better entry price and tighter stop loss.
# =============================================================

import MetaTrader5 as mt5
import pandas as pd
from datetime import datetime

from bot.logger import log


def get_rates(symbol, timeframe, bars=200):
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, bars)

    if rates is None or len(rates) == 0:
        log(f"{symbol}: rates unavailable for TF={timeframe} ❌")
        return None

    df = pd.DataFrame(rates)
    df["time"] = pd.to_datetime(df["time"], unit="s")
    return df


def calculate_ema(df, period=100):
    return df["close"].ewm(span=period, adjust=False).mean()


def compute_ha(df):
    """
    Compute Heikin-Ashi candles from regular OHLC data.

    HA candles average price across bars to reduce noise, making it
    much easier to confirm that a bounce is real rather than a wick.
    A HA bullish candle (close > open) is a stronger signal than a
    plain candle that barely closes a tick above its open.

    Formula:
        HA_Close = (open + high + low + close) / 4
        HA_Open  = (prev_HA_open + prev_HA_close) / 2   [iterative]
    """
    ha_close = (df["open"] + df["high"] + df["low"] + df["close"]) / 4

    ha_open = ha_close.copy()
    ha_open_vals = ha_open.values.copy()
    ha_close_vals = ha_close.values

    for i in range(1, len(df)):
        ha_open_vals[i] = (ha_open_vals[i - 1] + ha_close_vals[i - 1]) / 2

    result = df.copy()
    result["ha_open"]  = ha_open_vals
    result["ha_close"] = ha_close_vals
    return result


def is_in_session(cfg):
    """
    Returns True if current UTC hour is inside London or New York session.
    Uses calendar.timegm + time.gmtime to get reliable UTC on Windows.
    """
    session = cfg.get("session", {})

    if not session.get("enabled", False):
        return True  # if session filter is off, always allow

    # datetime.now(timezone.utc) can return local time on some Windows setups.
    # datetime.utcnow() is reliable cross-platform for getting the UTC hour.
    now_utc = datetime.utcnow().hour

    in_london  = session["london_start"]  <= now_utc < session["london_end"]
    in_newyork = session["newyork_start"] <= now_utc < session["newyork_end"]

    log(f"Session check: UTC hour={now_utc} | london={in_london} | newyork={in_newyork}")

    return in_london or in_newyork


def generate_signals(symbol_configs):
    """
    Returns a dict like {"XAUUSD": "BUY"} or {"XAUUSD": None}
    None means no valid signal right now — do nothing.
    """
    signal_map = {}

    for symbol, cfg in symbol_configs.items():

        if not cfg.get("enabled", False):
            continue

        # -------------------------------------------------------
        # SESSION FILTER
        # -------------------------------------------------------
        if not is_in_session(cfg):
            log(f"{symbol}: outside trading session — sleeping 💤")
            signal_map[symbol] = None
            continue

        # -------------------------------------------------------
        # STEP 1: H1 TREND — which direction are we allowed to trade?
        # -------------------------------------------------------
        df_h1 = get_rates(symbol, mt5.TIMEFRAME_H1, bars=150)

        if df_h1 is None or len(df_h1) < 105:
            signal_map[symbol] = None
            continue

        df_h1["ema"] = calculate_ema(df_h1, 100)
        # FIXED: use iloc[-2] — the last CLOSED H1 candle.
        # iloc[-1] is the candle currently forming and its close
        # changes every tick, causing the trend to flicker at the boundary.
        h1_ema   = df_h1["ema"].iloc[-2]
        h1_close = df_h1["close"].iloc[-2]

        if h1_close > h1_ema:
            trend = "BUY"
        else:
            trend = "SELL"

        log(f"{symbol}: H1 close={h1_close:.2f} | EMA={h1_ema:.2f} | Trend={trend}")

        # -------------------------------------------------------
        # STEP 2: M5 PULLBACK — has price come back near the EMA?
        # -------------------------------------------------------
        df_m5 = get_rates(symbol, mt5.TIMEFRAME_M5, bars=200)

        if df_m5 is None or len(df_m5) < 105:
            signal_map[symbol] = None
            continue

        df_m5["ema"] = calculate_ema(df_m5, 100)

        # Look at the second-to-last candle (last confirmed closed candle)
        prev = df_m5.iloc[-2]
        prev_ema = df_m5["ema"].iloc[-2]

        threshold = cfg.get("pullback_threshold", 0.003)

        # How far is the candle's LOW (for BUY) or HIGH (for SELL) from EMA?
        if trend == "BUY":
            # For a BUY pullback, the candle low should have dipped close to EMA
            distance_to_ema = abs(prev["low"] - prev_ema) / prev_ema
        else:
            # For a SELL pullback, the candle high should have pushed close to EMA
            distance_to_ema = abs(prev["high"] - prev_ema) / prev_ema

        pulled_back = distance_to_ema <= threshold

        log(f"{symbol}: M5 pullback distance={distance_to_ema:.4f} | threshold={threshold} | pulled_back={pulled_back}")

        if not pulled_back:
            signal_map[symbol] = None
            continue

        # -------------------------------------------------------
        # STEP 3: CONFIRMATION — did the pullback candle bounce?
        # -------------------------------------------------------
        # FIXED: The original code used df_m5.iloc[-1] which is the
        # LIVE, still-forming candle. A candle that looks bullish right
        # now can flip bearish before it closes — phantom signals.
        #
        # We now check the SAME closed candle from Step 2 (prev / iloc[-2]).
        # This candle has both touched near the EMA AND closed in the trend
        # direction — a complete single-candle pullback-and-bounce signal.
        #
        # IMPROVEMENT: Use Heikin-Ashi open/close for the direction check.
        # HA smooths noise so a HA-bullish candle is a much more reliable
        # bounce signal than a plain candle that barely moved.
        df_m5_ha = compute_ha(df_m5)
        prev_ha  = df_m5_ha.iloc[-2]

        if trend == "BUY":
            # HA bullish: smoothed close above smoothed open
            confirmed = prev_ha["ha_close"] > prev_ha["ha_open"]
        else:
            # HA bearish: smoothed close below smoothed open
            confirmed = prev_ha["ha_close"] < prev_ha["ha_open"]

        log(f"{symbol}: M5 HA confirmation (closed candle) → ha_open={prev_ha['ha_open']:.2f} ha_close={prev_ha['ha_close']:.2f} confirmed={confirmed}")

        if not confirmed:
            signal_map[symbol] = None
            continue

        # -------------------------------------------------------
        # ALL 3 CONDITIONS MET — emit signal
        # -------------------------------------------------------
        log(f"{symbol}: ✅ SIGNAL CONFIRMED → {trend}")
        signal_map[symbol] = trend

    return signal_map
