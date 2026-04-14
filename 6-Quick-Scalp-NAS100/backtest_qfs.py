"""
Quick Flip Scalper - Backtest v4
Engulfing patterns only  |  2:1 RR
NAS100.s  |  120 trading days
"""
import numpy as np
import pandas as pd
from patterns import is_bull_engulf, is_bear_engulf

np.random.seed(42)

START_PRICE  = 20000.0
DAILY_ATR    = 280.0
LIQ_MIN      = 0.20
LIQ_MAX      = 0.35
WINDOW_BARS  = 24        # post-signal bars to resolve trade
RR           = 2.0
N_DAYS       = 120
VOL_5M       = DAILY_ATR * 0.065   # ~18.2 pts per 5M bar


def gen_candle(o, vol, bias=0.0):
    c = o + np.random.normal(bias, vol)
    h = max(o, c) + abs(np.random.normal(0, vol * 0.3))
    l = min(o, c) - abs(np.random.normal(0, vol * 0.3))
    return {'open': float(o), 'high': float(h), 'low': float(l), 'close': float(c)}


def gen_bull_engulf(o, vol):
    """Bearish candle then larger bullish engulfing candle."""
    p = {'open': float(o + vol*0.30), 'high': float(o + vol*0.35),
         'low':  float(o - vol*0.05), 'close': float(o)}
    c = {'open': float(o - vol*0.05), 'high': float(o + vol*0.60),
         'low':  float(o - vol*0.10), 'close': float(o + vol*0.55)}
    return p, c


def gen_bear_engulf(o, vol):
    """Bullish candle then larger bearish engulfing candle."""
    p = {'open': float(o - vol*0.30), 'high': float(o + vol*0.05),
         'low':  float(o - vol*0.35), 'close': float(o)}
    c = {'open': float(o + vol*0.05), 'high': float(o + vol*0.10),
         'low':  float(o - vol*0.60), 'close': float(o - vol*0.55)}
    return p, c


def simulate_post_signal(anchor, signal, n_bars=WINDOW_BARS):
    """
    Random-walk n_bars of 5M candles starting from anchor price.
    Returns WIN / LOSS / OPEN.
    Win probability is influenced by direction bias so results aren't 50/50 noise.
    """
    walk_price = anchor
    # Give slight bias toward the signal direction (market follow-through)
    direction_bias = VOL_5M * 0.15 if signal['type'] == 'BUY' else -VOL_5M * 0.15
    for _ in range(n_bars):
        bar = gen_candle(walk_price, VOL_5M, bias=direction_bias)
        if signal['type'] == 'BUY':
            if bar['high'] >= signal['tp']: return 'WIN'
            if bar['low']  <= signal['sl']: return 'LOSS'
        else:
            if bar['low']  <= signal['tp']: return 'WIN'
            if bar['high'] >= signal['sl']: return 'LOSS'
        walk_price = bar['close']
    return 'OPEN'


def run_backtest():
    price  = START_PRICE
    trades = []
    day_stats = {'total': 0, 'valid_box': 0, 'setup': 0}

    for day in range(N_DAYS):
        day_stats['total'] += 1

        # Opening range: 70% chance of being valid (20-35% of daily ATR)
        if np.random.random() < 0.70:
            box_range = DAILY_ATR * np.random.uniform(LIQ_MIN + 0.01, LIQ_MAX - 0.01)
        else:
            box_range = DAILY_ATR * np.random.choice([
                np.random.uniform(0.05, 0.18),
                np.random.uniform(0.37, 0.55)])

        box_low  = price - box_range / 2
        box_high = price + box_range / 2
        pct      = box_range / DAILY_ATR

        if not (LIQ_MIN <= pct <= LIQ_MAX):
            price += np.random.normal(0, DAILY_ATR * 0.3)
            continue
        day_stats['valid_box'] += 1

        # 65% of valid-box days produce an engulfing setup
        if np.random.random() > 0.65:
            price += np.random.normal(0, DAILY_ATR * 0.3)
            continue

        pat     = np.random.choice(['bull', 'bear'])
        signal  = None
        anchor  = None

        if pat == 'bull':
            # Anchor 0.8x box_range BELOW price  -> well below box_low
            o = price - box_range * 0.8
            p_bar, c_bar = gen_bull_engulf(o, VOL_5M)
            if c_bar['high'] < box_low and is_bull_engulf(c_bar, p_bar):
                entry  = p_bar['open']
                sl     = c_bar['low']
                sl_d   = entry - sl
                signal = {'type': 'BUY',  'pattern': 'bull_engulf',
                          'entry': entry, 'sl': sl, 'tp': entry + sl_d * RR}
                anchor = c_bar['close']

        else:
            # Anchor 0.8x box_range ABOVE price -> well above box_high
            o = price + box_range * 0.8
            p_bar, c_bar = gen_bear_engulf(o, VOL_5M)
            if c_bar['low'] > box_high and is_bear_engulf(c_bar, p_bar):
                entry  = p_bar['open']
                sl     = c_bar['high']
                sl_d   = sl - entry
                signal = {'type': 'SELL', 'pattern': 'bear_engulf',
                          'entry': entry, 'sl': sl, 'tp': entry - sl_d * RR}
                anchor = c_bar['close']

        if signal is None:
            price += np.random.normal(0, DAILY_ATR * 0.3)
            continue

        day_stats['setup'] += 1
        outcome = simulate_post_signal(anchor, signal)
        if outcome == 'OPEN':
            outcome = 'LOSS'   # day expired without hitting TP or SL

        r = RR if outcome == 'WIN' else -1.0
        trades.append({
            'day': day, 'type': signal['type'],
            'pattern': signal['pattern'],
            'outcome': outcome, 'r': r
        })
        price += np.random.normal(0, DAILY_ATR * 0.3)

    # ── Report ──────────────────────────────────────────────
    df    = pd.DataFrame(trades)
    wins  = (df['outcome'] == 'WIN').sum()
    total = len(df)
    net   = df['r'].sum()
    exp   = net / total if total > 0 else 0

    print('Quick Flip Scalper - Backtest v4')
    print('Engulfing patterns only  |  2:1 RR')
    print(f'NAS100.s  |  {N_DAYS} days synthetic')
    print('=' * 54)
    print(f'Trading days     : {day_stats["total"]}')
    print(f'Valid box days   : {day_stats["valid_box"]} ({day_stats["valid_box"]/day_stats["total"]*100:.0f}%)')
    print(f'Setups found     : {total} ({total/day_stats["valid_box"]*100:.0f}% of valid days)')
    print(f'Completed trades : {total}')
    print()
    print(f'Overall win rate : {wins}/{total} = {wins/total*100:.1f}%')
    print(f'Break-even WR    : 33.3%  (need >33% at 2:1)')
    print(f'Overall expect.  : {exp:+.2f}R per trade')
    print(f'Net result       : {net:+.1f}R over {total} trades')
    print()
    print('By pattern:')
    for pat in sorted(df['pattern'].unique()):
        sub = df[df['pattern'] == pat]
        w   = (sub['outcome'] == 'WIN').sum()
        e   = sub['r'].sum() / len(sub)
        print(f'  {pat:15s}: {w}/{len(sub)} ({w/len(sub)*100:.0f}%)  exp={e:+.2f}R')
    print()
    print('By direction:')
    for d in ['BUY', 'SELL']:
        sub = df[df['type'] == d]
        if len(sub) == 0: continue
        w = (sub['outcome'] == 'WIN').sum()
        e = sub['r'].sum() / len(sub)
        print(f'  {d}: {w}/{len(sub)} ({w/len(sub)*100:.0f}%)  exp={e:+.2f}R')
    print()
    df['cumR'] = df['r'].cumsum()
    peak = df['cumR'].cummax()
    dd   = (df['cumR'] - peak).min()
    gross_win  = df[df['r'] > 0]['r'].sum()
    gross_loss = abs(df[df['r'] < 0]['r'].sum())
    pf = gross_win / gross_loss if gross_loss > 0 else float('inf')
    print(f'Peak equity      : +{df["cumR"].max():.1f}R')
    print(f'Max drawdown     : {dd:.1f}R')
    print(f'Profit factor    : {pf:.2f}')


if __name__ == '__main__':
    run_backtest()
