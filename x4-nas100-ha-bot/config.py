# ============================================================
#  NAS100 HA BOT V1 - CONFIGURATION
# ============================================================

BASE_SYMBOL = "NAS100"  # broker-agnostic base name
SYMBOL = BASE_SYMBOL      # resolved to broker symbol at startup
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
TP_ATR_MULTIPLIER       = 1.5   # TP = ATR × this (1.5R gives better expectancy than 1:1)
TRAILING_ATR_MULTIPLIER = 1.0
TRAIL_ATR_TRIGGER       = 0.75
TRAIL_ATR_BUFFER        = 0.50  # SL trails 0.25x ATR behind price (tighter trail)
BE_BUFFER_PTS           = 10.0  # SL placed 10 pts above entry when trail first fires (NAS100 floor)

# --- Entry filters ---
DOJI_THRESHOLD = 0.15     # max body/range ratio for doji
# NAS100 M5 ATR is typically 10-40 pts when active.
# Below 10 = choppy ranging market, skip.
MIN_ATR = 10.0

# --- Timing ---
SESSION_CLOSE_BUFFER = 30  # minutes — no new entries within 30min of session close

# --- Exit ---
REVERSAL_CANDLES_REQUIRED = 2

# --- Session filter (UTC) ---
# NAS100 best liquidity: US pre-market (13:00) through close (20:00 UTC)
# London afternoon overlap adds extra momentum 13:00-16:00.
SESSION_START_UTC = 13    # 13:00 UTC = 09:00 ET
SESSION_END_UTC   = 19    # 19:00 UTC — avoid late NY session fakeouts

# --- Daily safety limits ---
MAX_DAILY_TRADES   = 3
MAX_DAILY_LOSS_PCT = 6.0  # raised from 3% — min lot floors real risk at 2-4% per trade

# --- Execution filters ---
# NAS100 normal spread: 1-5 pts. Spike to 20+ during news.
# 50 pts gives headroom without trading into spikes.
MAX_SPREAD   = 50
MAGIC_NUMBER = 20260413

# --- Timing ---
CHECK_INTERVAL = 5        # seconds between candle checks
TRADE_COOLDOWN = 300      # seconds between entries