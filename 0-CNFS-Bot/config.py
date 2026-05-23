# =============================================================
#  CNFS Bot — Config
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
DOJI_THRESHOLD     = 0.25   # relaxed 2026-05-21: backtest Option B — wider doji, more signals (was 0.20)
DOJI_VOL_THRESHOLD = 0.60   # relaxed 2026-05-21: backtest shows 0.60 gives best EV (was 0.70)
PULLBACK_N         = 3      # 2026-05-22: raised to 3 M1 pullback candles — higher conviction setup (was 2)
PULLBACK_WICK_TOL  = 0.15   # wick tolerance (unchanged)
ATR_PERIOD         = 14
EMA_PERIOD         = 100
ATR_SL_MULT        = 2.0    # SL = ATR x 2.0
ATR_TP_MULT        = 3.0    # TP = ATR x 3.0
MIN_ATR            = 4.0    # absolute floor — block when market is dead quiet (was 0.30, raised 2026-05-19)
MIN_ATR_RATIO      = 0.75   # eased 2026-05-22: 75% of 20-bar avg — less aggressive gate, still blocks dead markets (was 0.85)
H1_CONSECUTIVE     = 2      # new 2026-05-21: require 2 consecutive same-direction H1 HA candles (was 1)

M1_BARS = 200
M5_BARS = 100
H1_BARS  = 50
M15_BARS = 100    # M15 bars for HA confirmation + ATR source (replaces M5 in signal check)

# --- Trailing stop ---
# Breakeven trigger : max(MIN_BE_PIPS, BE_TRIGGER_PCT x ATR)
# Trail distance    : max(MIN_TRAIL_PIPS, TRAIL_DIST_PCT x ATR)
BE_TRIGGER_PCT  = 0.20   # 20% of ATR
TRAIL_DIST_PCT  = 0.15   # 15% of ATR
# MIN_BE_PIPS: trigger BE lock when floating profit reaches this level.
# 50 pips = $5.00 at 0.01 lot — protects sooner. Was 80 ($8) — lowered 2026-05-13.
MIN_BE_PIPS     = 20     # $2.00 trigger — aligned to 247A (was 40 = $4.00, 2026-05-20)
# MIN_TRAIL_PIPS: distance trail SL sits behind current price once BE is active.
# 50 pips = $5.00 — widened 2026-05-22: 0% TP hit over 2 days proved $2 trail was exiting
# trades long before the ATR-calculated TP could be reached. (was 20 = $2.00)
MIN_TRAIL_PIPS  = 50     # $5.00 trail gap (was 20 = $2.00)
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
STRATEGY_NAME  = "CNFS Bot"
CHECK_INTERVAL = 30    # seconds between signal scans
TRAIL_INTERVAL = 8     # seconds between trail checks
# Minimum seconds between consecutive trade executions.
# Prevents candle-by-candle re-entry cascade when a persistent HA signal fires
# a new trade every 60s while previous ones are still hitting SL.
# 300s = 5 min gap — lets market settle before the next entry attempt.
TRADE_COOLDOWN = 300    # 5-min cooldown — 2026-05-22: M1 pattern reset takes ~3-5 min naturally;
                        # filters carry quality burden; 30 min was blocking valid re-entries (was 1800)

# --- Telegram (status messages) ---
BOT_TOKEN = os.getenv("BOT_TOKEN", "7716066914:AAEZATUSQXRRsTIO3xCIrYpNJ8dwzEnF1Iw")
CHAT_ID   = os.getenv("CHAT_ID",   "-1003523601209")

# --- Telegram Control Bot ---
# Set CTRL_BOT_TOKEN + CTRL_CHAT_ID in .env to enable /status /pause /resume
CTRL_BOT_TOKEN = os.getenv("CTRL_BOT_TOKEN", "")
CTRL_CHAT_ID   = os.getenv("CTRL_CHAT_ID",   "")
REPORT_CHAT_ID    = os.getenv("REPORT_CHAT_ID", CHAT_ID)  # trade reports; defaults to CHAT_ID
EOD_REPORT_HOUR   = int(os.getenv("EOD_REPORT_HOUR", "21"))  # UTC hour for scheduled daily report (default 21:00 UTC = 5 PM ET)
