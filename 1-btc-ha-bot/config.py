# ============================================================
#  BTC HA BOT V3 — CONFIGURATION
#  All your settings live here. No need to touch other files.
# ============================================================

SYMBOL = "BTCUSD"

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
EMA_PERIOD = 100         # Trend filter on M1
ATR_PERIOD = 14          # Volatility measurement

# --- Stop loss & take profit ---
ATR_MULTIPLIER          = 2.0   # SL distance = ATR × this
TP_ATR_MULTIPLIER       = 3.0   # TP distance = ATR × this  (raised from 2 → 3 for better R:R)
TRAILING_ATR_MULTIPLIER = 3.0   # Trailing SL distance

# --- Entry filters ---
DOJI_THRESHOLD = 0.15    # Max body/range ratio to qualify as a doji (tighter = fewer signals)
MIN_ATR        = 50.0    # Minimum M5 ATR to trade — skips flat/choppy markets

# --- Exit filters ---
REVERSAL_CANDLES_REQUIRED = 2   # Consecutive opposite M5 HA candles needed to exit

# --- Session filter (UTC hours) ---
# Only trade during London + NY overlap when BTC liquidity is highest.
# Outside these hours spreads widen and false moves are common.
SESSION_START_UTC = 7    # 07:00 UTC  (London open)
SESSION_END_UTC   = 20   # 20:00 UTC  (NY afternoon)

# --- Daily safety limits ---
# MAX_DAILY_TRADES: stop opening NEW entries after this many trades today.
# Replaces the old fixed-dollar limit which was larger than the whole account.
# 3 trades/day keeps exposure manageable on a small balance.
MAX_DAILY_TRADES = 3

# MAX_DAILY_LOSS_PCT: backstop — also stop if the day's realised loss exceeds
# this percentage of balance (whichever limit hits first wins).
# 3% of $97 ≈ $2.91 — a hard ceiling even if trades are small.
MAX_DAILY_LOSS_PCT = 3.0

# --- Spread filter ---
# Maximum allowed spread in MT5 points before skipping a trade.
# BTC spread is typically 50–200 points. Spike above this = bad fill risk.
MAX_SPREAD = 300   # points

# --- Timing ---
MAGIC_NUMBER    = 123456
CHECK_INTERVAL  = 5      # seconds between loop ticks
TRADE_COOLDOWN  = 60     # seconds to wait after closing a trade before looking for next entry
