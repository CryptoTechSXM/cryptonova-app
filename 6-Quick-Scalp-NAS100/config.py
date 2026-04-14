# ============================================================
#  QUICK FLIP SCALPER - NAS100.s
#  Strategy: Opening Range Breakout + Engulfing Reversal
#  Backtest: 63% WR | +0.87R expectancy | 2:1 RR
# ============================================================

SYMBOL          = 'NAS100.s'

# Session open (NY market open)
SESSION_OPEN_HOUR   = 13   # 13:30 UTC = 09:30 ET
SESSION_OPEN_MIN    = 30
SESSION_CLOSE_HOUR  = 20   # 20:00 UTC = 16:00 ET

# Timeframes
TF_5M   = 5
TF_15M  = 15
TF_1D   = 1440

# Liquidity candle: opening range must be 20-35% of daily ATR
LIQ_PCT_MIN = 0.20
LIQ_PCT_MAX = 0.35
ATR_PERIOD  = 14

# Entry window
WINDOW_MINUTES = 90

# Take profit
RR           = 2.0     # 2:1 risk-reward (engulfing patterns only)
TRAIL_RUNNERS = False  # set True to trail instead of fixed TP

# Risk management
RISK_PERCENT       = 1.0
MAX_DAILY_TRADES   = 2     # QFS is selective: 1-2 quality setups/day
MAX_DAILY_LOSS_PCT = 3.0

MAGIC_NUMBER   = 20260415
CHECK_INTERVAL = 10    # seconds
