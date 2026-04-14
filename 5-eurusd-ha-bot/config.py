# ============================================================
#  EURUSD HA BOT V1 - CONFIGURATION
# ============================================================

SYMBOL = 'EURUSD'

TIMEFRAMES = {
    'M1': 1,
    'M5': 5,
    'H1': 60,
}

# --- Position sizing ---
RISK_PERCENT = 1.0        # % of balance risked per trade

# --- Indicators ---
EMA_PERIOD = 100
ATR_PERIOD = 14

# --- Stop loss and take profit ---
# EURUSD M5 ATR is typically 0.0003-0.0008 (3-8 pips) during London/NY.
ATR_MULTIPLIER          = 1.5   # SL = ATR x this
TP_ATR_MULTIPLIER       = 3.0   # TP = ATR x this
TRAILING_ATR_MULTIPLIER = 2.0

# --- Entry filters ---
DOJI_THRESHOLD = 0.15
# Below 0.0003 (3 pips) = market is ranging/dead, skip.
MIN_ATR = 0.0003

# --- Exit ---
REVERSAL_CANDLES_REQUIRED = 2

# --- Session filter (UTC) ---
# EURUSD is most active during London (07:00-16:00) and NY (13:00-20:00).
# Full window 07:00-20:00 covers both sessions.
SESSION_START_UTC = 7     # 07:00 UTC = London open
SESSION_END_UTC   = 20    # 20:00 UTC = NY close

# --- Daily safety limits ---
MAX_DAILY_TRADES   = 3
MAX_DAILY_LOSS_PCT = 3.0

# --- Execution filters ---
# EURUSD normal spread: 0.5-1.5 pips = 5-15 points (5-digit broker).
# 20 points = 2 pips max before skipping.
MAX_SPREAD   = 20
MAGIC_NUMBER = 20260414

# --- Timing ---
CHECK_INTERVAL = 5
TRADE_COOLDOWN = 300