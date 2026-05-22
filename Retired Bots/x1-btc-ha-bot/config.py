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
# Trail: CNFS-style max(pip_floor, pct_of_ATR) — aligned 2026-05-20
# At ATR ~100pts: trigger=max(20, 20)=20pts, trail=max(15, 15)=15pts behind price
TRAIL_ATR_TRIGGER       = 0.20  # fire trail when profit >= 20% of ATR (was 0.75)
TRAIL_ATR_BUFFER        = 0.15  # SL trails 15% of ATR behind price (was 0.50)
MIN_BE_PIPS             = 20    # floor: 20pt minimum trigger regardless of ATR
MIN_TRAIL_PIPS          = 15    # floor: 15pt minimum trail gap behind price
PIP_SIZE                = 1.0   # BTC: 1 price point per pip
BE_BUFFER_PTS           = 10.0  # SL placed 10pts above entry at lock (was 30.0)

# --- Entry filters ---
DOJI_THRESHOLD     = 0.25    # Max body/range ratio to qualify as a doji (was 0.15 — too strict, 0 signals)
DOJI_VOL_THRESHOLD = 0.70    # Doji range >= this % of avg recent candle range (was 0.85 — 2026-05-20)
MIN_ATR        = 50.0    # Minimum M5 ATR to trade — skips flat/choppy markets
MAX_ATR        = 3000.0  # Maximum M5 ATR — skips news spikes / extreme volatility
                          # BTC normal ATR: 100–800 pts. Spike > 3000 = avoid.
SESSION_CLOSE_BUFFER = 0   # no buffer needed — BTC trades 24/7

# --- Exit filters ---
REVERSAL_CANDLES_REQUIRED = 2   # Consecutive opposite M5 HA candles needed to exit

# --- Session filter (UTC hours) ---
# BTC is a 24/7 asset — no session restriction needed.
# 0 → 24 keeps is_session_active() always true; session_close_guard() never fires
# since hour == 24 never exists in UTC.
SESSION_START_UTC = 0    # 24/7 — no session restriction for crypto
SESSION_END_UTC   = 24   # hour < 24 always true; session_close_guard never fires

# --- Daily safety limits ---
# MAX_DAILY_TRADES: stop opening NEW entries after this many trades today.
# Replaces the old fixed-dollar limit which was larger than the whole account.
# 3 trades/day keeps exposure manageable on a small balance.
MAX_DAILY_TRADES = 6      # increased from 3 — 24/7 operation allows more setups per calendar day

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