"""
param_sweep_backtest.py  v2  (vectorised)
=========================================
Data-driven parameter sweep for the CryptoNite Free Signals HA strategy.

SPEED FIX vs v1
---------------
v1 ran O(n²) — it re-filtered the M5/H1 DataFrames inside every M1 bar loop.
v2 pre-computes EVERY indicator as a numpy array in a single forward pass,
then each of the 1296 parameter combos is just a few boolean AND operations
on those arrays.  Typical runtime: 3-8 minutes on a modern laptop.

HOW IT WORKS
------------
1. Fetch M1, M5, H1 XAUUSD bars from MT5 (terminal must be open + logged in).
2. One-time precomputation of all HA, EMA, ATR, and per-bar filter arrays.
3. For each candidate signal bar, walk forward HOLD_BARS M1 bars to decide
   WIN (TP hit first), LOSS (SL hit first), or TIMEOUT (neither).
4. Grid-search 1296 parameter combinations; rank by Expected Value (R/trade).
5. Print Top-30 table + single-param impact breakdown.
6. Save full results to param_sweep_results.csv.

USAGE
-----
    python param_sweep_backtest.py

MT5 must be open and logged in.  Script latches to the open terminal.
"""

import sys
import itertools
import time as _time

import numpy as np
import pandas as pd

try:
    import MetaTrader5 as mt5
except ImportError:
    sys.exit("MetaTrader5 package not installed.  pip install MetaTrader5")

# ════════════════════════════════════════════════════════════
# CONSTANTS  (not swept)
# ════════════════════════════════════════════════════════════
SYMBOL_CANDIDATES = [
    "XAUUSD.s", "XAUUSD.f", "XAUUSD.pro", "XAUUSD", "XAUUSDm", "XAUUSD.a", "GOLD",
]

BARS_M1      = 20_000    # ~14 trading days of M1
BARS_M5      = 5_000
BARS_H1      = 600

ATR_PERIOD   = 14
EMA_PERIOD   = 100
ATR_SL_MULT  = 2.0
ATR_TP_MULT  = 3.0
MIN_ATR_ABS  = 4.0       # hard ATR floor — never swept
HOLD_BARS    = 240       # M1 bars scanned for outcome (= 4 h)
WARMUP       = EMA_PERIOD + 60   # skip first N bars while indicators warm up

# ════════════════════════════════════════════════════════════
# PARAMETER GRID
# ════════════════════════════════════════════════════════════
GRID = {
    "doji_threshold":     [0.10, 0.15, 0.20, 0.25],
    "doji_vol_threshold": [0.60, 0.70, 0.80, 0.90],
    "pullback_n":         [1, 2, 3],
    "pullback_wick_tol":  [0.05, 0.10, 0.15],
    "h1_consecutive":     [1, 2],
    "min_atr_ratio":      [0.65, 0.75, 0.85],
    "m5_wick_check":      [False, True],
    "min_signal_gap_min": [0, 15, 30],
}
TOP_N = 30


# ════════════════════════════════════════════════════════════
# MT5 HELPERS
# ════════════════════════════════════════════════════════════
def connect():
    if not mt5.initialize():
        sys.exit(f"MT5 init failed: {mt5.last_error()}")
    info = mt5.terminal_info()
    print(f"Connected to MT5: {info.name}")


def resolve_symbol():
    syms = {s.name for s in (mt5.symbols_get() or [])}
    for s in SYMBOL_CANDIDATES:
        if s in syms:
            print(f"Symbol resolved: {s}")
            return s
    sys.exit("No XAUUSD variant found in MT5")


def fetch(symbol, tf, count):
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None or len(rates) == 0:
        sys.exit(f"No rates: {symbol} tf={tf}  err={mt5.last_error()}")
    df = pd.DataFrame(rates)
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
    return df[["time", "open", "high", "low", "close"]].copy().reset_index(drop=True)


# ════════════════════════════════════════════════════════════
# INDICATOR HELPERS  (numpy, no pandas in hot loops)
# ════════════════════════════════════════════════════════════
def heikin_ashi_np(o, h, l, c):
    ha_c = (o + h + l + c) / 4
    ha_o = np.zeros_like(ha_c)
    ha_o[0] = (o[0] + c[0]) / 2
    for i in range(1, len(ha_c)):
        ha_o[i] = (ha_o[i-1] + ha_c[i-1]) / 2
    ha_h = np.maximum(h, np.maximum(ha_o, ha_c))
    ha_l = np.minimum(l, np.minimum(ha_o, ha_c))
    return ha_o, ha_c, ha_h, ha_l


def ema_np(series, period):
    k   = 2.0 / (period + 1)
    out = np.full_like(series, np.nan, dtype=float)
    # seed with simple mean of first `period` values
    seed_end = period
    if seed_end > len(series):
        return out
    out[seed_end - 1] = series[:seed_end].mean()
    for i in range(seed_end, len(series)):
        out[i] = series[i] * k + out[i-1] * (1 - k)
    return out


def atr_np(h, l, c, period):
    tr = np.maximum(h - l,
         np.maximum(np.abs(h - np.roll(c, 1)),
                    np.abs(l - np.roll(c, 1))))
    tr[0] = h[0] - l[0]
    out = np.full_like(tr, np.nan)
    out[period-1] = tr[:period].mean()
    alpha = 1.0 / period
    for i in range(period, len(tr)):
        out[i] = out[i-1] * (1 - alpha) + tr[i] * alpha
    return out


def rolling_mean_np(arr, window):
    """Trailing rolling mean; result[i] = mean(arr[i-window+1 : i+1])."""
    out = np.full_like(arr, np.nan, dtype=float)
    cs  = np.cumsum(arr)
    out[window-1:] = (cs[window-1:] - np.concatenate([[0], cs[:-window]])) / window
    return out


# ════════════════════════════════════════════════════════════
# PRECOMPUTE ALL FEATURE ARRAYS  (single pass)
# ════════════════════════════════════════════════════════════
def precompute(m1_raw, m5_raw, h1_raw):
    print("Pre-computing HA and indicators…")

    # --- M1 HA ------------------------------------------------
    m1o = m1_raw["open"].values.astype(float)
    m1h = m1_raw["high"].values.astype(float)
    m1l = m1_raw["low"].values.astype(float)
    m1c = m1_raw["close"].values.astype(float)
    ha1_o, ha1_c, ha1_h, ha1_l = heikin_ashi_np(m1o, m1h, m1l, m1c)

    # M1 EMA on HA close
    ema1 = ema_np(ha1_c, EMA_PERIOD)

    # --- M5 HA + ATR ------------------------------------------
    m5o = m5_raw["open"].values.astype(float)
    m5h = m5_raw["high"].values.astype(float)
    m5l = m5_raw["low"].values.astype(float)
    m5c = m5_raw["close"].values.astype(float)
    ha5_o, ha5_c, ha5_h, ha5_l = heikin_ashi_np(m5o, m5h, m5l, m5c)
    atr5 = atr_np(m5h, m5l, m5c, ATR_PERIOD)

    # --- H1 HA ------------------------------------------------
    h1o = h1_raw["open"].values.astype(float)
    h1h = h1_raw["high"].values.astype(float)
    h1l = h1_raw["low"].values.astype(float)
    h1c = h1_raw["close"].values.astype(float)
    ha1h_o, ha1h_c, ha1h_h, ha1h_l = heikin_ashi_np(h1o, h1h, h1l, h1c)

    # --- Time alignment: for each M1[i], find last closed M5/H1 bar ------
    m1_ts = m1_raw["time"].values.astype("int64")   # ns since epoch
    m5_ts = m5_raw["time"].values.astype("int64")
    h1_ts = h1_raw["time"].values.astype("int64")
    # "last closed M5 bar before M1[i]" = searchsorted(m5_ts, m1_ts[i], 'right')-2
    # (-2 because bar at idx is still forming; -1 is last closed)
    m1_to_m5 = np.searchsorted(m5_ts, m1_ts, side="right").astype(int) - 2
    m1_to_h1 = np.searchsorted(h1_ts, m1_ts, side="right").astype(int) - 2
    m1_to_m5 = np.clip(m1_to_m5, 0, len(m5_ts) - 1)
    m1_to_h1 = np.clip(m1_to_h1, 0, len(h1_ts) - 1)

    N = len(m1_ts)
    print(f"  M1 bars: {N}  M5: {len(m5_ts)}  H1: {len(h1_ts)}")

    # ================================================================
    # PER-BAR FEATURE ARRAYS  (indexed by M1 bar i)
    # ================================================================

    # --- ATR at each M1 bar (from aligned M5 bar) ---
    atr_at = atr5[m1_to_m5]    # ATR of the last closed M5 bar

    # --- ATR 20-bar rolling average (on M5 ATR series, then looked up by M1 time) ---
    atr5_avg20 = rolling_mean_np(np.where(np.isnan(atr5), 0.0, atr5), 20)
    atr_avg_at = atr5_avg20[m1_to_m5]

    # --- EMA trend (BUY=+1, SELL=-1, None=0) ---
    ema_trend = np.where(ha1_c > ema1, 1,
                np.where(ha1_c < ema1, -1, 0)).astype(np.int8)

    # --- H1 single-candle trend at each M1 bar ---
    h1_idx   = m1_to_h1
    h1_trend1 = np.where(ha1h_c[h1_idx] > ha1h_o[h1_idx],  1,
                np.where(ha1h_c[h1_idx] < ha1h_o[h1_idx], -1, 0)).astype(np.int8)

    # --- H1 two-consecutive-candle trend ---
    h1_idx_p1 = np.clip(h1_idx - 1, 0, len(h1_ts) - 1)
    h1_prev1  = np.where(ha1h_c[h1_idx_p1] > ha1h_o[h1_idx_p1],  1,
                np.where(ha1h_c[h1_idx_p1] < ha1h_o[h1_idx_p1], -1, 0)).astype(np.int8)
    h1_trend2 = np.where(h1_trend1 == h1_prev1, h1_trend1, np.int8(0))

    # --- Doji at bar i-3: body/range ratio and vol ratio ---
    doji_body_ratio = np.full(N, np.nan)
    doji_vol_ratio  = np.full(N, np.nan)
    for i in range(9, N):
        di = i - 3                              # index of doji candle
        body = abs(ha1_c[di] - ha1_o[di])
        rng  = ha1_h[di] - ha1_l[di]
        if rng <= 0:
            continue
        doji_body_ratio[i] = body / rng
        # avg range of 3 bars before the doji
        prev = ha1_h[max(0,di-3):di] - ha1_l[max(0,di-3):di]
        avg  = prev.mean() if len(prev) > 0 else 0.0
        doji_vol_ratio[i] = (rng / avg) if avg > 0 else 0.0

    # --- Clean pullback: precompute for n=1,2,3 and wick_tol=0.05,0.10,0.15 ---
    # clean_pb[n_idx][tol_idx][i] = True if pullback passes
    PB_N   = [1, 2, 3]
    PB_TOL = [0.05, 0.10, 0.15]
    # For pullback we need n clean candles in range [i-(n+3) : i-3]
    # direction matches ema_trend[i]
    clean_pb = {}
    for n in PB_N:
        for tol in PB_TOL:
            arr = np.zeros(N, dtype=bool)
            for i in range(n + 6, N):
                direction = ema_trend[i]
                if direction == 0:
                    continue
                start = i - (n + 3)
                end   = i - 3          # exclusive: candles [start..end-1]
                count = 0
                for j in range(start, end):
                    rng = ha1_h[j] - ha1_l[j]
                    if rng == 0:
                        continue
                    if direction == 1:   # BUY pullback = bearish HA candle
                        if ha1_c[j] < ha1_o[j]:
                            wick = ha1_h[j] - ha1_o[j]
                            if wick / rng <= tol:
                                count += 1
                    else:                # SELL pullback = bullish HA candle
                        if ha1_c[j] > ha1_o[j]:
                            wick = ha1_o[j] - ha1_l[j]
                            if wick / rng <= tol:
                                count += 1
                arr[i] = count >= n
            clean_pb[(n, tol)] = arr

    # --- M5 bar direction + wick ratios ---
    m5_idx_at = m1_to_m5
    m5_bullish = (ha5_c[m5_idx_at] > ha5_o[m5_idx_at]).astype(bool)
    m5_bearish = (ha5_c[m5_idx_at] < ha5_o[m5_idx_at]).astype(bool)

    m5_rng = ha5_h[m5_idx_at] - ha5_l[m5_idx_at]
    m5_rng_safe = np.where(m5_rng > 0, m5_rng, 1.0)

    m5_bull_wick = (ha5_h[m5_idx_at] - np.maximum(ha5_o[m5_idx_at], ha5_c[m5_idx_at])) / m5_rng_safe
    m5_bear_wick = (np.minimum(ha5_o[m5_idx_at], ha5_c[m5_idx_at]) - ha5_l[m5_idx_at]) / m5_rng_safe

    # --- M1 confirmation candle (bar i-2) direction ---
    m1_conf_bull = np.zeros(N, dtype=bool)
    m1_conf_bear = np.zeros(N, dtype=bool)
    for i in range(4, N):
        m1_conf_bull[i] = ha1_c[i-2] > ha1_o[i-2]
        m1_conf_bear[i] = ha1_c[i-2] < ha1_o[i-2]

    # ================================================================
    # OUTCOME PRECOMPUTATION
    # For every M1 bar i that *could* generate a signal (ATR floor passes,
    # EMA+H1 agree), compute WIN/LOSS/TIMEOUT based on subsequent M1 bars.
    # outcome_arr[i] = +1 (WIN), -1 (LOSS), 0 (TIMEOUT)
    # entry_price, sl_dist, tp_dist stored for reference
    # ================================================================
    print("Pre-computing trade outcomes for all candidate bars…")
    outcome_arr  = np.zeros(N, dtype=np.int8)    # default TIMEOUT
    atr_at_valid = np.zeros(N, dtype=bool)       # True where ATR is usable

    for i in range(WARMUP, N - HOLD_BARS):
        atr = atr_at[i]
        if np.isnan(atr) or atr < MIN_ATR_ABS:
            continue
        atr_avg = atr_avg_at[i]
        # Only mark valid if ATR is above the tightest ratio we sweep
        # (outcomes are direction-dependent, so we need a trend)
        trend = ema_trend[i]
        if trend == 0:
            continue
        atr_at_valid[i] = True

        entry = ha1_c[i - 1]      # price = last closed M1 ha_close
        sl_d  = atr * ATR_SL_MULT
        tp_d  = atr * ATR_TP_MULT

        if trend == 1:    # BUY
            sl = entry - sl_d
            tp = entry + tp_d
        else:             # SELL
            sl = entry + sl_d
            tp = entry - tp_d

        # Walk forward
        result = 0   # TIMEOUT default
        for k in range(i, min(i + HOLD_BARS, N)):
            bar_h = m1h[k]
            bar_l = m1l[k]
            if trend == 1:
                if bar_l <= sl:  result = -1; break
                if bar_h >= tp:  result =  1; break
            else:
                if bar_h >= sl:  result = -1; break
                if bar_l <= tp:  result =  1; break
        outcome_arr[i] = result

    features = {
        "ema_trend":        ema_trend,
        "h1_trend1":        h1_trend1,
        "h1_trend2":        h1_trend2,
        "doji_body_ratio":  doji_body_ratio,
        "doji_vol_ratio":   doji_vol_ratio,
        "clean_pb":         clean_pb,
        "m5_bullish":       m5_bullish,
        "m5_bearish":       m5_bearish,
        "m5_bull_wick":     m5_bull_wick,
        "m5_bear_wick":     m5_bear_wick,
        "m1_conf_bull":     m1_conf_bull,
        "m1_conf_bear":     m1_conf_bear,
        "atr_at":           atr_at,
        "atr_avg_at":       atr_avg_at,
        "atr_at_valid":     atr_at_valid,
        "outcome_arr":      outcome_arr,
        "m1_ts_min":        m1_ts,   # int64 ns — for cooldown calc
    }
    print("  Pre-computation done.\n")
    return features, N


# ════════════════════════════════════════════════════════════
# EVALUATE ONE PARAMETER COMBINATION  (vectorised + cooldown)
# ════════════════════════════════════════════════════════════
def eval_combo(features, params, N):
    f = features

    # ── Build base filter mask ────────────────────────────────
    trend   = f["ema_trend"]
    h1      = f["h1_trend2"] if params["h1_consecutive"] == 2 else f["h1_trend1"]

    valid   = (f["atr_at_valid"]
               & (trend != 0)
               & (h1 == trend)               # H1 agrees with EMA
               & ~np.isnan(f["doji_body_ratio"])
               & (f["doji_body_ratio"] < params["doji_threshold"])
               & ~np.isnan(f["doji_vol_ratio"])
               & (f["doji_vol_ratio"] >= params["doji_vol_threshold"])
               & f["clean_pb"][(params["pullback_n"], params["pullback_wick_tol"])])

    # ATR ratio filter
    atr_ratio = np.where(f["atr_avg_at"] > 0,
                         f["atr_at"] / f["atr_avg_at"],
                         0.0)
    valid &= (atr_ratio >= params["min_atr_ratio"])

    # M5 direction
    m5_ok = np.where(trend == 1, f["m5_bullish"],
            np.where(trend == -1, f["m5_bearish"], False))
    valid &= m5_ok

    # M5 wick quality (optional)
    if params["m5_wick_check"]:
        m5_wick_ok = np.where(trend == 1,  f["m5_bull_wick"] <= 0.20,
                     np.where(trend == -1, f["m5_bear_wick"] <= 0.20, True))
        valid &= m5_wick_ok

    # M1 confirmation candle
    m1_conf = np.where(trend == 1, f["m1_conf_bull"],
              np.where(trend == -1, f["m1_conf_bear"], False))
    valid &= m1_conf

    # ── Cooldown filter (sequential — can't be vectorised fully) ──
    gap_ns = int(params["min_signal_gap_min"] * 60 * 1_000_000_000)
    indices = np.where(valid)[0]

    if gap_ns > 0 and len(indices) > 1:
        keep = np.ones(len(indices), dtype=bool)
        last_ts = f["m1_ts_min"][indices[0]]
        for k in range(1, len(indices)):
            ts = f["m1_ts_min"][indices[k]]
            if ts - last_ts < gap_ns:
                keep[k] = False
            else:
                last_ts = ts
        indices = indices[keep]

    if len(indices) == 0:
        return None

    outcomes = f["outcome_arr"][indices]
    wins      = int((outcomes == 1).sum())
    losses    = int((outcomes == -1).sum())
    timeouts  = int((outcomes == 0).sum())
    total     = len(outcomes)
    win_pct   = wins / total * 100
    ev        = (wins * ATR_TP_MULT - losses * ATR_SL_MULT - timeouts * 0.5) / total

    # signals per day (approx: N bars ÷ 1440 M1 bars/day)
    days_covered = N / 1440
    spd = total / days_covered if days_covered > 0 else 0

    return {
        "total":   total,
        "wins":    wins,
        "losses":  losses,
        "timeouts":timeouts,
        "win_pct": round(win_pct, 1),
        "ev_r":    round(ev, 3),
        "sig_day": round(spd, 1),
    }


# ════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════
def main():
    connect()
    symbol = resolve_symbol()

    print(f"\nFetching data…")
    m1_raw = fetch(symbol, mt5.TIMEFRAME_M1, BARS_M1)
    m5_raw = fetch(symbol, mt5.TIMEFRAME_M5, BARS_M5)
    h1_raw = fetch(symbol, mt5.TIMEFRAME_H1, BARS_H1)
    mt5.shutdown()

    print(f"M1: {len(m1_raw)} bars  "
          f"({m1_raw['time'].iloc[0].strftime('%Y-%m-%d')} → "
          f"{m1_raw['time'].iloc[-1].strftime('%Y-%m-%d')})")

    features, N = precompute(m1_raw, m5_raw, h1_raw)

    keys   = list(GRID.keys())
    values = list(GRID.values())
    combos = list(itertools.product(*values))
    print(f"Parameter combinations: {len(combos)}")
    print("Running sweep…\n")

    t0 = _time.time()
    all_results = []
    for i, combo in enumerate(combos):
        params = dict(zip(keys, combo))
        r = eval_combo(features, params, N)
        if r:
            all_results.append({**params, **r})
        if (i + 1) % 200 == 0:
            elapsed = _time.time() - t0
            eta = elapsed / (i + 1) * (len(combos) - i - 1)
            print(f"  {i+1}/{len(combos)}  ETA {eta:.0f}s")

    elapsed = _time.time() - t0
    print(f"\nSweep complete in {elapsed:.1f}s  ({len(all_results)} valid combos)\n")

    df = pd.DataFrame(all_results).sort_values("ev_r", ascending=False).reset_index(drop=True)
    out_file = "param_sweep_results.csv"
    df.to_csv(out_file, index=False)
    print(f"Results saved → {out_file}\n")

    # ── Top N table ──────────────────────────────────────────
    cols = ["doji_threshold","doji_vol_threshold","pullback_n","pullback_wick_tol",
            "h1_consecutive","min_atr_ratio","m5_wick_check","min_signal_gap_min",
            "total","sig_day","win_pct","ev_r"]
    print(f"{'='*120}")
    print(f"TOP {TOP_N} COMBINATIONS BY EXPECTED VALUE  (R/trade)")
    print(f"{'='*120}")
    pd.set_option("display.max_columns", 20)
    pd.set_option("display.width", 200)
    print(df.head(TOP_N)[cols].to_string(index=True))

    # ── Current config rank ──────────────────────────────────
    current = dict(doji_threshold=0.20, doji_vol_threshold=0.70, pullback_n=2,
                   pullback_wick_tol=0.15, h1_consecutive=1, min_atr_ratio=0.70,
                   m5_wick_check=False, min_signal_gap_min=0)
    mask = pd.Series([True] * len(df))
    for k, v in current.items():
        mask &= df[k] == v
    matches = df[mask]
    if len(matches):
        rank = matches.index[0] + 1
        r    = matches.iloc[0]
        print(f"\n{'='*60}")
        print(f"CURRENT CONFIG  →  rank #{rank} of {len(df)}")
        print(f"  Trades: {r['total']}  Sig/day: {r['sig_day']}  "
              f"WR: {r['win_pct']}%  EV: {r['ev_r']}R")
        print(f"{'='*60}")

    # ── Single-param impact ──────────────────────────────────
    print(f"\n{'='*70}")
    print("SINGLE-PARAMETER IMPACT  (avg EV and WR across all combos)")
    print(f"{'='*70}")
    for param, vals in GRID.items():
        print(f"\n  {param}:")
        for v in vals:
            sub = df[df[param] == v]
            print(f"    {str(v):>6}  EV={sub['ev_r'].mean():+.3f}R  "
                  f"WR={sub['win_pct'].mean():.1f}%  "
                  f"sig/day={sub['sig_day'].mean():.1f}")

    print("\nDone.")


if __name__ == "__main__":
    main()
