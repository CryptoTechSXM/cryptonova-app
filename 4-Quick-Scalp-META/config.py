# ============================================================
#  QUICK FLIP SCALPER - META (Meta Platforms)
#  Strategy: Opening Range Breakout + Engulfing Reversal
#  Session : NYSE 09:30-16:00 ET  (13:30-20:00 UTC)
# ============================================================

BASE_SYMBOL     = "META"
SYMBOL          = BASE_SYMBOL  # resolved to broker symbol at startup

# Session window (UTC) -- NYSE open to close
SESSION_OPEN_HOUR   = 13   # 13:30 UTC = 09:30 ET
SESSION_OPEN_MIN    = 30
SESSION_CLOSE_HOUR  = 20   # 20:00 UTC = 16:00 ET

# Timeframes
TF_5M   = 5
TF_15M  = 15
TF_1D   = 1440

# Liquidity candle: opening range must be 15-50% of daily ATR.
# META price ~$500-600, daily ATR typically $10-20.
# Raised MAX from 0.50 → 0.70: stock opens regularly hit 50-65% of ATR.
LIQ_PCT_MIN = 0.15   # below this = dead open, skip
LIQ_PCT_MAX = 0.85   # above this = truly explosive / news-driven, skip
ATR_PERIOD  = 14

# Entry window -- 90 min from open
WINDOW_MINUTES = 120

# Take profit
RR            = 2.0    # 2:1 risk-reward
TRAIL_RUNNERS = False

# Risk management
RISK_PERCENT          = 1.0
MAX_DAILY_TRADES      = 2
MAX_DAILY_LOSS_PCT    = 3.0
MAX_ACTUAL_RISK_PCT   = 3.0   # warn or block when actual risk exceeds this % of balance
RISK_CAP_MODE         = "warn"  # "warn" = log but still trade | "block" = skip the trade

MAGIC_NUMBER   = 20260005   # unique -- bot 5
CHECK_INTERVAL = 10    # seconds