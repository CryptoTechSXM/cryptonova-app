# =============================================================
#  CryptoNite Free Signals Executor — Config
# =============================================================
import os
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# --- MT5 connection ---
MT5_LOGIN    = int(os.getenv("MT5_LOGIN",  "0") or "0")
MT5_PASSWORD = os.getenv("MT5_PASSWORD",   "") or ""
MT5_SERVER   = os.getenv("MT5_SERVER",     "") or ""

# --- Symbol ---
BASE_SYMBOL = "XAUUSD"
SYMBOL_CANDIDATES = [
    "XAUUSD.s", "XAUUSD.f", "XAUUSD.pro", "XAUUSD", "XAUUSDm", "XAUUSD.a", "GOLD",
]

# --- Strategy (same as Free Signals bot) ---
DOJI_THRESHOLD     = 0.25
DOJI_VOL_THRESHOLD = 0.70
PULLBACK_N         = 1
PULLBACK_WICK_TOL  = 0.15
ATR_PERIOD         = 14
EMA_PERIOD         = 100
ATR_SL_MULT        = 2.0    # SL = ATR x 2.0
ATR_TP_MULT        = 3.0    # TP = ATR x 3.0
MIN_ATR            = 0.30

M1_BARS = 200
M5_BARS = 100
H1_BARS = 50

# --- Trailing stop ---
# Breakeven trigger : max(MIN_BE_PIPS, BE_TRIGGER_PCT x ATR)
# Trail distance    : max(MIN_TRAIL_PIPS, TRAIL_DIST_PCT x ATR)
BE_TRIGGER_PCT  = 0.20   # 20% of ATR
TRAIL_DIST_PCT  = 0.15   # 15% of ATR
# MIN_BE_PIPS raised to 80: ensures be_trigger >= $8.00 (80 × pip_size 0.10)
# regardless of ATR. Previous value of 10 gave $1.00 trigger — BE fired immediately
# but SL at +$8 was invalid until price actually moved $8, causing confusion.
# Now trigger aligns with buffer so BE fires meaningfully at +$8.
MIN_BE_PIPS     = 80     # was 10 ($1.00) — now $8.00, matches BE_BUFFER_PRICE
# MIN_TRAIL_PIPS raised to 50: ensures trail gap >= $5.00 (50 × 0.10).
# Previous value of 8 gave $0.80 trail — XAU M5 noise ($2–4) stopped trades out
# constantly. $5 trail survives normal retracements while still locking profit.
MIN_TRAIL_PIPS  = 50     # was 8 ($0.80) — now $5.00, survives M5 noise
PIP_SIZE        = 0.10   # 1 pip = $0.10 price move for XAUUSD
# Buffer above/below entry when SL moves to BE (price units, same as other bots).
# At 0.01 lot XAUUSD (1 oz): 8.0 price units = $8 guaranteed minimum profit at BE.
# Covers commission (~$0.07 round-trip) and a small real profit.
BE_BUFFER_PRICE = 8.0
# Keep TP when BE locks — close at the signal's calculated target (avg $13–$15).
# Was True (TP removed) which caused trades to drift open-ended with $0.80 trail.
# Asian-session signals would sit open for hours with no target; active-session
# signals closed at $8 instead of the $13–$15 the strategy calculated.
# Scalp-style exit: TP fills fast, slot freed for next signal. Trail is backup only.
REMOVE_TP_ON_BE = False

# --- Concurrent position limits ---
MAX_AT_RISK_POSITIONS = 2   # max positions still at original SL
MAX_TOTAL_POSITIONS   = 5   # hard margin guard regardless of BE status

# --- Risk ---
RISK_PERCENT        = 1.0   # % of balance per trade
MAX_ACTUAL_RISK_PCT = 3.0   # warn/block threshold
RISK_CAP_MODE       = "warn"

# --- Bot identity ---
MAGIC_NUMBER   = 20261001
STRATEGY_NAME  = "CNFS Executor"
CHECK_INTERVAL = 30    # seconds between signal scans
TRAIL_INTERVAL = 8     # seconds between trail checks

# --- Telegram (status messages) ---
BOT_TOKEN = os.getenv("BOT_TOKEN", "7716066914:AAEZATUSQXRRsTIO3xCIrYpNJ8dwzEnF1Iw")
CHAT_ID   = os.getenv("CHAT_ID",   "-1003523601209")

# --- Telegram Control Bot ---
# CTRL_BOT_TOKEN  : token from BotFather for the control/report bot
# CTRL_CHAT_ID    : your personal Telegram user ID — only this ID can send commands
# REPORT_CHAT_ID  : channel -1003700973551 receives all trade reports
CTRL_BOT_TOKEN = os.getenv("CTRL_BOT_TOKEN", "8717821397:AAE1jqr1sHzwUMTfOJon1WkuvD1imfgpGYo")
CTRL_CHAT_ID   = os.getenv("CTRL_CHAT_ID",   "-1003700973551")
REPORT_CHAT_ID = os.getenv("REPORT_CHAT_ID", "-1003700973551")
