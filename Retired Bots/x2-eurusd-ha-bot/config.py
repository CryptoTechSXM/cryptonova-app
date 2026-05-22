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
# Trail: CNFS-style max(pip_floor, pct_of_ATR) — aligned 2026-05-20
# At ATR ~5pips: trigger=max(10pips, 1pip)=10pips, trail=max(8pips, 0.75pip)=8pips behind price
TRAIL_ATR_TRIGGER       = 0.20    # fire trail when profit >= 20% of ATR (was 0.75)
TRAIL_ATR_BUFFER        = 0.15    # SL trails 15% of ATR behind price (was 0.50)
MIN_BE_PIPS             = 10      # floor: 10pip minimum trigger (EURUSD-specific — $1.00 at 0.01 lot)
MIN_TRAIL_PIPS          = 8       # floor: 8pip minimum trail gap behind price
PIP_SIZE                = 0.0001  # EURUSD: 1 pip = 0.0001 price units
BE_BUFFER_PTS           = 0.0002  # 2 pips above entry at lock (was 0.0003)

# --- Entry filters ---
DOJI_THRESHOLD     = 0.25    # was 0.15 — relaxed to match BTC bot and CNFS executor
DOJI_VOL_THRESHOLD = 0.70    # Doji range >= this % of avg recent candle range (was 0.85 — 2026-05-20)
# Below 0.000175 (1.75 pips) = market truly dead, skip. Was 0.0003 (3 pips) — blocked most sessions 2026-05-20.
MIN_ATR = 0.000175

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