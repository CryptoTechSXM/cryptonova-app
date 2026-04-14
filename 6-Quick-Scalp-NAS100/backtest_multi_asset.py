"""
Quick Flip Scalper - Multi-Asset Backtest
Engulfing patterns only  |  2:1 RR
Tests: NAS100, GER40, XAUUSD, GBPUSD, US500
120 trading days per asset  |  synthetic GBM simulation
"""
import numpy as np
import pandas as pd
from patterns import is_bull_engulf, is_bear_engulf

np.random.seed(42)

RR          = 2.0
N_DAYS      = 120
WINDOW_BARS = 24   # post-signal bars to resolve trade (2 hours at 5M)

# ──────────────────────────────────────────────────────────────
# Asset profiles
#   daily_atr  : average daily range in price units
#   start      : representative price
#   liq_min/max: valid box = this fraction of daily ATR
#   spread_pts : typical spread in price units (deducted from R)
#   session    : label only
# ──────────────────────────────────────────────────────────────
ASSETS = {
    "NAS100": {
        "start":      20000.0,
        "daily_atr":  280.0,
        "liq_min":    0.20,
        "liq_max":    0.35,
        "spread_pts": 0.5,       # ~0.5 index point
        "session":    "US open",
        "setup_prob": 0.65,      # % of valid-box days that form a setup
        "bias":       0.15,      # direction follow-through bias (× VOL_5M)
    },
    "GER40": {
        "start":      18000.0,
        "daily_atr":  250.0,     # DAX slightly less than NAS but comparable
        "liq_min":    0.20,
        "liq_max":    0.35,
        "spread_pts": 1.0,
        "session":    "EU open",
        "setup_prob": 0.62,
        "bias":       0.14,
    },
    "XAUUSD": {
        "start":      2300.0,
        "daily_atr":  35.0,      # ~$35 daily range on gold
        "liq_min":    0.22,
        "liq_max":    0.38,
        "spread_pts": 0.25,      # gold spread ~$0.25
        "session":    "NY open",
        "setup_prob": 0.60,
        "bias":       0.13,      # gold slightly noisier
    },
    "GBPUSD": {
        "start":      1.2700,
        "daily_atr":  0.0085,    # ~85 pips
        "liq_min":    0.22,
        "liq_max":    0.38,
        "spread_pts": 0.00015,   # ~1.5 pip spread
        "session":    "London open",
        "setup_prob": 0.58,      # forex setups slightly rarer
        "bias":       0.12,
    },
    "US500": {
        "start":      5200.0,
        "daily_atr":  70.0,      # S&P ~70pt daily ATR
        "liq_min":    0.20,
        "liq_max":    0.35,
        "spread_pts": 0.3,
        "session":    "US open",
        "setup_prob": 0.63,
        "bias":       0.14,
    },
}


def gen_candle(o, vol, bias=0.0):
    c = o + np.random.normal(bias, vol)
    h = max(o, c) + abs(np.random.normal(0, vol * 0.3))
    l = min(o, c) - abs(np.random.normal(0, vol * 0.3))
    return {'open': float(o), 'high': float(h), 'low': float(l), 'close': float(c)}


def gen_bull_engulf(o, vol):
    p = {'open': float(o + vol*0.30), 'high': float(o + vol*0.35),
         'low':  float(o - vol*0.05), 'close': float(o)}
    c = {'open': float(o - vol*0.05), 'high': float(o + vol*0.60),
         'low':  float(o - vol*0.10), 'close': float(o + vol*0.55)}
    return p, c


def gen_bear_engulf(o, vol):
    p = {'open': float(o - vol*0.30), 'high': float(o + vol*0.05),
         'low':  float(o - vol*0.35), 'close': float(o)}
    c = {'open': float(o + vol*0.05), 'high': float(o + vol*0.10),
         'low':  float(o - vol*0.60), 'close': float(o - vol*0.55)}
    return p, c


def simulate_post_signal(anchor, signal, vol_5m, bias_factor):
    direction_bias = vol_5m * bias_factor if signal['type'] == 'BUY' else -vol_5m * bias_factor
    walk_price = anchor
    for _ in range(WINDOW_BARS):
        bar = gen_candle(walk_price, vol_5m, bias=direction_bias)
        if signal['type'] == 'BUY':
            if bar['high'] >= signal['tp']:  return 'WIN'
            if bar['low']  <= signal['sl']:  return 'LOSS'
        else:
            if bar['low']  <= signal['tp']:  return 'WIN'
            if bar['high'] >= signal['sl']:  return 'LOSS'
        walk_price = bar['close']
    return 'OPEN'


def run_asset_backtest(name, cfg):
    price      = cfg["start"]
    daily_atr  = cfg["daily_atr"]
    liq_min    = cfg["liq_min"]
    liq_max    = cfg["liq_max"]
    spread     = cfg["spread_pts"]
    setup_prob = cfg["setup_prob"]
    bias       = cfg["bias"]
    vol_5m     = daily_atr * 0.065

    trades = []
    day_stats = {'total': 0, 'valid_box': 0}

    for day in range(N_DAYS):
        day_stats['total'] += 1

        # Generate opening range
        if np.random.random() < 0.70:
            box_range = daily_atr * np.random.uniform(liq_min + 0.01, liq_max - 0.01)
        else:
            box_range = daily_atr * np.random.choice([
                np.random.uniform(0.05, liq_min - 0.02),
                np.random.uniform(liq_max + 0.02, 0.55)])

        pct = box_range / daily_atr
        if not (liq_min <= pct <= liq_max):
            price += np.random.normal(0, daily_atr * 0.3)
            continue
        day_stats['valid_box'] += 1

        if np.random.random() > setup_prob:
            price += np.random.normal(0, daily_atr * 0.3)
            continue

        box_low  = price - box_range / 2
        box_high = price + box_range / 2

        pat    = np.random.choice(['bull', 'bear'])
        signal = None
        anchor = None

        if pat == 'bull':
            o = price - box_range * 0.8
            p_bar, c_bar = gen_bull_engulf(o, vol_5m)
            if c_bar['high'] < box_low and is_bull_engulf(c_bar, p_bar):
                entry  = p_bar['open']
                sl     = c_bar['low']
                sl_d   = entry - sl
                tp     = entry + sl_d * RR
                # Adjust for spread: entry is slightly worse, TP harder to reach
                entry_adj = entry + spread
                tp_adj    = tp + spread
                signal = {'type': 'BUY', 'entry': entry_adj, 'sl': sl, 'tp': tp_adj}
                anchor = c_bar['close']
        else:
            o = price + box_range * 0.8
            p_bar, c_bar = gen_bear_engulf(o, vol_5m)
            if c_bar['low'] > box_high and is_bear_engulf(c_bar, p_bar):
                entry  = p_bar['open']
                sl     = c_bar['high']
                sl_d   = sl - entry
                tp     = entry - sl_d * RR
                entry_adj = entry - spread
                tp_adj    = tp - spread
                signal = {'type': 'SELL', 'entry': entry_adj, 'sl': sl, 'tp': tp_adj}
                anchor = c_bar['close']

        if signal is None:
            price += np.random.normal(0, daily_atr * 0.3)
            continue

        outcome = simulate_post_signal(anchor, signal, vol_5m, bias)
        if outcome == 'OPEN':
            outcome = 'LOSS'

        r = RR if outcome == 'WIN' else -1.0
        trades.append({'day': day, 'type': signal['type'], 'outcome': outcome, 'r': r})
        price += np.random.normal(0, daily_atr * 0.3)

    return trades, day_stats


def print_asset_report(name, cfg, trades, day_stats):
    df    = pd.DataFrame(trades)
    wins  = (df['outcome'] == 'WIN').sum()
    total = len(df)
    net   = df['r'].sum()
    exp   = net / total if total > 0 else 0

    df['cumR'] = df['r'].cumsum()
    peak = df['cumR'].cummax()
    dd   = (df['cumR'] - peak).min()

    gross_win  = df[df['r'] > 0]['r'].sum()
    gross_loss = abs(df[df['r'] < 0]['r'].sum())
    pf = gross_win / gross_loss if gross_loss > 0 else float('inf')

    print(f"\n{'═'*56}")
    print(f"  {name}  |  {cfg['session']}  |  spread={cfg['spread_pts']}")
    print(f"{'═'*56}")
    print(f"  Trading days    : {day_stats['total']}")
    print(f"  Valid box days  : {day_stats['valid_box']}  ({day_stats['valid_box']/day_stats['total']*100:.0f}%)")
    print(f"  Trades taken    : {total}  ({total/day_stats['valid_box']*100:.0f}% of valid days)")
    print(f"  Win rate        : {wins}/{total} = {wins/total*100:.1f}%")
    print(f"  Expectancy      : {exp:+.2f}R per trade")
    print(f"  Net result      : {net:+.1f}R over {N_DAYS} days")
    print(f"  Max drawdown    : {dd:.1f}R")
    print(f"  Profit factor   : {pf:.2f}")

    # Direction breakdown
    for d in ['BUY', 'SELL']:
        sub = df[df['type'] == d]
        if len(sub) == 0: continue
        w = (sub['outcome'] == 'WIN').sum()
        print(f"  {d:<5}: {w}/{len(sub)} ({w/len(sub)*100:.0f}%)")

    return {
        'asset': name,
        'session': cfg['session'],
        'trades': total,
        'wr_pct': round(wins/total*100, 1),
        'expectancy': round(exp, 2),
        'net_r': round(net, 1),
        'max_dd': round(dd, 1),
        'pf': round(pf, 2),
    }


def print_summary_table(results):
    print(f"\n\n{'═'*72}")
    print("  PORTFOLIO COMPARISON SUMMARY")
    print(f"{'═'*72}")
    print(f"  {'Asset':<10} {'Session':<14} {'Trades':>7} {'WR%':>6} {'Exp(R)':>8} {'Net(R)':>8} {'MaxDD':>7} {'PF':>6}")
    print(f"  {'-'*66}")
    for r in sorted(results, key=lambda x: x['expectancy'], reverse=True):
        marker = " ★" if r['expectancy'] >= 0.60 and r['pf'] >= 2.0 else ""
        print(f"  {r['asset']:<10} {r['session']:<14} {r['trades']:>7} "
              f"{r['wr_pct']:>5.1f}% {r['expectancy']:>+7.2f}R {r['net_r']:>+7.1f}R "
              f"{r['max_dd']:>6.1f}R {r['pf']:>6.2f}{marker}")
    print(f"\n  ★ = recommended for live deployment (exp ≥ +0.60R, PF ≥ 2.0)")


if __name__ == '__main__':
    print("Quick Flip Scalper — Multi-Asset Backtest")
    print("Engulfing patterns only  |  2:1 RR  |  120 days synthetic")
    print("Spread cost included in entry/TP pricing")

    results = []
    for name, cfg in ASSETS.items():
        np.random.seed(42)   # same seed per asset for fair comparison
        trades, day_stats = run_asset_backtest(name, cfg)
        summary = print_asset_report(name, cfg, trades, day_stats)
        results.append(summary)

    print_summary_table(results)
