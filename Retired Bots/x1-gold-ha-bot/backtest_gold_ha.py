"""
backtest_gold_ha.py
===================
Monte Carlo backtest comparing:
  - OLD 3-gold strategy (H1 + M1 EMA + doji + pullback + M5x1 + M1x1)
  - NEW 3-gold strategy (all rules from image + M5x2 + M1x2 + doji color + market structure)

Filter-chain probabilities estimated from HA strategy empirics.
Session: 07:00-21:00 UTC = 840 M1 candles per trading day.
"""

import random, statistics
random.seed(42)

# ──────────────────────────────────────────────
# FILTER CHAINS
# ──────────────────────────────────────────────

OLD_FILTERS = {
    "atr_floor":        0.82,   # ATR above minimum
    "h1_trend_2x":      0.55,   # 2 consecutive H1 HA candles same direction
    "m1_ema":           0.70,   # price on correct side of M1 EMA100
    "doji_0.15":        0.07,   # body/range < 15%
    "high_vol_doji":    0.65,   # doji range >= 85% avg
    "clean_pullback_2": 0.28,   # 2 clean no-wick pullback candles
    "m5_confirm_x1":    0.50,   # 1 M5 HA candle in direction
    "m1_confirm_x1":    0.35,   # 1 strong no-wick M1 candle
}

NEW_FILTERS = {
    "atr_floor":        0.85,   # ATR floor (gold usually active)
    "h1_trend_2x":      0.55,   # 2 consecutive H1 HA candles
    "m1_ema":           0.70,   # M1 EMA100 direction
    "m5_ema":           0.75,   # M5 EMA100 must agree
    "doji_0.15":        0.07,   # body/range < 15%
    "high_vol_doji":    0.65,   # doji range >= 85% avg
    "doji_color":       0.50,   # doji color matches trade direction
    "market_structure": 0.80,   # doji above/below EMA (higher low / lower high)
    "clean_pullback_2": 0.28,   # 2 clean no-wick pullback candles
    "m5_confirm_x2":    0.35,   # 2 consecutive M5 HA candles
    "m1_confirm_x2":    0.25,   # 2 consecutive strong no-wick M1 candles
}

# ──────────────────────────────────────────────
# OUTCOME PARAMETERS
# ──────────────────────────────────────────────

CANDLES_PER_DAY = 840    # 07:00-21:00 UTC session
DAYS            = 60
SIMS            = 1000
COMMISSION      = 0.05   # in R units

# Old: ATR-based SL/TP → 1.5 R:R
OLD_WIN_RATE = 0.62
OLD_RR       = 1.5

# New: stricter filters → higher quality signals
# Doji-wick SL + TP_ATR_MULTIPLIER=3.0 → avg ~1.8 R:R (tighter SL than ATR*2)
NEW_WIN_RATE = 0.67
NEW_RR       = 1.8


def p_signal(filters):
    p = 1.0
    for v in filters.values():
        p *= v
    return p


def simulate(p_sig, win_rate, rr, label):
    results = []
    trade_counts = []
    drawdowns = []

    for _ in range(SIMS):
        total_r = tc = wins = 0
        peak = dd = 0.0
        for _ in range(DAYS):
            for _ in range(CANDLES_PER_DAY):
                if random.random() < p_sig:
                    tc += 1
                    if random.random() < win_rate:
                        r = rr - COMMISSION
                        wins += 1
                    else:
                        r = -1.0 - COMMISSION
                    total_r += r
                    if total_r > peak: peak = total_r
                    dd = max(dd, peak - total_r)
        results.append(total_r)
        trade_counts.append(tc)
        drawdowns.append(dd)

    results.sort()
    avg_r  = statistics.mean(results)
    std_r  = statistics.stdev(results)
    p5     = results[int(SIMS * 0.05)]
    p50    = results[SIMS // 2]
    p95    = results[int(SIMS * 0.95)]
    avg_tc = statistics.mean(trade_counts)
    avg_dd = statistics.mean(drawdowns)
    pct_p  = sum(1 for r in results if r > 0) / SIMS * 100

    return {
        "label":    label,
        "p_sig":    p_sig,
        "avg_r":    avg_r,
        "std_r":    std_r,
        "p5":       p5,
        "p50":      p50,
        "p95":      p95,
        "avg_tc":   avg_tc,
        "avg_dd":   avg_dd,
        "pct_p":    pct_p,
        "win_rate": win_rate,
        "rr":       rr,
    }


# ──────────────────────────────────────────────
# RUN
# ──────────────────────────────────────────────

p_old = p_signal(OLD_FILTERS)
p_new = p_signal(NEW_FILTERS)

old = simulate(p_old, OLD_WIN_RATE, OLD_RR, "OLD (M5x1 + M1x1)")
new = simulate(p_new, NEW_WIN_RATE, NEW_RR, "NEW (M5x2 + M1x2 + color + structure)")

print("=" * 65)
print(f"GOLD HA STRATEGY BACKTEST  ({SIMS} sims x {DAYS} days)")
print(f"Session: 07:00-21:00 UTC  ({CANDLES_PER_DAY} M1 candles/day)")
print("=" * 65)

# Filter chain breakdown
print()
print("OLD FILTER CHAIN:")
running = 1.0
for k, v in OLD_FILTERS.items():
    running *= v
    print(f"  {k:<22} {v:.0%}  → cumulative {running:.4%}")
print()
print("NEW FILTER CHAIN:")
running = 1.0
for k, v in NEW_FILTERS.items():
    running *= v
    print(f"  {k:<22} {v:.0%}  → cumulative {running:.4%}")

print()
print("=" * 65)
print(f"{'Metric':<28} {'OLD':>12} {'NEW':>12}")
print("-" * 65)
print(f"{'P(signal per candle)':<28} {old['p_sig']:.4%}      {new['p_sig']:.4%}")
print(f"{'Signals per day':<28} {old['p_sig']*CANDLES_PER_DAY:>12.2f} {new['p_sig']*CANDLES_PER_DAY:>12.2f}")
print(f"{'Avg trades / {DAYS} days':<28} {old['avg_tc']:>12.1f} {new['avg_tc']:>12.1f}")
print(f"{'Win rate':<28} {old['win_rate']:>11.0%} {new['win_rate']:>11.0%}")
print(f"{'R:R':<28} {old['rr']:>12.1f} {new['rr']:>12.1f}")
print(f"{'EV per trade (R)':<28} {old['win_rate']*old['rr']-(1-old['win_rate'])-COMMISSION:>+12.4f} {new['win_rate']*new['rr']-(1-new['win_rate'])-COMMISSION:>+12.4f}")
print(f"{'Avg R over {DAYS} days':<28} {old['avg_r']:>+12.2f} {new['avg_r']:>+12.2f}")
print(f"{'5th percentile (worst 5%)':<28} {old['p5']:>+12.2f} {new['p5']:>+12.2f}")
print(f"{'Median R':<28} {old['p50']:>+12.2f} {new['p50']:>+12.2f}")
print(f"{'95th percentile (best 5%)':<28} {old['p95']:>+12.2f} {new['p95']:>+12.2f}")
print(f"{'Avg max drawdown (R)':<28} {old['avg_dd']:>12.2f} {new['avg_dd']:>12.2f}")
print(f"{'% sims profitable':<28} {old['pct_p']:>11.1f}% {new['pct_p']:>11.1f}%")
print("=" * 65)
print()

# Signal frequency in plain English
old_per_day = old['p_sig'] * CANDLES_PER_DAY
new_per_day = new['p_sig'] * CANDLES_PER_DAY
print("SIGNAL FREQUENCY:")
print(f"  Old: {old_per_day:.2f}/day  →  1 signal every {1/old_per_day:.0f} trading days")
if new_per_day > 0:
    print(f"  New: {new_per_day:.4f}/day →  1 signal every {1/new_per_day:.0f} trading days")
else:
    print(f"  New: {new_per_day:.4f}/day →  extremely rare")

print()
ev_old = old['win_rate'] * old['rr'] - (1 - old['win_rate']) - COMMISSION
ev_new = new['win_rate'] * new['rr'] - (1 - new['win_rate']) - COMMISSION
print("VERDICT:")
if new_per_day < 0.1:
    print("  ⚠  NEW strategy fires < 1 signal every 10 days.")
    print("     Filters may be TOO strict for live use.")
    print("     Consider loosening: M1x2 wick tolerance OR doji color.")
elif ev_new > ev_old:
    print(f"  OK  NEW strategy has higher EV ({ev_new:+.3f}R vs {ev_old:+.3f}R)")
    print(f"     but fires {old_per_day/new_per_day:.0f}x less often. Quality over quantity.")
else:
    print("  INFO  Old strategy has better overall R due to higher volume.")
