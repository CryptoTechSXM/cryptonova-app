# ============================================================
#  QUICK FLIP SCALPER - XAUUSD (Gold)
#  Strategy: Opening Range Breakout + Engulfing Reversal
#  Backtest: 66% WR | +0.98R expectancy | 2:1 RR
#  Session: NY open — strongest gold range window
# ============================================================

SYMBOL          = 'XAUUSD'

# Session open (NY market open — peak gold volatility)
SESSION_OPEN_HOUR   = 13   # 13:30 UTC = 09:30 ET
SESSION_OPEN_MIN    = 30
SESSION_CLOSE_HOUR  = 20   # 20:00 UTC = 16:00 ET

# Timeframes
TF_5M   = 5
TF_15M  = 15
TF_1D   = 1440

# Liquidity candle: opening range must be 22-38% of daily ATR
# Slightly wider than indices — gold can form larger opening candles
LIQ_PCT_MIN = 0.22
LIQ_PCT_MAX = 0.38
ATR_PERIOD  = 14

# Entry window: 90 min from NY open
WINDOW_MINUTES = 90

# Take profit
RR            = 2.0    # 2:1 RR (backtest: 66% WR, +0.98R expectancy)
TRAIL_RUNNERS = False

# Risk management
RISK_PERCENT       = 1.0
MAX_DAILY_TRADES   = 2
MAX_DAILY_LOSS_PCT = 3.0

MAGIC_NUMBER   = 20260417  # unique — GER40=20260416, NAS100=20260415
CHECK_INTERVAL = 10        # seconds
