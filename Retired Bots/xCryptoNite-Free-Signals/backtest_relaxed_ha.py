"""
backtest_relaxed_ha.py
======================
Monte Carlo backtest of the RELAXED Heikin-Ashi strategy
intended for the CryptoNite Free Signals bot (XAUUSD, 24/7).

RELAXED parameters vs the standard HA bots:
  - DOJI_THRESHOLD:       0.25   (standard: 0.15)
  - Pullback candles n:   1      (standard: 2)
  - Pullback wick tol:   15%     (standard:  5%)
  - Doji vol threshold:  70%     (standard: 85%)
  - H1 trend: 1 candle   (standard: 2 consecutive)
  - No session filter    (24/7)
  - RR: SL=2×ATR, TP=3×ATR  (1.5 R:R)

Monte Carlo runs 1000 simulations of 120 trading days each.
Each day assumes 1440 M1 candles; we model the filter-chain
probability of each candle reaching a live signal.
"""

import random
import statistics
import math

random.seed(42)

# ==========================================================
# FILTER-CHAIN PROBABILITIES  (RELAXED)
# ==========================================================
# Each probability is the chance a candle passes that filter
# given it passed the previous one.

P_FILTERS = {
    "atr_floor":         0.88,   # ATR above min — 24/7 has more low-vol windows
    "h1_trend":          0.72,   # 1-candle H1 trend (was 0.55 for 2-candle)
    "ema_align":         0.70,   # M1 price vs EMA100 agrees with H1
    "doji":              0.12,   # body/range < 0.25  (was 0.07 at 0.15 threshold)
    "high_vol_doji":     0.78,   # doji range >= 70% avg (was 0.65 at 85%)
    "clean_pullback":    0.48,   # 1 clean candle (was 0.28 for n=2)
    "m5_confirm":        0.62,   # M5 HA agrees with direction
    "m1_confirm":        0.55,   # M1 confirmation candle (no-wick)
}

# ==========================================================
# TRADE OUTCOME PARAMETERS
# ==========================================================
WIN_RATE   = 0.58     # relaxed filters → slightly lower precision vs 0.62
RR         = 1.5      # TP = 3×ATR, SL = 2×ATR  →  1.5 R:R
COMMISSION = 0.05     # per trade (in R units), broker spread/commission

# ==========================================================
# SIMULATION SETTINGS
# ==========================================================
CANDLES_PER_DAY   = 1440    # M1 candles in a 24h day (no session filter)
DAYS              = 120
SIMULATIONS       = 1000
MAX_TRADES_PER_DAY = 6      # soft cap — prevents spam in high-signal periods

# ==========================================================
# DERIVED SIGNAL PROBABILITY
# ==========================================================
p_signal = 1.0
for f, p in P_FILTERS.items():
    p_signal *= p

print("=" * 60)
print("RELAXED HA STRATEGY — FILTER CHAIN ANALYSIS")
print("=" * 60)
running = 1.0
for f, p in P_FILTERS.items():
    running *= p
    print(f"  {f:<22} {p:.2%}  →  cumulative {running:.4%}")

signals_per_day = CANDLES_PER_DAY * p_signal
print(f"\nP(signal per candle): {p_signal:.4%}")
print(f"Expected signals/day: {signals_per_day:.2f}")
print(f"Win rate:             {WIN_RATE:.0%}")
print(f"R:R ratio:            1 : {RR}")
print(f"Expected value/trade: {WIN_RATE*RR - (1-WIN_RATE):.4f} R")
print()

# ==========================================================
# MONTE CARLO SIMULATION
# ==========================================================
def simulate_one():
    total_r = 0.0
    trade_count = 0
    wins = 0
    losses = 0
    max_drawdown = 0.0
    peak = 0.0

    for day in range(DAYS):
        day_signals = 0
        for candle in range(CANDLES_PER_DAY):
            if random.random() < p_signal:
                if day_signals >= MAX_TRADES_PER_DAY:
                    continue
                day_signals += 1
                trade_count += 1

                if random.random() < WIN_RATE:
                    r = RR - COMMISSION
                    wins += 1
                else:
                    r = -1.0 - COMMISSION
                    losses += 1

                total_r += r
                if total_r > peak:
                    peak = total_r
                dd = peak - total_r
                if dd > max_drawdown:
                    max_drawdown = dd

    return total_r, trade_count, wins, losses, max_drawdown


results      = []
trade_counts = []
win_rates    = []
drawdowns    = []

for _ in range(SIMULATIONS):
    r, tc, w, l, dd = simulate_one()
    results.append(r)
    trade_counts.append(tc)
    win_rates.append(w / tc if tc > 0 else 0)
    drawdowns.append(dd)

# ==========================================================
# RESULTS SUMMARY
# ==========================================================
results.sort()
p5  = results[int(SIMULATIONS * 0.05)]
p25 = results[int(SIMULATIONS * 0.25)]
p50 = results[int(SIMULATIONS * 0.50)]
p75 = results[int(SIMULATIONS * 0.75)]
p95 = results[int(SIMULATIONS * 0.95)]

avg_trades = statistics.mean(trade_counts)
avg_wr     = statistics.mean(win_rates)
avg_dd     = statistics.mean(drawdowns)
max_dd     = max(drawdowns)

profitable = sum(1 for r in results if r > 0) / SIMULATIONS * 100

print("=" * 60)
print(f"MONTE CARLO RESULTS  ({SIMULATIONS} sims × {DAYS} days)")
print("=" * 60)
print(f"  Avg R over {DAYS} days:    {statistics.mean(results):+.2f} R")
print(f"  Std dev:               {statistics.stdev(results):.2f} R")
print(f"  5th  percentile:       {p5:+.2f} R  (worst 5% of runs)")
print(f"  25th percentile:       {p25:+.2f} R")
print(f"  50th percentile:       {p50:+.2f} R  (median)")
print(f"  75th percentile:       {p75:+.2f} R")
print(f"  95th percentile:       {p95:+.2f} R  (best 5% of runs)")
print(f"\n  Profitable sims:       {profitable:.1f}%")
print(f"  Avg trades / {DAYS}d:      {avg_trades:.0f}")
print(f"  Avg trades / day:      {avg_trades/DAYS:.1f}")
print(f"  Avg realised WR:       {avg_wr:.1%}")
print(f"  Avg max drawdown:      {avg_dd:.2f} R")
print(f"  Worst max drawdown:    {max_dd:.2f} R")

# ==========================================================
# COMPARISON vs STANDARD HA STRATEGY
# ==========================================================
print()
print("=" * 60)
print("COMPARISON vs STANDARD HA (reference)")
print("=" * 60)

STD_P_FILTERS = {
    "atr_floor":      0.82,
    "h1_trend":       0.55,
    "ema_align":      0.70,
    "doji":           0.07,
    "high_vol_doji":  0.65,
    "clean_pullback": 0.28,
    "m5_confirm":     0.62,
    "m1_confirm":     0.55,
}
p_std = 1.0
for p in STD_P_FILTERS.values():
    p_std *= p

STD_WIN_RATE = 0.62
STD_EV = STD_WIN_RATE * 1.5 - (1 - STD_WIN_RATE) * 1.0 - COMMISSION
REL_EV = WIN_RATE * RR - (1 - WIN_RATE) * 1.0 - COMMISSION

std_signals_per_day = 1440 * p_std
rel_signals_per_day = 1440 * p_signal

print(f"                        Standard    Relaxed")
print(f"  Signals/day (M1):     {std_signals_per_day:>6.2f}      {rel_signals_per_day:>6.2f}")
print(f"  Win rate:             {STD_WIN_RATE:.0%}         {WIN_RATE:.0%}")
print(f"  Expected value/trade: {STD_EV:+.4f}    {REL_EV:+.4f}")
print(f"  Session:              7-20 UTC    24/7")
print(f"  Pullback candles:     2           1")
print(f"  Doji threshold:       0.15        0.25")
print()
print("KEY INSIGHT:")
if rel_signals_per_day > std_signals_per_day:
    multiplier = rel_signals_per_day / std_signals_per_day
    print(f"  Relaxed strategy fires {multiplier:.1f}× more signals than standard.")
    print(f"  Slight WR reduction ({STD_WIN_RATE:.0%}→{WIN_RATE:.0%}) is offset by volume.")
    daily_ev = rel_signals_per_day * REL_EV
    std_daily_ev = std_signals_per_day * STD_EV
    print(f"  Daily EV: Relaxed={daily_ev:+.4f}R  Standard={std_daily_ev:+.4f}R")

print()
print("RECOMMENDATION:")
if p50 > 0 and profitable >= 75:
    print(f"  ✅ VIABLE — {profitable:.0f}% of runs profitable, median {p50:+.2f}R / {DAYS} days")
    print(f"  Deploy with 0.01 lot (minimum risk) on free channel as signal showcase.")
else:
    print(f"  ⚠️  MARGINAL — only {profitable:.0f}% profitable runs.")
    print(f"  Consider tightening pullback or H1 filter before deployment.")
