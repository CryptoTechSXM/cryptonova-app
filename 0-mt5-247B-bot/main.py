# bot_live_final_clean.py
# ExFusion MT5 Telegram Signal Bot (single file for DEMO + LIVE via DOTENV_FILE)

import os, re, time, math, json, asyncio, csv, traceback, urllib.request, urllib.parse
from datetime import datetime, timezone, date, timedelta

from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession
import MetaTrader5 as mt5


# ----------------- LOAD ENV -----------------
DOTENV_FILE = os.getenv("DOTENV_FILE", "cryptonite_bot.env")
load_dotenv(DOTENV_FILE, override=True)

if not os.getenv("API_ID"):
    raise SystemExit(f"API_ID missing. Loaded DOTENV_FILE={DOTENV_FILE}. Check the filename and that API_ID exists inside it.")


# ----------------- ENV (Telegram + MT5) -----------------
API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
SESSION_NAME    = os.getenv("SESSION_NAME", "mt5_signal_bot")
INSTANCE_NAME   = (os.getenv("INSTANCE_NAME") or SESSION_NAME).strip()  # e.g. "247A" / "247B"

MT5_LOGIN = int(os.getenv("MT5_LOGIN") or 0)   # 0 = latch to open terminal
MT5_PASSWORD = os.getenv("MT5_PASSWORD") or ""
MT5_SERVER = os.getenv("MT5_SERVER") or ""

ALLOWED_ACCOUNT_LOGIN = (os.getenv("ALLOWED_ACCOUNT_LOGIN") or "").strip()

LIVE_MODE = (os.getenv("LIVE_MODE", "false").strip().lower() == "true")
ACCOUNT_MODE = os.getenv("ACCOUNT_MODE", "DEMO").strip().upper()

# Sources
CHANNEL_IDS_RAW = (os.getenv("CHANNEL_IDS") or "").strip()
CHANNEL_USERNAME = (os.getenv("CHANNEL_USERNAME") or "").strip().lstrip("@").lower()
MIRROR_CHAT_ID = (os.getenv("MIRROR_CHAT_ID") or "").strip()

# Strict source loading:
# only CHANNEL_IDS is honored for ID-based source locking.
# Legacy single CHANNEL_ID fallback is intentionally ignored so old IDs
# cannot keep leaking in from stale env values.
CHANNEL_IDS = set()
if CHANNEL_IDS_RAW:
    for x in CHANNEL_IDS_RAW.split(","):
        x = x.strip()
        if x:
            CHANNEL_IDS.add(str(x))

# Scalp source gate
SCALP_SOURCE_IDS_RAW = (os.getenv("SCALP_SOURCE_IDS") or "").strip()
SCALP_SOURCE_IDS = []
if SCALP_SOURCE_IDS_RAW:
    for x in SCALP_SOURCE_IDS_RAW.split(","):
        x = x.strip()
        if x:
            SCALP_SOURCE_IDS.append(str(x))

# Early scalp
EARLY_SCALP_ENABLED = (os.getenv("EARLY_SCALP_ENABLED", "false").strip().lower() == "true")
EARLY_SCALP_ONLY_DEMO = (os.getenv("EARLY_SCALP_ONLY_DEMO", "true").strip().lower() == "true")
EARLY_SCALP_SYNC_WINDOW_SECONDS = int(os.getenv("EARLY_SCALP_SYNC_WINDOW_SECONDS", "180"))
EARLY_SCALP_SYMBOLS = [s.strip().upper() for s in (os.getenv("EARLY_SCALP_SYMBOLS", "XAU").split(",")) if s.strip()]
EARLY_SCALP_FORCE_RISK_MULT = float(os.getenv("EARLY_SCALP_FORCE_RISK_MULT", "0.5"))

# SL multiplier
APPLY_SL_MULTIPLIER = (os.getenv("APPLY_SL_MULTIPLIER", "false").strip().lower() == "true")
SL_MULTIPLIER = float(os.getenv("SL_MULTIPLIER", "1.0"))

# Fixed lot mode
USE_FIXED_LOT = (os.getenv("USE_FIXED_LOT", "false").strip().lower() == "true")
FIXED_LOT = float(os.getenv("FIXED_LOT", "0.01"))

# Entry mode
ENTRY_MODE = (os.getenv("ENTRY_MODE", "ZONE").strip().upper())  # ZONE | LIMIT_ALWAYS | MARKET | MARKET_ALWAYS | PENDING_ALWAYS
MARKET_FALLBACK_FOR_MARKET_SIGNALS = (os.getenv("MARKET_FALLBACK_FOR_MARKET_SIGNALS", "true").strip().lower() == "true")
XAU_ENTRY_TOLERANCE = float(os.getenv("XAU_ENTRY_TOLERANCE", "1.5"))
FX_ENTRY_TOLERANCE = float(os.getenv("FX_ENTRY_TOLERANCE", "0.0"))
CRYPTO_ENTRY_TOLERANCE = float(os.getenv("CRYPTO_ENTRY_TOLERANCE", "0.0"))
INDEX_ENTRY_TOLERANCE = float(os.getenv("INDEX_ENTRY_TOLERANCE", "2.0"))
EXECUTION_MODE = (os.getenv("EXECUTION_MODE", "AGGRESSIVE").strip().upper())  # SAFE | BALANCED | AGGRESSIVE

# Multi-pending
MULTI_PENDING_ENABLED = (os.getenv("MULTI_PENDING_ENABLED", "false").strip().lower() == "true")
MULTI_PENDING_ONLY_DEMO = (os.getenv("MULTI_PENDING_ONLY_DEMO", "true").strip().lower() == "true")
MULTI_PENDING_SOURCE_IDS_RAW = (os.getenv("MULTI_PENDING_SOURCE_IDS") or "").strip()
MULTI_PENDING_SOURCE_IDS = set()
if MULTI_PENDING_SOURCE_IDS_RAW:
    for x in MULTI_PENDING_SOURCE_IDS_RAW.split(","):
        x = x.strip()
        if x:
            MULTI_PENDING_SOURCE_IDS.add(str(x))

def _parse_fractions(raw: str):
    out = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(float(part))
        except Exception:
            continue
    if not out:
        out = [0.0, 0.25, 0.50]
    out2 = []
    for f in out:
        f2 = max(0.0, min(1.0, float(f)))
        if f2 not in out2:
            out2.append(f2)
    out2.sort()
    return out2

MULTI_PENDING_FRACTIONS = _parse_fractions(os.getenv("MULTI_PENDING_FRACTIONS", "0,0.25,0.5"))

# Filters / limits
COOLDOWN_SECONDS = int(os.getenv("COOLDOWN_SECONDS", "120"))  # per-channel cooldown
EMA_FILTER_ENABLED = os.getenv("EMA_FILTER_ENABLED", "true").strip().lower() == "true"
EMA_PERIOD         = int(os.getenv("EMA_PERIOD", "100"))  # M5 EMA period
EMA_TIMEFRAME      = os.getenv("EMA_TIMEFRAME", "M5")     # M5 or M15
MAX_OPEN_POSITIONS_PER_SYMBOL = int(os.getenv("MAX_OPEN_POSITIONS_PER_SYMBOL", "1"))
MAX_PENDING_ORDERS_PER_SYMBOL = int(os.getenv("MAX_PENDING_ORDERS_PER_SYMBOL", "1"))
# Global cap across ALL symbols — prevents correlated multi-symbol exposure during news events.
# 0 = disabled.
MAX_OPEN_POSITIONS_TOTAL = int(os.getenv("MAX_OPEN_POSITIONS_TOTAL", "0"))
COUNT_ONLY_MAGIC = (os.getenv("COUNT_ONLY_MAGIC", "true").strip().lower() == "true")
REPLACE_PENDING_ON_NEW_SIGNAL = (os.getenv("REPLACE_PENDING_ON_NEW_SIGNAL", "true").strip().lower() == "true")

# Trade caps
MAX_TRADES_PER_DAY = int(os.getenv("MAX_TRADES_PER_DAY", "0"))
MAX_TRADES_PER_DAY_WINNING = int(os.getenv("MAX_TRADES_PER_DAY_WINNING", str(MAX_TRADES_PER_DAY)))
MAX_TRADES_PER_DAY_AFTER_LOSS = int(os.getenv("MAX_TRADES_PER_DAY_AFTER_LOSS", str(MAX_TRADES_PER_DAY)))

# Spread logic
MAX_SPREAD_POINTS_FX = int(os.getenv("MAX_SPREAD_POINTS_FX", os.getenv("MAX_SPREAD_POINTS", "250")))
MAX_SPREAD_PRICE_DEFAULT = float(os.getenv("MAX_SPREAD_PRICE_DEFAULT", "5"))
MAX_SPREAD_PRICE_XAU = float(os.getenv("MAX_SPREAD_PRICE_XAU", "2.5"))
MAX_SPREAD_PRICE_XAG = float(os.getenv("MAX_SPREAD_PRICE_XAG", "2.5"))
MAX_SPREAD_PRICE_CRYPTO = float(os.getenv("MAX_SPREAD_PRICE_CRYPTO", "250"))
MAX_SPREAD_PRICE_INDEX = float(os.getenv("MAX_SPREAD_PRICE_INDEX", "30"))

SPREAD_RECHECK_ENABLED = (os.getenv("SPREAD_RECHECK_ENABLED", "true").strip().lower() == "true")
SPREAD_RECHECK_SECONDS = int(os.getenv("SPREAD_RECHECK_SECONDS", "2"))
SPREAD_RECHECK_INTERVAL = int(os.getenv("SPREAD_RECHECK_INTERVAL", "1"))

# Pending safety
PENDING_EXPIRE_MINUTES = int(os.getenv("PENDING_EXPIRE_MINUTES", "0"))
PENDING_EXPIRE_SECONDS = PENDING_EXPIRE_MINUTES * 60

AUTO_FIX_PENDING_TYPE = (os.getenv("AUTO_FIX_PENDING_TYPE", "true").strip().lower() == "true")
AUTO_FIX_PENDING_DISTANCE = (os.getenv("AUTO_FIX_PENDING_DISTANCE", "true").strip().lower() == "true")
MIN_PENDING_GAP_POINTS = int(os.getenv("MIN_PENDING_GAP_POINTS", "1"))

# Risk / limits
MONTHLY_MAX_DD_PCT = float(os.getenv("MONTHLY_MAX_DD_PCT", "5.0"))
PAUSE_COOLDOWN_DAYS = int(os.getenv("PAUSE_COOLDOWN_DAYS", "3"))

RISK_BASE = float(os.getenv("RISK_BASE", os.getenv("RISK_PER_TRADE", "0.002")))
RISK_DD1 = float(os.getenv("RISK_DD1", "0.0015"))
RISK_DD2 = float(os.getenv("RISK_DD2", "0.0010"))
RISK_DD3 = float(os.getenv("RISK_DD3", "0.0005"))

DD1_PCT = float(os.getenv("DD1_PCT", "1.0"))
DD2_PCT = float(os.getenv("DD2_PCT", "2.0"))
DD3_PCT = float(os.getenv("DD3_PCT", "3.0"))

MAX_DAILY_LOSS_PCT = float(os.getenv("MAX_DAILY_LOSS_PCT", "1.0"))
MAX_CONSECUTIVE_LOSSES = int(os.getenv("MAX_CONSECUTIVE_LOSSES", "3"))

# Manager settings
MANAGER_INTERVAL_SECONDS = int(os.getenv("MANAGER_INTERVAL_SECONDS", "15"))
SET_BROKER_TP = os.getenv("SET_BROKER_TP", "TP3").upper()

BE_AT_TP1 = (os.getenv("BE_AT_TP1", "true").strip().lower() == "true")
BE_BUFFER_USD = float(os.getenv("BE_BUFFER_USD", "1.0"))

TRAIL_FROM_ENTRY = (os.getenv("TRAIL_FROM_ENTRY", "false").strip().lower() == "true")
TRAIL_AFTER_TP1 = (os.getenv("TRAIL_AFTER_TP1", "false").strip().lower() == "true")
TRAIL_AFTER_TP2 = (os.getenv("TRAIL_AFTER_TP2", "true").strip().lower() == "true")

TRAIL_DISTANCE_USD = float(os.getenv("TRAIL_DISTANCE_USD", "2.0"))
TRAIL_STEP_USD     = float(os.getenv("TRAIL_STEP_USD", "1.0"))
TRAIL_DISTANCE_R   = float(os.getenv("TRAIL_DISTANCE_R", "0.5"))
TRAIL_STEP_R       = float(os.getenv("TRAIL_STEP_R", "0.1"))
# Hybrid trail: 0.0 = trail fires with scalp lock; >0 = trail delayed until this R level
TRAIL_TRIGGER_R    = float(os.getenv("TRAIL_TRIGGER_R", "0.0"))
# Fixed-pip trail: overrides R-based when > 0. Per-symbol smart defaults used when 0.
TRAIL_FIXED_PIPS   = float(os.getenv("TRAIL_FIXED_PIPS", "0.0"))

# ATR-based BE and trail (fires alongside TP1 trigger — whichever comes first)
ATR_BE_TRIGGER_PCT  = float(os.getenv("ATR_BE_TRIGGER_PCT",  "0.30"))  # 30% of ATR
ATR_TRAIL_DIST_PCT  = float(os.getenv("ATR_TRAIL_DIST_PCT",  "0.25"))  # 25% of ATR
ATR_TRAIL_ENABLED   = (os.getenv("ATR_TRAIL_ENABLED", "true").strip().lower() == "true")
MIN_BE_PIPS_PRICE   = float(os.getenv("MIN_BE_PIPS_PRICE",   "1.0"))   # price-unit floor for BE trigger
MIN_TRAIL_PRICE     = float(os.getenv("MIN_TRAIL_PRICE",     "0.80"))  # price-unit floor for trail dist


def _trail_pips_for_symbol(symbol: str) -> float:
    """Fixed trail distance in price-points for each asset class.
    Uses TRAIL_FIXED_PIPS env override when > 0, otherwise smart per-symbol defaults."""
    if TRAIL_FIXED_PIPS > 0:
        return TRAIL_FIXED_PIPS
    sym = symbol.upper()
    if "BTC" in sym:
        return 50.0     # BTC: $50 trail
    if "ETH" in sym:
        return 5.0      # ETH: $5 trail
    if "XAU" in sym or "GOLD" in sym:
        return 3.0      # Gold: 3pt trail — tight on typical 8-15pt SLs
    if "XAG" in sym or "SILVER" in sym:
        return 0.05
    if "NAS" in sym or "US100" in sym or "NDX" in sym:
        return 8.0      # NAS100: 8pt trail
    if "GER" in sym or "DAX" in sym:
        return 8.0
    if "SPX" in sym or "SP500" in sym or "US500" in sym:
        return 8.0
    return 0.00050      # Default FX: 5 pips


class _Mt5CalendarSettings:
    """Minimal settings shim so news_filter.py works in the 247-bot context."""
    def __init__(self):
        self.news_filter_enabled     = True
        self.news_filter_countries   = [c.strip().upper() for c in os.getenv("NEWS_FILTER_COUNTRIES", "US,EU,GB").split(",") if c.strip()]
        self.news_filter_importance  = [v.strip().upper() for v in os.getenv("NEWS_FILTER_IMPORTANCE", "RED,ORANGE").split(",") if v.strip()]
        self.news_filter_before_min  = int(os.getenv("NEWS_FILTER_BEFORE_MIN", "30"))
        self.news_filter_after_min   = int(os.getenv("NEWS_FILTER_AFTER_MIN",  "30"))
        self.news_close_before_min   = int(os.getenv("NEWS_CLOSE_BEFORE_MIN",  "10"))


def _mt5_calendar_settings() -> _Mt5CalendarSettings:
    return _Mt5CalendarSettings()


# Simple TP/SL model
SL_MODEL = os.getenv("SL_MODEL", "HYBRID").strip().upper()  # FIXED | ATR | HYBRID
ATR_TIMEFRAME = os.getenv("ATR_TIMEFRAME", "M5").strip().upper()
ATR_PERIOD = int(os.getenv("ATR_PERIOD", "14"))
ATR_MULTIPLIER = float(os.getenv("ATR_MULTIPLIER", "1.0"))

# Real TP ladder for SIMPLE trades
SIMPLE_TP_R1 = float(os.getenv("SIMPLE_TP_R1", "1.0"))
SIMPLE_TP_R2 = float(os.getenv("SIMPLE_TP_R2", "2.0"))
SIMPLE_TP_R3 = float(os.getenv("SIMPLE_TP_R3", "3.0"))

SIMPLE_SL_FIXED_DEFAULT      = float(os.getenv("SIMPLE_SL_FIXED_DEFAULT",      "10"))
SIMPLE_SL_FIXED_XAU          = float(os.getenv("SIMPLE_SL_FIXED_XAU",          str(SIMPLE_SL_FIXED_DEFAULT)))
SIMPLE_SL_FIXED_XAG          = float(os.getenv("SIMPLE_SL_FIXED_XAG",          str(SIMPLE_SL_FIXED_DEFAULT)))
SIMPLE_SL_FIXED_BTC          = float(os.getenv("SIMPLE_SL_FIXED_BTC",          "100"))
SIMPLE_SL_FIXED_CRYPTO_SMALL = float(os.getenv("SIMPLE_SL_FIXED_CRYPTO_SMALL", "0.004"))
# FX floor: tiny so ATR always dominates in HYBRID mode (ATR≫0.001 for any live pair)
SIMPLE_SL_FIXED_FX           = float(os.getenv("SIMPLE_SL_FIXED_FX",           "0.001"))
# INDEX floor: 3 points — ATR dominates for NAS100/GER40 but gives emergency fallback
SIMPLE_SL_FIXED_INDEX        = float(os.getenv("SIMPLE_SL_FIXED_INDEX",        str(SIMPLE_SL_FIXED_DEFAULT)))

# TP removal
REMOVE_TP_ON_BE = (os.getenv("REMOVE_TP_ON_BE", "false").strip().lower() == "true")
REMOVE_TP_ON_TRAIL = (os.getenv("REMOVE_TP_ON_TRAIL", "true").strip().lower() == "true")
REMOVE_TP_AFTER = (os.getenv("REMOVE_TP_AFTER", "TP1") or "TP1").strip().upper()
FORCE_TRAIL_ALL = (os.getenv("FORCE_TRAIL_ALL", "true").strip().lower() == "true")

# Partial close
PARTIAL_CLOSE_ENABLED = (os.getenv("PARTIAL_CLOSE_ENABLED", "false").strip().lower() == "true")
PARTIAL_AT_TP1 = float(os.getenv("PARTIAL_AT_TP1", "0.25"))
PARTIAL_AT_TP2 = float(os.getenv("PARTIAL_AT_TP2", "0.25"))

# Step 14 scalp lock
SCALP_LOCK_ENABLED     = (os.getenv("SCALP_LOCK_ENABLED", "false").strip().lower() == "true")
SCALP_LOCK_TRIGGER_USD = float(os.getenv("SCALP_LOCK_TRIGGER_USD", "5.0"))
SCALP_LOCK_AMOUNT_USD  = float(os.getenv("SCALP_LOCK_AMOUNT_USD", "2.0"))
SCALP_LOCK_TRIGGER_R   = float(os.getenv("SCALP_LOCK_TRIGGER_R", "0.75"))
SCALP_LOCK_AMOUNT_R    = float(os.getenv("SCALP_LOCK_AMOUNT_R", "0.25"))

# Logging
TRADES_CSV = os.getenv("TRADES_CSV", "trades.csv").strip()
INTAKE_LOG_CSV = os.getenv("INTAKE_LOG_CSV", "signal_intake.csv").strip()
INTAKE_ARCHIVE_ENABLED = (os.getenv("INTAKE_ARCHIVE_ENABLED", "true").strip().lower() == "true")

# Debug
DEBUG_ALL_MESSAGES = (os.getenv("DEBUG_ALL_MESSAGES", "false").strip().lower() == "true")
DEBUG_SOURCE_MISMATCH = (os.getenv("DEBUG_SOURCE_MISMATCH", "false").strip().lower() == "true")
DEBUG_PARSE_FAIL = (os.getenv("DEBUG_PARSE_FAIL", "false").strip().lower() == "true")
DEBUG_INTAKE_FILTER = (os.getenv("DEBUG_INTAKE_FILTER", "true").strip().lower() == "true")

# Daily report
DAILY_REPORT_ENABLED = (os.getenv("DAILY_REPORT_ENABLED", "false").strip().lower() == "true")
DAILY_REPORT_CHAT_ID = (os.getenv("DAILY_REPORT_CHAT_ID") or "").strip()
DAILY_REPORT_SEND_TIME = (os.getenv("DAILY_REPORT_SEND_TIME", "00:05") or "00:05").strip()
EXECUTION_CHAT_ID     = (os.getenv("EXECUTION_CHAT_ID") or "").strip()
ADOPT_MANUAL_TRADES   = (os.getenv("ADOPT_MANUAL_TRADES", "false").strip().lower() == "true")
DRAWDOWN_ALERT_PCT      = float(os.getenv("DRAWDOWN_ALERT_PCT",      "3.0"))
DAILY_PROFIT_TARGET_PCT = float(os.getenv("DAILY_PROFIT_TARGET_PCT", "2.0"))
# When true, no new entries are accepted once DAILY_PROFIT_TARGET_PCT is banked.
DAILY_PROFIT_LOCK       = (os.getenv("DAILY_PROFIT_LOCK", "false").strip().lower() == "true")
ORDER_TIMEOUT_MINUTES   = int(os.getenv("ORDER_TIMEOUT_MINUTES",   "60"))
# Block new entries for this many minutes when a high-impact news message is detected.
# 0 = disabled.
NEWS_PAUSE_MINUTES      = int(os.getenv("NEWS_PAUSE_MINUTES", "0"))

# Time filter — block signals outside the configured UTC window
TIME_FILTER_ENABLED    = (os.getenv("TIME_FILTER_ENABLED", "false").strip().lower() == "true")
TIME_FILTER_START_HOUR = int(os.getenv("TIME_FILTER_START_HOUR", "7"))
TIME_FILTER_END_HOUR   = int(os.getenv("TIME_FILTER_END_HOUR", "19"))
BLOCKED_HOURS          = [int(h.strip()) for h in os.getenv("BLOCKED_HOURS", "").split(",") if h.strip().isdigit()]

# Direction filter — scale lot size on SELL signals (1.0=normal, 0.5=half, 0.0=block)
SELL_LOT_MULTIPLIER    = float(os.getenv("SELL_LOT_MULTIPLIER", "1.0"))

# Reversal logic — close opposite positions when a new signal arrives
CLOSE_OPPOSITE_ON_SIGNAL        = (os.getenv("CLOSE_OPPOSITE_ON_SIGNAL",        "false").strip().lower() == "true")
CLOSE_OPPOSITE_SAME_SOURCE_ONLY = (os.getenv("CLOSE_OPPOSITE_SAME_SOURCE_ONLY", "true").strip().lower()  == "true")
# When true, only reverse a position if it is currently in profit.
# Protects against compounding a losing trade by flipping direction.
REVERSAL_REQUIRE_PROFIT         = (os.getenv("REVERSAL_REQUIRE_PROFIT",         "true").strip().lower()  == "true")

# Bot command interface
BOT_TOKEN        = (os.getenv("BOT_TOKEN") or "").strip()
CONTROL_CHAT_ID  = (os.getenv("CONTROL_CHAT_ID") or "").strip()


# ----------------- SYMBOL POLICY -----------------
ALLOW_ALL_SYMBOLS = (os.getenv("ALLOW_ALL_SYMBOLS", "true").strip().lower() == "true")
SYMBOL_SUFFIX_FORCE = (os.getenv("SYMBOL_SUFFIX_FORCE") or "").strip()
SYMBOL_SUFFIX_PREFER = [x.strip() for x in (os.getenv("SYMBOL_SUFFIX_PREFER", ".pro,.f,m,#").split(",")) if x.strip()]

SYMBOL_MAP = {}
for k, v in os.environ.items():
    if k.startswith("SYMBOL_") and v.strip():
        raw = k.replace("SYMBOL_", "").upper()
        SYMBOL_MAP[raw] = v.strip()

# Lot caps
MAX_LOT_DEFAULT = float(os.getenv("MAX_LOT_DEFAULT", "0.05"))
MAX_LOT_XAU = float(os.getenv("MAX_LOT_XAU", str(MAX_LOT_DEFAULT)))
MAX_LOT_XAG = float(os.getenv("MAX_LOT_XAG", str(MAX_LOT_DEFAULT)))
MAX_LOT_BTC = float(os.getenv("MAX_LOT_BTC", str(MAX_LOT_DEFAULT)))
MAX_LOT_CRYPTO_SMALL = float(os.getenv("MAX_LOT_CRYPTO_SMALL", str(MAX_LOT_DEFAULT)))
MAX_LOT_INDEX = float(os.getenv("MAX_LOT_INDEX", "0.10"))

MAGIC = 260214
STATE_FILE = "state.json"
EVENT_LOG = "events.log"

MT5_ASYNC_LOCK = asyncio.Lock()

# -----------------------------------------------------------------------
# DIRECTIONAL CHANNELS — post "BUY/SELL SYMBOL" as the first message.
# Bot executes immediately at market price using its own ATR SL/TP/trail.
# The classifier normally drops symbol-only messages as UNKNOWN; we bypass
# that filter for these channels so the directional parser can fire.
# -----------------------------------------------------------------------
_DIRECTIONAL_CHANNELS = {
    "-1003882026187",   # Limitless 2.0 — "XAUUSD BUY NOW" bare directional
    "-1003889406756",   # Limitless VIP — "XAUUSD Buy now" heads-up signals
    "-1002717527369",   # Free Tag — "4511-4488 | XAUUSD buy" range+directional format
}

FILLING_CACHE = {}
MT5_SYMBOLS_ALL = []
MT5_SYMBOLS_UPPER = set()
SYMBOL_RESOLVE_CACHE = {}

CRYPTO_SMALL_SET = {"XRP","ADA","DOGE","TRX","XLM","MATIC","LINK","DOT","UNI","LTC","SOL","AVAX","BNB","ETH"}

SYMBOL_ALIASES = {
    # Gold
    "XAUUSD": "XAU", "XAU": "XAU", "GOLD": "XAU",
    # Silver
    "XAGUSD": "XAG", "XAG": "XAG", "SILVER": "XAG",
    # Crypto
    "BTCUSD": "BTC",  "BTC": "BTC",
    "ETHUSD": "ETHUSD", "ETH": "ETHUSD",
    "XRPUSD": "XRP",  "XRP": "XRP",
    # Indices — map text aliases to canonical MT5-style names
    "US30": "US30", "DJI": "US30", "DOW": "US30",
    "NAS100": "NAS100", "NASDAQ": "NAS100", "NQ": "NAS100",
    "GER40": "GER40", "DAX": "GER40", "DAX40": "GER40", "GER30": "GER40",
    "UK100": "UK100", "FTSE": "UK100", "FTSE100": "UK100",
    "SPX500": "SPX500", "SPX": "SPX500", "SP500": "SPX500",
    "JP225": "JP225", "JPN225": "JP225", "NIKKEI": "JP225", "NKY": "JP225",
}


# ----------------- UTIL -----------------
def safe_symbol_text(symbol: str) -> str:
    return (symbol or "").replace(" ", "")

_LOG_MAX_BYTES  = 5 * 1024 * 1024   # 5 MB per log file
_LOG_KEEP_FILES = 3                  # keep 3 rotated archives

def _rotate_file(path: str):
    """Rename path -> path.1, path.1 -> path.2, ..., drop oldest."""
    try:
        for i in range(_LOG_KEEP_FILES - 1, 0, -1):
            src = f"{path}.{i}"
            dst = f"{path}.{i + 1}"
            if os.path.exists(src):
                os.replace(src, dst)
        if os.path.exists(path):
            os.replace(path, f"{path}.1")
    except Exception:
        pass

def log_event(msg: str):
    ts = datetime.now(timezone.utc).isoformat()
    line = f"{ts} | {msg}"
    try:
        print(line)
    except UnicodeEncodeError:
        print(line.encode("ascii", errors="replace").decode("ascii"))
    try:
        # Rotate if file exceeds size limit
        if os.path.exists(EVENT_LOG) and os.path.getsize(EVENT_LOG) >= _LOG_MAX_BYTES:
            _rotate_file(EVENT_LOG)
        with open(EVENT_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def load_state():
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _prune_state(state):
    """Remove entries older than 7 days to prevent unbounded growth."""
    cutoff = (datetime.now() - timedelta(days=7)).date().isoformat()

    # Prune old daily channel stats
    if "channel_stats" in state:
        state["channel_stats"] = {
            k: v for k, v in state["channel_stats"].items() if k >= cutoff
        }

    # Prune old daily trade buckets
    if "days" in state:
        state["days"] = {
            k: v for k, v in state["days"].items() if k >= cutoff
        }

    # Prune position_templates and managed_positions for closed positions.
    # Keep only tickets that still have open positions.
    #
    # IMPORTANT: position_sources is deliberately NOT included here.
    # Pruning it by open_tickets caused the UNKNOWN channel bug:
    #   save_state() would strip the source mapping for a just-closed
    #   position before log_new_closed_deals() could read it, so every
    #   trade was logged and notified as "Source: UNKNOWN".
    # position_sources stays in state until explicitly cleared or until
    # the bot has been running long enough that entries are stale.
    # The dict is tiny (one entry per executed trade) so this is safe.
    open_tickets = set()
    try:
        positions = mt5.positions_get()
        if positions:
            open_tickets = {str(p.ticket) for p in positions}
    except Exception:
        pass

    if open_tickets is not None:
        for key in ("position_templates", "managed_positions"):
            if key in state:
                state[key] = {k: v for k, v in state[key].items() if k in open_tickets}

def save_state(state):
    _prune_state(state)
    tmp = STATE_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, STATE_FILE)
    except Exception:
        pass

def month_key():
    now = datetime.now()
    return f"{now.year:04d}-{now.month:02d}"

def day_key():
    return str(date.today())

def within(x, a, b):
    return a <= x <= b

def within_tol(x, a, b, tol=0.0):
    lo, hi = min(a, b), max(a, b)
    return (lo - tol) <= x <= (hi + tol)

def entry_tolerance_for_symbol(raw_symbol: str) -> float:
    rs = (raw_symbol or "").upper()
    if rs.startswith("XAU") or rs == "GOLD":
        return float(XAU_ENTRY_TOLERANCE)
    if rs.startswith(("BTC", "ETH", "SOL", "XRP", "ADA", "DOGE")):
        return float(CRYPTO_ENTRY_TOLERANCE)
    if rs.startswith(("US30", "NAS", "SPX", "GER", "UK")):
        return float(INDEX_ENTRY_TOLERANCE)
    return float(FX_ENTRY_TOLERANCE)

def signal_requests_market(sig) -> bool:
    raw = (sig.get("raw") or "").upper()
    if "LIMIT" in raw or "STOP" in raw:
        return False
    return ("MARKET" in raw) or (" NOW " in f" {raw} ")

def signal_is_exact_entry(sig) -> bool:
    try:
        return sig.get("kind") == "FULL" and abs(float(sig.get("zone_low", 0.0)) - float(sig.get("zone_high", 0.0))) < 1e-12
    except Exception:
        return False


def smart_exact_entry_decision(sig, tick):
    side = (sig.get("side") or "").upper()
    entry = float(sig.get("zone_low", 0.0))
    ask = float(tick.ask)
    bid = float(tick.bid)
    mid = (ask + bid) / 2.0
    tol = max(entry_tolerance_for_symbol(sig.get("raw_symbol", "")), 0.0)
    exec_mode = (EXECUTION_MODE or "BALANCED").upper()

    # Balanced mode aims to catch nearby moves without chasing entries that are already gone.
    if exec_mode == "SAFE":
        market_band = tol * 0.6
        pending_band = max(tol * 1.25, tol + 0.25)
    elif exec_mode == "AGGRESSIVE":
        market_band = max(tol * 1.5, tol + 0.25)
        pending_band = max(tol * 4.0, tol + 2.0)
    else:  # BALANCED
        market_band = max(tol, 0.0)
        pending_band = max(tol * 2.5, tol + 1.0)

    distance = abs(entry - mid)
    if distance <= market_band:
        return ((mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_BUY, ask, f"ENTRY_EXACT_MARKET_{exec_mode}")
                if side == "BUY" else
                (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_SELL, bid, f"ENTRY_EXACT_MARKET_{exec_mode}"))

    if distance > pending_band:
        return None, None, None, f"SKIP_EXACT_TOO_FAR_{exec_mode}"

    if side == "BUY":
        if entry < bid:
            return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_BUY_LIMIT, entry, f"ENTRY_EXACT_BUY_LIMIT_{exec_mode}"
        return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_BUY_STOP, entry, f"ENTRY_EXACT_BUY_STOP_{exec_mode}"

    if entry > ask:
        return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_SELL_LIMIT, entry, f"ENTRY_EXACT_SELL_LIMIT_{exec_mode}"
    return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_SELL_STOP, entry, f"ENTRY_EXACT_SELL_STOP_{exec_mode}"


def is_price_like_symbol(symbol: str) -> bool:
    s = (symbol or '').upper()
    return s.startswith(('XAU', 'XAG', 'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'US30', 'NAS', 'SPX', 'GER', 'UK')) or s == 'GOLD'


def be_buffer_for_symbol(symbol: str) -> float:
    info = mt5.symbol_info(symbol)
    point = float(getattr(info, 'point', 0.0) or 0.0)
    if is_price_like_symbol(symbol):
        return float(BE_BUFFER_USD)
    if point > 0:
        return max(point * 10.0, point)
    return 0.0

def allowed_chat_ids():
    if CHANNEL_IDS:
        return sorted(CHANNEL_IDS)
    return []

def normalize_multilang_signal(text: str) -> str:
    t = (text or "")

    # Normalize separators
    t = t.replace("\r", "\n")
    t = t.replace("–", "-").replace("—", "-")
    t = re.sub(r"\s*\|\s*", " | ", t)
    t = re.sub(r"[ \t]+", " ", t).strip()

    # Spanish -> English
    t = re.sub(r"\bmercado\b", "market", t, flags=re.IGNORECASE)
    t = re.sub(r"\bcompra(r)?\b", "buy", t, flags=re.IGNORECASE)
    t = re.sub(r"\bventa(r)?\b", "sell", t, flags=re.IGNORECASE)
    t = re.sub(r"\bl[ií]mite\b", "limit", t, flags=re.IGNORECASE)

    # Fix duplicated side words
    t = re.sub(r"\b(buy|sell)\s*/\s*\1\b", r"\1", t, flags=re.IGNORECASE)
    t = re.sub(r"\b(buy|sell)\s+\1\b", r"\1", t, flags=re.IGNORECASE)

    # Fix duplicated market phrases
    t = re.sub(r"\b(buy|sell)\s+market\s+\1\s+market\b", r"\1 market", t, flags=re.IGNORECASE)
    t = re.sub(r"\bmarket\s+market\b", "market", t, flags=re.IGNORECASE)

    # Clean stray slashes
    t = re.sub(r"\s*/\s*", " ", t)

    # Final cleanup
    t = re.sub(r"[ \t]+", " ", t).strip()

    return t

def normalize_raw_symbol(raw: str) -> str:
    s = (raw or "").upper().replace("/", "").strip()
    return SYMBOL_ALIASES.get(s, s)

def looks_like_fx(raw_base: str) -> bool:
    s = (raw_base or "").upper().replace("/", "")
    return len(s) == 6 and s.isalpha()

def normalize_price_str(symbol_raw: str, s: str) -> str:
    sym = normalize_raw_symbol(symbol_raw)
    t = (s or "").strip().replace(" ", "")
    if "," in t:
        t = t.replace(",", "")
    if sym in ("BTC", "BTCUSD") and "." in t:
        a, b = t.split(".", 1)
        if a.isdigit() and b.isdigit() and len(a) in (2, 3) and len(b) == 3:
            t = a + b
    return t

def clean_signal_text(text: str) -> str:
    t = (text or "")
    t = t.replace("\r", "\n")
    t = t.replace("–", "-").replace("—", "-")
    t = t.strip()
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    t = t.replace("mercado", "market").replace("MERCADO", "MARKET")
    t = re.sub(r'\bventa\b', 'sell', t, flags=re.IGNORECASE)
    t = re.sub(r'\bcompra\b', 'buy', t, flags=re.IGNORECASE)
    t = t.replace("límite", "limit").replace("limite", "limit")
    # Normalise "XAU USD" (space-separated) → "XAUUSD" so all downstream parsers
    # see the standard form. Limitless 2.0 sends the symbol with a space.
    t = re.sub(r'\bXAU\s+USD\b', 'XAUUSD', t, flags=re.IGNORECASE)
    return t.strip()

def activity_inc(chat_id, field):
    CHANNEL_ACTIVITY.setdefault(chat_id, {
        "messages": 0,
        "signals": 0,
        "ignored": 0,
        "parse_fail": 0,
        "result_updates": 0,
        "commentary": 0,
        "spam": 0,
        "unknown": 0,
        "entry_candidates": 0,
    })
    CHANNEL_ACTIVITY[chat_id].setdefault(field, 0)
    CHANNEL_ACTIVITY[chat_id][field] += 1
    
def parse_hhmm(s: str):
    try:
        hh, mm = s.split(":")
        return int(hh), int(mm)
    except Exception:
        return 0, 5


# ----------------- DAILY PER-CHANNEL STATS -----------------
def day_key_local(d: date = None) -> str:
    if d is None:
        d = date.today()
    return d.isoformat()

def ensure_channel_day_bucket(state, day_str: str):
    state.setdefault("channel_stats", {})
    state["channel_stats"].setdefault(day_str, {})
    return state["channel_stats"][day_str]

def stats_add_trade_close(state, channel_id: str, profit: float, symbol: str = "", side: str = ""):
    day_str = day_key_local()
    day_bucket = ensure_channel_day_bucket(state, day_str)
    BE_PLUS_MAX = 5.0   # $0.01–$4.99 = protected BE exit; $5+ = genuine win

    b = day_bucket.setdefault(channel_id, {
        "trades": 0, "wins": 0, "losses": 0, "breakeven": 0, "be_plus": 0,
        "profit": 0.0, "sum_win": 0.0, "sum_loss": 0.0, "sum_be_plus": 0.0, "symbols": {},
    })

    b["trades"] += 1
    b["profit"] += float(profit)

    if profit >= BE_PLUS_MAX:
        b["wins"] += 1
        b["sum_win"] += float(profit)
    elif profit > 0:
        b["be_plus"] = b.get("be_plus", 0) + 1
        b["sum_be_plus"] = b.get("sum_be_plus", 0.0) + float(profit)
    elif profit < 0:
        b["losses"] += 1
        b["sum_loss"] += float(profit)
    else:
        b["breakeven"] += 1

    if symbol:
        symb = b["symbols"].setdefault(symbol, {"trades": 0, "profit": 0.0})
        symb["trades"] += 1
        symb["profit"] += float(profit)

CHANNEL_NAME_MAP = {
    "-1003523601209": "CryptoNite Free Signals",
    "-1002717527369": "Free Tag Signals",
    "-1003882026187": "Limitless Abundance 2.0",
    "-1003889406756": "Limitless Abundance VIP",
    "-1003628454081": "XFUSION SIGNALS",
    "-1003660487270": "CryptoNite MACD Premium (internal)",
    "-1003685899545": "CryptoNite MACD Signals",
}
CHANNEL_ACTIVITY = {}

def format_channel_report(state, day_str: str) -> str:
    stats = state.get("channel_stats", {}).get(day_str, {})

    # ── Aggregate totals across all channels ──────────────────────────────
    tot_trades = tot_wins = tot_losses = tot_be_plus = tot_be = 0
    tot_profit = 0.0
    for b in stats.values():
        tot_trades  += int(b.get("trades",    0))
        tot_wins    += int(b.get("wins",      0))
        tot_losses  += int(b.get("losses",    0))
        tot_be_plus += int(b.get("be_plus",   0))
        tot_be      += int(b.get("breakeven", 0))
        tot_profit  += float(b.get("profit",  0.0))

    pnl_sign = "+" if tot_profit >= 0 else ""
    denom    = tot_wins + tot_losses
    winrate  = (tot_wins / denom * 100.0) if denom > 0 else 0.0

    # ── CNSF-style summary header ──────────────────────────────────────────
    lines = [
        "📊 <b>End-of-Day Report</b>",
        f"📡 {INSTANCE_NAME}",
        f"📅 {day_str}",
        "",
    ]

    if tot_trades > 0:
        lines += [
            f"🔢 Trades: <b>{tot_trades}</b>  ({tot_wins}W / {tot_losses}L / {tot_be_plus}BE+ / {tot_be}BE)",
            f"💰 P&L: <b>{pnl_sign}{tot_profit:.2f}</b>",
            f"🎯 Win rate: <b>{winrate:.1f}%</b>",
            "",
        ]
    else:
        lines += ["ℹ️ No trades logged today.", ""]

    # ── Per-channel breakdown ──────────────────────────────────────────────
    if stats:
        lines.append("📡 <b>By Channel</b>")
        lines.append("")
        items = sorted(stats.items(), key=lambda kv: float(kv[1].get("profit", 0.0)), reverse=True)

        for cid, b in items:
            trades  = int(b.get("trades",    0))
            wins    = int(b.get("wins",      0))
            losses  = int(b.get("losses",    0))
            be_plus = int(b.get("be_plus",   0))
            be      = int(b.get("breakeven", 0))
            prof    = float(b.get("profit",  0.0))
            be_plus_sum = float(b.get("sum_be_plus", 0.0))

            denom_ch = (wins + losses)
            winrate_ch = (wins / denom_ch * 100.0) if denom_ch > 0 else 0.0

            avg_win  = (float(b.get("sum_win",  0.0)) / wins)   if wins   > 0 else 0.0
            avg_loss = (float(b.get("sum_loss", 0.0)) / losses) if losses > 0 else 0.0

            cname = CHANNEL_NAME_MAP.get(cid, "Unknown Channel")

            lines.append(f"• {cname}")
            lines.append(
                f"P/L={prof:+.2f} | trades={trades} | "
                f"W/L/BE+/BE={wins}/{losses}/{be_plus}/{be} | "
                f"WR={winrate_ch:.1f}% | avgW={avg_win:+.2f} | avgL={avg_loss:+.2f}"
                + (f" | BE+={be_plus_sum:+.2f}" if be_plus > 0 else "")
            )
            lines.append("")

    # ── Channel activity (message intake stats) ────────────────────────────
    if CHANNEL_ACTIVITY:
        lines.append("📨 <b>Signal Intake</b>")
        lines.append("")
        for cid, data in CHANNEL_ACTIVITY.items():
            cname = CHANNEL_NAME_MAP.get(cid, "Unknown Channel")
            lines.append(f"• {cname}")
            lines.append(
                f"msgs={data['messages']} | signals={data['signals']} | "
                f"ignored={data['ignored']} | fail={data['parse_fail']}"
            )
            lines.append("")

    return "\n".join(lines).rstrip()


# ----------------- MT5 SYMBOL RESOLUTION -----------------
def mt5_refresh_symbol_cache():
    global MT5_SYMBOLS_ALL, MT5_SYMBOLS_UPPER
    syms = mt5.symbols_get()
    if syms is None:
        MT5_SYMBOLS_ALL = []
        MT5_SYMBOLS_UPPER = set()
        return
    MT5_SYMBOLS_ALL = [s.name for s in syms if getattr(s, "name", None)]
    MT5_SYMBOLS_UPPER = set(x.upper() for x in MT5_SYMBOLS_ALL)

def resolve_symbol_live(raw_symbol_text: str) -> str:
    raw_norm = normalize_raw_symbol(raw_symbol_text)
    raw_base = raw_norm.replace("/", "").upper()

    if raw_base in SYMBOL_MAP:
        mapped = SYMBOL_MAP[raw_base]
        # If the mapped symbol is directly in MT5, use it
        if mapped.upper() in MT5_SYMBOLS_UPPER:
            return mapped
        # Mapped symbol not found — try suffixes on the mapped name
        # (e.g. SYMBOL_XAU=XAUUSD but broker has XAUUSD.f)
        mapped_base = mapped.upper()
        if SYMBOL_SUFFIX_FORCE:
            candidate = f"{mapped_base}{SYMBOL_SUFFIX_FORCE}"
            if candidate.upper() in MT5_SYMBOLS_UPPER:
                log_event(f"[SYMBOL] SYMBOL_MAP {raw_base}→{mapped} not found; using {candidate}")
                return candidate
        for suf in SYMBOL_SUFFIX_PREFER:
            candidate = f"{mapped_base}{suf}"
            if candidate.upper() in MT5_SYMBOLS_UPPER:
                log_event(f"[SYMBOL] SYMBOL_MAP {raw_base}→{mapped} not found; using {candidate}")
                return candidate
        starts = [s for s in MT5_SYMBOLS_ALL if s.upper().startswith(mapped_base)]
        if starts:
            starts.sort(key=lambda x: (len(x), x))
            log_event(f"[SYMBOL] SYMBOL_MAP {raw_base}→{mapped} not found; using {starts[0]}")
            return starts[0]
        # Nothing found — return the mapped value and let the caller handle failure
        return mapped

    if raw_base in SYMBOL_RESOLVE_CACHE:
        return SYMBOL_RESOLVE_CACHE[raw_base]

    if raw_base in MT5_SYMBOLS_UPPER:
        SYMBOL_RESOLVE_CACHE[raw_base] = raw_base
        return raw_base

    if SYMBOL_SUFFIX_FORCE:
        candidate = f"{raw_base}{SYMBOL_SUFFIX_FORCE}"
        if candidate.upper() in MT5_SYMBOLS_UPPER:
            SYMBOL_RESOLVE_CACHE[raw_base] = candidate
            return candidate

    for suf in SYMBOL_SUFFIX_PREFER:
        candidate = f"{raw_base}{suf}"
        if candidate.upper() in MT5_SYMBOLS_UPPER:
            SYMBOL_RESOLVE_CACHE[raw_base] = candidate
            return candidate

    starts = [s for s in MT5_SYMBOLS_ALL if s.upper().startswith(raw_base)]
    if starts:
        starts.sort(key=lambda x: (len(x), x))
        SYMBOL_RESOLVE_CACHE[raw_base] = starts[0]
        return starts[0]

    SYMBOL_RESOLVE_CACHE[raw_base] = raw_base
    return raw_base


def alt_crypto_symbol(raw_symbol_text: str) -> str:
    raw = normalize_raw_symbol(raw_symbol_text).replace("/", "").upper()
    if raw not in ("BTC", "BTCUSD", "ETH", "ETHUSD"):
        return ""

    preferred = []
    if raw.startswith("BTC"):
        preferred.append(SYMBOL_MAP.get("BTC") or globals().get("SYMBOL_BTC") or ("BTCUSD.f" if LIVE_MODE else "BTCUSD.pro"))
        candidates = [s for s in MT5_SYMBOLS_ALL if "BTC" in s.upper()]
    else:
        preferred.append(SYMBOL_MAP.get("ETH") or globals().get("SYMBOL_ETH") or ("ETHUSD.f" if LIVE_MODE else "ETHUSD.pro"))
        candidates = [s for s in MT5_SYMBOLS_ALL if "ETH" in s.upper()]

    for p in preferred:
        if p and p in MT5_SYMBOLS_ALL:
            return p

    if candidates:
        prefer_live = ".F" if LIVE_MODE else ".PRO"
        fallback = ".PRO" if LIVE_MODE else ".F"
        candidates.sort(key=lambda x: (prefer_live not in x.upper(), fallback not in x.upper(), len(x), x))
        return candidates[0]
    return ""


# ----------------- PARSERS -----------------
FULL_RE = re.compile(
    r"""
    (?P<side>BUY|SELL)\s+
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<z1>\d+(?:\.\d+)?)\s*[-]\s*(?P<z2>\d+(?:\.\d+)?)
    .*?
    TP1[:\s]*\s*(?P<tp1>\d+(?:\.\d+)?)
    .*?
    TP2[:\s]*\s*(?P<tp2>\d+(?:\.\d+)?)
    .*?
    TP3[:\s]*\s*(?P<tp3>\d+(?:\.\d+)?)
    .*?
    SL[:\s]*\s*(?P<sl>\d+(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE
)

SIMPLE_RE = re.compile(
    r"""
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<side>BUY|SELL)\s+
    (?:MARKET)?\s*
    (?P<z1>\d+(?:\.\d+)?)\s*[-]\s*(?P<z2>\d+(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE
)

SIMPLE_PENDING_RE = re.compile(
    r"""
    ^\s*
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<side>BUY|SELL)\s+
    (?P<ptype>LIMIT|STOP)\s+
    (?P<entry>\d+(?:\.\d+)?)
    \s*$
    """,
    re.IGNORECASE | re.VERBOSE
)

PENDING_RE = re.compile(
    r"""
    ^\s*PENDING\s+
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<side>BUY|SELL)\s+
    (?P<ptype>LIMIT|STOP)\s+
    (?P<entry>\d+(?:\.\d+)?)\s+
    SL\s+(?P<sl>\d+(?:\.\d+)?)\s+
    TP\s+(?P<tp>\d+(?:\.\d+)?)
    (?:\s+.*)?\s*$
    """,
    re.IGNORECASE | re.VERBOSE
)

CT_SCALP_MARKET_RE = re.compile(
    r"""
    ^\s*
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<side>BUY|SELL)\s+
    MARKET
    (?:\s*\|\s*)?
    (?:PRICE\s*[:\-]?\s*)?
    (?P<price>\d+(?:\.\d+)?)
    .*$
    """,
    re.IGNORECASE | re.VERBOSE
)

SIG_ENTRY_RE = re.compile(
    r"""
    (?:\#\s*SIG\d+\s*)?
    .*?
    (?:(?:SIGNAL)\s*\d+\s*:\s*)?
    .*?
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+(?P<side>BUY|SELL)
    .*?
    ENTRY\s*[@:]?\s*(?P<entry>\d+(?:\.\d+)?)
    .*?
    TP1.*?@\s*(?P<tp1>\d+(?:\.\d+)?)
    .*?
    TP2.*?@\s*(?P<tp2>\d+(?:\.\d+)?)
    .*?
    TP3.*?@\s*(?P<tp3>\d+(?:\.\d+)?)
    (?:.*?TP4.*?@\s*(?P<tp4>\d+(?:\.\d+)?))?
    .*?
    SL.*?@\s*(?P<sl>\d+(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE
)

SIGNAL_ALERT_RE = re.compile(
    r"""
    (?P<side>BUY|SELL)\s+
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<z1>\d+(?:\.\d+)?)\s*[-]\s*(?P<z2>\d+(?:\.\d+)?)
    .*?
    TP1[:\s]*\s*(?P<tp1>\d+(?:\.\d+)?)
    .*?
    TP2[:\s]*\s*(?P<tp2>\d+(?:\.\d+)?)
    .*?
    TP3[:\s]*\s*(?P<tp3>\d+(?:\.\d+)?)
    .*?
    SL[:\s]*\s*(?P<sl>\d+(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE
)

EARLY_SCALP_TRIGGER_RE = re.compile(
    r"^\s*(?P<symbol>XAU|XAG|BTC|US30)\s+(?P<side>BUY|SELL)\s+SCALP\s+TRADE\s*$",
    re.IGNORECASE
)

RESULT_ONLY_RE = re.compile(
    r"""
    ^\s*
    (?P<symbol>[A-Z0-9\/\.\-_]+)
    .*?
    RESULT\s*\#?(?:TP\d+|SL)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE
)

HASH_SIGNAL_RE = re.compile(
    r"""
    ^\s*#?(?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<side>BUY|SELL)\s+
    (?P<entry>\d+(?:\.\d+)?)
    """,
    re.IGNORECASE | re.VERBOSE,
)

REVERSE_SIMPLE_RE = re.compile(
    r"""
    ^\s*
    (?P<z1>\d+(?:\.\d+)?)\s*[-]\s*(?P<z2>\d+(?:\.\d+)?)\s+
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<side>BUY|SELL)\s+MARKET
    \s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)

GENERIC_PENDING_SLTP_RE = re.compile(
    r"""
    ^\s*
    (?P<symbol>[A-Z0-9\/\.\-_]+)\s+
    (?P<side>BUY|SELL)\s+
    (?P<ptype>LIMIT|STOP)\s+
    (?P<entry>\d+(?:\.\d+)?)
    .*?\bSL\b\s*[:;@-]?\s*(?P<sl>\d+(?:\.\d+)?)
    .*?\bTP\d*\b\s*[:;@-]?\s*(?P<tp1>\d+(?:\.\d+)?)
    (?:.*?\bTP\d*\b\s*[:;@-]?\s*(?P<tp2>\d+(?:\.\d+)?))?
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

ANALYZER_ENGINE_RE = re.compile(
    r"(?is)(?:gold\s+analyzer|analyzer\s+engine|cryptonite(?:\s+\w+)*\s+signals).*?(?:asset\s*[:;]\s*([A-Z0-9_./-]+))?.*?direction\s*[:;]\s*(buy|sell).*?entry\s*[:;]\s*(\d+(?:\.\d+)?).*?sl\s*[:;]\s*(\d+(?:\.\d+)?).*?tp\s*[:;]\s*(\d+(?:\.\d+)?)"
)

# New CryptoNite icon format:
# 🚨 CryptoNite Signal | 📡 ... | 📈 XAUUSD | BUY | ⏰ ... | 📍 Entry: X | 🛑 SL: X | 🎯 TP: X
CRYPTONITE_ICON_RE = re.compile(
    r"(?:📈|📉)\s*(?P<symbol>[A-Z0-9./]+)\s*[|\n]\s*(?P<side>BUY|SELL)"
    r".*?📍\s*Entry:\s*(?P<entry>[\d.]+)"
    r".*?🛑\s*SL:\s*(?P<sl>[\d.]+)"
    r".*?🎯\s*TP:\s*(?P<tp>[\d.]+)",
    re.IGNORECASE | re.DOTALL,
)

GOLD_RANGE_FULL_RE = re.compile(
    r"""
    ^\s*
    (?:(?P<side1>BUY|SELL)\s+(?P<symbol1>GOLD|XAU(?:USD)?)|(?P<symbol2>GOLD|XAU(?:USD)?)\s+(?P<side2>BUY|SELL))
    (?:\s+NOW)?\s*@?\s*
    (?P<z1>\d+(?:\.\d+)?)\s*[-]\s*(?P<z2>\d+(?:\.\d+)?)
    .*?\bSL\b\s*[:;@-]?\s*(?P<sl>\d+(?:\.\d+)?)
    .*?\bTP1\b\s*[:;@-]?\s*(?P<tp1>\d+(?:\.\d+)?)
    .*?\bTP2\b\s*[:;@-]?\s*(?P<tp2>\d+(?:\.\d+)?)
    (?:.*?\bTP3\b\s*[:;@-]?\s*(?P<tp3>\d+(?:\.\d+)?))?
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

GOLD_RANGE_SIMPLE_RE = re.compile(
    r"""
    ^\s*
    (?:(?P<side1>BUY|SELL)\s+(?P<symbol1>GOLD|XAU(?:USD)?)|(?P<symbol2>GOLD|XAU(?:USD)?)\s+(?P<side2>BUY|SELL))
    (?:\s+NOW)?\s*@?\s*
    (?P<z1>\d+(?:\.\d+)?)\s*[-]\s*(?P<z2>\d+(?:\.\d+)?)
    .*?\bSL\b\s*[:;@-]?\s*(?P<sl>\d+(?:\.\d+)?)
    .*?\bTP\b\s*[:;@-]?\s*(?P<tp_raw>[0-9 .]+PIPS?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# TAG INLINE: "XAUUSD 4709-4689 buy" / "XAUUSD | 4543.5-4559 | sell"
# Symbol first, range, then explicit BUY/SELL (no ENTRY/SL/TP needed).
# -----------------------------------------------------------------------
SYMBOL_RANGE_SIDE_RE = re.compile(
    r"""
    ^\s*
    (?P<symbol>XAU(?:USD)?|GOLD|BTC(?:USD)?|NAS(?:DAQ|100)?|US30|GER\d*|EUR(?:USD)?|GBP(?:USD)?)\s*
    (?:\|\s*)?
    (?P<z1>\d{4,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{4,5}(?:\.\d+)?)\s*
    (?:\|\s*)?
    (?P<side>BUY|SELL)
    \b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# -----------------------------------------------------------------------
# RANGE SIDE SYMBOL: "4687-4700 sell market | XAUUSD"  (numbers first, symbol last)
# Complements SYMBOL_RANGE_SIDE_RE (symbol first). Free Tag uses both orders.
# -----------------------------------------------------------------------
RANGE_SIDE_SYMBOL_RE = re.compile(
    r"""
    ^\s*
    (?P<z1>\d{4,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{4,5}(?:\.\d+)?)
    [\s|]*
    (?P<side>BUY|SELL)(?:\s+MARKET)?
    .*?
    (?P<symbol>XAU(?:USD)?|GOLD|BTC(?:USD)?|NAS(?:DAQ|100)?|US30)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# LIKING RANGE: "Liking buys | 4697-4678 | XAUUSD buy"
#               "Liking sells | 4865-4880 XAUUSD"
#               "Liking buys again XAUUSD | 4598.6-4579"
# Side extracted from "buys"/"buy"/"sells"/"sell" near "liking"/"like".
# -----------------------------------------------------------------------
LIKING_SIDE_RANGE_RE = re.compile(
    r"""
    (?:liking|like)\s+
    (?P<side>buy(?:s)?|sell(?:s)?)\s*
    .*?
    (?P<z1>\d{4,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{4,5}(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# LIMITLESS FULL: "Sell Gold 4808 - 4800 | Stop Loss 4812 | TP1 4798 | TP2 4796 | TP3 4794 | TP4 Open (...)"
# -----------------------------------------------------------------------
LIMITLESS_FULL_RE = re.compile(
    r"""
    # No ^ anchor — allow emoji/headers before BUY/SELL (use search not match)
    (?P<side>BUY|SELL)\s+(?:GOLD|XAU(?:USD)?)\s+
    (?P<z1>\d{3,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{3,5}(?:\.\d+)?)
    .*?STOP\s*LOSS\s+(?P<sl>\d{3,5}(?:\.\d+)?)
    .*?TP1\s*[:\-]?\s*(?P<tp1>\d{3,5}(?:\.\d+)?)
    .*?TP2\s*[:\-]?\s*(?P<tp2>\d{3,5}(?:\.\d+)?)
    .*?TP3\s*[:\-]?\s*(?P<tp3>\d{3,5}(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# LIMITLESS MARKET: "Sell market | XAUUSD | 4592-4612"
# No ^ anchor — allows emoji/text before BUY/SELL; \d{3,5} covers all price ranges.
# [^\d|]* used instead of [^|]* so the pipe filler never consumes leading digits.
# -----------------------------------------------------------------------
LIMITLESS_MARKET_RE = re.compile(
    r"""
    (?P<side>BUY|SELL)\s+MARKET\s*
    (?:\|[^\d|]*)?\|?\s*
    (?:XAU(?:USD)?|GOLD)\s*
    (?:\|[^\d|]*)?\|?\s*
    (?P<z1>\d{3,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{3,5}(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# LIMITLESS VIP PIPE:
#   "Direction BUY | Currency: XAUUSD | ENTRY: 4690-4688 | TP1: 4691 | TP2: 4692"
# No SL provided — bot will auto-calculate SL from ATR.
# -----------------------------------------------------------------------
LIMITLESS_VIP_PIPE_RE = re.compile(
    r"""
    (?:direction|dir)[\ \t:|]+(?P<side>BUY|SELL)
    .*?
    (?:currency|asset|symbol|instrument)[\ \t:|]+(?P<symbol>[A-Z0-9]+(?:/[A-Z0-9]+)?)
    .*?
    (?:entry|enter)[\ \t:|]+(?P<z1>\d{3,5}(?:\.\d+)?)\s*[-–]\s*(?P<z2>\d{3,5}(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# DIRECTIONAL: fires on symbol + BUY/SELL alone — no price required.
#   "XAU USD SELL", "XAUUSD BUY", "GOLD SELL NOW", "BUY XAUUSD"
# Returns entry=0, sl=0, tp=0 so executor uses ATR-based auto-calc.
# -----------------------------------------------------------------------
_DIR_SYMS = r"""
    XAU(?:USD)?|XAUEUR|GOLD|
    SILVER|XAG(?:USD)?|
    GBP(?:JPY|USD|CHF|AUD|CAD|NZD)?|
    EUR(?:USD|JPY|GBP|CHF|CAD|AUD|NZD)?|
    USD(?:JPY|CHF|CAD)|
    AUD(?:USD|JPY|CAD|NZD|CHF)?|
    NZD(?:USD|JPY|CAD|CHF)?|
    CAD(?:JPY|CHF)?|
    CHF(?:JPY)?|
    BTC(?:USD)?|
    ETH(?:USD)?|
    NAS(?:DAQ|100)?|US30|
    GER(?:40|30)?|DAX(?:40)?|
    UK(?:100)?|
    SPX(?:500)?|
    JP(?:225)?|JPN(?:225)?
"""
DIRECTIONAL_RE = re.compile(
    r"""
    (?:
        \b(?P<sym1>""" + _DIR_SYMS + r""")\b
        [\s,|]*
        (?P<side1>BUY|SELL)\b
    |
        \b(?P<side2>BUY|SELL)\b
        [\s,|]*
        \b(?P<sym2>""" + _DIR_SYMS + r""")\b
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)

# -----------------------------------------------------------------------
# LIMITLESS EMOJI: Limitless Abundance 2.0 format (after clean_signal_text normalises "XAU USD" → "XAUUSD")
#   "XAUUSD SELL NOW4537.50-4541.50🥇TP1 4535🥈TP2 4533🥉TP3 4531🏅TP4 4529TP5 4525"
#   "XAUUSD BUY NOW4537-4533🥇TP1 4540🥈TP2 4542🥉TP3 4544🏅TP4 4546TP5 4550🚫SL 4527"
# SL is optional (SELL signals sometimes omit it — executor falls back to ATR SL).
# Must run BEFORE directional for -1003882026187 — directional would steal the signal
# and discard all the zone/TP/SL data.
# -----------------------------------------------------------------------
LIMITLESS_EMOJI_RE = re.compile(
    r"""
    (?P<sym>XAUUSD|XAU(?:USD)?|GOLD)\s+
    (?P<side>BUY|SELL)\s+NOW\s*
    (?P<z1>\d+(?:\.\d+)?)\s*[-]\s*(?P<z2>\d+(?:\.\d+)?)
    .*?TP1\s*(?P<tp1>\d+(?:\.\d+)?)
    (?:.*?TP2\s*(?P<tp2>\d+(?:\.\d+)?))?
    (?:.*?TP3\s*(?P<tp3>\d+(?:\.\d+)?))?
    (?:.*?SL\s*(?P<sl>\d+(?:\.\d+)?))?
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# XFUSION: "GOLD SELL | ENTRY: 4703-4706 | SL: 4716 |  | TP1: 4698 | TP2: 4695 | TP3: 4690 | TP4: Open"
#           "GOLD BUY | ENTRY: 4583-4585 | SL: 4577 |  | TP1: 4588 | TP2: 4592 | TP3: 4597 | TP4: Open"
#           "GOLD SELL - SMALL SIZE | High Risk Setup | ENTRY: 4581-4584 | SL: 4590 | ..."
# NOTE: NOT compiled with re.VERBOSE — VERBOSE+DOTALL combination silently breaks STRUCTURED_ENTRY
# patterns on the pipe-separated multi-segment format XFusion uses.
# -----------------------------------------------------------------------
XFUSION_RE = re.compile(
    r"(?:GOLD|XAU(?:USD)?)\s+(?P<side>BUY|SELL)"
    r".*?ENTRY\s*:\s*(?P<z1>\d{3,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{3,5}(?:\.\d+)?)"
    r".*?SL\s*:\s*(?P<sl>\d{3,5}(?:\.\d+)?)"
    r".*?TP1\s*:\s*(?P<tp1>\d{3,5}(?:\.\d+)?)"
    r".*?TP2\s*:\s*(?P<tp2>\d{3,5}(?:\.\d+)?)"
    r".*?TP3\s*:\s*(?P<tp3>\d{3,5}(?:\.\d+)?)",
    re.IGNORECASE | re.DOTALL,
)

STRUCTURED_ENTRY_SYMBOL_FIRST_RE = re.compile(
    r"""
    ^\s*#?(?P<symbol>GOLD|XAU(?:USD)?|[A-Z0-9\/\.\-_]+)\s+
    (?P<side>BUY|SELL)
    .*?(?:ENTRY\s*[:;@]?|@)\s*(?P<z1>\d+(?:\.\d+)?)
    (?:\s*[-]\s*(?P<z2>\d+(?:\.\d+)?))?
    .*?SL\s*[:;@]?\s*(?P<sl>\d+(?:\.\d+)?)
    (?P<tail>.*)$
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

STRUCTURED_ENTRY_SIDE_FIRST_RE = re.compile(
    r"""
    ^\s*(?P<side>BUY|SELL)\s+
    (?P<symbol>GOLD|XAU(?:USD)?|[A-Z0-9\/\.\-_]+)
    .*?(?:ENTRY\s*[:;@]?|@)\s*(?P<z1>\d+(?:\.\d+)?)
    (?:\s*[-]\s*(?P<z2>\d+(?:\.\d+)?))?
    .*?SL\s*[:;@]?\s*(?P<sl>\d+(?:\.\d+)?)
    (?P<tail>.*)$
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

PARSER_PROFILE_MAP = {
    # cryptonite_icon is first for any channel that posts the 🚨 CryptoNite Signal emoji format.
    # Added to -1002717527369 after observing parse failures
    # when the same format arrived from this source (forwards/relays CryptoNite signals).
    "-1002717527369": ["directional", "cryptonite_icon", "analyzer_engine", "structured_entry", "symbol_range_side", "range_side_symbol", "liking_range", "simple", "reverse_simple", "gold_range_full", "gold_range_simple", "generic_pending_sltp", "hashtag", "sig", "pending", "simple_pending", "signal_alert"],
    "-1003523601209": ["cryptonite_icon", "analyzer_engine", "structured_entry", "simple_pending", "simple", "reverse_simple", "gold_range_full", "gold_range_simple", "generic_pending_sltp", "hashtag", "sig", "pending", "signal_alert"],
    "-1002623109215": ["analyzer_engine", "structured_entry", "sig", "hashtag", "generic_pending_sltp", "simple", "reverse_simple", "pending", "simple_pending", "signal_alert", "gold_range_full", "gold_range_simple"],
    "-1003628454081": ["xfusion", "analyzer_engine", "structured_entry", "gold_range_full", "gold_range_simple", "simple", "reverse_simple", "simple_pending", "generic_pending_sltp", "hashtag", "sig", "pending", "signal_alert"],  # xfusion first — dedicated parser for pipe-separated GOLD signals
    # New channels — use broad default profile until signal format is confirmed
    "-1003271148230": ["analyzer_engine", "structured_entry", "sig", "simple_pending", "generic_pending_sltp", "gold_range_full", "gold_range_simple", "hashtag", "reverse_simple", "signal_alert", "simple", "pending"],
    "-1003882026187": ["limitless_emoji", "directional", "analyzer_engine", "structured_entry", "sig", "simple_pending", "generic_pending_sltp", "gold_range_full", "gold_range_simple", "hashtag", "reverse_simple", "signal_alert", "simple", "pending"],  # limitless_emoji FIRST — captures zone+TP+SL from emoji format before directional steals the signal
    "-1003889406756": ["directional", "limitless_vip_pipe", "cryptonite_icon", "limitless_full", "limitless_market", "analyzer_engine", "structured_entry", "sig", "simple_pending", "generic_pending_sltp", "gold_range_full", "gold_range_simple", "hashtag", "reverse_simple", "signal_alert", "simple", "pending"],  # directional first — fires on bare "XAUUSD BUY NOW"; limitless_vip_pipe second — captures full pipe-format follow-up (Direction|Currency|ENTRY|TP|SL)
    "-1003731092037": ["cryptonite_icon", "limitless_vip_pipe", "limitless_full", "limitless_market", "analyzer_engine", "structured_entry", "sig", "simple_pending", "generic_pending_sltp", "gold_range_full", "gold_range_simple", "hashtag", "reverse_simple", "signal_alert", "simple", "pending"],
    # CNMS Signals — tight profile: only the icon format fires here.
    "-1003685899545": ["cryptonite_icon"],  # CryptoNite MACD Signals — CNMS customer channel
    "default": ["cryptonite_icon", "analyzer_engine", "structured_entry", "sig", "simple_pending", "generic_pending_sltp", "gold_range_full", "gold_range_simple", "hashtag", "reverse_simple", "signal_alert", "simple", "pending"],
}


def _mk_sig(kind, raw_symbol, side, zone_low, zone_high, tps, sl, raw, pending_type="", high_risk=False):
    return {
        "kind": kind,
        "raw_symbol": raw_symbol,
        "side": side,
        "pending_type": pending_type,
        "zone_low": zone_low,
        "zone_high": zone_high,
        "tps": tps,
        "sl": sl,
        "high_risk": high_risk,
        "raw": raw,
        "ts": time.time(),
    }


def parse_reverse_simple_signal(t: str, upper: str):
    m = REVERSE_SIMPLE_RE.match(t)
    if not m:
        return None
    raw_symbol = m.group("symbol").upper().replace("/", "")
    side = m.group("side").upper()
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    return _mk_sig("SIMPLE", raw_symbol, side, zone_low, zone_high, [0.0, 0.0, 0.0], 0.0, t, high_risk=(("HIGH RISK" in upper) or ("HIGHRISK" in upper)))


def parse_hash_signal(t: str, upper: str):
    m = HASH_SIGNAL_RE.match(t)
    if not m:
        return None
    raw_symbol = m.group("symbol").upper().replace("/", "")
    side = m.group("side").upper()
    entry = float(normalize_price_str(raw_symbol, m.group("entry")))
    tp_matches = re.findall(r"\bTP\d*\b\s*[:;@-]?\s*(\d+(?:\.\d+)?)", t, flags=re.IGNORECASE)
    sl_match = re.search(r"\bSL\b\s*[:;@-]?\s*(\d+(?:\.\d+)?)", t, flags=re.IGNORECASE)
    if not sl_match:
        return None
    tps = [float(normalize_price_str(raw_symbol, x)) for x in tp_matches[:4]]
    if not tps:
        return None
    while len(tps) < 3:
        tps.append(tps[-1])
    sl = float(normalize_price_str(raw_symbol, sl_match.group(1)))
    return _mk_sig("FULL", raw_symbol, side, entry, entry, tps, sl, t, high_risk=(("HIGH RISK" in upper) or ("HIGHRISK" in upper)))


def parse_gold_range_full_signal(t: str, upper: str):
    m = GOLD_RANGE_FULL_RE.search(t)
    if not m:
        return None
    side = (m.group("side1") or m.group("side2") or "").upper()
    raw_symbol = normalize_raw_symbol((m.group("symbol1") or m.group("symbol2") or "XAU").upper())
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    sl = float(normalize_price_str(raw_symbol, m.group("sl")))
    tps = [
        float(normalize_price_str(raw_symbol, m.group("tp1"))),
        float(normalize_price_str(raw_symbol, m.group("tp2"))),
    ]
    tp3 = m.group("tp3")
    tps.append(float(normalize_price_str(raw_symbol, tp3)) if tp3 else tps[-1])
    return _mk_sig("FULL", raw_symbol, side, zone_low, zone_high, tps, sl, t, high_risk=(("HIGH RISK" in upper) or ("HIGHRISK" in upper)))


def parse_gold_range_simple_signal(t: str, upper: str):
    m = GOLD_RANGE_SIMPLE_RE.search(t)
    if not m:
        return None
    side = (m.group("side1") or m.group("side2") or "").upper()
    raw_symbol = normalize_raw_symbol((m.group("symbol1") or m.group("symbol2") or "XAU").upper())
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    return _mk_sig("SIMPLE", raw_symbol, side, zone_low, zone_high, [0.0, 0.0, 0.0], 0.0, t, high_risk=(("HIGH RISK" in upper) or ("HIGHRISK" in upper)))


def parse_symbol_range_side_signal(t: str, upper: str):
    """Handles: 'XAUUSD 4709-4689 buy' / 'XAUUSD | 4543.5-4559 | sell'"""
    m = SYMBOL_RANGE_SIDE_RE.search(t)
    if not m:
        return None
    raw_symbol = normalize_raw_symbol(m.group("symbol").upper())
    side = m.group("side").upper()
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    return _mk_sig("SIMPLE", raw_symbol, side, zone_low, zone_high, [0.0, 0.0, 0.0], 0.0, t)


def parse_range_side_symbol_signal(t: str, upper: str):
    """Handles: '4687-4700 sell market | XAUUSD' (range first, side, then symbol).
    Complement to parse_symbol_range_side_signal — Free Tag uses both orderings."""
    m = RANGE_SIDE_SYMBOL_RE.search(upper)
    if not m:
        return None
    raw_symbol = normalize_raw_symbol((m.group("symbol") or "XAU").upper())
    side = m.group("side").upper()
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    return _mk_sig("SIMPLE", raw_symbol, side, zone_low, zone_high, [0.0, 0.0, 0.0], 0.0, t)


def parse_liking_side_range_signal(t: str, upper: str):
    """Handles informal signals: 'Liking sells | 4865-4880 XAUUSD', 'Liking buys | 4697-4678 | XAUUSD buy'"""
    m = LIKING_SIDE_RANGE_RE.search(t)
    if not m:
        return None
    raw_side = m.group("side").upper()
    # Normalize: "BUYS" -> "BUY", "SELLS" -> "SELL"
    side = "BUY" if raw_side.startswith("BUY") else "SELL"
    z1 = float(normalize_price_str("XAUUSD", m.group("z1")))
    z2 = float(normalize_price_str("XAUUSD", m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    # Try to find an explicit symbol in the full text (XAUUSD, GOLD, etc.)
    sym_m = re.search(r"\b(XAU(?:USD)?|GOLD|BTC(?:USD)?|NAS(?:100)?|US30)\b", t, re.IGNORECASE)
    raw_symbol = normalize_raw_symbol(sym_m.group(1).upper() if sym_m else "XAUUSD")
    return _mk_sig("SIMPLE", raw_symbol, side, zone_low, zone_high, [0.0, 0.0, 0.0], 0.0, t)


def parse_limitless_full_signal(t: str, upper: str):
    """Handles: 'Sell Gold 4808 - 4800 | Stop Loss 4812 | TP1 4798 | TP2 4796 | TP3 4794 | TP4 Open (...)'"""
    m = LIMITLESS_FULL_RE.search(t)
    if not m:
        return None
    raw_symbol = "XAUUSD"
    side = m.group("side").upper()
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    sl  = float(normalize_price_str(raw_symbol, m.group("sl")))
    tp1 = float(normalize_price_str(raw_symbol, m.group("tp1")))
    tp2 = float(normalize_price_str(raw_symbol, m.group("tp2")))
    tp3 = float(normalize_price_str(raw_symbol, m.group("tp3")))
    # Extract TP4 from the "TP4 Open (N N N N)" parenthetical if present
    tp4_m = re.search(r"TP4\s+Open\s*\(\s*(\d+(?:\.\d+)?)", t, re.IGNORECASE)
    tp4 = float(normalize_price_str(raw_symbol, tp4_m.group(1))) if tp4_m else tp3
    return _mk_sig("FULL", raw_symbol, side, zone_low, zone_high, [tp1, tp2, tp3, tp4], sl, t)


def parse_limitless_market_signal(t: str, upper: str):
    """Handles: 'Sell market | XAUUSD | 4592-4612'"""
    m = LIMITLESS_MARKET_RE.search(t)
    if not m:
        return None
    raw_symbol = "XAUUSD"
    side = m.group("side").upper()
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    return _mk_sig("SIMPLE", raw_symbol, side, zone_low, zone_high, [0.0, 0.0, 0.0], 0.0, t)


def parse_limitless_emoji_signal(t: str, upper: str):
    """Handles Limitless Abundance 2.0 emoji format (after clean_signal_text):
    'XAUUSD SELL NOW4537.50-4541.50🥇TP1 4535🥈TP2 4533🥉TP3 4531🏅TP4 4529TP5 4525'
    'XAUUSD BUY NOW4537-4533🥇TP1 4540🥈TP2 4542🥉TP3 4544🏅TP4 4546TP5 4550🚫SL 4527'
    SL is optional — if absent, executor falls back to ATR-based SL (sl=0).
    MUST run before directional in the chain — directional would steal the signal
    and discard zone/TP/SL data."""
    m = LIMITLESS_EMOJI_RE.search(t)
    if not m:
        return None
    raw_symbol = normalize_raw_symbol((m.group("sym") or "XAUUSD").upper())
    side       = m.group("side").upper()
    z1         = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2         = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    tp1s = m.group("tp1"); tp2s = m.group("tp2"); tp3s = m.group("tp3"); sls = m.group("sl")
    tp1  = float(normalize_price_str(raw_symbol, tp1s)) if tp1s else 0.0
    tp2  = float(normalize_price_str(raw_symbol, tp2s)) if tp2s else tp1
    tp3  = float(normalize_price_str(raw_symbol, tp3s)) if tp3s else tp2
    sl   = float(normalize_price_str(raw_symbol, sls))  if sls  else 0.0
    high_risk = ("HIGH RISK" in upper) or ("HIGHRISK" in upper)
    return _mk_sig("FULL", raw_symbol, side, zone_low, zone_high, [tp1, tp2, tp3], sl, t, high_risk=high_risk)


def parse_xfusion_signal(t: str, upper: str):
    """Handles XFusion GOLD signals:
    'GOLD SELL | ENTRY: 4703-4706 | SL: 4716 |  | TP1: 4698 | TP2: 4695 | TP3: 4690 | TP4: Open'
    'GOLD SELL - SMALL SIZE | High Risk Setup | ENTRY: 4581-4584 | SL: 4590 | ...'
    Uses a non-VERBOSE regex — VERBOSE+DOTALL silently breaks this pipe-separated format.
    """
    m = XFUSION_RE.search(t)
    if not m:
        return None
    raw_symbol = "XAUUSD"
    side = m.group("side").upper()
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    sl  = float(normalize_price_str(raw_symbol, m.group("sl")))
    tp1 = float(normalize_price_str(raw_symbol, m.group("tp1")))
    tp2 = float(normalize_price_str(raw_symbol, m.group("tp2")))
    tp3 = float(normalize_price_str(raw_symbol, m.group("tp3")))
    # TP4 is often "Open" — try to extract it from the parenthetical fallback
    tp4_m = re.search(r"TP4\s+Open\s*\(\s*(\d+(?:\.\d+)?)", t, re.IGNORECASE)
    tp4 = float(normalize_price_str(raw_symbol, tp4_m.group(1))) if tp4_m else tp3
    high_risk = bool(re.search(r"SMALL\s+SIZE|HIGH\s+RISK", upper))
    return _mk_sig("FULL", raw_symbol, side, zone_low, zone_high, [tp1, tp2, tp3, tp4], sl, t, high_risk=high_risk)

def parse_limitless_vip_pipe_signal(t: str, upper: str):
    """Handles: 'Direction BUY | Currency: XAUUSD | ENTRY: 4690-4688 | TP1: 4691 | TP2: 4692 | SL: 4680'
    Also handles emoji variants: 'Direction  BUY  |  | Currency: XAUUSD | ENTRY : 4552-4550 | 🤑TP1: 4554 | 🛑 SL: 4546'
    Extracts SL and up to 7 TPs when present; falls back to SIMPLE (ATR auto-calc) when absent."""
    m = LIMITLESS_VIP_PIPE_RE.search(t)
    if not m:
        return None
    raw_symbol = normalize_raw_symbol(m.group("symbol").upper().replace("/", ""))
    side = m.group("side").upper()
    z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
    z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    # Extract TPs — handles both "TP1: 4554" and "🤑TP1: 4554"
    tp_matches = re.findall(r"TP\d+\s*:\s*(\d+(?:\.\d+)?)", t, re.IGNORECASE)
    tps = [float(normalize_price_str(raw_symbol, x)) for x in tp_matches[:4]] if tp_matches else []
    while len(tps) < 3:
        tps.append(tps[-1] if tps else 0.0)
    # Extract SL — handles "SL: 4546" and "🛑 SL:  4546"
    sl_m = re.search(r"(?:🛑\s*)?SL\s*:\s*(\d+(?:\.\d+)?)", t, re.IGNORECASE)
    sl = float(normalize_price_str(raw_symbol, sl_m.group(1))) if sl_m else 0.0
    high_risk = bool(re.search(r"SMALL\s+SIZE|HIGH\s+RISK", upper))
    if sl > 0 and any(tp > 0 for tp in tps):
        return _mk_sig("FULL", raw_symbol, side, zone_low, zone_high, tps, sl, t, high_risk=high_risk)
    return _mk_sig("SIMPLE", raw_symbol, side, zone_low, zone_high, tps, sl, t, high_risk=high_risk)


def parse_directional_signal(t: str, upper: str):
    """Handles bare directional signals: 'XAU USD SELL', 'XAUUSD BUY', 'GOLD SELL NOW', 'BUY XAUUSD'.
    Returns entry=0, sl=0, tp=0 — executor will auto-calculate SL/TP from ATR and use
    configured trail settings. Designed for channels that send direction first, then setup."""
    m = DIRECTIONAL_RE.search(t)
    if not m:
        return None
    side = (m.group("side1") or m.group("side2") or "").upper()
    sym_raw = (m.group("sym1") or m.group("sym2") or "").upper().replace(" ", "")
    if not side or not sym_raw:
        return None
    raw_symbol = normalize_raw_symbol(sym_raw)
    return {
        "kind":       "MARKET",
        "raw_symbol": raw_symbol,   # fix: place_trade() reads sig.get("raw_symbol"), not "symbol"
        "side":       side,
        "entry":      0.0,
        "zone_low":   0.0,
        "zone_high":  0.0,
        "sl":         0.0,
        "tp1":        0.0,
        "tp2":        0.0,
        "tp3":        0.0,
        "tp_levels":  [],
        "tps":        [],   # place_trade expects this key; will be rebuilt via build_simple_sl_tp
        "ts":         None, # fix: place_trade() does sig["ts"] — must exist even if None for MARKET sigs
        "raw":        t,
        "high_risk":  False,
    }


def parse_generic_pending_sltp_signal(t: str, upper: str):
    m = GENERIC_PENDING_SLTP_RE.search(t)
    if not m:
        return None
    raw_symbol = m.group("symbol").upper().replace("/", "")
    side = m.group("side").upper()
    ptype = m.group("ptype").upper()
    entry = float(normalize_price_str(raw_symbol, m.group("entry")))
    sl = float(normalize_price_str(raw_symbol, m.group("sl")))
    tp1 = float(normalize_price_str(raw_symbol, m.group("tp1")))
    tp2g = m.group("tp2")
    tp2 = float(normalize_price_str(raw_symbol, tp2g)) if tp2g else tp1
    return _mk_sig("PENDING", raw_symbol, side, entry, entry, [tp1, tp2, tp2], sl, t, pending_type=ptype, high_risk=(("HIGH RISK" in upper) or ("HIGHRISK" in upper)))


def parse_analyzer_engine_signal(t: str, upper: str):
    m = ANALYZER_ENGINE_RE.search(t)
    if not m:
        return None
    raw_symbol = normalize_raw_symbol((m.group(1) or "XAUUSD").upper())
    side = m.group(2).upper()
    entry = float(normalize_price_str(raw_symbol, m.group(3)))
    sl = float(normalize_price_str(raw_symbol, m.group(4)))
    tp = float(normalize_price_str(raw_symbol, m.group(5)))
    return _mk_sig("FULL", raw_symbol, side, entry, entry, [tp, tp, tp], sl, t, high_risk=False)


def parse_structured_entry_signal(t: str, upper: str):
    m = STRUCTURED_ENTRY_SYMBOL_FIRST_RE.search(t) or STRUCTURED_ENTRY_SIDE_FIRST_RE.search(t)
    if not m:
        return None

    raw_symbol = normalize_raw_symbol((m.group("symbol") or "").upper())
    side = (m.group("side") or "").upper()
    z1s = m.group("z1")
    z2s = m.group("z2") or z1s
    sls = m.group("sl")
    if not (raw_symbol and side and z1s and sls):
        return None

    z1 = float(normalize_price_str(raw_symbol, z1s))
    z2 = float(normalize_price_str(raw_symbol, z2s))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    sl = float(normalize_price_str(raw_symbol, sls))
    tail = m.group("tail") or ""

    tp_matches = re.findall(r"\bTP\d*\b\s*[:;@-]?\s*(\d+(?:\.\d+)?)", tail, flags=re.IGNORECASE)
    if tp_matches:
        tps = [float(normalize_price_str(raw_symbol, x)) for x in tp_matches[:4]]
        while len(tps) < 3:
            tps.append(tps[-1])
        return _mk_sig("FULL", raw_symbol, side, zone_low, zone_high, tps, sl, t, high_risk=(("HIGH RISK" in upper) or ("HIGHRISK" in upper)))

    pip_match = re.search(r"\bTP\b\s*[:;@-]?\s*(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?\s*PIPS?", tail, flags=re.IGNORECASE)
    if pip_match:
        return {
            "kind": "SIMPLE",
            "raw_symbol": raw_symbol,
            "side": side,
            "pending_type": "",
            "zone_low": zone_low,
            "zone_high": zone_high,
            "tps": [0.0, 0.0, 0.0],
            "sl": sl,
            "high_risk": (("HIGH RISK" in upper) or ("HIGHRISK" in upper)),
            "raw": t,
            "ts": time.time(),
        }

    return None


def parse_cryptonite_icon_signal(t: str, upper: str):
    """Parses the new CryptoNite icon-based format:
    🚨 CryptoNite Signal | 📡 ... | 📈 XAUUSD | BUY | ⏰ ... | 📍 Entry: X | 🛑 SL: X | 🎯 TP: X
    """
    m = CRYPTONITE_ICON_RE.search(t)
    if not m:
        return None
    raw_symbol = normalize_raw_symbol(m.group("symbol").upper())
    side = m.group("side").upper()
    entry = float(normalize_price_str(raw_symbol, m.group("entry")))
    sl    = float(normalize_price_str(raw_symbol, m.group("sl")))
    tp    = float(normalize_price_str(raw_symbol, m.group("tp")))
    return _mk_sig("FULL", raw_symbol, side, entry, entry, [tp, tp, tp], sl, t, high_risk=False)


def parse_signal_by_source(chat_id: str, text: str):
    t = clean_signal_text(text)
    upper = t.upper()

    # shared cleanup for ugly Telegram formatting before regex parsing
    t = re.sub(r"\b([A-Z0-9\/\.\-_]+)\s+(BUY|SELL)\s+MARKET\s+\2\s+MARKET\b", r"\1 \2 MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\b([A-Z0-9\/\.\-_]+)\s+(BUY|SELL)\s+\2\s+MARKET\b", r"\1 \2 MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\b([A-Z0-9\/\.\-_]+)\s+(BUY|SELL)\s*/\s*(BUY|SELL)\s+MARKET\b", r"\1 \2 MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\b(BUY|SELL)\s+MARKET\s+(BUY|SELL)\b", r"\1 MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\bMARKET\s+MARKET\b", "MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\b(BUY|SELL)\s+MARKET\s+AT\s+(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?)\s+([A-Z0-9/._-]+)\b", r"\3 \1 MARKET \2", t, flags=re.IGNORECASE)

    if RESULT_ONLY_RE.search(t):
        return None

    profile = PARSER_PROFILE_MAP.get(str(chat_id), PARSER_PROFILE_MAP["default"])
    for name in profile:
        if name == "cryptonite_icon":
            sig = parse_cryptonite_icon_signal(t, upper)
            if sig:
                return sig
        elif name == "analyzer_engine":
            sig = parse_analyzer_engine_signal(t, upper)
            if sig:
                return sig
        elif name == "structured_entry":
            sig = parse_structured_entry_signal(t, upper)
            if sig:
                return sig
        elif name == "reverse_simple":
            sig = parse_reverse_simple_signal(t, upper)
            if sig:
                return sig
        elif name == "symbol_range_side":
            sig = parse_symbol_range_side_signal(t, upper)
            if sig:
                return sig
        elif name == "range_side_symbol":
            sig = parse_range_side_symbol_signal(t, upper)
            if sig:
                return sig
        elif name == "liking_range":
            sig = parse_liking_side_range_signal(t, upper)
            if sig:
                return sig
        elif name == "directional":
            sig = parse_directional_signal(t, upper)
            if sig:
                return sig
        elif name == "xfusion":
            sig = parse_xfusion_signal(t, upper)
            if sig:
                return sig
        elif name == "limitless_vip_pipe":
            sig = parse_limitless_vip_pipe_signal(t, upper)
            if sig:
                return sig
        elif name == "limitless_emoji":
            sig = parse_limitless_emoji_signal(t, upper)
            if sig:
                return sig
        elif name == "limitless_full":
            sig = parse_limitless_full_signal(t, upper)
            if sig:
                return sig
        elif name == "limitless_market":
            sig = parse_limitless_market_signal(t, upper)
            if sig:
                return sig
        elif name == "hashtag":
            sig = parse_hash_signal(t, upper)
            if sig:
                return sig
        elif name == "gold_range_full":
            sig = parse_gold_range_full_signal(t, upper)
            if sig:
                return sig
        elif name == "gold_range_simple":
            sig = parse_gold_range_simple_signal(t, upper)
            if sig:
                return sig
        elif name == "generic_pending_sltp":
            sig = parse_generic_pending_sltp_signal(t, upper)
            if sig:
                return sig
        elif name == "sig":
            sig = parse_any_signal(t)
            if sig and sig.get("kind") == "FULL":
                return sig
        elif name == "simple_pending":
            sig = parse_any_signal(t)
            if sig and sig.get("kind") == "SIMPLE_PENDING":
                return sig
        elif name == "pending":
            sig = parse_any_signal(t)
            if sig and sig.get("kind") == "PENDING":
                return sig
        elif name == "signal_alert":
            sig = parse_any_signal(t)
            if sig and sig.get("kind") == "FULL":
                return sig
        elif name == "simple":
            sig = parse_any_signal(t)
            if sig and sig.get("kind") in ("SIMPLE", "SCALP_MARKET", "EARLY_SCALP"):
                return sig

    return parse_any_signal(t)

def choose_tp(tps, which: str):
    which = (which or "").upper()
    if len(tps) >= 3:
        return {"TP1": tps[0], "TP2": tps[1], "TP3": tps[2]}.get(which, tps[1])
    if len(tps) == 2:
        return {"TP1": tps[0], "TP2": tps[1]}.get(which, tps[0])
    return tps[0] if tps else 0.0

def parse_any_signal(text: str):
    t = clean_signal_text(text)
    upper = t.upper()

    # Extra cleanup for ugly Telegram formatting before regex parsing
    t = re.sub(r"\b([A-Z0-9\/\.\-_]+)\s+(BUY|SELL)\s+MARKET\s+\2\s+MARKET\b", r"\1 \2 MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\b([A-Z0-9\/\.\-_]+)\s+(BUY|SELL)\s+\2\s+MARKET\b", r"\1 \2 MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\b([A-Z0-9\/\.\-_]+)\s+(BUY|SELL)\s*/\s*(BUY|SELL)\s+MARKET\b", r"\1 \2 MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\b(BUY|SELL)\s+MARKET\s+(BUY|SELL)\b", r"\1 MARKET", t, flags=re.IGNORECASE)
    t = re.sub(r"\bMARKET\s+MARKET\b", "MARKET", t, flags=re.IGNORECASE)

    # Skip obvious result-only posts
    if RESULT_ONLY_RE.search(t):
        return None

    # Cleanup weird repeated patterns before parsing
    t = re.sub(r"\b([A-Z0-9\/\.\-_]+)\s+(BUY|SELL)\s*/\s*(BUY|SELL)\b", r"\1 \2", t, flags=re.IGNORECASE)
    t = re.sub(r"\b(BUY|SELL)\s*/\s*(BUY|SELL)\s+MARKET\b", lambda m: f"{m.group(1)} MARKET", t, flags=re.IGNORECASE)

    # Early scalp trigger (no prices)
    m0 = EARLY_SCALP_TRIGGER_RE.match(t)
    if m0:
        raw_symbol = m0.group("symbol").upper()
        side = m0.group("side").upper()
        return {
            "kind": "EARLY_SCALP",
            "raw_symbol": raw_symbol,
            "side": side,
            "pending_type": "",
            "zone_low": 0.0, "zone_high": 0.0,
            "tps": [0.0, 0.0, 0.0],
            "sl": 0.0,
            "high_risk": True,
            "raw": t,
            "ts": time.time(),
        }

    # CT scalp market
    m = CT_SCALP_MARKET_RE.match(t)
    if m:
        raw_symbol = m.group("symbol").upper().replace("/", "")
        side = m.group("side").upper()
        price = float(normalize_price_str(raw_symbol, m.group("price")))
        return {
            "kind": "SCALP_MARKET",
            "raw_symbol": raw_symbol,
            "side": side,
            "pending_type": "",
            "zone_low": price, "zone_high": price,
            "tps": [0.0, 0.0, 0.0],
            "sl": 0.0,
            "high_risk": ("HIGH RISK" in upper) or ("HIGHRISK" in upper),
            "raw": t,
            "ts": time.time(),
        }

    # SIG format
    m = SIG_ENTRY_RE.search(t)
    if m:
        raw_symbol = m.group("symbol").upper().replace("/", "")
        side = m.group("side").upper()
        entry = float(normalize_price_str(raw_symbol, m.group("entry")))
        sl = float(normalize_price_str(raw_symbol, m.group("sl")))
        tp1 = float(normalize_price_str(raw_symbol, m.group("tp1")))
        tp2 = float(normalize_price_str(raw_symbol, m.group("tp2")))
        tp3 = float(normalize_price_str(raw_symbol, m.group("tp3")))
        tp4g = m.group("tp4")
        tps = [tp1, tp2, tp3]
        if tp4g:
            tps.append(float(normalize_price_str(raw_symbol, tp4g)))
        return {
            "kind": "FULL",
            "raw_symbol": raw_symbol,
            "side": side,
            "zone_low": entry, "zone_high": entry,
            "tps": tps,
            "sl": sl,
            "high_risk": ("HIGH RISK" in upper) or ("HIGHRISK" in upper),
            "raw": t,
            "ts": time.time(),
        }

    # Generic inline pending format
    sig = parse_generic_pending_sltp_signal(t, upper)
    if sig:
        return sig

    # PENDING format
    m = PENDING_RE.match(t)
    if m:
        raw_symbol = m.group("symbol").upper().replace("/", "")
        side = m.group("side").upper()
        ptype = m.group("ptype").upper()
        entry = float(normalize_price_str(raw_symbol, m.group("entry")))
        sl = float(normalize_price_str(raw_symbol, m.group("sl")))
        tp = float(normalize_price_str(raw_symbol, m.group("tp")))
        return {
            "kind": "PENDING",
            "raw_symbol": raw_symbol,
            "side": side,
            "pending_type": ptype,
            "zone_low": entry, "zone_high": entry,
            "tps": [tp, tp, tp],
            "sl": sl,
            "high_risk": ("HIGH RISK" in upper) or ("HIGHRISK" in upper),
            "raw": t,
            "ts": time.time(),
        }

    # SIMPLE_PENDING format
    m = SIMPLE_PENDING_RE.match(t)
    if m:
        raw_symbol = m.group("symbol").upper().replace("/", "")
        side = m.group("side").upper()
        ptype = m.group("ptype").upper()
        entry = float(normalize_price_str(raw_symbol, m.group("entry")))
        return {
            "kind": "SIMPLE_PENDING",
            "raw_symbol": raw_symbol,
            "side": side,
            "pending_type": ptype,
            "zone_low": entry, "zone_high": entry,
            "tps": [0.0, 0.0, 0.0],
            "sl": 0.0,
            "high_risk": ("HIGH RISK" in upper) or ("HIGHRISK" in upper),
            "raw": t,
            "ts": time.time(),
        }

    # SIGNAL ALERT / FULL format
    m = SIGNAL_ALERT_RE.search(t)
    if m:
        side = m.group("side").upper()
        raw_symbol = m.group("symbol").upper().replace("/", "")
        z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
        z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
        zone_low, zone_high = min(z1, z2), max(z1, z2)
        tps = [
            float(normalize_price_str(raw_symbol, m.group("tp1"))),
            float(normalize_price_str(raw_symbol, m.group("tp2"))),
            float(normalize_price_str(raw_symbol, m.group("tp3"))),
        ]
        sl = float(normalize_price_str(raw_symbol, m.group("sl")))
        return {
            "kind": "FULL",
            "raw_symbol": raw_symbol,
            "side": side,
            "zone_low": zone_low, "zone_high": zone_high,
            "tps": tps,
            "sl": sl,
            "high_risk": ("HIGH RISK" in upper) or ("HIGHRISK" in upper),
            "raw": t,
            "ts": time.time(),
        }

    # SIMPLE format
    m = SIMPLE_RE.search(t)
    if m:
        raw_symbol = m.group("symbol").upper().replace("/", "")
        side = m.group("side").upper()
        z1 = float(normalize_price_str(raw_symbol, m.group("z1")))
        z2 = float(normalize_price_str(raw_symbol, m.group("z2")))
        zone_low, zone_high = min(z1, z2), max(z1, z2)
        return {
            "kind": "SIMPLE",
            "raw_symbol": raw_symbol,
            "side": side,
            "zone_low": zone_low, "zone_high": zone_high,
            "tps": [0.0, 0.0, 0.0],
            "sl": 0.0,
            "high_risk": ("HIGH RISK" in upper) or ("HIGHRISK" in upper),
            "raw": t,
            "ts": time.time(),
        }

    return None


# ----------------- MT5 HELPERS -----------------
_mt5_latch_logged = False   # suppress repeated "Latched" log on every connect/disconnect cycle

def mt5_connect(retries: int = 3):
    """Connect to MT5.
    If MT5_LOGIN is 0 (not set in .env), skip credentials entirely and latch
    to whatever terminal is already open on this machine — useful when moving
    between machines or when the broker login is managed outside the bot.
    If MT5_LOGIN is set, attempt a full credential login first, then fall back
    to latch-mode if the broker returns -6 (auth failed but terminal is open).
    """
    global _mt5_latch_logged
    last_err = None
    for i in range(retries):
        if mt5.initialize(timeout=10000):
            # ── Latch mode: no credentials configured ──
            if not MT5_LOGIN:
                acc = mt5.account_info()
                if acc is not None:
                    if not _mt5_latch_logged:
                        log_event(f"[MT5] Latched to open terminal — login={acc.login} server={acc.server}")
                        _mt5_latch_logged = True
                    mt5_refresh_symbol_cache()
                    return
                mt5.shutdown()
            else:
                # ── Credential mode ──
                if mt5.login(MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
                    if not _mt5_latch_logged:
                        log_event(f"[MT5] Connected — login={MT5_LOGIN} server={MT5_SERVER}")
                        _mt5_latch_logged = True
                    mt5_refresh_symbol_cache()
                    return
                last_err = mt5.last_error()
                # -6 = Authorization failed: terminal open but credentials rejected.
                # Fall back to latching on to the already-logged-in session.
                if last_err and last_err[0] == -6:
                    mt5.shutdown()
                    if mt5.initialize(timeout=10000):
                        acc = mt5.account_info()
                        if acc is not None:
                            if not _mt5_latch_logged:
                                log_event(f"[MT5] Auth failed with credentials; latched to open terminal (login={acc.login})")
                                _mt5_latch_logged = True
                            mt5_refresh_symbol_cache()
                            return
                        mt5.shutdown()
        else:
            last_err = mt5.last_error()
        time.sleep(1.0 + i)
    raise RuntimeError(f"MT5 connect failed after retries: {last_err}")

def mt5_disconnect():
    mt5.shutdown()

def mt5_reset_latch_log():
    """Call this after a real MT5 outage so the next connect logs the latch again."""
    global _mt5_latch_logged
    _mt5_latch_logged = False

def enforce_account_lock():
    if not ALLOWED_ACCOUNT_LOGIN:
        return
    acc = mt5.account_info()
    if acc is None:
        raise RuntimeError("account_info() is None; cannot verify account lock.")
    if str(acc.login) != str(ALLOWED_ACCOUNT_LOGIN):
        raise RuntimeError(f"WRONG ACCOUNT: connected {acc.login} but ALLOWED_ACCOUNT_LOGIN={ALLOWED_ACCOUNT_LOGIN}")

def ensure_symbol(symbol: str):
    info = mt5.symbol_info(symbol)
    if info is None:
        return None
    if not info.visible:
        mt5.symbol_select(symbol, True)
        info = mt5.symbol_info(symbol)
    return info

def round_price(symbol: str, price: float) -> float:
    info = mt5.symbol_info(symbol)
    if not info:
        return float(price)
    digits = int(getattr(info, "digits", 5) or 5)
    return round(float(price), digits)

def symbol_class(symbol: str, raw_hint: str = "") -> str:
    s = (symbol or "").upper()
    h = (raw_hint or "").upper()

    if "XAU" in s or "XAU" in h or "GOLD" in h:
        return "XAU"
    if "XAG" in s or "XAG" in h or "SILVER" in h:
        return "XAG"
    if "BTC" in s or "BTC" in h:
        return "BTC"

    raw = normalize_raw_symbol(raw_hint).replace("/", "") if raw_hint else ""
    if raw in CRYPTO_SMALL_SET or "XRP" in s:
        return "CRYPTO_SMALL"

    if any(k in s for k in ("US30", "NAS", "NQ", "SPX", "GER", "UK100", "DJ", "DAX", "JP225", "JPN225", "NIKKEI", "NKY")):
        return "INDEX"

    base = normalize_raw_symbol(raw_hint) if raw_hint else s
    base = base.replace("/", "")
    if looks_like_fx(base):
        return "FX"

    if s.endswith("USD") and not looks_like_fx(s.replace(".PRO", "").replace(".F", "")):
        return "CRYPTO"

    return "DEFAULT"

def spread_threshold(symbol: str, raw_hint: str = ""):
    cls = symbol_class(symbol, raw_hint)
    if cls == "FX":
        return ("POINTS", float(MAX_SPREAD_POINTS_FX))
    if cls == "XAU":
        return ("PRICE", float(MAX_SPREAD_PRICE_XAU))
    if cls == "XAG":
        return ("PRICE", float(MAX_SPREAD_PRICE_XAG))
    if cls in ("BTC", "CRYPTO", "CRYPTO_SMALL"):
        return ("PRICE", float(MAX_SPREAD_PRICE_CRYPTO))
    if cls == "INDEX":
        return ("PRICE", float(MAX_SPREAD_PRICE_INDEX))
    return ("PRICE", float(MAX_SPREAD_PRICE_DEFAULT))

def spread_info(symbol: str, raw_hint: str = ""):
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if not info or not tick:
        return (False, "NO_TICK", None, None, None)

    ask = float(tick.ask)
    bid = float(tick.bid)
    spread_price = max(0.0, ask - bid)

    mode, lim = spread_threshold(symbol, raw_hint)

    if mode == "POINTS":
        pt = float(info.point) if float(info.point) != 0 else 0.0
        spread_points = (spread_price / pt) if pt > 0 else 999999.0
        ok = spread_points <= lim
        return (ok, "POINTS", spread_points, lim, spread_price)
    else:
        ok = spread_price <= lim
        return (ok, "PRICE", spread_price, lim, spread_price)

def spread_ok_with_recheck(symbol: str, raw_hint: str = "") -> bool:
    ok, mode, val, lim, sp = spread_info(symbol, raw_hint)
    if ok:
        return True
    if not SPREAD_RECHECK_ENABLED or SPREAD_RECHECK_SECONDS <= 0:
        log_event(f"Skip: spread too wide on {symbol} ({mode} {val} > {lim}) spread_price={sp}")
        return False

    deadline = time.time() + SPREAD_RECHECK_SECONDS
    while time.time() < deadline:
        time.sleep(max(0.2, SPREAD_RECHECK_INTERVAL))
        ok2, mode2, val2, lim2, sp2 = spread_info(symbol, raw_hint)
        if ok2:
            log_event(f"Spread recheck OK on {symbol} after wait ({mode2} {val2} <= {lim2})")
            return True

    log_event(f"Skip: spread too wide on {symbol} after recheck ({mode} {val} > {lim})")
    return False

def open_positions_count(symbol: str) -> int:
    poss = mt5.positions_get(symbol=symbol)
    if poss is None:
        return 0
    if not COUNT_ONLY_MAGIC:
        return len(poss)
    return len([p for p in poss if int(getattr(p, "magic", 0)) == MAGIC])



def find_recent_position_ticket(symbol: str, volume: float, lookback_seconds: int = 15):
    """Best-effort helper to find the most recent open position ticket for a symbol/volume."""
    try:
        poss = mt5.positions_get(symbol=symbol)
        if not poss:
            return None
        now = time.time()
        candidates = []
        for p in poss:
            try:
                if COUNT_ONLY_MAGIC and int(getattr(p, "magic", 0)) != MAGIC:
                    continue
            except Exception:
                pass
            pv = float(getattr(p, "volume", 0.0) or 0.0)
            if volume > 0 and abs(pv - float(volume)) > 1e-9:
                continue
            t = getattr(p, "time", None)
            age_ok = True
            if t is not None:
                try:
                    age_ok = abs(now - float(t)) <= float(lookback_seconds)
                except Exception:
                    age_ok = True
            if age_ok:
                candidates.append((float(t or 0), int(getattr(p, "ticket", 0))))
        if not candidates:
            # fallback: most recent matching position even if outside lookback
            for p in poss:
                try:
                    if COUNT_ONLY_MAGIC and int(getattr(p, "magic", 0)) != MAGIC:
                        continue
                except Exception:
                    pass
                pv = float(getattr(p, "volume", 0.0) or 0.0)
                if volume > 0 and abs(pv - float(volume)) > 1e-9:
                    continue
                candidates.append((float(getattr(p, "time", 0) or 0), int(getattr(p, "ticket", 0))))
        if not candidates:
            return None
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1]
    except Exception:
        return None
def pending_orders_count(symbol: str) -> int:
    orders = mt5.orders_get(symbol=symbol)
    if orders is None:
        return 0
    if not COUNT_ONLY_MAGIC:
        return len(orders)
    return len([o for o in orders if int(getattr(o, "magic", 0)) == MAGIC])

def remove_my_pending_orders_for_symbol(symbol: str) -> int:
    orders = mt5.orders_get(symbol=symbol)
    if orders is None:
        return 0
    removed = 0
    for o in orders:
        if int(getattr(o, "magic", 0)) != MAGIC:
            continue
        req = {"action": mt5.TRADE_ACTION_REMOVE, "order": int(o.ticket)}
        res = mt5.order_send(req)
        rc = getattr(res, "retcode", None)
        if rc in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009):
            removed += 1
    return removed


def cancel_all_my_pending_orders() -> int:
    """Cancel ALL pending orders placed by this bot across all symbols.
    Called on MT5 reconnect to flush orders that were placed at stale prices
    during the outage — prevents them from filling unexpectedly on reconnect.
    Returns the number of orders successfully cancelled."""
    orders = mt5.orders_get()
    if not orders:
        return 0
    removed = 0
    for o in orders:
        if int(getattr(o, "magic", 0)) != MAGIC:
            continue
        req = {"action": mt5.TRADE_ACTION_REMOVE, "order": int(o.ticket)}
        res = mt5.order_send(req)
        rc = getattr(res, "retcode", None)
        if rc in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009):
            removed += 1
            log_event(
                f"🧹 Cancelled stale pending: ticket={o.ticket} "
                f"{getattr(o, 'symbol', '?')} (MT5 reconnect cleanup)"
            )
        else:
            log_event(
                f"🧹 Cancel pending FAILED: ticket={o.ticket} retcode={rc}"
            )
    return removed

def min_stop_distance(symbol: str) -> float:
    info = mt5.symbol_info(symbol)
    if not info:
        return 0.0
    pts = float(getattr(info, "trade_stops_level", 0) or 0)
    return pts * float(info.point)

def cap_max_lot(symbol: str, lots: float, raw_hint: str = "") -> float:
    cls = symbol_class(symbol, raw_hint)
    if cls == "XAU":
        return min(lots, MAX_LOT_XAU)
    if cls == "XAG":
        return min(lots, MAX_LOT_XAG)
    if cls == "BTC":
        return min(lots, MAX_LOT_BTC)
    if cls == "CRYPTO_SMALL":
        return min(lots, MAX_LOT_CRYPTO_SMALL)
    if cls == "INDEX":
        return min(lots, MAX_LOT_INDEX)
    return min(lots, MAX_LOT_DEFAULT)

def floor_to_step(lots: float, step: float) -> float:
    if step <= 0:
        return lots
    return math.floor(lots / step) * step

def _balance_scale_factor(balance: float) -> float:
    """Return a lot-size multiplier based on account balance tier.
    Allows small accounts to trade proportionally smaller positions
    rather than being stuck at the broker minimum lot floor.
      $0    - $499  : 0.10x (10x smaller)
      $500  - $999  : 0.25x (4x smaller)
      $1000 - $1999 : 0.50x (2x smaller)
      $2000 - $4999 : 0.75x (1.33x smaller)
      $5000+        : 1.00x (full size)
    """
    if balance < 500:
        return 0.10
    elif balance < 1000:
        return 0.25
    elif balance < 2000:
        return 0.50
    elif balance < 5000:
        return 0.75
    else:
        return 1.00


def lot_from_risk(symbol: str, entry: float, sl: float, risk_frac: float, raw_hint: str = "") -> float:
    acc = mt5.account_info()
    info = mt5.symbol_info(symbol)
    if acc is None or info is None:
        raise RuntimeError("Missing MT5 account/symbol info")

    risk_amount = float(acc.balance) * float(risk_frac)

    tick_value, tick_size = info.trade_tick_value, info.trade_tick_size
    if not tick_size or tick_size == 0:
        raise RuntimeError("Bad tick size")

    value_per_price_unit = tick_value / tick_size
    stop_dist = abs(entry - sl)
    if stop_dist <= 0:
        raise ValueError("Invalid SL distance")

    ideal_lots = risk_amount / (stop_dist * value_per_price_unit)
    ideal_lots = cap_max_lot(symbol, ideal_lots, raw_hint)

    # Balance-tier scaling — small accounts get proportionally smaller lots
    # so signals fire rather than being forced to broker minimum floor
    scale = _balance_scale_factor(float(acc.balance))
    scaled_lots = ideal_lots * scale

    # Round to step; do NOT enforce volume_min floor (stock CFDs accept sub-min)
    step = info.volume_step if info.volume_step > 0 else 0.01
    lots = round(scaled_lots / step) * step
    if lots <= 0:
        lots = step
    lots = min(lots, info.volume_max)

    tier_label = "x{:.0f}".format(1.0 / scale) if scale < 1.0 else "full"
    print(f"[LOT] {symbol} balance={acc.balance:.2f} [{tier_label}] "
          f"ideal={ideal_lots:.4f} scaled={scaled_lots:.4f} → lots={round(lots,8)}")

    return round(lots, 8)

def downscale_lots_to_margin(symbol: str, order_type: int, lots: float, price: float, raw_hint: str = "") -> float:
    acc = mt5.account_info()
    info = mt5.symbol_info(symbol)
    if acc is None or info is None:
        return 0.0

    free_margin = float(acc.margin_free)
    step = float(info.volume_step)
    vmin = float(info.volume_min)

    lots = cap_max_lot(symbol, lots, raw_hint)
    lots = min(lots, float(info.volume_max))
    lots = max(vmin, lots)
    lots = floor_to_step(lots, step)
    lots = max(vmin, lots)

    m = mt5.order_calc_margin(order_type, symbol, lots, price)
    if m is None:
        return 0.0

    while m > free_margin and lots > vmin + 1e-12:
        lots = lots - step
        lots = floor_to_step(lots, step)
        if lots < vmin:
            lots = vmin
        m = mt5.order_calc_margin(order_type, symbol, lots, price)
        if m is None:
            return 0.0
        if abs(lots - vmin) < 1e-12 and m > free_margin:
            return 0.0

    if m > free_margin:
        return 0.0

    return round(lots, 2)

def fixed_lot_size(symbol: str, raw_hint: str = "") -> float:
    info = mt5.symbol_info(symbol)
    if info is None:
        return 0.0
    lots = cap_max_lot(symbol, float(FIXED_LOT), raw_hint)
    lots = max(float(info.volume_min), min(lots, float(info.volume_max)))
    lots = floor_to_step(lots, float(info.volume_step))
    lots = max(float(info.volume_min), lots)
    return round(lots, 2)


# Safe aliases for manager/execution paths
def mt5_connect_safe(retries: int = 3):
    return mt5_connect(retries=retries)

def mt5_disconnect_safe():
    return mt5_disconnect()


def clamp_partial_fraction(x: float) -> float:
    try:
        return max(0.0, min(1.0, float(x)))
    except Exception:
        return 0.0


def normalized_close_volume(symbol: str, requested_volume: float, current_volume: float) -> float:
    info = mt5.symbol_info(symbol)
    if info is None:
        return 0.0
    step = float(info.volume_step)
    vmin = float(info.volume_min)
    vmax = float(info.volume_max)
    vol = max(0.0, min(float(requested_volume), float(current_volume)))
    if vol <= 0:
        return 0.0
    vol = min(vol, vmax)
    vol = floor_to_step(vol, step)
    if vol < vmin:
        return 0.0
    remaining = float(current_volume) - vol
    if remaining > 0 and remaining < vmin:
        adjusted = floor_to_step(float(current_volume) - vmin, step)
        if adjusted >= vmin:
            vol = adjusted
        else:
            return 0.0
    return round(vol, 2)


def close_partial_position(position_ticket: int, symbol: str, pos_type: int, current_volume: float, fraction: float):
    frac = clamp_partial_fraction(fraction)
    if frac <= 0:
        return None, 0.0

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return None, 0.0

    requested = float(current_volume) * frac
    volume = normalized_close_volume(symbol, requested, current_volume)
    if volume <= 0:
        return None, 0.0

    close_type = mt5.ORDER_TYPE_SELL if pos_type == 0 else mt5.ORDER_TYPE_BUY
    price = float(tick.bid) if pos_type == 0 else float(tick.ask)

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "position": int(position_ticket),
        "symbol": symbol,
        "volume": float(volume),
        "type": close_type,
        "price": float(price),
        "deviation": 30,
        "magic": MAGIC,
        "comment": "partial close",
    }
    res = order_send_with_filling_fallback(req, symbol, mt5.TRADE_ACTION_DEAL)
    return res, volume


def close_full_position(ticket: int, symbol: str, pos_type: int, volume: float) -> bool:
    """
    Close an entire position at market.
    pos_type: 0 = BUY (close with SELL), 1 = SELL (close with BUY)
    Returns True if MT5 accepted the close.
    """
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return False
    close_type = mt5.ORDER_TYPE_SELL if pos_type == 0 else mt5.ORDER_TYPE_BUY
    price      = float(tick.bid)    if pos_type == 0 else float(tick.ask)
    req = {
        "action":   mt5.TRADE_ACTION_DEAL,
        "position": int(ticket),
        "symbol":   symbol,
        "volume":   float(volume),
        "type":     close_type,
        "price":    price,
        "deviation": 30,
        "magic":    MAGIC,
        "comment":  "reversal close",
    }
    res = order_send_with_filling_fallback(req, symbol, mt5.TRADE_ACTION_DEAL)
    return res is not None and res.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009)


def close_opposite_positions(symbol: str, new_side: str, new_source: str, state: dict) -> int:
    """
    Close all open market positions on `symbol` that are in the opposite direction
    to `new_side`.  If CLOSE_OPPOSITE_SAME_SOURCE_ONLY is True, only closes positions
    opened by the same source channel as the incoming signal.
    Returns the number of positions closed.
    """
    if not CLOSE_OPPOSITE_ON_SIGNAL:
        return 0

    opposite_type = mt5.ORDER_TYPE_SELL if new_side.upper() == "BUY" else mt5.ORDER_TYPE_BUY
    # MT5 position type: 0 = BUY, 1 = SELL
    opposite_pos_type = 0 if new_side.upper() == "SELL" else 1

    positions = mt5.positions_get(symbol=symbol)
    if not positions:
        return 0

    position_sources = state.get("position_sources", {})
    closed = 0

    for pos in positions:
        if pos.type != opposite_pos_type:
            continue

        pos_src = position_sources.get(str(pos.ticket), "")

        if CLOSE_OPPOSITE_SAME_SOURCE_ONLY:
            # Only close if same source channel, or if position source is unknown (adopted)
            if pos_src and pos_src != "ADOPTED" and pos_src != new_source:
                log_event(
                    f"↔️  REVERSAL skip: ticket={pos.ticket} {pos.symbol} src={pos_src} "
                    f"≠ new_src={new_source} (same-source-only mode)"
                )
                continue

        pnl = pos.profit

        # Profit guard — don't flip a position that's currently at a loss.
        # Reversing a loser locks in the loss AND opens new directional risk.
        # Only skip if REVERSAL_REQUIRE_PROFIT is enabled (default: True).
        if REVERSAL_REQUIRE_PROFIT and pnl <= 0:
            log_event(
                f"↔️  REVERSAL skip: ticket={pos.ticket} {pos.symbol} "
                f"P&L={pnl:.2f} (not in profit — require-profit guard active)"
            )
            continue

        sign = "+" if pnl >= 0 else ""
        ok = close_full_position(pos.ticket, symbol, pos.type, pos.volume)
        if ok:
            log_event(
                f"↔️  REVERSAL closed: ticket={pos.ticket} {pos.symbol} "
                f"{'BUY' if pos.type == 0 else 'SELL'} vol={pos.volume} "
                f"P&L={sign}{pnl:.2f} src={pos_src or 'UNKNOWN'}"
            )
            # Clean up tracking dicts for the closed position
            tk = str(pos.ticket)
            state.get("position_templates", {}).pop(tk, None)
            state.get("position_sources",   {}).pop(tk, None)
            closed += 1
        else:
            log_event(f"↔️  REVERSAL close FAILED: ticket={pos.ticket} {pos.symbol}")

    return closed


# ----------------- ATR / SIMPLE SL MODEL -----------------
def tf_to_mt5(tf: str) -> int:
    tf = (tf or "").upper()
    return {
        "M1": mt5.TIMEFRAME_M1,
        "M2": mt5.TIMEFRAME_M2,
        "M3": mt5.TIMEFRAME_M3,
        "M4": mt5.TIMEFRAME_M4,
        "M5": mt5.TIMEFRAME_M5,
        "M10": mt5.TIMEFRAME_M10,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
    }.get(tf, mt5.TIMEFRAME_M5)

def atr_value(symbol: str, timeframe: str, period: int) -> float:
    tf = tf_to_mt5(timeframe)
    bars_needed = max(50, period + 5)
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, bars_needed)
    if rates is None or len(rates) < period + 2:
        return 0.0

    trs = []
    prev_close = float(rates[0]["close"])
    for i in range(1, len(rates)):
        high = float(rates[i]["high"])
        low = float(rates[i]["low"])
        close = float(rates[i]["close"])
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        trs.append(tr)
        prev_close = close

    if len(trs) < period:
        return 0.0
    last = trs[-period:]
    return sum(last) / float(period)

def fixed_sl_floor(symbol: str, raw_hint: str = "") -> float:
    cls = symbol_class(symbol, raw_hint)
    if cls == "XAU":
        return SIMPLE_SL_FIXED_XAU
    if cls == "XAG":
        return SIMPLE_SL_FIXED_XAG
    if cls == "BTC":
        return SIMPLE_SL_FIXED_BTC
    if cls == "CRYPTO_SMALL":
        return SIMPLE_SL_FIXED_CRYPTO_SMALL
    if cls == "FX":
        return SIMPLE_SL_FIXED_FX      # tiny floor — ATR dominates in HYBRID
    if cls == "INDEX":
        return SIMPLE_SL_FIXED_INDEX   # 3pt emergency floor — ATR dominates in HYBRID
    return SIMPLE_SL_FIXED_DEFAULT

def sl_delta(symbol: str, raw_hint: str = "") -> float:
    floor = float(fixed_sl_floor(symbol, raw_hint))
    if SL_MODEL == "FIXED":
        return floor
    a = float(atr_value(symbol, ATR_TIMEFRAME, ATR_PERIOD))
    if a <= 0:
        return floor
    atr_based = a * float(ATR_MULTIPLIER)
    if SL_MODEL == "ATR":
        return atr_based
    return max(floor, atr_based)

def build_simple_sl_tp(symbol: str, side: str, entry: float, raw_hint: str = ""):
    d = sl_delta(symbol, raw_hint)
    if side == "BUY":
        sl = entry - d
        tp1 = entry + (SIMPLE_TP_R1 * d)
        tp2 = entry + (SIMPLE_TP_R2 * d)
        tp3 = entry + (SIMPLE_TP_R3 * d)
    else:
        sl = entry + d
        tp1 = entry - (SIMPLE_TP_R1 * d)
        tp2 = entry - (SIMPLE_TP_R2 * d)
        tp3 = entry - (SIMPLE_TP_R3 * d)
    return sl, tp1, [tp1, tp2, tp3]

def apply_sl_multiplier(side: str, entry: float, sl: float) -> float:
    try:
        if not APPLY_SL_MULTIPLIER:
            return float(sl)
        mult = float(SL_MULTIPLIER)
        if mult <= 0 or abs(mult - 1.0) < 1e-9:
            return float(sl)

        side_u = (side or "").upper()
        e = float(entry)
        s = float(sl)

        if side_u == "BUY":
            dist = max(0.0, e - s)
            return e - dist * mult
        else:
            dist = max(0.0, s - e)
            return e + dist * mult
    except Exception:
        return float(sl)


# ----------------- Pending clamp fix -----------------
def clamp_to_valid_pending(symbol: str, side: str, ptype: str, entry: float, tick):
    side = side.upper()
    ptype = (ptype or "LIMIT").upper()
    bid = float(tick.bid)
    ask = float(tick.ask)

    info = mt5.symbol_info(symbol)
    point = float(getattr(info, "point", 0.0) or 0.0)
    gap = (MIN_PENDING_GAP_POINTS * point) if point > 0 else 0.0
    dmin = float(min_stop_distance(symbol) or 0.0)
    sep = max(dmin, gap)

    note = []

    if AUTO_FIX_PENDING_TYPE:
        if side == "BUY":
            if entry >= ask:
                ptype = "STOP"
            elif entry <= bid:
                ptype = "LIMIT"
            else:
                ptype = "STOP"
                note.append("inside spread -> STOP")
        else:
            if entry <= bid:
                ptype = "STOP"
            elif entry >= ask:
                ptype = "LIMIT"
            else:
                ptype = "STOP"
                note.append("inside spread -> STOP")

    if AUTO_FIX_PENDING_DISTANCE:
        if side == "BUY":
            if ptype == "LIMIT":
                max_price = bid - sep
                if entry > max_price:
                    entry = max_price
                    note.append("entry->bid-sep")
            else:
                min_price = ask + sep
                if entry < min_price:
                    entry = min_price
                    note.append("entry->ask+sep")
        else:
            if ptype == "LIMIT":
                min_price = ask + sep
                if entry < min_price:
                    entry = min_price
                    note.append("entry->ask+sep")
            else:
                max_price = bid - sep
                if entry > max_price:
                    entry = max_price
                    note.append("entry->bid-sep")

    entry = round_price(symbol, entry)
    return ptype, float(entry), ("; ".join(note) if note else "")


# ----------------- Filling fallback -----------------
def filling_candidates(symbol: str, action: int):
    info = mt5.symbol_info(symbol)
    base = []
    if symbol in FILLING_CACHE:
        base.append(FILLING_CACHE[symbol])

    if info is not None:
        fm = int(getattr(info, "filling_mode", 0) or 0)
        if fm:
            base.append(fm)

    if action == mt5.TRADE_ACTION_PENDING:
        base += [mt5.ORDER_FILLING_RETURN, mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK]
    else:
        base += [mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN]

    out, seen = [], set()
    for x in base:
        if x not in seen:
            out.append(x)
            seen.add(x)
    return out

def order_send_with_filling_fallback(req: dict, symbol: str, action: int):
    for tf in filling_candidates(symbol, action):
        r = dict(req)
        r["type_filling"] = tf
        res = mt5.order_send(r)
        if res is None:
            continue
        if getattr(res, "retcode", None) == 10030:
            continue
        if res.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
            FILLING_CACHE[symbol] = tf
        return res
    return None


# ----------------- RISK / LIMITS -----------------
def get_month_bucket(state):
    mk = month_key()
    state.setdefault("months", {})
    if mk not in state["months"]:
        state["months"][mk] = {"start_equity": None, "high_equity": None, "paused_until": None, "min_risk_until_new_high": False}
    return state["months"][mk]

def get_day_bucket(state):
    dk = day_key()
    state.setdefault("days", {})
    if dk not in state["days"]:
        state["days"][dk] = {"trades": 0, "start_equity": None, "blocked_today": False}
    return state["days"][dk]

def update_highwater(month_bucket, equity: float):
    if month_bucket.get("start_equity") is None:
        month_bucket["start_equity"] = equity
    if month_bucket.get("high_equity") is None:
        month_bucket["high_equity"] = equity
    if equity > month_bucket["high_equity"]:
        month_bucket["high_equity"] = equity
        month_bucket["min_risk_until_new_high"] = False

def compute_monthly_dd_pct(month_bucket, equity: float) -> float:
    hi = month_bucket.get("high_equity")
    if hi is None or hi <= 0:
        return 0.0
    return max(0.0, (hi - equity) / hi * 100.0)

def current_risk_from_dd(dd_pct: float) -> float:
    if dd_pct < DD1_PCT:
        return RISK_BASE
    if dd_pct < DD2_PCT:
        return RISK_DD1
    if dd_pct < DD3_PCT:
        return RISK_DD2
    return RISK_DD3

def enforce_pause_logic(month_bucket, dd_pct: float) -> bool:
    now_ts = time.time()
    paused_until = month_bucket.get("paused_until")

    # If cooldown is disabled (0 days), clear any stale paused_until from
    # previous runs that used a longer cooldown, so it never blocks trading.
    if PAUSE_COOLDOWN_DAYS == 0 and paused_until:
        month_bucket["paused_until"] = None
        paused_until = None

    if dd_pct >= MONTHLY_MAX_DD_PCT:
        if PAUSE_COOLDOWN_DAYS > 0:
            if not paused_until or now_ts > paused_until:
                month_bucket["paused_until"] = now_ts + PAUSE_COOLDOWN_DAYS * 86400
        month_bucket["min_risk_until_new_high"] = True
        return True
    if paused_until and now_ts < paused_until:
        return True
    if paused_until and now_ts >= paused_until:
        month_bucket["paused_until"] = None
        return False
    return False

def daily_loss_pct(day_bucket, equity: float) -> float:
    start = day_bucket.get("start_equity")
    if start is None or start <= 0:
        return 0.0
    return max(0.0, (start - equity) / start * 100.0)

def start_of_today_local():
    now = datetime.now()
    return datetime(now.year, now.month, now.day)

def had_loss_today() -> bool:
    now = datetime.now()
    deals = mt5.history_deals_get(start_of_today_local(), now + timedelta(seconds=1))
    if deals is None:
        return False
    for d in deals:
        if getattr(d, "magic", None) != MAGIC:
            continue
        if getattr(d, "entry", None) not in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
            continue
        if float(getattr(d, "profit", 0.0)) < 0:
            return True
    return False

def count_consecutive_losses_today():
    now = datetime.now()
    start = datetime(now.year, now.month, now.day)
    deals = mt5.history_deals_get(start, now + timedelta(seconds=1))
    if deals is None:
        return 0
    my = [d for d in deals if getattr(d, "magic", None) == MAGIC]
    my.sort(key=lambda d: d.time)
    streak = 0
    for d in reversed(my):
        if getattr(d, "entry", None) not in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
            continue
        profit = float(getattr(d, "profit", 0.0))
        if profit < 0:
            streak += 1
        elif profit > 0:
            break
    return streak

def max_trades_cap_today() -> int:
    loss = had_loss_today()
    return int(MAX_TRADES_PER_DAY_AFTER_LOSS if loss else MAX_TRADES_PER_DAY_WINNING)


# ----------------- ORDER DECISION -----------------
def decide_entry(sig, tick, entry_mode: str):
    side = sig["side"]
    zl, zh = float(sig["zone_low"]), float(sig["zone_high"])
    ask, bid = float(tick.ask), float(tick.bid)
    entry_mode = (entry_mode or "ZONE").upper()
    tol = entry_tolerance_for_symbol(sig.get("raw_symbol", ""))

    if sig.get("kind") == "EARLY_SCALP":
        return (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_BUY, ask, "ENTRY_EARLY_SCALP") if side == "BUY" else (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_SELL, bid, "ENTRY_EARLY_SCALP")

    if sig.get("kind") == "SCALP_MARKET":
        return (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_BUY, ask, "ENTRY_SCALP_MARKET") if side == "BUY" else (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_SELL, bid, "ENTRY_SCALP_MARKET")

    if sig.get("kind") in ("PENDING", "SIMPLE_PENDING"):
        price = float(zl)
        ptype = (sig.get("pending_type") or "LIMIT").upper()
        if side == "BUY":
            otype = mt5.ORDER_TYPE_BUY_LIMIT if ptype == "LIMIT" else mt5.ORDER_TYPE_BUY_STOP
        else:
            otype = mt5.ORDER_TYPE_SELL_LIMIT if ptype == "LIMIT" else mt5.ORDER_TYPE_SELL_STOP
        return mt5.TRADE_ACTION_PENDING, otype, price, "ENTRY_NATIVE_PENDING"

    if entry_mode == "PENDING_ALWAYS":
        if signal_requests_market(sig) and MARKET_FALLBACK_FOR_MARKET_SIGNALS:
            return (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_BUY, ask, "ENTRY_MARKET_FALLBACK") if side == "BUY" else (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_SELL, bid, "ENTRY_MARKET_FALLBACK")
        if abs(zl - zh) < 1e-12 or sig.get("kind") == "FULL":
            return smart_exact_entry_decision(sig, tick)
        if abs(zl - zh) < 1e-12:
            price = zl
        else:
            price = zl if side == "BUY" else zh
        if side == "BUY":
            return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_BUY_LIMIT, float(price), "ENTRY_PENDING_ALWAYS"
        else:
            return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_SELL_LIMIT, float(price), "ENTRY_PENDING_ALWAYS"

    if entry_mode in ("MARKET", "MARKET_ALWAYS"):
        if signal_is_exact_entry(sig):
            action2, order_type2, entry2, reason2 = smart_exact_entry_decision(sig, tick)
            if action2 is not None:
                return action2, order_type2, entry2, f"{reason2}_OVERRIDE_MARKET_MODE"
            return None, None, None, reason2
        return (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_BUY, ask, "ENTRY_MARKET_MODE") if side == "BUY" else (mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_SELL, bid, "ENTRY_MARKET_MODE")

    if abs(zl - zh) < 1e-12:
        price = zl
        return ((mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_BUY_LIMIT, price, "ENTRY_SINGLE_PRICE_PENDING")
                if side == "BUY" else (mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_SELL_LIMIT, price, "ENTRY_SINGLE_PRICE_PENDING"))

    if entry_mode == "LIMIT_ALWAYS":
        if side == "BUY":
            price = zh if ask > zh else zl
            return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_BUY_LIMIT, price, "ENTRY_LIMIT_ALWAYS"
        else:
            price = zl if bid < zl else zh
            return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_SELL_LIMIT, price, "ENTRY_LIMIT_ALWAYS"

    if side == "BUY":
        if within_tol(ask, zl, zh, tol):
            return mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_BUY, ask, "ENTRY_ZONE_MARKET"
        if ask < (zl - tol):
            return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_BUY_LIMIT, zl, "ENTRY_ZONE_BUY_LIMIT"
        return None, None, None, "SKIP_PRICE_OUTSIDE_ZONE"

    if within_tol(bid, zl, zh, tol):
        return mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_SELL, bid, "ENTRY_ZONE_MARKET"
    if bid > (zh + tol):
        return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_SELL_LIMIT, zh, "ENTRY_ZONE_SELL_LIMIT"
    return None, None, None, "SKIP_PRICE_OUTSIDE_ZONE"

    if within(bid, zl, zh):
        return mt5.TRADE_ACTION_DEAL, mt5.ORDER_TYPE_SELL, bid
    if bid > zh:
        return mt5.TRADE_ACTION_PENDING, mt5.ORDER_TYPE_SELL_LIMIT, zh
    return None, None, None


# ----------------- PENDING EXPIRY (LOCAL) -----------------
def expire_pending_orders(state):
    if PENDING_EXPIRE_SECONDS <= 0:
        return

    orders = mt5.orders_get()
    if orders is None:
        return

    idx = {}
    for it in state.get("pending_orders", []) or []:
        try:
            idx[int(it.get("order", 0))] = it
        except Exception:
            continue

    now = time.time()
    removed = 0
    kept = []

    open_tickets = set()
    for o in orders:
        try:
            if int(getattr(o, "magic", 0)) != MAGIC:
                continue
            open_tickets.add(int(getattr(o, "ticket", 0)))
        except Exception:
            continue

    for o in orders:
        if int(getattr(o, "magic", 0)) != MAGIC:
            continue
        ticket = int(getattr(o, "ticket", 0))

        meta = idx.get(ticket)
        if not meta:
            kept.append({"symbol": safe_symbol_text(o.symbol), "order": ticket, "ts": None, "source": "UNKNOWN", "kind": "UNKNOWN"})
            continue

        ts_local = meta.get("ts")
        if ts_local is None:
            kept.append(meta)
            continue

        age = now - float(ts_local)
        if age >= PENDING_EXPIRE_SECONDS:
            req = {"action": mt5.TRADE_ACTION_REMOVE, "order": ticket}
            res = mt5.order_send(req)
            rc = getattr(res, "retcode", None)
            if rc in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009):
                removed += 1
                log_event(
                    f"🧹 Expired pending (LOCAL): ticket={ticket} symbol={safe_symbol_text(o.symbol)} "
                    f"age_sec={int(age)} retcode={rc} comment={getattr(res,'comment',None)}"
                )
            else:
                kept.append(meta)
        else:
            kept.append(meta)

    cleaned = []
    for it in kept:
        try:
            t = int(it.get("order", 0))
            if t in open_tickets:
                cleaned.append(it)
        except Exception:
            continue

    state["pending_orders"] = cleaned

    if removed > 0:
        log_event(f"🧹 Pending expiry sweep done. removed={removed} kept={len(state['pending_orders'])}")


# ----------------- MULTI-PENDING ACTIVE -----------------
def multi_pending_active_for(sig) -> bool:
    if not MULTI_PENDING_ENABLED:
        return False
    if MULTI_PENDING_ONLY_DEMO and ACCOUNT_MODE != "DEMO":
        return False
    if signal_requests_market(sig):
        return False
    src = str(sig.get("source", "") or "")
    if not src or (MULTI_PENDING_SOURCE_IDS and src not in MULTI_PENDING_SOURCE_IDS):
        return False
    if sig.get("kind") not in ("FULL", "SIMPLE"):
        return False
    zl = float(sig.get("zone_low", 0.0))
    zh = float(sig.get("zone_high", 0.0))
    return abs(zl - zh) > 1e-12


def market_stops_valid(symbol: str, side: str, entry: float, sl: float, tp: float) -> bool:
    info = mt5.symbol_info(symbol)
    if info is None:
        return False
    point = float(getattr(info, "point", 0.0) or 0.0)
    min_dist = float(min_stop_distance(symbol) or 0.0)
    if point > 0:
        min_dist = max(min_dist, point)
    side = (side or "").upper()
    entry = float(entry); sl = float(sl); tp = float(tp)
    if side == "BUY":
        if not (sl < entry and tp > entry):
            return False
        if (entry - sl) < min_dist or (tp - entry) < min_dist:
            return False
    else:
        if not (sl > entry and tp < entry):
            return False
        if (sl - entry) < min_dist or (entry - tp) < min_dist:
            return False
    return True


def stop_safety_distance(symbol: str) -> float:
    info = mt5.symbol_info(symbol)
    point = float(getattr(info, "point", 0.0) or 0.0) if info else 0.0
    broker_min = float(min_stop_distance(symbol) or 0.0)
    base = max(broker_min, point)
    raw = normalize_raw_symbol(symbol)
    if symbol_class(symbol, raw) == "XAU":
        return max(base * 1.5, point * 20.0 if point > 0 else 0.20, 0.20)
    if symbol_class(symbol, raw) == "INDEX":
        return max(base * 1.25, point * 25.0 if point > 0 else 1.0)
    if symbol_class(symbol, raw) in ("BTC", "CRYPTO_SMALL"):
        return max(base * 1.25, point * 30.0 if point > 0 else 1.0)
    return max(base * 1.2, point * 10.0 if point > 0 else 0.0002)


def sanitize_market_stops(symbol: str, side: str, entry: float, sl: float, tp: float):
    side = (side or "").upper()
    entry = float(entry)
    sl = float(sl)
    tp = float(tp)
    dist = stop_safety_distance(symbol)
    rr = max(abs(tp - entry), abs(entry - sl), dist * 1.5)

    if side == "BUY":
        if not (sl < entry - dist):
            sl = entry - max(dist, abs(entry - sl), rr * 0.8)
        if not (tp > entry + dist):
            tp = entry + max(dist, rr)
    else:
        if not (sl > entry + dist):
            sl = entry + max(dist, abs(sl - entry), rr * 0.8)
        if not (tp < entry - dist):
            tp = entry - max(dist, rr)

    sl = round_price(symbol, sl)
    tp = round_price(symbol, tp)

    if not market_stops_valid(symbol, side, entry, sl, tp):
        if side == "BUY":
            sl = round_price(symbol, entry - max(dist * 1.5, rr))
            tp = round_price(symbol, entry + max(dist * 1.5, rr))
        else:
            sl = round_price(symbol, entry + max(dist * 1.5, rr))
            tp = round_price(symbol, entry - max(dist * 1.5, rr))
    return sl, tp


def retry_with_execution_fallback(req: dict, symbol: str, sig, tick, action: int, order_type, entry, sl, tp, decision_reason: str):
    INVALID_PRICE = 10015
    INVALID_STOPS = 10016
    side = (sig.get("side") or "").upper()

    res = order_send_with_filling_fallback(req, symbol, action)
    if res is None:
        return None, action, order_type, entry, sl, tp, decision_reason

    rc = getattr(res, "retcode", None)
    if rc not in (INVALID_PRICE, INVALID_STOPS):
        return res, action, order_type, entry, sl, tp, decision_reason

    # Refresh tick and try one smart reroute for exact-entry FULL signals.
    tick2 = mt5.symbol_info_tick(symbol) or tick
    if signal_is_exact_entry(sig):
        action2, order_type2, entry2, reason2 = smart_exact_entry_decision(sig, tick2)
        if action2 == mt5.TRADE_ACTION_DEAL:
            entry2 = float(tick2.ask) if side == "BUY" else float(tick2.bid)
            sl2, tp2 = sanitize_market_stops(symbol, side, float(entry2), float(sl), float(tp))
            req2 = dict(req)
            req2.update({
                "action": mt5.TRADE_ACTION_DEAL,
                "type": order_type2,
                "price": float(entry2),
                "sl": float(sl2),
                "tp": float(tp2),
                "comment": f"{req.get('comment', 'TG auto')} F1",
            })
            res2 = order_send_with_filling_fallback(req2, symbol, mt5.TRADE_ACTION_DEAL)
            if res2 is not None and getattr(res2, "retcode", None) in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009):
                log_event(f"🔁 Fallback reroute accepted: {decision_reason}->{reason2} entry={entry}->{entry2} sl={sl}->{sl2} tp={tp}->{tp2}")
                return res2, mt5.TRADE_ACTION_DEAL, order_type2, entry2, sl2, tp2, f"{reason2}_FALLBACK"
        elif action2 == mt5.TRADE_ACTION_PENDING:
            req2 = dict(req)
            req2.update({
                "action": mt5.TRADE_ACTION_PENDING,
                "type": order_type2,
                "price": float(entry2),
                "comment": f"{req.get('comment', 'TG auto')} F1",
            })
            res2 = order_send_with_filling_fallback(req2, symbol, mt5.TRADE_ACTION_PENDING)
            if res2 is not None and getattr(res2, "retcode", None) in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009):
                log_event(f"🔁 Fallback reroute accepted: {decision_reason}->{reason2} entry={entry}->{entry2}")
                return res2, mt5.TRADE_ACTION_PENDING, order_type2, float(entry2), sl, tp, f"{reason2}_FALLBACK"

    if action == mt5.TRADE_ACTION_DEAL and rc == INVALID_STOPS:
        entry2 = float(tick2.ask) if side == "BUY" else float(tick2.bid)
        sl2, tp2 = sanitize_market_stops(symbol, side, float(entry2), float(sl), float(tp))
        req2 = dict(req)
        req2.update({
            "price": float(entry2),
            "sl": float(sl2),
            "tp": float(tp2),
            "comment": f"{req.get('comment', 'TG auto')} S1",
        })
        res2 = order_send_with_filling_fallback(req2, symbol, mt5.TRADE_ACTION_DEAL)
        if res2 is not None and getattr(res2, "retcode", None) in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009):
            log_event(f"🛡️ Stop-safety retry accepted: entry={entry}->{entry2} sl={sl}->{sl2} tp={tp}->{tp2}")
            return res2, mt5.TRADE_ACTION_DEAL, order_type, entry2, sl2, tp2, f"{decision_reason}_STOPSAFE"

    return res, action, order_type, entry, sl, tp, decision_reason


# ----------------- PLACE TRADE -----------------
def place_trade(sig, state):
    raw_symbol = sig.get("raw_symbol", "")
    symbol = resolve_symbol_live(raw_symbol)

    if not ALLOW_ALL_SYMBOLS:
        allowed = set(SYMBOL_MAP.values())
        if symbol not in allowed:
            log_event(f"Skip: symbol not allowed (ALLOW_ALL_SYMBOLS=false): raw={raw_symbol} resolved={symbol}")
            return None

    info = ensure_symbol(symbol)
    if info is None:
        alt_symbol = alt_crypto_symbol(raw_symbol)
        if alt_symbol:
            symbol = alt_symbol
            info = ensure_symbol(symbol)
        if info is None:
            log_event(f"Skip: symbol not found/visible in MT5: raw={raw_symbol} resolved={symbol}")
            return None

    if not spread_ok_with_recheck(symbol, raw_symbol):
        return None

    if open_positions_count(symbol) >= MAX_OPEN_POSITIONS_PER_SYMBOL:
        log_event(f"Skip: already have {MAX_OPEN_POSITIONS_PER_SYMBOL}+ open positions on {symbol}")
        return None

    if MAX_OPEN_POSITIONS_TOTAL > 0:
        all_pos = mt5.positions_get()
        total_open = len([p for p in (all_pos or []) if not COUNT_ONLY_MAGIC or getattr(p, "magic", 0) == MAGIC])
        if total_open >= MAX_OPEN_POSITIONS_TOTAL:
            log_event(f"Skip: global position cap reached ({total_open}/{MAX_OPEN_POSITIONS_TOTAL} open across all symbols)")
            return None

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        log_event("Skip: no tick data")
        return None

    multi_pending = False
    multi_entries = []

    if multi_pending_active_for(sig):
        multi_pending = True
        zl = float(sig["zone_low"]); zh = float(sig["zone_high"])
        lo, hi = (zl, zh) if zl < zh else (zh, zl)
        rng = max(1e-12, hi - lo)

        if sig["side"] == "BUY":
            multi_entries = [lo + f * rng for f in MULTI_PENDING_FRACTIONS]
        else:
            multi_entries = [hi - f * rng for f in MULTI_PENDING_FRACTIONS]

        action = mt5.TRADE_ACTION_PENDING
        order_type = None
        entry = float(multi_entries[0]) if multi_entries else float(lo)
    else:
        action, order_type, entry, decision_reason = decide_entry(sig, tick, ENTRY_MODE)

    if action is None:
        log_event(
            f"{decision_reason}: {sig['side']} {symbol} "
            f"(zone {sig['zone_low']}-{sig['zone_high']}) tick bid/ask={tick.bid}/{tick.ask} "
            f"entry_mode={ENTRY_MODE} exec_mode={EXECUTION_MODE} market_signal={signal_requests_market(sig)}"
        )
        return None

    if action == mt5.TRADE_ACTION_PENDING and REPLACE_PENDING_ON_NEW_SIGNAL:
        removed = remove_my_pending_orders_for_symbol(symbol)
        if removed:
            log_event(f"🧹 Replaced pending orders on {symbol}: removed={removed}")
            state.setdefault("pending_orders", [])
            state["pending_orders"] = [x for x in state["pending_orders"] if str(x.get("symbol", "")) != str(symbol)]

    if action == mt5.TRADE_ACTION_PENDING:
        existing_pending = pending_orders_count(symbol)
        if not multi_pending:
            if existing_pending >= MAX_PENDING_ORDERS_PER_SYMBOL:
                log_event(f"Skip: already have {MAX_PENDING_ORDERS_PER_SYMBOL}+ pending orders on {symbol}")
                return None
        else:
            allowed_slots = max(0, MAX_PENDING_ORDERS_PER_SYMBOL - existing_pending)
            if allowed_slots <= 0:
                log_event(f"Skip: pending slots full on {symbol} (existing={existing_pending} cap={MAX_PENDING_ORDERS_PER_SYMBOL})")
                return None
            if len(multi_entries) > allowed_slots:
                multi_entries = multi_entries[:allowed_slots]

    mode_label = ENTRY_MODE
    if action == mt5.TRADE_ACTION_PENDING and sig.get("kind") in ("PENDING", "SIMPLE_PENDING"):
        ptype = (sig.get("pending_type") or "LIMIT").upper()
        ptype2, entry2, note = clamp_to_valid_pending(symbol, sig["side"], ptype, float(entry), tick)
        if note:
            log_event(f"🛠️ Pending auto-fix: {sig['side']} {symbol} {ptype}->{ptype2} entry={entry}->{entry2} ({note})")
        sig["pending_type"] = ptype2
        entry = entry2
        mode_label = f"PENDING_{ptype2}"

        if sig["side"] == "BUY":
            order_type = mt5.ORDER_TYPE_BUY_LIMIT if ptype2 == "LIMIT" else mt5.ORDER_TYPE_BUY_STOP
        else:
            order_type = mt5.ORDER_TYPE_SELL_LIMIT if ptype2 == "LIMIT" else mt5.ORDER_TYPE_SELL_STOP

    # Build SL/TP
    # Directional signals (kind=MARKET, sl=0) need ATR auto-calc just like SIMPLE signals
    _needs_auto_sl = sig["kind"] in ("SIMPLE", "SIMPLE_PENDING", "SCALP_MARKET", "EARLY_SCALP") \
                     or (sig["kind"] == "MARKET" and float(sig.get("sl") or 0) == 0.0)
    if _needs_auto_sl:
        sl, _, tps = build_simple_sl_tp(symbol, sig["side"], float(entry), raw_symbol)
        sl = apply_sl_multiplier(sig["side"], float(entry), float(sl))
        sig["sl"] = round_price(symbol, sl)
        sig["tps"] = [round_price(symbol, x) for x in tps]
    else:
        original_sl = float(sig["sl"])
        new_sl = apply_sl_multiplier(sig["side"], float(entry), original_sl)
        sig["sl"] = round_price(symbol, new_sl)
        sig["tps"] = [round_price(symbol, float(x)) for x in sig["tps"]]

    tp = round_price(symbol, float(choose_tp(sig["tps"], SET_BROKER_TP)))
    sl = round_price(symbol, float(sig["sl"]))

    if action == mt5.TRADE_ACTION_DEAL:
        sl, tp = sanitize_market_stops(symbol, sig["side"], float(entry), float(sl), float(tp))
        if not market_stops_valid(symbol, sig["side"], float(entry), float(sl), float(tp)):
            log_event(
                f"Skip: invalid market stops after routing on {symbol} "
                f"side={sig['side']} entry={entry} sl={sl} tp={tp}"
            )
            return None

    acc = mt5.account_info()
    if acc is None:
        log_event("Skip: cannot read account_info")
        return None

    ti = mt5.terminal_info()
    if not ti:
        log_event("Skip: terminal_info() is None")
        return None
    if hasattr(ti, "trade_allowed") and not ti.trade_allowed:
        log_event("🛑 MT5 terminal trade not allowed (AutoTrading off?)")
        return None

    month_bucket = get_month_bucket(state)
    day_bucket = get_day_bucket(state)

    if day_bucket.get("start_equity") is None:
        day_bucket["start_equity"] = float(acc.equity)

    update_highwater(month_bucket, float(acc.equity))
    dd_pct = compute_monthly_dd_pct(month_bucket, float(acc.equity))
    if enforce_pause_logic(month_bucket, dd_pct):
        log_event(f"🛑 PAUSED (monthly DD {dd_pct:.2f}% / limit {MONTHLY_MAX_DD_PCT:.2f}%). No new trades.")
        return None

    if state.get("manual_pause"):
        log_event("🛑 PAUSED by manual /pause command. No new trades.")
        return None

    # Weekend check — markets closed Saturday & Sunday
    if datetime.now(timezone.utc).weekday() >= 5:
        return None

    # Time filter — block signals outside the allowed UTC trading window
    if TIME_FILTER_ENABLED:
        now_hour = datetime.now(timezone.utc).hour
        in_window = (
            (TIME_FILTER_START_HOUR < TIME_FILTER_END_HOUR and TIME_FILTER_START_HOUR <= now_hour < TIME_FILTER_END_HOUR)
            or
            (TIME_FILTER_START_HOUR >= TIME_FILTER_END_HOUR and (now_hour >= TIME_FILTER_START_HOUR or now_hour < TIME_FILTER_END_HOUR))
        )
        if not in_window:
            log_event(f"⏰ TIME FILTER blocked signal at {now_hour:02d}:00 UTC (window {TIME_FILTER_START_HOUR:02d}:00-{TIME_FILTER_END_HOUR:02d}:00)")
            return None
        if now_hour in BLOCKED_HOURS:
            log_event(f"⏰ TIME FILTER blocked signal at {now_hour:02d}:00 UTC (blocked hour)")
            return None

    dloss = daily_loss_pct(day_bucket, float(acc.equity))
    if dloss >= MAX_DAILY_LOSS_PCT:
        day_bucket["blocked_today"] = True
        log_event(f"🛑 Daily loss stop hit: {dloss:.2f}% >= {MAX_DAILY_LOSS_PCT:.2f}%.")
        return None

    # News pause gate (text-based) — block entries after a Telegram news message.
    if NEWS_PAUSE_MINUTES > 0:
        import time as _t
        remaining = _news_pause_until - _t.time()
        if remaining > 0:
            log_event(
                f"📰 NEWS PAUSE: ~{int(remaining / 60) + 1} min remaining — signal blocked."
            )
            return None

    # MT5 calendar news gate — block entries near high-impact scheduled events.
    _nf_enabled = os.getenv("NEWS_FILTER_ENABLED", "false").strip().lower() == "true"
    if _nf_enabled:
        try:
            from news_filter import is_news_blackout as _is_blackout
            _blackout, _reason = _is_blackout(_mt5_calendar_settings())
            if _blackout:
                log_event(f"📰 MT5 CALENDAR BLOCK: {_reason}")
                return None
        except Exception as _ne:
            log_event(f"[NEWS] Calendar gate error: {_ne}")

    # Profit lock — stop new entries once daily target is banked.
    # Enabled via DAILY_PROFIT_LOCK=true in .env (default: off).
    if DAILY_PROFIT_LOCK and DAILY_PROFIT_TARGET_PCT > 0 and acc.balance > 0:
        _pnl = load_state().get("realised_pnl_today", 0.0)
        _tgt = acc.balance * DAILY_PROFIT_TARGET_PCT / 100
        if _pnl >= _tgt:
            log_event(
                f"🎯 Profit lock: target +{_tgt:.2f} ({DAILY_PROFIT_TARGET_PCT:.1f}%) "
                f"reached (today P&L={_pnl:+.2f}). No new trades."
            )
            return None

    cap = max_trades_cap_today()
    if cap > 0 and int(day_bucket.get("trades", 0)) >= cap:
        log_event(f"🛑 Trades cap hit for today: trades={day_bucket.get('trades',0)} cap={cap}")
        return None

    streak = count_consecutive_losses_today()
    if streak >= MAX_CONSECUTIVE_LOSSES:
        day_bucket["blocked_today"] = True
        log_event(f"🛑 Consecutive loss stop hit: {streak} >= {MAX_CONSECUTIVE_LOSSES}.")
        return None

    risk_frac = current_risk_from_dd(dd_pct)
    if month_bucket.get("min_risk_until_new_high", False):
        risk_frac = min(risk_frac, RISK_DD3)

    if sig.get("high_risk"):
        risk_frac *= 0.5

    if sig.get("kind") == "EARLY_SCALP":
        risk_frac *= float(EARLY_SCALP_FORCE_RISK_MULT)

    # MULTI-PENDING placement
    if multi_pending and action == mt5.TRADE_ACTION_PENDING and multi_entries:
        res_last = None
        per_order_risk = float(risk_frac) / float(len(multi_entries)) if len(multi_entries) > 0 else float(risk_frac)

        for i, raw_entry in enumerate(multi_entries, start=1):
            raw_entry = float(raw_entry)

            if sig["kind"] == "SIMPLE":
                sl_i, _, tps_i = build_simple_sl_tp(symbol, sig["side"], raw_entry, raw_symbol)
                sl_i = apply_sl_multiplier(sig["side"], raw_entry, sl_i)
                sl_i = round_price(symbol, sl_i)
                tps_i = [round_price(symbol, x) for x in tps_i]
            else:
                sl_i = round_price(symbol, float(sl))
                tps_i = [round_price(symbol, float(x)) for x in sig["tps"]]

            tp_i = round_price(symbol, float(choose_tp(tps_i, SET_BROKER_TP)))

            ptype2, entry2, note = clamp_to_valid_pending(symbol, sig["side"], "LIMIT", raw_entry, tick)
            if note:
                log_event(f"🛠️ MultiPending auto-fix L{i}: {sig['side']} {symbol} LIMIT->{ptype2} entry={raw_entry}->{entry2} ({note})")

            if sig["side"] == "BUY":
                order_type_i = mt5.ORDER_TYPE_BUY_LIMIT if ptype2 == "LIMIT" else mt5.ORDER_TYPE_BUY_STOP
            else:
                order_type_i = mt5.ORDER_TYPE_SELL_LIMIT if ptype2 == "LIMIT" else mt5.ORDER_TYPE_SELL_STOP

            if USE_FIXED_LOT:
                lots_i = fixed_lot_size(symbol, raw_symbol)
            else:
                lots_risk_i = lot_from_risk(symbol, float(entry2), float(sl_i), per_order_risk, raw_symbol)
                lots_i = downscale_lots_to_margin(symbol, order_type_i, lots_risk_i, float(entry2), raw_symbol)

            if lots_i <= 0:
                log_event(f"Skip: insufficient lot/margin for MultiPending L{i}. symbol={symbol}")
                continue

            log_event(
                f"Decision: {sig['side']} {symbol} (raw={raw_symbol}) kind={sig.get('kind')} "
                f"mode=MULTI_PENDING L{i} action=PENDING entry={entry2} sl={sl_i} tp={tp_i} lots={lots_i}"
            )

            req_i = {
                "action": mt5.TRADE_ACTION_PENDING,
                "symbol": symbol,
                "volume": float(lots_i),
                "type": order_type_i,
                "price": float(entry2),
                "sl": float(sl_i),
                "tp": float(tp_i),
                "deviation": 30,
                "magic": MAGIC,
                "comment": f"TG {ACCOUNT_MODE} MP{i}",
                "type_time": mt5.ORDER_TIME_GTC,
            }

            res_i = order_send_with_filling_fallback(req_i, symbol, mt5.TRADE_ACTION_PENDING)
            res_last = res_i

            if res_i is None:
                log_event(f"Order failed (MultiPending L{i}): order_send returned None")
                continue

            if res_i.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009):
                day_bucket["trades"] = int(day_bucket.get("trades", 0)) + 1
                log_event(f"✅ Accepted (MultiPending L{i}). trades_today={day_bucket['trades']} retcode={res_i.retcode} order={res_i.order} deal={res_i.deal}")

                state.setdefault("templates", {})
                state.setdefault("position_templates", {})
                state.setdefault("position_sources", {})

                tps_save = tps_i[:]
                while len(tps_save) < 3:
                    tps_save.append(tps_save[-1] if tps_save else 0.0)

                tpl_i = {
                    "side": sig["side"],
                    "tp1": float(tps_save[0]),
                    "tp2": float(tps_save[1]),
                    "tp3": float(tps_save[2]),
                    "sl": float(sl_i),
                    "ts": sig.get("ts"),
                    "source": str(sig.get("source", "")),
                }

                # keep symbol fallback
                state["templates"][symbol] = dict(tpl_i)

                if getattr(res_i, "order", 0):
                    state.setdefault("pending_orders", [])
                    state["pending_orders"].append({
                        "symbol": symbol,
                        "order": int(res_i.order),
                        "ts": time.time(),
                        "source": str(sig.get("source", "")),
                        "kind": f"MP{i}",
                    })              
            else:
                log_event(f"❌ Rejected (MultiPending L{i}). retcode={res_i.retcode} comment={getattr(res_i,'comment',None)}")

        return res_last

    # Reversal — close any open opposite-direction positions on this symbol
    # before placing the new order so we're not hedged against ourselves.
    # Only fires for market orders (not pending), same-source by default.
    if action == mt5.TRADE_ACTION_DEAL:
        n_closed = close_opposite_positions(symbol, sig["side"], str(sig.get("source", "")), state)
        if n_closed:
            log_event(f"↔️  Reversal: closed {n_closed} opposite position(s) on {symbol} before opening {sig['side']}")

    # SINGLE order placement
    if USE_FIXED_LOT:
        lots = fixed_lot_size(symbol, raw_symbol)
    else:
        lots_risk = lot_from_risk(symbol, float(entry), float(sl), risk_frac, raw_symbol)
        lots = downscale_lots_to_margin(symbol, order_type, lots_risk, float(entry), raw_symbol)

    # Direction filter — scale down SELL lots when SELL_LOT_MULTIPLIER < 1.0
    if sig.get("side", "").upper() == "SELL" and SELL_LOT_MULTIPLIER != 1.0:
        if SELL_LOT_MULTIPLIER <= 0.0:
            log_event(f"🚫 SELL signal blocked (SELL_LOT_MULTIPLIER=0): {symbol}")
            return None
        info = mt5.symbol_info(symbol)
        orig_lots = lots
        lots = max(float(info.volume_min), lots * SELL_LOT_MULTIPLIER)
        lots = floor_to_step(lots, float(info.volume_step))
        log_event(f"📉 SELL lot scaled: {orig_lots} → {lots} (multiplier={SELL_LOT_MULTIPLIER})")

    if lots <= 0:
        log_event(f"Skip: insufficient lot/margin. symbol={symbol}")
        return None

    log_event(
        f"Decision: {sig['side']} {symbol} (raw={raw_symbol}) kind={sig.get('kind')} "
        f"mode={mode_label} action={'DEAL' if action==mt5.TRADE_ACTION_DEAL else 'PENDING'} "
        f"entry={entry} sl={sl} tp={tp} lots={lots}"
    )

    req = {
        "action": action,
        "symbol": symbol,
        "volume": float(lots),
        "type": order_type,
        "price": float(entry),
        "sl": float(sl),
        "tp": float(tp),
        "deviation": 30,
        "magic": MAGIC,
        "comment": f"TG {ACCOUNT_MODE} auto",
        "type_time": mt5.ORDER_TIME_GTC,
    }

    res, action, order_type, entry, sl, tp, decision_reason = retry_with_execution_fallback(
        req, symbol, sig, tick, action, order_type, entry, sl, tp, decision_reason
    )
    if res is None:
        log_event("Order failed: order_send returned None (or filling retries exhausted)")
        return None

    if res.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009):
        day_bucket["trades"] = int(day_bucket.get("trades", 0)) + 1
        log_event(f"✅ Accepted. trades_today={day_bucket['trades']} retcode={res.retcode} order={res.order} deal={res.deal}")

        # Write bridge with ACTUAL executed SL/TP — after multiplier, ATR model, TP ladder.
        # Gold HA bot reads this to cross-confirm direction and use the proven levels.
        _write_signal_bridge_executed(
            raw_symbol=raw_symbol,
            direction=sig["side"],
            entry=entry, sl=sl, tp=tp,
            channel_id=sig.get("source", ""),
        )

        state.setdefault("templates", {})
        state.setdefault("position_templates", {})
        state.setdefault("position_sources", {})

        tps = sig["tps"][:]
        while len(tps) < 3:
            tps.append(tps[-1] if tps else 0.0)

        tpl = {
            "side": sig["side"],
            "tp1": float(tps[0]),
            "tp2": float(tps[1]),
            "tp3": float(tps[2]),
            "sl": float(sl),
            "ts": sig.get("ts"),
            "source": str(sig.get("source", "")),
        }

        # keep symbol fallback
        state["templates"][symbol] = dict(tpl)

        if action == mt5.TRADE_ACTION_PENDING and getattr(res, "order", 0):
            state.setdefault("pending_orders", [])
            state["pending_orders"].append({
                "symbol": symbol,
                "order": int(res.order),
                "ts": time.time(),
                "source": str(sig.get("source", "")),
                "kind": "SINGLE",
            })
        else:
            # market order: try to bind template directly to real position ticket
            # res.order IS the position ticket for market fills in MT5 — avoids
            # race condition where positions_get() hasn't updated yet.
            pos_ticket = int(res.order) if getattr(res, "order", 0) else find_recent_position_ticket(symbol, float(lots))
            if pos_ticket:
                state["position_templates"][str(pos_ticket)] = dict(tpl)
                sig_src = str(sig.get("source", "") or "")
                if sig_src:
                    state["position_sources"][str(pos_ticket)] = sig_src
                # Store EMA context captured in process_signal_sync
                state.setdefault("position_ema", {})[str(pos_ticket)] = {
                    "ema_at_entry": sig.get("ema_at_entry"),
                    "ema_aligned":  sig.get("ema_aligned"),
                }
                log_event(f"🧾 Stored position template: ticket={pos_ticket} symbol={symbol} src={sig_src} ema={sig.get('ema_at_entry')}")

    else:
        log_event(f"❌ Rejected. reason={decision_reason} retcode={res.retcode} comment={getattr(res,'comment',None)}")

    return res


# ----------------- MANAGER (BE + Trail) -----------------
def attach_templates_to_positions(state):
    state.setdefault("managed_positions", {})
    state.setdefault("position_templates", {})
    state.setdefault("position_sources", {})

    templates = state.get("templates", {})
    position_templates = state.get("position_templates", {})

    poss = mt5.positions_get()
    if poss is None:
        return

    for p in poss:
        if int(getattr(p, "magic", 0)) != MAGIC:
            continue

        symbol = safe_symbol_text(p.symbol)
        ticket = str(p.ticket)

        # If this position already has no dedicated template, create one from symbol fallback
        if ticket not in position_templates:
            tpl_fallback = templates.get(symbol) or templates.get(getattr(p, "symbol", ""))
            if tpl_fallback:
                position_templates[ticket] = dict(tpl_fallback)
                src = str(tpl_fallback.get("source", "") or "")
                if src:
                    state["position_sources"][ticket] = src
                log_event(f"🧾 Stored position template: ticket={ticket} symbol={symbol} src={src}")

        if ticket in state["managed_positions"]:
            continue

        tpl = position_templates.get(ticket)
        if not tpl:
            tpl = templates.get(symbol) or templates.get(getattr(p, "symbol", ""))
        if not tpl:
            continue

        pos_type = int(p.type)  # 0 buy, 1 sell
        if (pos_type == 0 and tpl.get("side") != "BUY") or (pos_type == 1 and tpl.get("side") != "SELL"):
            continue

        state["managed_positions"][ticket] = {
            "symbol":            symbol,
            "type":              pos_type,
            "entry":             float(p.price_open),
            "orig_sl":           float(tpl.get("sl", p.sl or 0)),  # original SL for R calculation
            "tp1":               float(tpl["tp1"]),
            "tp2":               float(tpl["tp2"]),
            "tp3":               float(tpl["tp3"]),
            "moved_be":          False,
            "trail_on":          False,
            "tp_removed":        False,
            "tp1_partial_done":  False,
            "tp2_partial_done":  False,
            "peak_profit_usd":   0.0,
            "created":           time.time(),
        }

        src = str(tpl.get("source", "") or "")
        if src:
            state["position_sources"][ticket] = src

        log_event(f"🧩 Attached template to position ticket={ticket} symbol={symbol} src={src}")

def modify_sl_tp(position_ticket: int, symbol: str, new_sl: float, new_tp: float):
    req = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": position_ticket,
        "symbol": symbol,
        "sl": new_sl,
        "tp": new_tp,
        "magic": MAGIC,
        "comment": "manager",
    }
    return mt5.order_send(req)


def market_tick_is_fresh(tick, max_age_seconds: int = 120) -> bool:
    try:
        if not tick:
            return False
        t = int(getattr(tick, "time", 0) or 0)
        if t <= 0:
            return False
        return (time.time() - t) <= max_age_seconds
    except Exception:
        return False

def manage_positions_once(state):
    attach_templates_to_positions(state)
    managed = state.get("managed_positions", {})
    if not managed:
        return

    poss = mt5.positions_get()
    if poss is None:
        return
    pos_by_ticket = {str(p.ticket): p for p in poss}

    for ticket_str, meta in list(managed.items()):
        p = pos_by_ticket.get(ticket_str)
        if p is None:
            managed.pop(ticket_str, None)
            continue

        symbol = safe_symbol_text(meta["symbol"])
        pos_type = meta["type"]
        entry = float(meta["entry"])
        tp1 = float(meta["tp1"])
        tp2 = float(meta["tp2"])

        tick = mt5.symbol_info_tick(symbol)
        if not tick:
            tick = mt5.symbol_info_tick(getattr(p, "symbol", symbol))
        if not tick or not market_tick_is_fresh(tick):
            continue

        bid, ask = float(tick.bid), float(tick.ask)
        current_price = bid if pos_type == 0 else ask
        cur_sl = float(p.sl) if p.sl else 0.0
        cur_tp = float(p.tp) if p.tp else 0.0
        point = float(getattr(mt5.symbol_info(getattr(p, "symbol", symbol)), "point", 0.0) or 0.0)
        eps = max(point * 2.0, 0.01)

        # MFE tracking — update peak unrealised profit each loop tick
        _unrealised = (current_price - entry) if pos_type == 0 else (entry - current_price)
        if _unrealised > float(meta.get("peak_profit_usd", 0.0) or 0.0):
            meta["peak_profit_usd"] = round(_unrealised, 4)

        tp1_hit = (current_price >= tp1) if pos_type == 0 else (current_price <= tp1)
        tp2_hit = (current_price >= tp2) if pos_type == 0 else (current_price <= tp2)

        # Optional partials on TP ladder (kept for compatibility)
        if PARTIAL_CLOSE_ENABLED and tp1_hit and not meta.get("tp1_partial_done", False):
            res, vol = close_partial_position(int(p.ticket), getattr(p, "symbol", symbol), pos_type, float(p.volume), PARTIAL_AT_TP1)
            if res is not None and getattr(res, "retcode", None) in (mt5.TRADE_RETCODE_DONE, 10009):
                log_event(f"💸 Partial TP1: ticket={p.ticket} vol={vol:.2f} retcode={getattr(res,'retcode',None)}")
                meta["tp1_partial_done"] = True

        if PARTIAL_CLOSE_ENABLED and tp2_hit and not meta.get("tp2_partial_done", False):
            res, vol = close_partial_position(int(p.ticket), getattr(p, "symbol", symbol), pos_type, float(p.volume), PARTIAL_AT_TP2)
            if res is not None and getattr(res, "retcode", None) in (mt5.TRADE_RETCODE_DONE, 10009):
                log_event(f"💸 Partial TP2: ticket={p.ticket} vol={vol:.2f} retcode={getattr(res,'retcode',None)}")
                meta["tp2_partial_done"] = True

        # ATR-based BE/trail trigger — fires when float reaches % of ATR, regardless of TP levels
        if ATR_TRAIL_ENABLED and not meta.get("moved_be", False):
            _atr_val = atr_value(symbol, ATR_TIMEFRAME, ATR_PERIOD)
            # When ATR unavailable or ATR_BE_TRIGGER_PCT is huge (>1), use MIN floor directly
            if _atr_val > 0 or MIN_BE_PIPS_PRICE > 0:
                _effective_atr = _atr_val if _atr_val > 0 else 0.0
                _be_threshold  = max(MIN_BE_PIPS_PRICE, _effective_atr * ATR_BE_TRIGGER_PCT)
                _float_dist    = (current_price - entry) if pos_type == 0 else (entry - current_price)
                if _float_dist >= _be_threshold:
                    _be_buf = be_buffer_for_symbol(getattr(p, "symbol", symbol))
                    _new_sl = (entry + _be_buf) if pos_type == 0 else (entry - _be_buf)
                    _ok = (pos_type == 0 and (cur_sl == 0.0 or _new_sl > cur_sl + eps) and _new_sl < current_price) \
                       or (pos_type == 1 and (cur_sl == 0.0 or _new_sl < cur_sl - eps) and _new_sl > current_price)
                    if _ok:
                        res = modify_sl_tp(int(p.ticket), getattr(p, "symbol", symbol), round(_new_sl, 2), cur_tp)
                        if getattr(res, 'retcode', None) in (mt5.TRADE_RETCODE_DONE, 10009):
                            log_event(f"🛡️ ATR-BE locked: ticket={p.ticket} entry={entry} SL→{_new_sl:.2f} float={_float_dist:.2f}pt threshold={_be_threshold:.2f}pt buffer={_be_buf:.2f}")
                            meta["moved_be"] = True
                            meta["trail_on"] = True
                            cur_sl = _new_sl

        # Legacy BE/TP-based manager
        if not SCALP_LOCK_ENABLED:
            if BE_AT_TP1 and not meta["moved_be"] and tp1_hit:
                be_buf = be_buffer_for_symbol(getattr(p, "symbol", symbol))
                new_sl = entry + be_buf if pos_type == 0 else entry - be_buf
                ok = (pos_type == 0 and (cur_sl == 0.0 or new_sl > cur_sl + eps) and new_sl < current_price) or (pos_type == 1 and (cur_sl == 0.0 or new_sl < cur_sl - eps) and new_sl > current_price)
                if ok:
                    res = modify_sl_tp(int(p.ticket), getattr(p, "symbol", symbol), round_price(symbol, new_sl), cur_tp)
                    log_event(f"🛡️ BE move: ticket={p.ticket} new_sl={new_sl} retcode={getattr(res,'retcode',None)}")
                    if getattr(res, 'retcode', None) in (mt5.TRADE_RETCODE_DONE, 10009):
                        meta["moved_be"] = True

            if not meta.get("tp_removed", False):
                remove_now = False
                if REMOVE_TP_ON_BE and meta.get("moved_be", False):
                    remove_now = True
                if REMOVE_TP_ON_TRAIL:
                    if REMOVE_TP_AFTER == "TP1" and tp1_hit:
                        remove_now = True
                    if REMOVE_TP_AFTER == "TP2" and tp2_hit:
                        remove_now = True

                if remove_now:
                    res = modify_sl_tp(int(p.ticket), getattr(p, "symbol", symbol), cur_sl, 0.0)
                    if getattr(res, 'retcode', None) in (mt5.TRADE_RETCODE_DONE, 10009):
                        log_event(f"🎯 TP removed: ticket={p.ticket} retcode={getattr(res,'retcode',None)}")
                        meta["tp_removed"] = True

            if TRAIL_FROM_ENTRY:
                meta["trail_on"] = True
            else:
                if TRAIL_AFTER_TP1 and tp1_hit:
                    meta["trail_on"] = True
                elif TRAIL_AFTER_TP2 and tp2_hit:
                    meta["trail_on"] = True

            if FORCE_TRAIL_ALL and meta.get("moved_be", False):
                meta["trail_on"] = True
        else:
            # Scalp lock — trigger based on R if orig_sl known, else fall back to USD profit
            orig_sl  = float(meta.get("orig_sl", 0.0) or 0.0)
            sl_dist  = abs(entry - orig_sl) if orig_sl > 0 else 0.0

            if sl_dist > 0:
                # R-based: trigger when price has moved SCALP_LOCK_TRIGGER_R × sl_dist
                price_move = (current_price - entry) if pos_type == 0 else (entry - current_price)
                profit_r   = price_move / sl_dist
                triggered  = profit_r >= SCALP_LOCK_TRIGGER_R
                lock_dist  = SCALP_LOCK_AMOUNT_R * sl_dist
            else:
                # USD fallback for positions without orig_sl (resumed positions etc.)
                triggered = float(getattr(p, "profit", 0.0) or 0.0) >= SCALP_LOCK_TRIGGER_USD
                lock_dist = SCALP_LOCK_AMOUNT_USD

            if triggered:
                # Hybrid trail: lock SL at entry+buffer immediately, but only
                # enable the trailing stop once profit reaches TRAIL_TRIGGER_R.
                # If TRAIL_TRIGGER_R == 0 the trail fires together with the lock (old behaviour).
                if TRAIL_TRIGGER_R > 0:
                    trail_r_threshold = TRAIL_TRIGGER_R
                    if sl_dist > 0 and (price_move / sl_dist) >= trail_r_threshold:
                        meta["trail_on"] = True
                    elif sl_dist <= 0:
                        # USD fallback: no precise R, activate trail once lock fires
                        meta["trail_on"] = True
                else:
                    meta["trail_on"] = True

                lock_sl = (entry + lock_dist) if pos_type == 0 else (entry - lock_dist)
                lock_sl = round_price(symbol, lock_sl)

                lock_ok = False
                if pos_type == 0:
                    lock_ok = (cur_sl == 0.0 or lock_sl > cur_sl + eps) and lock_sl < current_price - eps
                else:
                    lock_ok = (cur_sl == 0.0 or lock_sl < cur_sl - eps) and lock_sl > current_price + eps

                if lock_ok:
                    res = modify_sl_tp(int(p.ticket), getattr(p, "symbol", symbol), lock_sl, cur_tp)
                    if getattr(res, 'retcode', None) in (mt5.TRADE_RETCODE_DONE, 10009):
                        label = f"{profit_r:.2f}R" if sl_dist > 0 else f"${float(getattr(p,'profit',0)):+.2f}"
                        log_event(f"💰 Scalp lock: ticket={p.ticket} trigger={label} new_sl={lock_sl} trail_on={meta['trail_on']}")
                        cur_sl = lock_sl

                if REMOVE_TP_ON_TRAIL and not meta.get("tp_removed", False) and meta["trail_on"]:
                    res = modify_sl_tp(int(p.ticket), getattr(p, "symbol", symbol), cur_sl, 0.0)
                    if getattr(res, 'retcode', None) in (mt5.TRADE_RETCODE_DONE, 10009):
                        log_event(f"🎯 TP removed: ticket={p.ticket} retcode={getattr(res,'retcode',None)}")
                        meta["tp_removed"] = True

        if meta.get("trail_on", False):
            orig_sl = float(meta.get("orig_sl", 0.0) or 0.0)
            sl_dist = abs(entry - orig_sl) if orig_sl > 0 else 0.0

            # ATR-based trail distance (25% of ATR) with fixed-pip fallback
            if ATR_TRAIL_ENABLED:
                _atr_val   = atr_value(symbol, ATR_TIMEFRAME, ATR_PERIOD)
                trail_dist = max(MIN_TRAIL_PRICE, _atr_val * ATR_TRAIL_DIST_PCT) if _atr_val > 0 \
                             else _trail_pips_for_symbol(symbol)
            else:
                trail_dist = _trail_pips_for_symbol(symbol)
            # Minimum step before SL is moved: 20% of trail distance (avoids micro-adjustments)
            step_dist  = trail_dist * 0.2

            desired_sl = (current_price - trail_dist) if pos_type == 0 else (current_price + trail_dist)
            desired_sl = round_price(symbol, desired_sl)

            last_attempt = float(meta.get("last_trail_sl", 0.0) or 0.0)
            should_send  = False
            if pos_type == 0:
                should_send = desired_sl > cur_sl + step_dist and desired_sl < current_price - eps
            else:
                should_send = (cur_sl == 0.0 or desired_sl < cur_sl - step_dist) and desired_sl > current_price + eps

            if should_send and abs(desired_sl - last_attempt) > eps:
                tp_to_send = 0.0 if meta.get("tp_removed", False) else (float(p.tp) if p.tp else 0.0)
                res = modify_sl_tp(int(p.ticket), getattr(p, "symbol", symbol), desired_sl, tp_to_send)
                rc  = getattr(res, 'retcode', None)
                meta["last_trail_sl"] = desired_sl
                if rc in (mt5.TRADE_RETCODE_DONE, 10009):
                    log_event(f"🏃 Trail: ticket={p.ticket} new_sl={desired_sl} trail={trail_dist}pt retcode={rc}")


# ----------------- CSV -----------------
def ensure_csv_header():
    if os.path.exists(TRADES_CSV):
        return
    with open(TRADES_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["time_utc","symbol","side","volume","profit","commission","swap","position_id","deal_id","channel_id","ema_at_entry","ema_aligned","mfe_pips"])

def append_trade_csv(row: dict):
    ensure_csv_header()
    with open(TRADES_CSV, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            row.get("time_utc"), row.get("symbol"), row.get("side"), row.get("volume"),
            row.get("profit"), row.get("commission"), row.get("swap"),
            row.get("position_id"), row.get("deal_id"), row.get("channel_id"),
            row.get("ema_at_entry"), row.get("ema_aligned"), row.get("mfe_pips"),
        ])

def log_new_closed_deals(state, notifications=None):
    state.setdefault("last_logged_deal_id", 0)
    last_id = int(state.get("last_logged_deal_id", 0))

    deals = mt5.history_deals_get(start_of_today_local(), datetime.now() + timedelta(seconds=1))
    if deals is None:
        return

    new_close = []
    for d in deals:
        if getattr(d, "magic", None) != MAGIC:
            continue
        if getattr(d, "entry", None) not in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
            continue
        did = int(getattr(d, "ticket", 0))
        if did > last_id:
            new_close.append(d)

    if not new_close:
        return

    new_close.sort(key=lambda x: int(getattr(x, "ticket", 0)))
    state.setdefault("position_sources", {})

    for d in new_close:
        deal_id = int(getattr(d, "ticket", 0))
        pos_id = str(getattr(d, "position_id", ""))

        symbol = safe_symbol_text(getattr(d, "symbol", ""))
        volume = float(getattr(d, "volume", 0.0))
        profit = float(getattr(d, "profit", 0.0))
        commission = float(getattr(d, "commission", 0.0))
        swap = float(getattr(d, "swap", 0.0))

        side = "BUY" if int(getattr(d, "type", 0)) == mt5.DEAL_TYPE_BUY else "SELL"
        t_utc = datetime.fromtimestamp(int(getattr(d, "time", time.time())), tz=timezone.utc).isoformat()

        channel_id = state["position_sources"].get(pos_id, "") or "UNKNOWN"
        stats_add_trade_close(state, channel_id, float(profit), symbol=symbol, side=side)
        save_state(state)   # flush channel_stats immediately so reports are current

        log_event(f"🏁 CLOSED | {symbol} | {side} | vol={volume:.2f} | P/L={profit:+.2f} | pos={pos_id} | deal={deal_id} | src={channel_id}")

        # Queue close notification for async send in manager_loop
        if EXECUTION_CHAT_ID and notifications is not None:
            _BE_PLUS_MAX = 5.0
            if profit >= _BE_PLUS_MAX:
                outcome, icon = "WIN",  "✅"
            elif profit > 0:
                outcome, icon = "BE+",  "🛡️"
            elif profit < 0:
                outcome, icon = "LOSS", "❌"
            else:
                outcome, icon = "BE",   "➖"
            src_name  = CHANNEL_NAME_MAP.get(channel_id, channel_id)
            clean_sym = symbol.split(".")[0] if "." in symbol else symbol
            dir_icon  = "📈" if side == "BUY" else "📉"
            from datetime import datetime as _dt, timezone as _tz
            now_str   = _dt.now(_tz.utc).strftime("%Y-%m-%d %H:%M UTC")

            # Resolve entry price from today's deal history (entry deal for this position)
            exit_price  = float(getattr(d, "price", 0.0))
            entry_price = None
            orig_sl_v   = None
            for _ed in deals:
                if (str(getattr(_ed, "position_id", "")) == pos_id
                        and getattr(_ed, "entry", None) == mt5.DEAL_ENTRY_IN):
                    entry_price = float(getattr(_ed, "price", 0.0))
                    break
            # Fallback: managed_positions (rare — usually already cleaned up)
            if entry_price is None:
                _mp = state.get("managed_positions", {}).get(pos_id, {})
                if _mp:
                    entry_price = _mp.get("entry")
                    orig_sl_v   = _mp.get("orig_sl")

            # R:R calculation
            rr_line = ""
            if entry_price and entry_price > 0:
                if orig_sl_v is None:
                    orig_sl_v = state.get("managed_positions", {}).get(pos_id, {}).get("orig_sl")
                if orig_sl_v and abs(entry_price - float(orig_sl_v)) > 0:
                    sl_dist    = abs(entry_price - float(orig_sl_v))
                    price_diff = (exit_price - entry_price) if side == "BUY" else (entry_price - exit_price)
                    rr_val     = round(price_diff / sl_dist, 2)
                    rr_line    = f"📊 R:R:    {rr_val:+.2f}R\n"

            entry_str = f"{entry_price:.2f}" if entry_price else "—"
            exit_str  = f"{exit_price:.2f}"  if exit_price  else "—"

            notifications.append(
                f"{icon} <b>Trade Closed — {outcome}</b>\n"
                f"📊 {INSTANCE_NAME}  |  📡 {src_name}\n"
                f"\n"
                f"{dir_icon} <b>{clean_sym} | {side}</b>\n"
                f"⏰ {now_str}\n"
                f"\n"
                f"📍 Entry:  {entry_str}\n"
                f"🏁 Exit:   {exit_str}\n"
                f"{rr_line}"
                f"💰 P/L:    <b>{profit:+.2f}</b>\n"
                f"🎫 Ticket: {pos_id}"
            )

        ema_info  = state.get("position_ema", {}).get(str(pos_id), {})
        _mfe_usd  = float(state.get("managed_positions", {}).get(pos_id, {}).get("peak_profit_usd", 0.0) or 0.0)
        _mfe_pips = round(_mfe_usd / 0.10, 1) if _mfe_usd > 0 else 0.0
        append_trade_csv({
            "time_utc": t_utc,
            "symbol": symbol,
            "side": side,
            "volume": volume,
            "profit": profit,
            "commission": commission,
            "swap": swap,
            "position_id": pos_id,
            "deal_id": deal_id,
            "channel_id": channel_id,
            "ema_at_entry": ema_info.get("ema_at_entry"),
            "ema_aligned": ema_info.get("ema_aligned"),
            "mfe_pips": _mfe_pips,
        })

        state["last_logged_deal_id"] = deal_id


# ----------------- SOURCE INTAKE ARCHIVE -----------------
def ensure_intake_csv_header():
    if os.path.exists(INTAKE_LOG_CSV):
        return
    with open(INTAKE_LOG_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            "time_utc",
            "channel_id",
            "channel_title",
            "message_id",
            "classification",
            "reason",
            "preview",
            "raw_text",
        ])


def archive_signal_intake(chat_id: str, chat_title: str, message_id, classification: str, reason: str, text: str):
    if not INTAKE_ARCHIVE_ENABLED:
        return
    ensure_intake_csv_header()
    clean = clean_signal_text(text)
    preview = clean.replace("\n", " | ")[:240]
    with open(INTAKE_LOG_CSV, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            datetime.now(timezone.utc).isoformat(),
            chat_id,
            chat_title or "",
            message_id or "",
            classification,
            reason,
            preview,
            clean,
        ])


RESULT_MESSAGE_RE = re.compile(
    r"\b(?:"
    r"tp\s*\d*\s*(?:hit|done|reached|smashed|closed)"
    r"|sl\s*(?:hit|done|triggered|closed)"
    r"|result\s*#?\s*(?:tp\d+|sl)"
    r"|profit\s+(?:booked|locked|secured|hit)"
    r"|running\s+in\s+(?:profit|loss)"
    r"|(?:\d+\s*)?pips?\s+(?:profit|gain|loss)"
    r"|target\s*hit"
    r"|trade\s*closed"
    r")\b",
    re.IGNORECASE,
)

def is_result_message(text: str) -> bool:
    if not text:
        return False
    return bool(RESULT_MESSAGE_RE.search(text))
COMMENTARY_MESSAGE_RE = re.compile(
    r"""
    (?:\bGOOD\s+MORNING\b)
    |(?:\bGET\s+READY\b)
    |(?:\bWHO\s+(?:TOOK|IS\s+IN)\b)
    |(?:\bWAITING\s+FOR\s+(?:A\s+)?CONFIRMATION\b)
    |(?:\bBREAK\s*OUT\s+INCOMING\b)
    |(?:\bBREAKOUT\s+INCOMING\b)
    |(?:\bI[‘’]?M\s+SEEING\s+(?:BUYS|SELLS)\b)
    |(?:\bDID\s+YOU\s+GUYS\s+SEE\b)
    |(?:\bWHAT\s+AN\s+AMAZING\s+WEEK\b)
    |(?:\bREACT\s+HERE\b)
    |(?:\bGOOD\s+LUCK\b)
    # ---- Limitless VIP commentary false-positives ----
    # "Are we all in Gold buy" / "Are we in"
    |(?:\bARE\s+WE\s+(?:ALL\s+)?IN\b)
    # "Now active Within entry zone XAUUSD Buy" / "Within entry zone"
    |(?:\bWITHIN\s+(?:THE\s+)?ENTRY\s+ZONE\b)
    |(?:\bNOW\s+ACTIVE\b)
    # "Today’s results so far | ✅XAUUSD Buy +70"
    |(?:\bRESULTS?\s+SO\s+FAR\b)
    |(?:\bTODAY[‘’]?S\s+RESULTS?\b)
    # symbol+side followed immediately by a +/- pnl number — always a results update
    |(?:(?:XAU(?:USD)?|GOLD|GBPJPY|EURUSD)\s+(?:BUY|SELL)\s+[+\-]\d)
    # "Im going again" status updates
    |(?:\bIM\s+GOING\s+AGAIN\b)
    # "Check in" / "Update" commentary without price data
    |(?:\bWE\s+(?:ARE|WERE)\s+(?:NOW\s+)?(?:IN\s+)?(?:PROFIT|PIPS?)\b)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

SPAM_MESSAGE_RE = re.compile(
    r"""
    (?:\bVIP\b)
    |(?:\bSUBSCRIB(?:E|ER|ERS|ING)\b)
    |(?:\bPAYMENT\b)
    |(?:\bINVEST(?:MENT)?\b)
    |(?:\bACCOUNT\s+MANAG(?:EMENT|ER)\b)
    |(?:\bBROKER\b)
    |(?:\bCONTACT\s+ME\b)
    |(?:\bDM\s+ME\b)
    |(?:\bWHATSAPP\b)
    |(?:\bCOPY\s+TRADING\b)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)


# High-impact news detection — triggers a trading pause when matched.
# Catches common channel patterns: "High Impact news", named releases (NFP/CPI/FOMC),
# "cancelling orders due to news", "waiting for news to pass", etc.
NEWS_TRIGGER_RE = re.compile(
    r"""
    (?:HIGH[- ]IMPACT\s+NEWS)
    |(?:NEWS\s+IN\s+\d+\s+MINUTES?)
    |(?:BEFORE\s+(?:THE\s+)?NEWS)
    |(?:NEWS\s+(?:EVENT|RELEASE|COMING|TONIGHT|TOMORROW))
    |(?:CANCELL?ING.*(?:ORDER|TRADE|POSITION)S?.*NEWS)
    |(?:(?:WAIT(?:ING)?|HOLD(?:ING)?).*NEWS\s*(?:OVER|PASS|DONE|CLEAR|SETTLE))
    |(?:\bNFP\b)
    |(?:\bFOMC\b)
    |(?:NON[- ]FARM\s+PAYROLL)
    |(?:\bCPI\b.*(?:DATA|RELEASE|REPORT|TODAY|TOMORROW))
    |(?:\bPPI\b.*(?:DATA|RELEASE|REPORT|TODAY|TOMORROW))
    |(?:INTEREST\s+RATE\s+DECISION)
    |(?:CENTRAL\s+BANK\s+(?:MEETING|DECISION|STATEMENT))
    """,
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)

# Module-level timestamp: non-zero while a news pause is active.
# Written by the async Telegram handler, read by execute_signal() in the thread pool.
_news_pause_until: float = 0.0

# Bot lifecycle messages (ONLINE / STOPPED / FROZEN / RECOVERED)
# sent by all bots to the same channel — silently ignore them.
BOT_STATUS_RE = re.compile(
    r'(?:Bot\s+(?:ONLINE|STOPPED|FROZEN|RECOVERED)|'
    r'\U0001f7e2|\U0001f534).*(?:QFS|HA Bot|Signal Bot|CryptoNite)',
    re.IGNORECASE | re.DOTALL,
)

def classify_source_message(text: str):
    t = clean_signal_text(text)
    if not t:
        return "UNKNOWN", "empty_text"

    # Bot status messages — silently drop, don't log as UNKNOWN
    if BOT_STATUS_RE.search(t):
        return "SPAM", "bot_status_message"

    # Analyzer-engine signals contain TP as a target field, not a TP-hit update.
    # They must bypass result filtering and go straight to the parser layer.
    if ANALYZER_ENGINE_RE.search(t):
        return "ENTRY_SIGNAL", "matched_analyzer_engine"

    if RESULT_ONLY_RE.search(t) or RESULT_MESSAGE_RE.search(t):
        return "RESULT_UPDATE", "matched_result_pattern"

    if COMMENTARY_MESSAGE_RE.search(t):
        return "COMMENTARY", "matched_commentary_pattern"

    if SPAM_MESSAGE_RE.search(t):
        return "SPAM", "matched_spam_pattern"

    entry_patterns = (
        EARLY_SCALP_TRIGGER_RE,
        CT_SCALP_MARKET_RE,
        SIG_ENTRY_RE,
        PENDING_RE,
        SIMPLE_PENDING_RE,
        SIGNAL_ALERT_RE,
        SIMPLE_RE,
        REVERSE_SIMPLE_RE,
        HASH_SIGNAL_RE,
        GENERIC_PENDING_SLTP_RE,
        GOLD_RANGE_FULL_RE,
        GOLD_RANGE_SIMPLE_RE,
    )
    for rx in entry_patterns:
        try:
            if rx.search(t):
                return "ENTRY_SIGNAL", f"matched_{rx.__class__.__name__}"
        except Exception:
            continue

    upper = t.upper()
    has_side = bool(re.search(r"\b(BUY|SELL)\b", upper))
    has_trade_word = bool(re.search(r"\b(MARKET|LIMIT|STOP|ENTRY|TP\d*|SL|SCALP)\b", upper))
    has_number = bool(re.search(r"\d+(?:\.\d+)?", upper))

    if has_side and has_trade_word and has_number:
        return "ENTRY_SIGNAL", "matched_entry_heuristic"

    return "UNKNOWN", "no_entry_or_ignore_match"


# ----------------- TELEGRAM -----------------
client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
_channel_last_trade: dict = {}  # chat_id -> last trade timestamp (per-channel cooldown)

def _activate_news_pause(source_hint: str = "") -> None:
    """Set the module-level news pause timestamp and log the event."""
    global _news_pause_until
    import time as _t
    _news_pause_until = _t.time() + NEWS_PAUSE_MINUTES * 60
    until_str = datetime.fromtimestamp(_news_pause_until, tz=timezone.utc).strftime("%H:%M UTC")
    log_event(
        f"📰 NEWS PAUSE activated — new entries blocked for {NEWS_PAUSE_MINUTES} min "
        f"(until {until_str}){' src=' + source_hint if source_hint else ''}"
    )

def _write_signal_bridge(sig: dict, chat_id) -> None:
    """
    Write a validated XAUUSD signal to signal_bridge.json so the Gold HA bot
    can cross-confirm its own M1 pattern signals against the analyst's levels.
    Only writes for XAUUSD signals — other assets are not bridged.
    """
    raw_sym = (sig.get("raw_symbol") or "").upper()
    if raw_sym not in ("XAU", "XAUUSD"):
        return
    direction = (sig.get("side") or "").upper()
    if direction not in ("BUY", "SELL"):
        return
    sl   = sig.get("sl")
    tps  = sig.get("tps") or []
    tp   = float(tps[0]) if tps else None
    if not sl or not tp:
        return
    import json as _json, os as _os
    bridge_file = _os.path.join(
        _os.path.dirname(_os.path.abspath(__file__)), '..', 'signal_bridge.json'
    )
    try:
        try:
            with open(bridge_file, 'r', encoding='utf-8') as f:
                data = _json.load(f)
        except Exception:
            data = {}
        data["XAUUSD"] = {
            "direction":    direction,
            "entry":        sig.get("entry"),
            "sl":           float(sl),
            "tp":           float(tp),
            "sl_dist":      round(abs(float(sig.get("entry") or 0) - float(sl)), 2) if sig.get("entry") else None,
            "channel_id":   str(chat_id),
            "channel_name": CHANNEL_NAME_MAP.get(str(chat_id), str(chat_id)),
            "timestamp":    datetime.now(timezone.utc).isoformat(),
        }
        with open(bridge_file, 'w', encoding='utf-8') as f:
            _json.dump(data, f, indent=2)
        log_event(
            f"🌉 Signal bridge updated: XAUUSD {direction} "
            f"SL={sl} TP={tp} src={CHANNEL_NAME_MAP.get(str(chat_id), str(chat_id))}"
        )
    except Exception as e:
        log_event(f"⚠️ Signal bridge write failed: {e}")


def _write_signal_bridge_executed(raw_symbol: str, direction: str,
                                  entry, sl, tp, channel_id) -> None:
    """
    Write CONFIRMED EXECUTED signal parameters to signal_bridge.json.
    Called only after MT5 accepts the order — sl/tp are the exact values sent to
    the broker (after SL_MULTIPLIER, ATR model, TP ladder, sanitize_market_stops).
    These are the battle-tested parameters that achieve 83% WR — the Gold HA bot
    uses these levels rather than the raw signal values.
    """
    base = raw_symbol.upper().replace('.S', '').replace('.P', '').replace('.F', '').replace('.PRO', '')
    if base not in ("XAU", "XAUUSD"):
        return
    direction = direction.upper()
    if direction not in ("BUY", "SELL"):
        return
    import json as _json, os as _os
    bridge_file = _os.path.join(
        _os.path.dirname(_os.path.abspath(__file__)), '..', 'signal_bridge.json'
    )
    try:
        try:
            with open(bridge_file, 'r', encoding='utf-8') as f:
                data = _json.load(f)
        except Exception:
            data = {}
        data["XAUUSD"] = {
            "direction":    direction,
            "entry":        float(entry) if entry else None,
            "sl":           float(sl),
            "tp":           float(tp),
            "sl_dist":      round(abs(float(entry or 0) - float(sl)), 2) if entry else None,
            "channel_id":   str(channel_id),
            "channel_name": CHANNEL_NAME_MAP.get(str(channel_id), str(channel_id)),
            "timestamp":    datetime.now(timezone.utc).isoformat(),
            "executed":     True,
        }
        with open(bridge_file, 'w', encoding='utf-8') as f:
            _json.dump(data, f, indent=2)
        log_event(
            f"🌉 Bridge updated (EXECUTED): XAUUSD {direction} "
            f"entry={entry} SL={sl} TP={tp} "
            f"src={CHANNEL_NAME_MAP.get(str(channel_id), str(channel_id))}"
        )
    except Exception as e:
        log_event(f"⚠️ Signal bridge write failed: {e}")


def is_from_signal_source(event) -> bool:
    if CHANNEL_IDS:
        return str(getattr(event, "chat_id", "")) in CHANNEL_IDS
    if CHANNEL_USERNAME:
        try:
            return (event.chat.username or "").lower() == CHANNEL_USERNAME
        except Exception:
            return False
    return False

@client.on(events.NewMessage)
async def handler(event):

    raw_text = event.raw_text or ""
    text = normalize_multilang_signal(raw_text)
    chat_id = str(getattr(event, "chat_id", "") or "")
    
    activity_inc(chat_id, "messages")
    
    chat_title = getattr(getattr(event, "chat", None), "title", None)

    if DEBUG_ALL_MESSAGES:
        preview = clean_signal_text(text)[:200].replace("\n", " | ")
        log_event(f"👂 MSG: chat_id={chat_id} title={chat_title} text={preview}")

    if not is_from_signal_source(event):
        if DEBUG_SOURCE_MISMATCH:
            preview = clean_signal_text(text)[:160].replace("\n", " | ")
            log_event(
                f"🚫 SOURCE MISMATCH: got chat_id={chat_id} title={chat_title} "
                f"locked={allowed_chat_ids() or CHANNEL_USERNAME} text={preview}"
            )
        return

    # News pause detection — runs on every accepted message, even COMMENTARY/UNKNOWN,
    # because news warnings don't arrive in signal format.
    if NEWS_PAUSE_MINUTES > 0 and NEWS_TRIGGER_RE.search(text):
        _activate_news_pause(source_hint=chat_id)
        if EXECUTION_CHAT_ID:
            until_str = datetime.fromtimestamp(_news_pause_until, tz=timezone.utc).strftime("%H:%M UTC")
            asyncio.create_task(safe_send(
                int(EXECUTION_CHAT_ID),
                f"📰 <b>News Pause Active</b>\n"
                f"📡 {INSTANCE_NAME}\n"
                f"High-impact news detected from <code>{chat_id}</code>.\n"
                f"⏸ New entries blocked for <b>{NEWS_PAUSE_MINUTES} min</b> "
                f"(until {until_str}).\n"
                f"⏰ {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"
            ))

    classification, class_reason = classify_source_message(text)
    archive_signal_intake(
        chat_id=chat_id,
        chat_title=chat_title,
        message_id=getattr(event, "id", ""),
        classification=classification,
        reason=class_reason,
        text=text,
    )

    if classification == "RESULT_UPDATE":
        activity_inc(chat_id, "result_updates")
        activity_inc(chat_id, "ignored")
        if DEBUG_INTAKE_FILTER:
            preview = clean_signal_text(text)[:180].replace("\n", " | ")
            log_event(f"🧾 FILTER RESULT_UPDATE src={chat_id} reason={class_reason} text={preview}")
        return

    if classification == "COMMENTARY":
        activity_inc(chat_id, "commentary")
        activity_inc(chat_id, "ignored")
        if DEBUG_INTAKE_FILTER:
            preview = clean_signal_text(text)[:180].replace("\n", " | ")
            log_event(f"💬 FILTER COMMENTARY src={chat_id} reason={class_reason} text={preview}")
        return

    if classification == "SPAM":
        activity_inc(chat_id, "spam")
        activity_inc(chat_id, "ignored")
        if class_reason != "bot_status_message" and DEBUG_INTAKE_FILTER:
            preview = clean_signal_text(text)[:180].replace("\n", " | ")
            log_event(f"🚫 FILTER SPAM src={chat_id} reason={class_reason} text={preview}")
        return

    if classification == "UNKNOWN":
        # Directional channels (e.g. Limitless 2.0) send bare "XAUUSD SELL" messages
        # with no price numbers — the classifier marks these UNKNOWN, but we want to
        # fire immediately. Let them fall through to parse_signal_by_source.
        if chat_id not in _DIRECTIONAL_CHANNELS:
            activity_inc(chat_id, "unknown")
            activity_inc(chat_id, "ignored")
            if DEBUG_INTAKE_FILTER:
                preview = clean_signal_text(text)[:180].replace("\n", " | ")
                log_event(f"❓ FILTER UNKNOWN src={chat_id} reason={class_reason} text={preview}")
            return

    activity_inc(chat_id, "entry_candidates")
    sig = parse_signal_by_source(chat_id, text)

    if not sig:
        activity_inc(chat_id, "parse_fail")

        if DEBUG_PARSE_FAIL:
            log_event("⚠️ From source but did NOT match signal format.")
            log_event("Raw text: " + clean_signal_text(text).replace("\n", " | "))
        return

    sig["source"] = chat_id

    # SCALP protection
    if sig.get("kind") == "SCALP_MARKET":

        if not SCALP_SOURCE_IDS:
            log_event(
                f"🛑 SCALP_MARKET blocked (SCALP_SOURCE_IDS empty). chat_id={chat_id}"
            )
            return

        if chat_id not in set(SCALP_SOURCE_IDS):
            log_event(
                f"🛑 SCALP_MARKET blocked (source not allowed). "
                f"chat_id={chat_id} allowed={SCALP_SOURCE_IDS}"
            )
            return

    # EARLY SCALP protection
    if sig.get("kind") == "EARLY_SCALP":

        if not EARLY_SCALP_ENABLED:
            log_event(
                f"🛑 EARLY_SCALP blocked (EARLY_SCALP_ENABLED=false). src={chat_id}"
            )
            return

        if EARLY_SCALP_ONLY_DEMO and ACCOUNT_MODE != "DEMO":
            log_event(
                f"🛑 EARLY_SCALP blocked (ONLY_DEMO=true and ACCOUNT_MODE={ACCOUNT_MODE})."
            )
            return

        if sig.get("raw_symbol") not in set(EARLY_SCALP_SYMBOLS):
            log_event(
                f"🛑 EARLY_SCALP blocked (symbol not allowed): "
                f"{sig.get('raw_symbol')} allowed={EARLY_SCALP_SYMBOLS}"
            )
            return

        if chat_id not in set(SCALP_SOURCE_IDS):
            log_event(
                f"🛑 EARLY_SCALP blocked (source not allowed). "
                f"src={chat_id} scalp_sources={SCALP_SOURCE_IDS}"
            )
            return

    activity_inc(chat_id, "signals")

    log_event(
        f"📩 SIGNAL ({sig.get('kind','?')}) RECEIVED: "
        + sig["raw"].replace("\n", " | ")
        + f" | src={chat_id}"
    )

    if MIRROR_CHAT_ID:
        try:
            await client.send_message(
                int(MIRROR_CHAT_ID),
                "📌 SIGNAL COPY\n\n" + sig["raw"]
            )
            log_event("📤 Signal mirrored.")
        except Exception:
            log_event("Mirror send failed:\n" + traceback.format_exc())

    if not LIVE_MODE:
        log_event("🛑 LIVE_MODE=false — refusing to place trades.")
        return

    now = time.time()

    if COOLDOWN_SECONDS > 0 and (now - _channel_last_trade.get(str(chat_id), 0)) < COOLDOWN_SECONDS:
        log_event(f"Cooldown: skipping (channel {chat_id} — {COOLDOWN_SECONDS}s)")
        return

    try:

        async with MT5_ASYNC_LOCK:
            res = await asyncio.to_thread(process_signal_sync, sig)

        if (
            res is not None
            and getattr(res, "retcode", None)
            in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009)
        ):
            _channel_last_trade[str(chat_id)] = time.time()
            if EXECUTION_CHAT_ID:
                side   = (sig.get("side") or "").upper()
                icon   = "🟢" if side == "BUY" else "🔴"
                # Use resolved broker symbol, fall back to raw if not yet resolved
                sym    = resolve_symbol_live(sig.get("raw_symbol", "?"))
                ticket = getattr(res, "order", 0)
                sl     = sig.get("sl", 0)
                tps    = sig.get("tps", [])
                src    = CHANNEL_NAME_MAP.get(str(chat_id), str(chat_id))

                # Only show TP levels that are actually distinct
                unique_tps = []
                for tp in tps:
                    if tp and tp > 0 and tp not in unique_tps:
                        unique_tps.append(tp)

                clean_sym   = sym.split(".")[0] if "." in sym else sym
                dir_icon    = "📈" if side == "BUY" else "📉"
                from datetime import datetime as _dt, timezone as _tz
                now_str     = _dt.now(_tz.utc).strftime("%Y-%m-%d %H:%M UTC")
                entry_price = getattr(res, "price", None)
                entry_str   = f"{float(entry_price):.2f}" if entry_price else "—"
                sl_str      = f"{float(sl):.2f}" if sl else "—"
                # Use the final executed TP (SET_BROKER_TP = last unique TP)
                exec_tp  = unique_tps[-1] if unique_tps else None
                tp_str   = f"{float(exec_tp):.2f}" if exec_tp else "—"
                lots_val = getattr(res, "volume", None)
                lots_str = f"{float(lots_val):.2f}" if lots_val else "—"
                notify = (
                    f"{icon} <b>Trade Opened</b>\n"
                    f"📊 {INSTANCE_NAME}  |  📡 {src}\n"
                    f"\n"
                    f"{dir_icon} <b>{clean_sym} | {side}</b>\n"
                    f"⏰ {now_str}\n"
                    f"\n"
                    f"📍 Entry:  {entry_str}\n"
                    f"🛑 SL:     {sl_str}\n"
                    f"🎯 TP:     {tp_str}\n"
                    f"📦 Lots:   {lots_str}\n"
                    f"🎫 Ticket: {ticket}"
                )
                await safe_send(int(EXECUTION_CHAT_ID), notify)

        if res is not None:
            log_event(
                f"MT5 result retcode={res.retcode} "
                f"comment={getattr(res,'comment',None)}"
            )

    except Exception:
        log_event("Exception:\n" + traceback.format_exc())


def calc_ema_m5(symbol: str):
    """Return (ema_value, current_price) using M5 EMA_PERIOD.
    Returns (None, None) on data failure."""
    tf_map = {"M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15, "H1": mt5.TIMEFRAME_H1}
    tf = tf_map.get(EMA_TIMEFRAME.upper(), mt5.TIMEFRAME_M5)
    needed = EMA_PERIOD + 20  # a few extra bars for a warm EMA
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, needed)
    if rates is None or len(rates) < EMA_PERIOD:
        return None, None
    closes = [r["close"] for r in rates[-EMA_PERIOD:]]
    ema = closes[0]
    k = 2.0 / (EMA_PERIOD + 1)
    for price in closes[1:]:
        ema = price * k + ema * (1 - k)
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return ema, None
    return ema, tick.bid  # use bid as proxy for current price

def process_signal_sync(sig):
    state = load_state()
    try:
        mt5_connect_safe()
        enforce_account_lock()

        # ── EMA FILTER ──────────────────────────────────────────────
        if EMA_FILTER_ENABLED:
            raw_sym = sig.get('raw_symbol', '')
            broker_sym = resolve_symbol_live(raw_sym) if raw_sym else None
            side = (sig.get('side') or '').upper()
            if broker_sym and side:
                ema_val, cur_price = calc_ema_m5(broker_sym)
                if ema_val is None:
                    # Insufficient data — block and log (fail closed)
                    log_event(f'[EMA FILTER BLOCK] {side} {broker_sym} — insufficient M5 data')
                    return None
                sig['ema_at_entry'] = round(ema_val, 2)
                aligned = (side == 'BUY' and cur_price >= ema_val) or \
                          (side == 'SELL' and cur_price <= ema_val)
                sig['ema_aligned'] = aligned
                if aligned:
                    log_event(f'[EMA FILTER PASS] {side} {broker_sym} price={cur_price:.2f} EMA={ema_val:.2f}')
                else:
                    log_event(f'[EMA FILTER BLOCK] {side} {broker_sym} price={cur_price:.2f} EMA={ema_val:.2f} — counter-trend, skipping')
                    return None
        # ────────────────────────────────────────────────────────────

        res = place_trade(sig, state)
        save_state(state)
        return res
    finally:
        mt5_disconnect_safe()

def adopt_manual_trades(state, notifications=None):
    """
    Scan all open positions that lack the bot's magic number and bring
    them under bot management (BE + trailing stop).

    For each unmanaged position:
      1. Skip if already adopted this session.
      2. Use the position's existing SL — if none, calculate ATR × 1.5.
      3. Use the position's existing TP — if none, project 1R/2R/3R levels.
      4. Register in managed_positions so the manager loop takes over.

    Controlled by ADOPT_MANUAL_TRADES=true in the env.
    """
    if not ADOPT_MANUAL_TRADES:
        return

    state.setdefault("adopted_tickets", [])
    state.setdefault("managed_positions", {})
    state.setdefault("position_sources", {})

    already = set(str(t) for t in state["adopted_tickets"])

    positions = mt5.positions_get()
    if not positions:
        return

    for pos in positions:
        ticket     = str(pos.ticket)
        pos_magic  = int(getattr(pos, "magic", 0) or 0)
        pos_type   = int(pos.type)   # 0=BUY, 1=SELL
        symbol     = safe_symbol_text(pos.symbol)
        entry      = float(pos.price_open)
        cur_sl     = float(pos.sl or 0.0)
        cur_tp     = float(pos.tp or 0.0)

        # Skip if already tracked in managed_positions (bot own or previously adopted)
        if ticket in state["managed_positions"]:
            continue
        # Bot's own position not in managed_positions = orphaned after restart — recover it
        # Manual position (different magic) = adopt as usual
        is_orphaned_bot = (pos_magic == MAGIC)
        if ticket in already and not is_orphaned_bot:
            continue

        # ── SL: use existing or calculate ATR × 1.5 ──────────────────
        if cur_sl and cur_sl != 0.0:
            orig_sl = cur_sl
        else:
            atr = atr_value(symbol, ATR_TIMEFRAME, ATR_PERIOD)
            if atr <= 0:
                log_event(f"⚠️  ADOPT: no ATR for {symbol} #{ticket} — skipping")
                continue
            orig_sl = (entry - atr * 1.5) if pos_type == 0 else (entry + atr * 1.5)
            log_event(f"📐 ADOPT: no SL on {symbol} #{ticket} — applied ATR SL={orig_sl:.5f}")

        sl_dist = abs(entry - orig_sl)
        if sl_dist <= 0:
            continue

        # ── TP: use existing or project 1R/2R/3R ─────────────────────
        if cur_tp and cur_tp != 0.0:
            tp1 = cur_tp
            tp2 = entry + (2 * sl_dist) if pos_type == 0 else entry - (2 * sl_dist)
            tp3 = entry + (3 * sl_dist) if pos_type == 0 else entry - (3 * sl_dist)
        else:
            tp1 = entry + (1 * sl_dist) if pos_type == 0 else entry - (1 * sl_dist)
            tp2 = entry + (2 * sl_dist) if pos_type == 0 else entry - (2 * sl_dist)
            tp3 = entry + (3 * sl_dist) if pos_type == 0 else entry - (3 * sl_dist)

        side = "BUY" if pos_type == 0 else "SELL"

        # ── Register in managed_positions ────────────────────────────
        state["managed_positions"][ticket] = {
            "symbol":           symbol,
            "type":             pos_type,
            "entry":            entry,
            "orig_sl":          orig_sl,
            "tp1":              round(tp1, 5),
            "tp2":              round(tp2, 5),
            "tp3":              round(tp3, 5),
            "moved_be":         False,
            "trail_on":         False,
            "tp_removed":       False,
            "tp1_partial_done": False,
            "tp2_partial_done": False,
            "peak_profit_usd":  0.0,
            "created":          time.time(),
        }
        src_label = "RECOVERED" if is_orphaned_bot else "ADOPTED"
        state["position_sources"][ticket] = src_label
        if not is_orphaned_bot:
            state["adopted_tickets"].append(int(ticket))

        action_label = "RECOVERED" if is_orphaned_bot else "ADOPTED"
        log_event(
            f"🤝 {action_label}: {symbol} #{ticket} {side} @ {entry} | "
            f"SL={orig_sl:.5f} | TP1={tp1:.5f} | magic={pos_magic}"
        )

        if EXECUTION_CHAT_ID and notifications is not None:
            _clean_sym = symbol.split(".")[0] if "." in symbol else symbol
            _dir_icon  = "📈" if side == "BUY" else "📉"
            _fmt_v     = lambda v: f"{v:.5f}" if v <= 10 else f"{v:.2f}"
            _now_str   = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
            notifications.append(
                f"📎 <b>Trade Adopted</b>\n"
                f"📡 {INSTANCE_NAME}\n"
                f"\n"
                f"{_dir_icon} <b>{_clean_sym} | {side}</b>\n"
                f"⏰ {_now_str}\n"
                f"\n"
                f"📍 Entry: {_fmt_v(entry)}\n"
                f"🛑 SL:    {_fmt_v(orig_sl)}  (ATR-based)\n"
                f"🎯 TP1:   {_fmt_v(tp1)}\n"
                f"\n"
                f"🤖 Now managed by bot"
            )


# =========================
# SESSION CLOSE GUARD
# Fires once per day at TIME_FILTER_END_HOUR UTC.
# Closes any open managed positions that are in profit but have NOT yet had
# their SL moved to breakeven — they still carry full original downside risk.
# Positions with SL already at/above entry are left for the trail to handle.
# =========================
def session_close_guard(state):
    now_utc = datetime.now(timezone.utc)
    end_hour = TIME_FILTER_END_HOUR

    # Only fire at or after the session end hour
    if now_utc.hour < end_hour:
        return []

    # Fire once per calendar day only
    today_str = now_utc.date().isoformat()
    if state.get("session_close_guard_fired") == today_str:
        return []
    state["session_close_guard_fired"] = today_str

    managed  = state.get("managed_positions", {})
    if not managed:
        return []

    poss = mt5.positions_get()
    if not poss:
        return []

    pos_by_ticket = {str(p.ticket): p for p in poss}
    notifications = []
    closed = 0

    for ticket_str, meta in list(managed.items()):
        p = pos_by_ticket.get(ticket_str)
        if p is None:
            continue

        # Skip if not in profit
        if float(getattr(p, "profit", 0.0) or 0.0) <= 0:
            continue

        entry    = float(meta.get("entry", 0.0))
        pos_type = int(meta.get("type", 0))   # 0=BUY 1=SELL
        cur_sl   = float(p.sl) if p.sl else 0.0
        symbol   = safe_symbol_text(meta.get("symbol", getattr(p, "symbol", "")))
        info     = mt5.symbol_info(symbol)
        point    = float(getattr(info, "point", 0.0) or 0.0)
        eps      = max(point * 2.0, 0.00001)

        # Check if SL is still on the wrong side of entry (not yet at BE)
        sl_unprotected = (
            (pos_type == 0 and (cur_sl == 0.0 or cur_sl < entry - eps)) or
            (pos_type == 1 and (cur_sl == 0.0 or cur_sl > entry + eps))
        )
        if not sl_unprotected:
            log_event(f"🔒 Session guard: ticket={ticket_str} {symbol} SL={cur_sl:.5f} protected — leaving for trail")
            continue

        # Close the unprotected profitable position
        pnl   = float(getattr(p, "profit", 0.0) or 0.0)
        side  = "BUY" if pos_type == 0 else "SELL"
        ok    = close_full_position(int(ticket_str), symbol, pos_type, float(p.volume))
        if ok:
            log_event(f"🔒 Session guard: closed ticket={ticket_str} {symbol} {side} P&L={pnl:+.2f} (SL not at BE)")
            managed.pop(ticket_str, None)
            closed += 1
        else:
            log_event(f"⚠️ Session guard: close FAILED ticket={ticket_str} {symbol}")

    if closed:
        msg = f"🔒 <b>Session Close Guard</b>\n\nSecured {closed} unprotected position(s) at {end_hour:02d}:00 UTC"
        log_event(msg)
        notifications.append(msg)

    return notifications


def process_manager_sync():
    state = load_state()
    notifications = []
    try:
        mt5_connect_safe()
        enforce_account_lock()
        expire_pending_orders(state)
        adopt_manual_trades(state, notifications)   # ← adoption before management
        manage_positions_once(state)
        notifications.extend(session_close_guard(state))  # close unprotected profitable positions at session end
        log_new_closed_deals(state, notifications)
        save_state(state)
    finally:
        mt5_disconnect_safe()
    return notifications

async def safe_send(chat_id: int, message: str):
    try:
        if not client.is_connected():
            await client.connect()
        await client.send_message(chat_id, message, parse_mode="html")
        return True
    except asyncio.CancelledError:
        # CancelledError is BaseException (not Exception) in Python 3.8+ —
        # catch it explicitly so a Telethon internal cancellation doesn't
        # propagate out and kill the bot.
        log_event("Telegram send cancelled (CancelledError) — treating as failure")
        return False
    except Exception:
        log_event("Telegram send failed:\n" + traceback.format_exc())
        return False


def send_bot_api_sync(message: str):
    """Generic synchronous Bot-API send — no event loop required.
    Used for startup and shutdown notifications where asyncio may not be
    fully running.  Silently ignores failures."""
    if not BOT_TOKEN or not EXECUTION_CHAT_ID:
        return
    try:
        payload = urllib.parse.urlencode({
            "chat_id": EXECUTION_CHAT_ID,
            "text": message,
            "parse_mode": "HTML",
        }).encode()
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        req = urllib.request.Request(url, data=payload, method="POST")
        with urllib.request.urlopen(req, timeout=10):
            pass
        log_event("[BOT API] Sync send OK")
    except Exception as _e:
        log_event(f"[BOT API] Sync send failed: {_e}")


def send_shutdown_notify_sync(message: str):
    """Synchronous shutdown notification via Bot API — no event loop needed."""
    send_bot_api_sync(message)


async def send_session_open_247():
    """Send the full session-open card on startup (mirrors tg-bot / CNFS format).
    Returns True if the message was sent successfully, False otherwise."""
    if not EXECUTION_CHAT_ID:
        return True  # nothing to send \u2014 treat as success
    # process_manager_sync calls mt5_disconnect_safe() in its finally block on
    # every cycle, so mt5.account_info() returns None between ticks.  Acquire
    # MT5_ASYNC_LOCK and do our own connect/read/disconnect \u2014 same pattern as
    # process_manager_sync \u2014 to guarantee we get live account data.
    acc = None
    try:
        async with MT5_ASYNC_LOCK:
            def _read_account():
                try:
                    mt5_connect_safe()
                    return mt5.account_info()
                finally:
                    mt5_disconnect_safe()
            acc = await asyncio.to_thread(_read_account)
    except Exception as _e:
        log_event(f'[STARTUP] account_info fetch error: {_e}')
    if not acc:
        return await safe_send(int(EXECUTION_CHAT_ID),
            f'\U0001f7e2 <b>Bot ONLINE</b>\n'
            f'\U0001f4e1 {INSTANCE_NAME}\n'
            f'\u23f0 {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}')
    st       = load_state()
    today_s  = day_key_local()
    ch_s     = st.get("channel_stats", {}).get(today_s, {})
    _tw = _tl = _tbep = _tbe = 0
    for b in ch_s.values():
        _tw   += b.get("wins",      0)
        _tl   += b.get("losses",    0)
        _tbep += b.get("be_plus",   0)
        _tbe  += b.get("breakeven", 0)
    _total   = _tw + _tl + _tbep + _tbe
    _pnl     = st.get("realised_pnl_today", 0.0)
    _pnl_sgn = "+" if _pnl >= 0 else ""
    _blocked = st.get("blocked_today", False)
    _status  = "\u26d4 BLOCKED" if _blocked else "\u2705 Trading enabled"
    brief = (
        f'\U0001f4ca <b>Session Open</b>\n'
        f'\U0001f4e1 {INSTANCE_NAME}\n'
        f'\u23f0 {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}\n'
        f'\U0001f4b0 Balance: <b>{acc.balance:.2f}</b>  |  Equity: <b>{acc.equity:.2f}</b>\n'
        f'\U0001f4c8 Today P&L: <b>{_pnl_sgn}{_pnl:.2f}</b>\n'
        f'\U0001f522 Trades: {_total} ({_tw}W / {_tl}L / {_tbep}BE+ / {_tbe}BE)\n'
        f'{_status}'
    )
    return await safe_send(int(EXECUTION_CHAT_ID), brief)

async def manager_loop():
    last_report_day = None
    rep_hh, rep_mm = parse_hhmm(DAILY_REPORT_SEND_TIME)
    _mt5_was_down = False          # tracks whether an alert was already sent
    _mt5_fail_count = 0            # consecutive failure counter for backoff
    _dd_alerted          = False   # drawdown alert fired today
    _profit_alerted      = False   # profit target alert fired today
    _session_brief_sent  = False   # session open snapshot sent today
    _alerted_orders      = set()   # stale order tickets already alerted
    _last_alert_day      = None    # track UTC date for daily resets

    while True:
        # Weekend guard — skip main loop on Saturday & Sunday
        if datetime.now(timezone.utc).weekday() >= 5:
            await asyncio.sleep(60)
            continue
        try:
            async with MT5_ASYNC_LOCK:
                notifications = await asyncio.to_thread(process_manager_sync)
            if EXECUTION_CHAT_ID and notifications:
                for msg in notifications:
                    await safe_send(int(EXECUTION_CHAT_ID), msg)
            # MT5 came back — flush stale pending orders then send recovery alert
            if _mt5_was_down:
                log_event("[MT5] Connection recovered.")
                # Cancel any pending orders placed before/during the outage —
                # their entry prices are now stale and could fill at wrong levels.
                async with MT5_ASYNC_LOCK:
                    n_cancelled = await asyncio.to_thread(cancel_all_my_pending_orders)
                if n_cancelled:
                    log_event(f"🧹 Reconnect: cancelled {n_cancelled} stale pending order(s).")
                if EXECUTION_CHAT_ID:
                    cancel_note = f"\n🧹 Cancelled {n_cancelled} stale pending order(s)." if n_cancelled else ""
                    await safe_send(int(EXECUTION_CHAT_ID),
                        f"✅ MT5 connection RECOVERED — bot is trading again.{cancel_note}")
                _mt5_was_down = False
                _mt5_fail_count = 0
        except Exception as exc:
            _mt5_fail_count += 1
            err_str = str(exc)
            is_auth = "Authorization failed" in err_str or "-6" in err_str
            # Send Telegram alert on first failure (or every 60 consecutive ones = ~10 min)
            if not _mt5_was_down or _mt5_fail_count % 60 == 0:
                reason = "Authorization failed (-6) — MT5 terminal may be logged out or disconnected" if is_auth else err_str[:200]
                alert = f"⚠️ MT5 CONNECTION LOST\n\n{reason}\n\nBot is paused until MT5 reconnects. Restart the bot or re-login to MT5."
                log_event(f"[MT5 DOWN] {reason}")
                if EXECUTION_CHAT_ID:
                    await safe_send(int(EXECUTION_CHAT_ID), alert)
            _mt5_was_down = True
            mt5_reset_latch_log()   # next successful connect should log the latch again
            log_event("Manager exception:\n" + traceback.format_exc())

        if DAILY_REPORT_ENABLED:
            now = datetime.now()
            today = now.date()
            if now.hour > rep_hh or (now.hour == rep_hh and now.minute >= rep_mm):
                if last_report_day != today:
                    # Afternoon report (≥12:00) → use today's trades; midnight report → yesterday
                    report_day = today.isoformat() if rep_hh >= 12 else (today - timedelta(days=1)).isoformat()
                    st = load_state()
                    msg = format_channel_report(st, report_day)

                    log_event(msg.replace("\n", " | "))

                    if DAILY_REPORT_CHAT_ID:
                        try:
                            await safe_send(int(DAILY_REPORT_CHAT_ID), msg)
                            log_event("📤 Daily report sent.")
                        except Exception:
                            log_event("Daily report send failed:\n" + traceback.format_exc())

                    last_report_day = today

        # Daily reset of alert flags at midnight UTC
        _today = datetime.now(timezone.utc).date()
        if _last_alert_day != _today:
            _last_alert_day      = _today
            _dd_alerted          = False
            _profit_alerted      = False
            _session_brief_sent  = False
            _alerted_orders      = set()

        # Session open snapshot
        _now_h = datetime.now(timezone.utc).hour
        if not _session_brief_sent and TIME_FILTER_ENABLED and _now_h >= TIME_FILTER_START_HOUR and EXECUTION_CHAT_ID:
            _session_brief_sent = True
            _acc = mt5.account_info()
            if _acc:
                # Gather today's W/L/BE+/BE from channel stats
                _st      = load_state()
                _today_s = day_key_local()
                _ch_s    = _st.get("channel_stats", {}).get(_today_s, {})
                _tw = _tl = _tbep = _tbe = 0
                for _b in _ch_s.values():
                    _tw   += _b.get("wins",      0)
                    _tl   += _b.get("losses",    0)
                    _tbep += _b.get("be_plus",   0)
                    _tbe  += _b.get("breakeven", 0)
                _total   = _tw + _tl + _tbep + _tbe
                _pnl     = _st.get("realised_pnl_today", 0.0)
                _pnl_sgn = "+" if _pnl >= 0 else ""
                _blocked = _st.get("blocked_today", False)
                _status  = "\u26d4 BLOCKED" if _blocked else "\u2705 Trading enabled"
                _brief = (
                    f'\U0001f4ca <b>Session Open</b>\n'
                    f'\U0001f4e1 CryptoNite Signal Bot\n'
                    f'\u23f0 {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}\n'
                    f'\U0001f4b0 Balance: <b>{_acc.balance:.2f}</b>  |  Equity: <b>{_acc.equity:.2f}</b>\n'
                    f'\U0001f4c8 Today P&L: <b>{_pnl_sgn}{_pnl:.2f}</b>\n'
                    f'\U0001f522 Trades: {_total} ({_tw}W / {_tl}L / {_tbep}BE+ / {_tbe}BE)\n'
                    f'{_status}'
                )
                await safe_send(int(EXECUTION_CHAT_ID), _brief)

        # Drawdown alert
        if not _dd_alerted and DRAWDOWN_ALERT_PCT > 0 and EXECUTION_CHAT_ID:
            _acc = mt5.account_info()
            if _acc and _acc.balance > 0:
                _dd = (_acc.balance - _acc.equity) / _acc.balance * 100
                if _dd >= DRAWDOWN_ALERT_PCT:
                    _dd_alerted = True
                    await safe_send(int(EXECUTION_CHAT_ID),
                        f'\u26a0\ufe0f <b>Drawdown Alert</b>\n'
                        f'\U0001f4e1 {INSTANCE_NAME}\n'
                        f'\U0001f4c9 Equity dropped <b>{_dd:.1f}%</b> below balance\n'
                        f'\U0001f4b0 Balance: <b>{_acc.balance:.2f}</b>  |  Equity: <b>{_acc.equity:.2f}</b>\n'
                        f'\u23f0 {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}\n'
                        f'\U0001f4a1 Consider pausing signal execution.')


        # Daily profit target alert
        if not _profit_alerted and DAILY_PROFIT_TARGET_PCT > 0 and EXECUTION_CHAT_ID:
            try:
                _acc = mt5.account_info()
                if _acc and _acc.balance > 0:
                    _st  = load_state()
                    _pnl = _st.get("realised_pnl_today", 0.0)
                    _tgt = _acc.balance * DAILY_PROFIT_TARGET_PCT / 100
                    if _pnl >= _tgt:
                        _profit_alerted = True
                        _ps = "+" if _pnl >= 0 else ""
                        await safe_send(int(EXECUTION_CHAT_ID),
                            f"\U0001f3af <b>Daily Profit Target Hit</b>\n"
                            f"\U0001f4e1 {INSTANCE_NAME}\n"
                            f"\u2705 Today's P&L: <b>{_ps}{_pnl:.2f}</b> ({_pnl/_acc.balance*100:.1f}% of balance)\n"
                            f"\U0001f3c6 Target: +{_tgt:.2f} ({DAILY_PROFIT_TARGET_PCT:.1f}%)\n"
                            f"\u23f0 {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
                            f"\U0001f4a1 Consider calling it a day.")
            except Exception:
                pass

        # Heartbeat — lets watchdog.py detect a frozen loop
        try:
            import time as _t
            open('heartbeat.txt', 'w').write(str(_t.time()))
        except Exception:
            pass

        # Pending order timeout alert
        if EXECUTION_CHAT_ID and ORDER_TIMEOUT_MINUTES > 0:
            try:
                _orders = mt5.orders_get() or []
                for _ord in _orders:
                    if _ord.ticket in _alerted_orders:
                        continue
                    _age = (datetime.now(timezone.utc) - datetime.fromtimestamp(_ord.time_setup, tz=timezone.utc)).total_seconds() / 60
                    if _age >= ORDER_TIMEOUT_MINUTES:
                        _alerted_orders.add(_ord.ticket)
                        _side = 'BUY' if _ord.type in (0,4,6) else 'SELL'
                        await safe_send(int(EXECUTION_CHAT_ID),
                            f'\U0001f5d1 <b>Stale Order Cancelled</b>\n'
                            f'\U0001f4e1 {INSTANCE_NAME}\n'
                            f'\U0001f4cc {_ord.symbol} {_side}\n'
                            f'\u23f1 Pending for <b>{_age:.0f} min</b> (limit: {ORDER_TIMEOUT_MINUTES}min)\n'
                            f'\U0001f3ab Ticket: {_ord.ticket}\n'
                            f'\u23f0 {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}')
            except Exception:
                pass

        # When MT5 is down, back off to 60s retries instead of hammering every 8s
        sleep_secs = min(60, MANAGER_INTERVAL_SECONDS * (1 + _mt5_fail_count // 5)) if _mt5_was_down else MANAGER_INTERVAL_SECONDS
        await asyncio.sleep(sleep_secs)

# =============================================================
# BOT COMMAND HANDLER
# Runs a second Telegram client (bot token) alongside the main
# user client. Accepts /commands from CONTROL_CHAT_ID only.
#
# Commands:
#   /status   — trading flags, daily loss %, monthly DD, open trades
#   /pause    — block new signal execution
#   /resume   — unblock
#   /stats    — today's P&L, wins/losses/BE, balance/equity
#   /trades   — list open managed positions with live P&L
#   /monthly  — monthly DD, high equity, pause status
#   /help     — show all commands
#
# Setup: add to .env
#   BOT_TOKEN=<your bot token from @BotFather>
#   CONTROL_CHAT_ID=<your Telegram user or group ID>
# =============================================================
class BotCommandHandler:

    def __init__(self):
        self.bot_client = None

    async def start(self):
        if not BOT_TOKEN or not CONTROL_CHAT_ID:
            log_event("[BOT CMD] BOT_TOKEN or CONTROL_CHAT_ID not set — commands disabled.")
            return
        try:
            self.bot_client = TelegramClient(StringSession(), API_ID, API_HASH)
            await self.bot_client.start(bot_token=BOT_TOKEN)
            self._register()
            log_event(f"[BOT CMD] Command interface active. Control chat: {CONTROL_CHAT_ID}")
            await self._send(f"🤖 {INSTANCE_NAME} Bot is ONLINE\n\nSend /help to see available commands.")
        except Exception as _e:
            log_event(f"[BOT CMD] Failed to start — commands disabled: {_e}")
            try:
                if self.bot_client:
                    await self.bot_client.disconnect()
            except Exception:
                pass
            self.bot_client = None

    def _register(self):

        @self.bot_client.on(events.NewMessage(pattern=r"^/help"))
        async def _(event):
            if not self._auth(event): return
            await self._send(
                f"📋 {INSTANCE_NAME} Commands\n\n"
                "/status  — Bot state, W/L/BE results, open trades\n"
                "/pause   — Stop accepting new signals\n"
                "/resume  — Re-enable signal processing\n"
                "/daily   — Today's full P&L breakdown by channel\n"
                "/weekly  — Last 7 days W/L/BE and P&L summary\n"
                "/monthly — Monthly DD %, high equity, pause status\n"
                "/stats   — Today's P&L, W/L/BE, balance, equity\n"
                "/trades  — All open positions with live P&L\n"
                "/help    — Show this message"
            )

        @self.bot_client.on(events.NewMessage(pattern=r"^/status"))
        async def _(event):
            if not self._auth(event): return
            await self._send(await asyncio.to_thread(self._build_status))

        @self.bot_client.on(events.NewMessage(pattern=r"^/pause"))
        async def _(event):
            if not self._auth(event): return
            def _do():
                state = load_state()
                state["manual_pause"] = True
                save_state(state)
            await asyncio.to_thread(_do)
            await self._send(
                "⏸ Trading PAUSED\n\n"
                "No new signals will be executed.\n"
                "Open trades are unaffected.\n\n"
                "Send /resume to re-enable."
            )
            log_event("[BOT CMD] Manual pause activated.")

        @self.bot_client.on(events.NewMessage(pattern=r"^/resume"))
        async def _(event):
            if not self._auth(event): return
            def _do():
                state = load_state()
                state["manual_pause"] = False
                save_state(state)
            await asyncio.to_thread(_do)
            await self._send("▶️ Trading RESUMED\n\nBot is now accepting signals again.")
            log_event("[BOT CMD] Manual pause cleared.")

        @self.bot_client.on(events.NewMessage(pattern=r"^/stats"))
        async def _(event):
            if not self._auth(event): return
            await self._send(await asyncio.to_thread(self._build_stats))

        @self.bot_client.on(events.NewMessage(pattern=r"^/trades"))
        async def _(event):
            if not self._auth(event): return
            await self._send(await asyncio.to_thread(self._build_trades))

        @self.bot_client.on(events.NewMessage(pattern=r"^/daily"))
        async def _(event):
            if not self._auth(event): return
            await self._send(await asyncio.to_thread(self._build_daily))

        @self.bot_client.on(events.NewMessage(pattern=r"^/weekly"))
        async def _(event):
            if not self._auth(event): return
            await self._send(await asyncio.to_thread(self._build_weekly))

        @self.bot_client.on(events.NewMessage(pattern=r"^/monthly"))
        async def _(event):
            if not self._auth(event): return
            await self._send(await asyncio.to_thread(self._build_monthly))

    # ----------------------------------------------------------
    def _auth(self, event) -> bool:
        chat_id   = str(event.chat_id)
        sender_id = str(getattr(event, "sender_id", ""))
        ok = (chat_id == CONTROL_CHAT_ID) or (sender_id == CONTROL_CHAT_ID)
        if not ok:
            log_event(f"[BOT CMD] Unauthorised: chat={chat_id} sender={sender_id}")
        return ok

    async def _send(self, text: str):
        # Use the Bot HTTP API directly for outgoing messages — avoids Telethon's
        # entity-resolution error on fresh StringSession bots that haven't yet
        # received an update from the control channel.
        # ssl_ctx disables cert verification — handles self-signed proxy certs on
        # some machines (e.g. corporate VPN). Safe for outbound-only Bot API calls.
        try:
            import urllib.request as _ur, urllib.parse as _up, ssl as _ssl
            _ctx = _ssl.create_default_context()
            _ctx.check_hostname = False
            _ctx.verify_mode = _ssl.CERT_NONE
            payload = _up.urlencode({
                "chat_id":    CONTROL_CHAT_ID,
                "text":       text,
                "parse_mode": "HTML",
            }).encode()
            url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
            req = _ur.Request(url, data=payload, method="POST")
            await asyncio.to_thread(lambda: _ur.urlopen(req, timeout=10, context=_ctx).read())
        except Exception as e:
            log_event(f"[BOT CMD] Send failed: {e}")

    # ----------------------------------------------------------
    def _build_status(self) -> str:
        try:
            mt5_connect_safe()
            acc   = mt5.account_info()
            state = load_state()

            manual_pause = state.get("manual_pause", False)
            dk = day_key()
            day_bucket = state.get("days", {}).get(dk, {})
            blocked = day_bucket.get("blocked_today", False)

            mk = month_key()
            month_bucket = state.get("months", {}).get(mk, {})
            dd_pct = compute_monthly_dd_pct(month_bucket, float(acc.equity)) if acc else 0.0
            monthly_paused = enforce_pause_logic(month_bucket, dd_pct) if acc else False

            if manual_pause:
                trading_status = "⏸ PAUSED (manual)"
            elif monthly_paused:
                trading_status = f"⏸ PAUSED (monthly DD {dd_pct:.2f}%)"
            elif blocked:
                trading_status = "🛑 BLOCKED (daily loss)"
            else:
                trading_status = "✅ ACTIVE"

            positions = mt5.positions_get() or []
            managed   = state.get("managed_positions", {})
            open_count = len(positions)
            managed_count = len(managed)

            dloss_pct = daily_loss_pct(day_bucket, float(acc.equity)) if acc else 0.0
            trades_today = day_bucket.get("trades", 0)

            balance = acc.balance if acc else 0.0
            equity  = acc.equity  if acc else 0.0

            # W/L/BE from today's channel stats
            today_str   = day_key_local()
            ch_stats    = state.get("channel_stats", {}).get(today_str, {})
            t_wins = t_losses = t_bep = t_be = 0
            for b in ch_stats.values():
                t_wins   += b.get("wins",      0)
                t_losses += b.get("losses",    0)
                t_bep    += b.get("be_plus",   0)
                t_be     += b.get("breakeven", 0)
            loss_cap = int(MAX_CONSECUTIVE_LOSSES) if MAX_CONSECUTIVE_LOSSES < 999 else "∞"

            return (
                "📡 Bot Status\n\n"
                f"Trading:  {trading_status}\n"
                f"Results:  ✅ {t_wins} W  |  ❌ {t_losses} L  |  🛡️ {t_bep} BE+  |  ➡️ {t_be} BE\n"
                f"Loss cap: {t_losses}/{loss_cap} daily\n"
                f"Open:     {open_count} position(s)\n\n"
                f"Daily loss:  {dloss_pct:.2f}% / {MAX_DAILY_LOSS_PCT:.2f}% limit\n"
                f"Monthly DD:  {dd_pct:.2f}% / {MONTHLY_MAX_DD_PCT:.2f}% limit\n\n"
                f"Balance: ${balance:,.2f}\n"
                f"Equity:  ${equity:,.2f}"
            )
        except Exception as e:
            return f"❌ Status error: {e}"
        finally:
            mt5_disconnect_safe()

    def _build_daily(self) -> str:
        """Full daily breakdown — per-channel W/L/BE/P&L for today."""
        try:
            mt5_connect_safe()
            acc   = mt5.account_info()
            state = load_state()

            today_str = day_key_local()
            ch_stats  = state.get("channel_stats", {}).get(today_str, {})

            total_wins = total_losses = total_bep = total_be = 0
            total_pnl  = 0.0

            ch_lines = []
            for ch_id, b in ch_stats.items():
                w = b.get("wins", 0); l = b.get("losses", 0); bep = b.get("be_plus", 0); be = b.get("breakeven", 0)
                total_wins   += w
                total_losses += l
                total_bep    += bep
                total_be     += be
                pnl = b.get("profit", 0.0)
                total_pnl    += pnl
                if w + l + bep + be == 0:
                    continue
                name = CHANNEL_NAME_MAP.get(str(ch_id), str(ch_id))
                pnl_s = f"{'+' if pnl >= 0 else ''}{pnl:.2f}"
                bep_s = f"  {bep}BE+" if bep > 0 else ""
                ch_lines.append(f"  📌 {name}\n     {w}W  {l}L{bep_s}  {be}BE  →  {pnl_s}")

            total_trades = total_wins + total_losses + total_bep + total_be
            win_rate = round(total_wins / total_trades * 100) if total_trades > 0 else 0
            pnl_emoji = "📈" if total_pnl >= 0 else "📉"
            pnl_sign  = "+" if total_pnl >= 0 else ""
            balance = acc.balance if acc else 0.0
            equity  = acc.equity  if acc else 0.0
            win_streak  = state.get("win_streak",  0)
            loss_streak = state.get("loss_streak", 0)
            if win_streak >= 2:
                streak = f"🔥 W{win_streak}"
            elif loss_streak >= 2:
                streak = f"❄️ L{loss_streak}"
            else:
                streak = "—"

            ch_section = "\n\n" + "\n".join(ch_lines) if ch_lines else "\n\n  No closed trades today yet."
            closed_label = f"{total_trades} closed" if total_trades else "no trades yet"

            return (
                f"📊 Daily Summary — {today_str}\n\n"
                f"Results:  ✅ {total_wins} W  |  ❌ {total_losses} L  |  🛡️ {total_bep} BE+  |  ➡️ {total_be} BE  ({closed_label})\n"
                f"Win rate: {win_rate}%  |  Streak: {streak}\n\n"
                f"P&L:     {pnl_emoji} {pnl_sign}{total_pnl:.2f}\n"
                f"Balance: ${balance:,.2f}\n"
                f"Equity:  ${equity:,.2f}"
                f"{ch_section}"
            )
        except Exception as e:
            return f"❌ Daily error: {e}"
        finally:
            mt5_disconnect_safe()

    def _build_weekly(self) -> str:
        """Aggregate last 7 calendar days from channel_stats."""
        try:
            mt5_connect_safe()
            acc   = mt5.account_info()
            state = load_state()

            all_ch_stats = state.get("channel_stats", {})
            today = date.today()
            week_days = [(today - timedelta(days=i)) for i in range(6, -1, -1)]  # Mon→today

            total_wins = total_losses = total_bep = total_be = 0
            total_pnl  = 0.0
            per_channel: dict = {}  # ch_id -> {w, l, bep, be, pnl}

            for d in week_days:
                dk = day_key_local(d)
                day_bucket = all_ch_stats.get(dk, {})
                for ch_id, b in day_bucket.items():
                    w   = b.get("wins",      0)
                    l   = b.get("losses",    0)
                    bep = b.get("be_plus",   0)
                    be  = b.get("breakeven", 0)
                    pnl = b.get("profit",    0.0)
                    total_wins   += w
                    total_losses += l
                    total_bep    += bep
                    total_be     += be
                    total_pnl    += pnl
                    agg = per_channel.setdefault(ch_id, {"w": 0, "l": 0, "bep": 0, "be": 0, "pnl": 0.0})
                    agg["w"]   += w
                    agg["l"]   += l
                    agg["bep"] += bep
                    agg["be"]  += be
                    agg["pnl"] += pnl

            total_trades = total_wins + total_losses + total_bep + total_be
            win_rate = round(total_wins / total_trades * 100) if total_trades > 0 else 0
            pnl_emoji = "📈" if total_pnl >= 0 else "📉"
            pnl_sign  = "+" if total_pnl >= 0 else ""
            balance = acc.balance if acc else 0.0
            equity  = acc.equity  if acc else 0.0

            date_range = f"{day_key_local(week_days[0])} → {day_key_local(today)}"

            ch_lines = []
            for ch_id, agg in per_channel.items():
                if agg["w"] + agg["l"] + agg["bep"] + agg["be"] == 0:
                    continue
                name = CHANNEL_NAME_MAP.get(str(ch_id), str(ch_id))
                p = agg["pnl"]
                bep_s = f"  {agg['bep']}BE+" if agg["bep"] > 0 else ""
                ch_lines.append(
                    f"  📌 {name}\n"
                    f"     {agg['w']}W  {agg['l']}L{bep_s}  {agg['be']}BE  →  {'+' if p >= 0 else ''}{p:.2f}"
                )

            ch_section = "\n\n" + "\n".join(ch_lines) if ch_lines else "\n\n  No trades in the last 7 days."
            closed_label = f"{total_trades} closed" if total_trades else "no trades"

            return (
                f"📅 Weekly Summary\n"
                f"{date_range}\n\n"
                f"Results:  ✅ {total_wins} W  |  ❌ {total_losses} L  |  🛡️ {total_bep} BE+  |  ➡️ {total_be} BE  ({closed_label})\n"
                f"Win rate: {win_rate}%\n\n"
                f"P&L:     {pnl_emoji} {pnl_sign}{total_pnl:.2f}\n"
                f"Balance: ${balance:,.2f}\n"
                f"Equity:  ${equity:,.2f}"
                f"{ch_section}"
            )
        except Exception as e:
            return f"❌ Weekly error: {e}"
        finally:
            mt5_disconnect_safe()

    def _build_stats(self) -> str:
        try:
            mt5_connect_safe()
            acc   = mt5.account_info()
            state = load_state()

            today_str = day_key_local()
            ch_stats  = state.get("channel_stats", {}).get(today_str, {})

            total_wins = total_losses = total_bep = total_be = 0
            total_pnl  = 0.0

            for ch_id, b in ch_stats.items():
                total_wins   += b.get("wins",      0)
                total_losses += b.get("losses",    0)
                total_bep    += b.get("be_plus",   0)
                total_be     += b.get("breakeven", 0)
                total_pnl    += b.get("profit",    0.0)

            total_trades = total_wins + total_losses + total_bep + total_be
            win_rate = round(total_wins / total_trades * 100) if total_trades > 0 else 0

            pnl_emoji = "📈" if total_pnl >= 0 else "📉"
            pnl_sign  = "+" if total_pnl >= 0 else ""

            balance = acc.balance if acc else 0.0
            equity  = acc.equity  if acc else 0.0

            # Streak from state
            win_streak  = state.get("win_streak",  0)
            loss_streak = state.get("loss_streak", 0)
            if win_streak >= 2:
                streak = "🔥 W{}".format(win_streak)
            elif loss_streak >= 2:
                streak = "❄️ L{}".format(loss_streak)
            else:
                streak = "—"

            closed_label = "{} closed".format(total_trades) if total_trades else "no trades yet"
            loss_cap = int(MAX_CONSECUTIVE_LOSSES) if MAX_CONSECUTIVE_LOSSES < 999 else "∞"

            # Per-channel breakdown (only channels with activity today)
            ch_lines = []
            for ch_id, b in ch_stats.items():
                if b.get("wins", 0) + b.get("losses", 0) + b.get("be_plus", 0) + b.get("breakeven", 0) == 0:
                    continue
                name = CHANNEL_NAME_MAP.get(str(ch_id), str(ch_id))
                ch_pnl = b.get("profit", 0.0)
                bep_s = f" {b.get('be_plus',0)}BE+" if b.get("be_plus", 0) > 0 else ""
                ch_lines.append(
                    f"  {name}: {b.get('wins',0)}W {b.get('losses',0)}L"
                    f"{bep_s} {b.get('breakeven',0)}BE  {'+' if ch_pnl >= 0 else ''}{ch_pnl:.2f}"
                )

            ch_section = "\n\n" + "\n".join(ch_lines) if ch_lines else ""

            return (
                "📊 Today's Stats\n\n"
                f"Results:  ✅ {total_wins} W  |  ❌ {total_losses} L  |  🛡️ {total_bep} BE+  |  ➡️ {total_be} BE  ({closed_label})\n"
                f"Win rate: {win_rate}%  |  Streak: {streak}\n"
                f"Loss cap: {total_losses}/{loss_cap}\n\n"
                f"P&L:     {pnl_emoji} {pnl_sign}{total_pnl:.2f}\n"
                f"Balance: ${balance:,.2f}\n"
                f"Equity:  ${equity:,.2f}"
                f"{ch_section}"
            )
        except Exception as e:
            return f"❌ Stats error: {e}"
        finally:
            mt5_disconnect_safe()

    def _build_trades(self) -> str:
        try:
            mt5_connect_safe()
            state     = load_state()
            positions = mt5.positions_get() or []
            managed   = state.get("managed_positions", {})

            if not positions:
                return "📭 No open positions right now."

            lines = [f"📂 Open Positions ({len(positions)})\n"]
            for pos in positions:
                tick = mt5.symbol_info_tick(pos.symbol)
                current = (tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask) if tick else 0.0
                pnl = pos.profit
                pnl_sign  = "+" if pnl >= 0 else ""
                pnl_emoji = "🟢" if pnl >= 0 else "🔴"
                side = "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL"
                is_managed = str(pos.ticket) in managed or pos.ticket in managed
                tag = "" if is_managed else " ⚠️ manual"

                lines.append(
                    f"{pnl_emoji} {pos.symbol} {side}{tag}\n"
                    f"   Entry: {pos.price_open:.5f}  Now: {current:.5f}\n"
                    f"   SL: {pos.sl:.5f}  TP: {pos.tp:.5f}\n"
                    f"   Lot: {pos.volume}  P&L: {pnl_sign}{pnl:.2f}\n"
                    f"   Ticket: #{pos.ticket}"
                )

            return "\n".join(lines)
        except Exception as e:
            return f"❌ Trades error: {e}"
        finally:
            mt5_disconnect_safe()

    def _build_monthly(self) -> str:
        try:
            mt5_connect_safe()
            acc   = mt5.account_info()
            state = load_state()

            mk = month_key()
            month_bucket = state.get("months", {}).get(mk, {})

            equity      = acc.equity  if acc else 0.0
            balance     = acc.balance if acc else 0.0
            high_equity = month_bucket.get("high_equity") or equity
            dd_pct      = compute_monthly_dd_pct(month_bucket, equity)
            paused_until= month_bucket.get("paused_until")
            min_risk    = month_bucket.get("min_risk_until_new_high", False)

            if paused_until and time.time() < paused_until:
                from datetime import datetime
                until_str = datetime.fromtimestamp(paused_until).strftime("%Y-%m-%d %H:%M UTC")
                pause_str = f"⏸ Paused until {until_str}"
            else:
                pause_str = "✅ Not paused"

            return (
                "\U0001f4c5 <b>Monthly Summary</b>\n\n"
                f"Month:      {mk}\n"
                f"DD:         {dd_pct:.2f}% / {MONTHLY_MAX_DD_PCT:.2f}% limit\n"
                f"High equity: ${high_equity:,.2f}\n"
                f"Current equity: ${equity:,.2f}\n"
                f"Balance:    ${balance:,.2f}\n"
                f"Pause status: {pause_str}\n"
                f"Min risk mode: {'✅ ON' if min_risk else '❌ OFF'}"
            )
        except Exception as e:
            return f"❌ Monthly error: {e}"
        finally:
            mt5_disconnect_safe()

    async def run(self):
        if self.bot_client:
            while True:
                try:
                    await self.bot_client.run_until_disconnected()
                    break  # clean disconnect — exit loop
                except asyncio.CancelledError:
                    break  # shutdown signal
                except Exception as e:
                    log_event(f"[BOT CMD] Disconnected ({e!r}) — reconnecting in 30s…")
                    await asyncio.sleep(30)
                    try:
                        if not self.bot_client.is_connected():
                            await self.bot_client.connect()
                        log_event("[BOT CMD] Reconnected.")
                    except Exception as re:
                        log_event(f"[BOT CMD] Reconnect failed: {re!r}")

    async def stop(self):
        if self.bot_client:
            try:
                await self._send(f"\U0001f534 {INSTANCE_NAME} Bot going OFFLINE.")
            except Exception:
                pass
            await self.bot_client.disconnect()



async def main_async():
    has_sources = bool(CHANNEL_IDS) or bool(CHANNEL_USERNAME)
    if LIVE_MODE and not has_sources:
        raise RuntimeError("LIVE_MODE=true but no CHANNEL_IDS/CHANNEL_USERNAME set. Refusing to run.")

    log_event("=" * 55)
    log_event("  CRYPTONITE 247 BOT")
    log_event(f"  Strategy : Multi-channel | XAUUSD | 24/7")
    log_event(f"  BE trigger: ${SCALP_LOCK_TRIGGER_USD} ({SCALP_LOCK_TRIGGER_R}R) lock ${SCALP_LOCK_AMOUNT_USD} ({SCALP_LOCK_AMOUNT_R}R)")
    log_event(f"  Trail gap : {TRAIL_DISTANCE_USD}pt ({int(TRAIL_DISTANCE_USD / 0.10):.0f} pips) behind price")
    log_event(f"  Caps: {MAX_OPEN_POSITIONS_PER_SYMBOL}/symbol  |  {MAX_OPEN_POSITIONS_TOTAL} total  |  lot: {FIXED_LOT}  |  sell: x{SELL_LOT_MULTIPLIER}")
    log_event("=" * 55)
    log_event("Bot starting...")
    log_event(f"DOTENV_FILE={DOTENV_FILE}  CWD={os.getcwd()}")
    log_event(f"Mode: ACCOUNT_MODE={ACCOUNT_MODE} LIVE_MODE={LIVE_MODE}")

    if CHANNEL_IDS:
        log_event(f"CHANNEL_IDS_RAW={CHANNEL_IDS_RAW}")
        log_event(f"Locked to CHANNEL_IDS={sorted(CHANNEL_IDS)}")
        log_event("Channels (IDs): " + ", ".join(sorted(CHANNEL_IDS)))
    elif CHANNEL_USERNAME:
        log_event(f"Locked to CHANNEL_USERNAME={CHANNEL_USERNAME}")

    log_event(f"ALLOW_ALL_SYMBOLS={ALLOW_ALL_SYMBOLS} SYMBOL_SUFFIX_FORCE={SYMBOL_SUFFIX_FORCE or '(none)'} prefer={SYMBOL_SUFFIX_PREFER}")
    log_event(f"ENTRY_MODE={ENTRY_MODE} MAX_PENDING_ORDERS_PER_SYMBOL={MAX_PENDING_ORDERS_PER_SYMBOL} PENDING_EXPIRE_MINUTES={PENDING_EXPIRE_MINUTES}")
    log_event(f"MARKET_FALLBACK_FOR_MARKET_SIGNALS={MARKET_FALLBACK_FOR_MARKET_SIGNALS} EXECUTION_MODE={EXECUTION_MODE} XAU_ENTRY_TOLERANCE={XAU_ENTRY_TOLERANCE}")
    log_event("Step13: execution safety active (exact-entry protection, stop-safety retry, pending fallback reroute)")
    log_event(f"REPLACE_PENDING_ON_NEW_SIGNAL={REPLACE_PENDING_ON_NEW_SIGNAL}")
    log_event(f"USE_FIXED_LOT={USE_FIXED_LOT} FIXED_LOT={FIXED_LOT}")
    log_event(f"APPLY_SL_MULTIPLIER={APPLY_SL_MULTIPLIER} SL_MULTIPLIER={SL_MULTIPLIER}")
    log_event(f"SIMPLE TP ladder: R1={SIMPLE_TP_R1} R2={SIMPLE_TP_R2} R3={SIMPLE_TP_R3}")

    log_event(f"SCALP_SOURCE_IDS={SCALP_SOURCE_IDS}")
    if SCALP_SOURCE_IDS:
        log_event("Scalp Channels (IDs): " + ", ".join(SCALP_SOURCE_IDS))

    if EARLY_SCALP_ENABLED:
        log_event(f"EARLY_SCALP: ENABLED={EARLY_SCALP_ENABLED} ONLY_DEMO={EARLY_SCALP_ONLY_DEMO} WINDOW={EARLY_SCALP_SYNC_WINDOW_SECONDS}s SYMBOLS={EARLY_SCALP_SYMBOLS} RISK_MULT={EARLY_SCALP_FORCE_RISK_MULT}")

    log_event(
        f"KillSwitch: MAX_DAILY_LOSS={MAX_DAILY_LOSS_PCT}% MAX_CONSEC_LOSSES={MAX_CONSECUTIVE_LOSSES} "
        f"DRAWDOWN_ALERT={DRAWDOWN_ALERT_PCT}% DAILY_PROFIT_TARGET={DAILY_PROFIT_TARGET_PCT}%"
    )
    log_event(f"TRADE CAPS: WINNING={MAX_TRADES_PER_DAY_WINNING} AFTER_LOSS={MAX_TRADES_PER_DAY_AFTER_LOSS} (0=unlimited)")
    log_event(f"Daily report: ENABLED={DAILY_REPORT_ENABLED} TIME={DAILY_REPORT_SEND_TIME} CHAT_ID={DAILY_REPORT_CHAT_ID or '(none)'}")
    log_event(f"Debug: ALL={DEBUG_ALL_MESSAGES} SRC_MISMATCH={DEBUG_SOURCE_MISMATCH} PARSE_FAIL={DEBUG_PARSE_FAIL}")
    log_event("Listening for signals...")

    log_event(f"Manager: BE_AT_TP1={BE_AT_TP1} BE_BUFFER_USD={BE_BUFFER_USD}")
    log_event(f"Manager: TRAIL_FROM_ENTRY={TRAIL_FROM_ENTRY} TRAIL_AFTER_TP1={TRAIL_AFTER_TP1} TRAIL_AFTER_TP2={TRAIL_AFTER_TP2} FORCE_TRAIL_ALL={FORCE_TRAIL_ALL}")
    log_event(f"Manager: PARTIAL_CLOSE_ENABLED={PARTIAL_CLOSE_ENABLED} PARTIAL_AT_TP1={PARTIAL_AT_TP1} PARTIAL_AT_TP2={PARTIAL_AT_TP2}")
    log_event(f"Manager: TRAIL_DISTANCE_USD={TRAIL_DISTANCE_USD} TRAIL_STEP_USD={TRAIL_STEP_USD}")
    log_event(f"Manager: SCALP_LOCK_ENABLED={SCALP_LOCK_ENABLED} TRIGGER={SCALP_LOCK_TRIGGER_USD} LOCK={SCALP_LOCK_AMOUNT_USD}")

    await client.start()
    asyncio.create_task(manager_loop())

    bot_cmd = BotCommandHandler()
    await bot_cmd.start()

    # Session-open runs INSIDE asyncio.gather as a third coroutine.
    # This is the only reliable way: Telethon's receive loop must be
    # active (i.e. run_until_disconnected must be running concurrently)
    # before client.send_message can complete without CancelledError.
    # A 1-second delay is enough for Telethon to fully authenticate.
    async def _session_open_on_start():
        try:
            await asyncio.sleep(1)
            sent = await send_session_open_247()
            if not sent:
                log_event('[STARTUP] Session open retry in 5s')
                await asyncio.sleep(5)
                await send_session_open_247()
            pass
        except Exception as _e:
            log_event(f'[STARTUP] Session open error: {_e}')

    async def _resilient_telethon():
        """Wraps client.run_until_disconnected() with auto-reconnect on network loss.
        Without this, a momentary outage kills ConnectionError → asyncio.gather → whole process."""
        while True:
            try:
                await client.run_until_disconnected()
                break  # intentional disconnect (shutdown) — exit loop
            except asyncio.CancelledError:
                break  # shutdown signal — exit cleanly
            except Exception as exc:
                log_event(f"[TELEGRAM] Main connection lost ({exc!r}) — reconnecting in 30s…")
                await asyncio.sleep(30)
                try:
                    await client.connect()
                    log_event("[TELEGRAM] Reconnected successfully.")
                except Exception as re:
                    log_event(f"[TELEGRAM] Reconnect attempt failed ({re!r}) — will retry")

    try:
        await asyncio.gather(
            _resilient_telethon(),
            bot_cmd.run(),
            _session_open_on_start(),
        )
    finally:
        if EXECUTION_CHAT_ID:
            try:
                _now_str = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
                await safe_send(int(EXECUTION_CHAT_ID),
                    f'\U0001f534 <b>Bot STOPPED</b>\n'
                    f'\U0001f4e1 {INSTANCE_NAME}\n'
                    f'⏰ {_now_str}')
            except Exception:
                pass
        await bot_cmd.stop()


def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        log_event("Shutdown requested (Ctrl+C).")


if __name__ == "__main__":
    main()