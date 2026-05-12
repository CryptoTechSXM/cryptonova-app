# ============================================================
#  EURUSD HA BOT V1 - CONFIGURATION
# ============================================================

BASE_SYMBOL = "EURUSD"  # broker-agnostic base name
SYMBOL = BASE_SYMBOL      # resolved to broker symbol at startup

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
TP_ATR_MULTIPLIER       = 1.5   # TP = ATR x this (was 1.0 → 1:1; now 1.5R gives better expectancy)
TRAILING_ATR_MULTIPLIER = 1.0
# Trail fires at 0.75x ATR profit (~3-4 pips) — was 0.30 (1.5 pips) which caused instant BE exits.
# TP is only removed once trail SL crosses entry (true breakeven+), not at first trail tick.
TRAIL_ATR_TRIGGER       = 0.75
TRAIL_ATR_BUFFER        = 0.50    # SL trails 0.50x ATR behind price (was 0.25 — too tight, caused noise stops)
BE_BUFFER_PTS           = 0.0003  # Lock in 3 pips above entry before trailing free (was 0.0005)

# --- Entry filters ---
DOJI_THRESHOLD = 0.15
# Below 0.0003 (3 pips) = market is ranging/dead, skip.
MIN_ATR = 0.0003

# --- Timing ---
SESSION_CLOSE_BUFFER = 30  # minutes — no new entries within 30min of session close

# --- Exit ---
REVERSAL_CANDLES_REQUIRED = 2

# --- Session filter (UTC) ---
# EURUSD is most active during London (07:00-16:00) and NY (13:00-20:00).
# Full window 07:00-20:00 covers both sessions.
SESSION_START_UTC = 7     # 07:00 UTC = London open
SESSION_END_UTC   = 19    # 19:00 UTC — avoid late NY session fakeouts

# --- Daily safety limits ---
MAX_DAILY_TRADES   = 3
MAX_DAILY_LOSS_PCT = 6.0  # raised from 3% — min lot floors real risk at 2-4% per trade

# --- Execution filters ---
# EURUSD normal spread: 0.5-1.5 pips = 5-15 points (5-digit broker).
# 20 points = 2 pips max before skipping.
MAX_SPREAD   = 20
MAGIC_NUMBER = 20260414

# --- Timing ---
CHECK_INTERVAL = 5
TRADE_COOLDOWN = 300