# ============================================================
#  ETH HA BOT V1 — CONFIGURATION
#  All your settings live here. No need to touch other files.
#  Ported from BTC HA Bot V3 — adjusted for ETH characteristics.
# ============================================================

BASE_SYMBOL = "ETHUSD"  # broker-agnostic base name
SYMBOL = BASE_SYMBOL      # resolved to broker symbol at startup

TIMEFRAMES = {
    "M1": 1,
    "M5": 5,
    "H1": 60
}

# --- Position sizing ---
# "risk" mode: lot is calculated so a full SL hit = exactly RISK_PERCENT of balance.
# On a $97 account at 1%: max loss per trade = $0.97
RISK_PERCENT = 1.0       # % of balance to risk per trade

# --- Indicators ---
EMA_PERIOD = 100         # Trend filter on M1 (same as BTC)
ATR_PERIOD = 14          # Volatility measurement

# --- Stop loss & take profit ---
ATR_MULTIPLIER          = 2.0   # SL distance = ATR × this
TP_ATR_MULTIPLIER       = 3.0   # TP = ATR × this (3.0 / 2.0 SL = 1.5:1 R:R, matches portfolio ratio)
TRAILING_ATR_MULTIPLIER = 1.0
TRAIL_ATR_TRIGGER       = 0.75
TRAIL_ATR_BUFFER        = 0.50  # SL trails 0.50x ATR behind price (tighter trail)
BE_BUFFER_PTS           = 5.0   # SL placed 5 pts above entry when trail first fires (ETH floor)

# --- Entry filters ---
DOJI_THRESHOLD = 0.15    # Max body/range ratio to qualify as a doji
# ETH ATR is lower in absolute terms than BTC — adjusted threshold.
# BTC MIN_ATR was 50.0; ETH typically moves ~3–5 USD per M5 candle when active.
MIN_ATR        = 3.0     # Minimum M5 ATR to trade — skips flat/choppy markets

# --- Entry/exit timing ---
SESSION_CLOSE_BUFFER = 30  # minutes — no new entries within 30min of London/NY close

# --- Exit filters ---
REVERSAL_CANDLES_REQUIRED = 2   # Consecutive opposite M5 HA candles needed to exit

# --- Session filter (UTC hours) ---
# ETH follows similar liquidity patterns to BTC — London + NY overlap.
# ETH can also be active during Asian hours due to DeFi activity,
# but we keep the same conservative window to match the BTC bot's logic.
SESSION_START_UTC = 7    # 07:00 UTC  (London open)
SESSION_END_UTC   = 19   # 19:00 UTC  (NY afternoon — avoid late fakeouts)

# --- Daily safety limits ---
# MAX_DAILY_TRADES: stop opening NEW entries after this many trades today.
# 3 trades/day keeps exposure manageable on a small balance.
MAX_DAILY_TRADES = 3

# MAX_DAILY_LOSS_PCT: backstop — also stop if the day's realised loss exceeds
# this percentage of balance (whichever limit hits first wins).
# 3% of $97 ≈ $2.91
MAX_DAILY_LOSS_PCT = 6.0  # raised from 3% — min lot floors real risk at 2-4% per trade

# --- Spread filter ---
# Maximum allowed spread in MT5 points before skipping a trade.
# ETH spread is typically 10–50 points. Spike above this = bad fill risk.
MAX_SPREAD = 150   # points

# --- Timing ---
MAGIC_NUMBER    = 654321     # Different from BTC bot so MT5 can distinguish them
CHECK_INTERVAL  = 5          # seconds between loop ticks
TRADE_COOLDOWN  = 60         # seconds to wait after closing a trade before next entry
