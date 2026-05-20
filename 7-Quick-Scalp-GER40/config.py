# ============================================================
#  QUICK FLIP SCALPER - GER40 (DAX)
#  Strategy: Opening Range Breakout + Engulfing Reversal
#  Backtest: 67% WR | +1.02R expectancy | 2:1 RR
#  Session: Frankfurt EU open -- best range formation
# ============================================================

BASE_SYMBOL     = "GER40"   # PUPrime symbol: GER40.s (resolver finds via suffix search)
SYMBOL          = BASE_SYMBOL  # resolved to broker symbol at startup

# Session open (Frankfurt 08:00 CET = 07:00 UTC)
SESSION_OPEN_HOUR   = 7    # 07:00 UTC = 08:00 CET / 09:00 CEST
SESSION_OPEN_MIN    = 0
SESSION_CLOSE_HOUR  = 15   # 15:00 UTC = 16:00 CET (cash close)

# Timeframes
TF_5M   = 5
TF_15M  = 15
TF_1D   = 1440

# Liquidity candle: opening range must be 20-35% of daily ATR
# Same thresholds as NAS100 -- both are high-vol indices
LIQ_PCT_MIN = 0.10  # lowered from 0.20 -- DAX opening candles typically 10-15% of daily ATR
LIQ_PCT_MAX = 0.50  # raised ceiling slightly to match
ATR_PERIOD  = 14

# Entry window: 90 min from EU open
WINDOW_MINUTES = 120

# Take profit
RR            = 2.0    # 2:1 RR (backtest: 67% WR, +1.02R expectancy)
TRAIL_RUNNERS = False

# Risk management
RISK_PERCENT          = 1.0
MAX_DAILY_TRADES      = 2
MAX_DAILY_LOSS_PCT    = 3.0
MAX_ACTUAL_RISK_PCT   = 3.0   # warn or block when actual risk exceeds this % of balance
RISK_CAP_MODE         = "warn"  # "warn" = log but still trade | "block" = skip the trade

MAGIC_NUMBER   = 20260416  # unique -- different from NAS100 (20260415)
CHECK_INTERVAL = 10        # seconds
