# ============================================================
#  NAS100 HA BOT V1 - CONFIGURATION
# ============================================================

SYMBOL = 'NAS100.s'   # spot — as shown in your MT5 Market Watch
                       # futures alternative: 'NAS100fts.'

TIMEFRAMES = {
    'M1': 1,
    'M5': 5,
    'H1': 60,
}

# --- Position sizing ---
RISK_PERCENT = 1.0        # % of balance risked per trade

# --- Indicators ---
EMA_PERIOD = 100          # M1 trend filter
ATR_PERIOD = 14           # volatility measurement

# --- Stop loss and take profit ---
# NAS100 is choppier than crypto intraday; slightly tighter SL
ATR_MULTIPLIER          = 1.5   # SL = ATR x this
TP_ATR_MULTIPLIER       = 3.0   # TP = ATR x this (2:1 RR)
TRAILING_ATR_MULTIPLIER = 2.0   # trailing SL distance

# --- Entry filters ---
DOJI_THRESHOLD = 0.15     # max body/range ratio for doji
# NAS100 M5 ATR is typically 10-40 pts when active.
# Below 10 = choppy ranging market, skip.
MIN_ATR = 10.0

# --- Exit ---
REVERSAL_CANDLES_REQUIRED = 2

# --- Session filter (UTC) ---
# NAS100 best liquidity: US pre-market (13:00) through close (20:00 UTC)
# London afternoon overlap adds extra momentum 13:00-16:00.
SESSION_START_UTC = 13    # 13:00 UTC = 09:00 ET
SESSION_END_UTC   = 20    # 20:00 UTC = 16:00 ET

# --- Daily safety limits ---
MAX_DAILY_TRADES   = 3
MAX_DAILY_LOSS_PCT = 3.0

# --- Execution filters ---
# NAS100 normal spread: 1-5 pts. Spike to 20+ during news.
# 50 pts gives headroom without trading into spikes.
MAX_SPREAD   = 50
MAGIC_NUMBER = 20260413

# --- Timing ---
CHECK_INTERVAL = 5        # seconds between candle checks
TRADE_COOLDOWN = 300      # seconds between entries