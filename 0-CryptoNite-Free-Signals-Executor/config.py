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
DOJI_THRESHOLD     = 0.20   # was 0.25 — tightened 2026-05-19, backtest: best median R + lowest worst-DD
DOJI_VOL_THRESHOLD = 0.70
PULLBACK_N         = 2    # was 1 — 2 HA pullback candles required, tighter filter 2026-05-14
PULLBACK_WICK_TOL  = 0.15
ATR_PERIOD         = 14
EMA_PERIOD         = 100
ATR_SL_MULT        = 2.0    # SL = ATR x 2.0
ATR_TP_MULT        = 3.0    # TP = ATR x 3.0
MIN_ATR            = 4.0    # absolute floor — block when market is dead quiet (was 0.30, raised 2026-05-19)
MIN_ATR_RATIO      = 0.70   # also block if ATR < 70% of its 20-bar rolling average (catches unusually quiet candles)

M1_BARS = 200
M5_BARS = 100
H1_BARS = 50

# --- Trailing stop ---
# Breakeven trigger : max(MIN_BE_PIPS, BE_TRIGGER_PCT x ATR)
# Trail distance    : max(MIN_TRAIL_PIPS, TRAIL_DIST_PCT x ATR)
BE_TRIGGER_PCT  = 0.20   # 20% of ATR
TRAIL_DIST_PCT  = 0.15   # 15% of ATR
# MIN_BE_PIPS: trigger BE lock when floating profit reaches this level.
# 50 pips = $5.00 at 0.01 lot — protects sooner. Was 80 ($8) — lowered 2026-05-13.
MIN_BE_PIPS     = 40     # $4.00 trigger — Scenario B 4pt / +1pt buffer (was 50 = $5.00)
# MIN_TRAIL_PIPS: distance trail SL sits behind current price once BE is active.
# 30 pips = $3.00 — tighter trail, gives back less. Was 50 ($5) — lowered 2026-05-13.
MIN_TRAIL_PIPS  = 30     # $3.00 trail gap (was 50 = $5.00)
PIP_SIZE        = 0.10   # 1 pip = $0.10 price move for XAUUSD
# BE_BUFFER_PRICE: how far ABOVE entry the SL is placed when BE fires.
# Must be LESS than trail_dist ($5.00) so the trail activates immediately at
# the BE trigger price and starts ticking upward without delay.
# $3.00 = guaranteed minimum profit at BE, covers commission (~$0.07) + buffer.
# Was $8.00 (matched the trigger exactly) → SL sat right at current price →
# any micro-pullback closed the trade before the trail could move at all.
BE_BUFFER_PRICE = 1.0    # +1pt floor at lock — Scenario B (was 3.0)
# Keep TP active when BE locks — TP and trail run in parallel, whichever fires first.
# Strategy is doji/HA mean-reversion: price tends to reach the ATR-calculated target
# and reverse, not trend through it. Simulation confirmed: removing TP costs money
# whenever price peaks at or near TP (the most common winning scenario).
# Trail acts as backup only — rescues the trade if TP is overshot or never filled.
# Revisit once more data shows consistent trend-extension beyond TP.
REMOVE_TP_ON_BE = False  # TP kept — trail is backup, TP is primary exit target

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
# Minimum seconds between consecutive trade executions.
# Prevents candle-by-candle re-entry cascade when a persistent HA signal fires
# a new trade every 60s while previous ones are still hitting SL.
# 300s = 5 min gap — lets market settle before the next entry attempt.
TRADE_COOLDOWN = 300

# --- Telegram (status messages) ---
BOT_TOKEN = os.getenv("BOT_TOKEN", "7716066914:AAEZATUSQXRRsTIO3xCIrYpNJ8dwzEnF1Iw")
CHAT_ID   = os.getenv("CHAT_ID",   "-1003523601209")

# --- Telegram Control Bot ---
# Set CTRL_BOT_TOKEN + CTRL_CHAT_ID in .env to enable /status /pause /resume
CTRL_BOT_TOKEN = os.getenv("CTRL_BOT_TOKEN", "")
CTRL_CHAT_ID   = os.getenv("CTRL_CHAT_ID",   "")
REPORT_CHAT_ID = os.getenv("REPORT_CHAT_ID", CHAT_ID)  # trade reports; defaults to CHAT_ID
