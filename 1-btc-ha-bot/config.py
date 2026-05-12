# ============================================================
#  BTC HA BOT V3 — CONFIGURATION
#  All your settings live here. No need to touch other files.
# ============================================================

BASE_SYMBOL = "BTCUSD"  # broker-agnostic base name
SYMBOL = BASE_SYMBOL      # resolved to broker symbol at startup

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
TP_ATR_MULTIPLIER       = 3.0   # TP = ATR × this (3.0 / 2.0 SL = 1.5:1 R:R, matches portfolio ratio)
TRAILING_ATR_MULTIPLIER = 1.0   # Not used
# ATR-based trail — adapts to current market volatility
# Trigger: fire BE+trail when profit >= TRAIL_ATR_TRIGGER x M5 ATR
# Buffer:  SL trails TRAIL_ATR_BUFFER x M5 ATR behind current price
TRAIL_ATR_TRIGGER       = 0.75  # fire trail when profit >= 75% of ATR (aggressive)
TRAIL_ATR_BUFFER        = 0.50  # SL trails 0.50x ATR behind price (tighter trail)
BE_BUFFER_PTS           = 30.0  # SL placed 30 pts above entry when trail first fires (BTC floor)

# --- Entry filters ---
DOJI_THRESHOLD = 0.15    # Max body/range ratio to qualify as a doji (tighter = fewer signals)
MIN_ATR        = 50.0    # Minimum M5 ATR to trade — skips flat/choppy markets
MAX_ATR        = 3000.0  # Maximum M5 ATR — skips news spikes / extreme volatility
                          # BTC normal ATR: 100–800 pts. Spike > 3000 = avoid.
SESSION_CLOSE_BUFFER = 30  # minutes — no new entries within 30min of London (16:00) or NY (19:00) close

# --- Exit filters ---
REVERSAL_CANDLES_REQUIRED = 2   # Consecutive opposite M5 HA candles needed to exit

# --- Session filter (UTC hours) ---
# Only trade during London + NY overlap when BTC liquidity is highest.
# Outside these hours spreads widen and false moves are common.
SESSION_START_UTC = 7    # 07:00 UTC  (London open)
SESSION_END_UTC   = 19   # 19:00 UTC  (NY afternoon — avoid late fakeouts)

# --- Daily safety limits ---
# MAX_DAILY_TRADES: stop opening NEW entries after this many trades today.
# Replaces the old fixed-dollar limit which was larger than the whole account.
# 3 trades/day keeps exposure manageable on a small balance.
MAX_DAILY_TRADES = 3

# MAX_DAILY_LOSS_PCT: backstop — also stop if the day's realised loss exceeds
# this percentage of balance (whichever limit hits first wins).
# 3% of $97 ≈ $2.91 — a hard ceiling even if trades are small.
MAX_DAILY_LOSS_PCT = 6.0  # raised from 3% — min lot (0.01) floors real risk at 2-4% per trade

# --- Spread filter ---
# Maximum allowed spread in MT5 points before skipping a trade.
# BTC spread is typically 50–200 points. Spike above this = bad fill risk.
MAX_SPREAD = 300   # points

# --- Timing ---
MAGIC_NUMBER    = 20260201  # BTC HA Bot unique identifier
CHECK_INTERVAL  = 5      