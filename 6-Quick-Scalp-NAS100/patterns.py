# ── Pattern Detection for Quick Flip Scalper ───────────────


def is_hammer(c, threshold=0.3):
    """Small body at top, long lower wick (>=60% of range), tiny upper wick."""
    body  = abs(c['close'] - c['open'])
    rng   = c['high'] - c['low']
    if rng == 0:
        return False
    lower = min(c['open'], c['close']) - c['low']
    upper = c['high'] - max(c['open'], c['close'])
    return body / rng < threshold and lower / rng >= 0.6 and upper <= body


def is_inv_hammer(c, threshold=0.3):
    """Small body at bottom, long upper wick (>=60% of range), tiny lower wick."""
    body  = abs(c['close'] - c['open'])
    rng   = c['high'] - c['low']
    if rng == 0:
        return False
    upper = c['high'] - max(c['open'], c['close'])
    lower = min(c['open'], c['close']) - c['low']
    return body / rng < threshold and upper / rng >= 0.6 and lower <= body


def is_bull_engulf(c, p):
    """Current green candle fully engulfs previous red candle."""
    prev_red   = p['close'] < p['open']
    curr_green = c['close'] > c['open']
    engulfs    = c['open'] <= p['close'] and c['close'] >= p['open']
    return prev_red and curr_green and engulfs


def is_bear_engulf(c, p):
    """Current red candle fully engulfs previous green candle."""
    prev_green = p['close'] > p['open']
    curr_red   = c['close'] < c['open']
    engulfs    = c['open'] >= p['close'] and c['close'] <= p['open']
    return prev_green and curr_red and engulfs
