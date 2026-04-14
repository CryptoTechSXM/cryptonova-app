# bot_live_final_clean.py
# ExFusion MT5 Telegram Signal Bot (single file for DEMO + LIVE via DOTENV_FILE)

import os, re, time, math, json, asyncio, csv, traceback
from datetime import datetime, timezone, date, timedelta

from dotenv import load_dotenv
from telethon import TelegramClient, events
import MetaTrader5 as mt5


# ----------------- LOAD ENV -----------------
DOTENV_FILE = os.getenv("DOTENV_FILE", "cryptonite_bot.env")
load_dotenv(DOTENV_FILE, override=True)

if not os.getenv("API_ID"):
    raise SystemExit(f"API_ID missing. Loaded DOTENV_FILE={DOTENV_FILE}. Check the filename and that API_ID exists inside it.")


# ----------------- ENV (Telegram + MT5) -----------------
API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
SESSION_NAME = os.getenv("SESSION_NAME", "mt5_signal_bot")

MT5_LOGIN = int(os.getenv("MT5_LOGIN"))
MT5_PASSWORD = os.getenv("MT5_PASSWORD")
MT5_SERVER = os.getenv("MT5_SERVER")

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
COOLDOWN_SECONDS = int(os.getenv("COOLDOWN_SECONDS", "60"))
MAX_OPEN_POSITIONS_PER_SYMBOL = int(os.getenv("MAX_OPEN_POSITIONS_PER_SYMBOL", "1"))
MAX_PENDING_ORDERS_PER_SYMBOL = int(os.getenv("MAX_PENDING_ORDERS_PER_SYMBOL", "1"))
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

# Simple TP/SL model
SL_MODEL = os.getenv("SL_MODEL", "HYBRID").strip().upper()  # FIXED | ATR | HYBRID
ATR_TIMEFRAME = os.getenv("ATR_TIMEFRAME", "M5").strip().upper()
ATR_PERIOD = int(os.getenv("ATR_PERIOD", "14"))
ATR_MULTIPLIER = float(os.getenv("ATR_MULTIPLIER", "1.0"))

# Real TP ladder for SIMPLE trades
SIMPLE_TP_R1 = float(os.getenv("SIMPLE_TP_R1", "1.0"))
SIMPLE_TP_R2 = float(os.getenv("SIMPLE_TP_R2", "2.0"))
SIMPLE_TP_R3 = float(os.getenv("SIMPLE_TP_R3", "3.0"))

SIMPLE_SL_FIXED_DEFAULT = float(os.getenv("SIMPLE_SL_FIXED_DEFAULT", "10"))
SIMPLE_SL_FIXED_XAU = float(os.getenv("SIMPLE_SL_FIXED_XAU", str(SIMPLE_SL_FIXED_DEFAULT)))
SIMPLE_SL_FIXED_XAG = float(os.getenv("SIMPLE_SL_FIXED_XAG", str(SIMPLE_SL_FIXED_DEFAULT)))
SIMPLE_SL_FIXED_BTC = float(os.getenv("SIMPLE_SL_FIXED_BTC", "100"))
SIMPLE_SL_FIXED_CRYPTO_SMALL = float(os.getenv("SIMPLE_SL_FIXED_CRYPTO_SMALL", "0.004"))

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
EXECUTION_CHAT_ID = (os.getenv("EXECUTION_CHAT_ID") or "").strip()


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

FILLING_CACHE = {}
MT5_SYMBOLS_ALL = []
MT5_SYMBOLS_UPPER = set()
SYMBOL_RESOLVE_CACHE = {}

CRYPTO_SMALL_SET = {"XRP","ADA","DOGE","TRX","XLM","MATIC","LINK","DOT","UNI","LTC","SOL","AVAX","BNB","ETH"}

SYMBOL_ALIASES = {
    "XAUUSD": "XAU",
    "XAU": "XAU",
    "GOLD": "XAU",
    "XAGUSD": "XAG",
    "XAG": "XAG",
    "SILVER": "XAG",
    "BTCUSD": "BTC",
    "BTC": "BTC",
    "XRPUSD": "XRP",
    "XRP": "XRP",
    "US30": "US30",
    "DJI": "US30",
    "DOW": "US30",
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

    # Prune position_sources and position_templates for closed positions
    # Keep only tickets that still have open positions
    open_tickets = set()
    try:
        positions = mt5.positions_get()
        if positions:
            open_tickets = {str(p.ticket) for p in positions}
    except Exception:
        pass

    if open_tickets is not None:
        for key in ("position_templates", "position_sources", "managed_positions"):
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
    t = t.replace("venta", "sell")
    t = t.replace("compra", "buy")
    t = t.replace("límite", "limit").replace("limite", "limit")
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
    b = day_bucket.setdefault(channel_id, {
        "trades": 0, "wins": 0, "losses": 0, "breakeven": 0,
        "profit": 0.0, "sum_win": 0.0, "sum_loss": 0.0, "symbols": {},
    })

    b["trades"] += 1
    b["profit"] += float(profit)

    if profit > 0:
        b["wins"] += 1
        b["sum_win"] += float(profit)
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
    "-1003700973551": "CryptoNite Premium",
    "-1002717527369": "Free TAG Signals",
    "-1003628454081": "95% TAG Signals",
    "-1003660487270": "CryptoNite HA Premium",
    "-1003685899545": "CryptoNite QFS Premium",
}
CHANNEL_ACTIVITY = {}

def format_channel_report(state, day_str: str) -> str:
    stats = state.get("channel_stats", {}).get(day_str, {})

    lines = [f"📊 Daily Channel Report ({day_str})", ""]

    if stats:
        items = sorted(stats.items(), key=lambda kv: float(kv[1].get("profit", 0.0)), reverse=True)

        for cid, b in items:
            trades = int(b.get("trades", 0))
            wins = int(b.get("wins", 0))
            losses = int(b.get("losses", 0))
            be = int(b.get("breakeven", 0))
            prof = float(b.get("profit", 0.0))

            denom = (wins + losses)
            winrate = (wins / denom * 100.0) if denom > 0 else 0.0

            avg_win = (float(b.get("sum_win", 0.0)) / wins) if wins > 0 else 0.0
            avg_loss = (float(b.get("sum_loss", 0.0)) / losses) if losses > 0 else 0.0

            cname = CHANNEL_NAME_MAP.get(cid, "Unknown Channel")

            lines.append(f"• {cname}")
            lines.append(
                f"P/L={prof:+.2f} | trades={trades} | "
                f"W/L/BE={wins}/{losses}/{be} | "
                f"WR={winrate:.1f}% | avgW={avg_win:+.2f} | avgL={avg_loss:+.2f}"
            )
            lines.append("")
    else:
        lines.append("No closed trades recorded.")
        lines.append("")

    lines.append("Channel Legend")

    for cid, name in CHANNEL_NAME_MAP.items():
        lines.append(cid)
        lines.append(name)
        lines.append("")

    lines.append("📡 Channel Activity")

    for cid, data in CHANNEL_ACTIVITY.items():
        cname = CHANNEL_NAME_MAP.get(cid, "Unknown Channel")

        lines.append(cname)
        lines.append(
            f"messages={data['messages']} | "
            f"signals={data['signals']} | "
            f"ignored={data['ignored']} | "
            f"parse_fail={data['parse_fail']}"
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
        return SYMBOL_MAP[raw_base]

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
    "-1002717527369": ["analyzer_engine", "structured_entry", "simple", "reverse_simple", "gold_range_full", "gold_range_simple", "generic_pending_sltp", "hashtag", "sig", "pending", "simple_pending", "signal_alert"],
    "-1003523601209": ["analyzer_engine", "structured_entry", "simple_pending", "simple", "reverse_simple", "gold_range_full", "gold_range_simple", "generic_pending_sltp", "hashtag", "sig", "pending", "signal_alert"],
    "-1002623109215": ["analyzer_engine", "structured_entry", "sig", "hashtag", "generic_pending_sltp", "simple", "reverse_simple", "pending", "simple_pending", "signal_alert", "gold_range_full", "gold_range_simple"],
    "-1003628454081": ["analyzer_engine", "structured_entry", "gold_range_full", "gold_range_simple", "simple", "reverse_simple", "simple_pending", "generic_pending_sltp", "hashtag", "sig", "pending", "signal_alert"],
    "default": ["analyzer_engine", "structured_entry", "sig", "simple_pending", "generic_pending_sltp", "gold_range_full", "gold_range_simple", "hashtag", "reverse_simple", "signal_alert", "simple", "pending"],
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
        if name == "analyzer_engine":
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
def mt5_connect(retries: int = 3):
    last_err = None
    for i in range(retries):
        if mt5.initialize(timeout=10000):
            if mt5.login(MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
                mt5_refresh_symbol_cache()
                return
            last_err = mt5.last_error()
        else:
            last_err = mt5.last_error()
        time.sleep(1.0 + i)
    raise RuntimeError(f"MT5 connect failed after retries: {last_err}")

def mt5_disconnect():
    mt5.shutdown()

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

    if any(k in s for k in ("US30", "NAS", "NQ", "SPX", "GER", "UK", "DJ", "DAX")):
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

    lots = risk_amount / (stop_dist * value_per_price_unit)
    lots = cap_max_lot(symbol, lots, raw_hint)

    lots = max(info.volume_min, min(lots, info.volume_max))
    lots = floor_to_step(lots, info.volume_step)
    lots = max(info.volume_min, lots)

    return round(lots, 2)

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
    if dd_pct >= MONTHLY_MAX_DD_PCT:
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
    if sig["kind"] in ("SIMPLE", "SIMPLE_PENDING", "SCALP_MARKET", "EARLY_SCALP"):
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

    dloss = daily_loss_pct(day_bucket, float(acc.equity))
    if dloss >= MAX_DAILY_LOSS_PCT:
        day_bucket["blocked_today"] = True
        log_event(f"🛑 Daily loss stop hit: {dloss:.2f}% >= {MAX_DAILY_LOSS_PCT:.2f}%.")
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
                    "ts": sig["ts"],
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

    # SINGLE order placement
    if USE_FIXED_LOT:
        lots = fixed_lot_size(symbol, raw_symbol)
    else:
        lots_risk = lot_from_risk(symbol, float(entry), float(sl), risk_frac, raw_symbol)
        lots = downscale_lots_to_margin(symbol, order_type, lots_risk, float(entry), raw_symbol)

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
            "ts": sig["ts"],
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
            pos_ticket = find_recent_position_ticket(symbol, float(lots))
            if pos_ticket:
                state["position_templates"][str(pos_ticket)] = dict(tpl)
                src = str(sig.get("source", "") or "")
                if src:
                    state["position_sources"][str(pos_ticket)] = src
                log_event(f"🧾 Stored position template: ticket={pos_ticket} symbol={symbol} src={src}")

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
                        log_event(f"💰 Scalp lock: ticket={p.ticket} trigger={label} new_sl={lock_sl}")
                        cur_sl = lock_sl

                if REMOVE_TP_ON_TRAIL and not meta.get("tp_removed", False):
                    res = modify_sl_tp(int(p.ticket), getattr(p, "symbol", symbol), cur_sl, 0.0)
                    if getattr(res, 'retcode', None) in (mt5.TRADE_RETCODE_DONE, 10009):
                        log_event(f"🎯 TP removed: ticket={p.ticket} retcode={getattr(res,'retcode',None)}")
                        meta["tp_removed"] = True

        if meta.get("trail_on", False):
            orig_sl = float(meta.get("orig_sl", 0.0) or 0.0)
            sl_dist = abs(entry - orig_sl) if orig_sl > 0 else 0.0

            if sl_dist > 0:
                # R-based trail: SL follows price at TRAIL_DISTANCE_R × sl_dist behind
                trail_dist = TRAIL_DISTANCE_R * sl_dist
                step_dist  = TRAIL_STEP_R * sl_dist
            else:
                # USD fallback
                trail_dist = TRAIL_DISTANCE_USD
                step_dist  = TRAIL_STEP_USD

            desired_sl = (current_price - trail_dist) if pos_type == 0 else (current_price + trail_dist)
            desired_sl = round_price(symbol, desired_sl)

            last_attempt = float(meta.get("last_trail_sl", 0.0) or 0.0)
            should_send  = False
            if pos_type == 0:
                should_send = desired_sl > cur_sl + step_dist and desired_sl < current_price - eps
            else:
                should_send = (cur_sl == 0.0 or desired_sl < cur_sl - step_dist) and desired_sl > current_price + eps

            if should_send and abs(desired_sl - last_attempt) > eps:
                res = modify_sl_tp(int(p.ticket), getattr(p, "symbol", symbol), desired_sl, float(p.tp) if p.tp else 0.0)
                rc  = getattr(res, 'retcode', None)
                meta["last_trail_sl"] = desired_sl
                if rc in (mt5.TRADE_RETCODE_DONE, 10009):
                    label = f"{sl_dist:.5f} sl_dist" if sl_dist > 0 else "USD"
                    log_event(f"🏃 Trail: ticket={p.ticket} new_sl={desired_sl} basis={label} retcode={rc}")


# ----------------- CSV -----------------
def ensure_csv_header():
    if os.path.exists(TRADES_CSV):
        return
    with open(TRADES_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["time_utc","symbol","side","volume","profit","commission","swap","position_id","deal_id","channel_id"])

def append_trade_csv(row: dict):
    ensure_csv_header()
    with open(TRADES_CSV, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            row.get("time_utc"), row.get("symbol"), row.get("side"), row.get("volume"),
            row.get("profit"), row.get("commission"), row.get("swap"),
            row.get("position_id"), row.get("deal_id"), row.get("channel_id"),
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

        log_event(f"🏁 CLOSED | {symbol} | {side} | vol={volume:.2f} | P/L={profit:+.2f} | pos={pos_id} | deal={deal_id} | src={channel_id}")

        # Queue close notification for async send in manager_loop
        if EXECUTION_CHAT_ID and notifications is not None:
            outcome = "WIN" if profit > 0 else ("LOSS" if profit < 0 else "BE")
            icon    = "✅" if profit > 0 else ("❌" if profit < 0 else "➖")
            src_name = CHANNEL_NAME_MAP.get(channel_id, channel_id)
            notifications.append(
                f"{icon} <b>Trade Closed — {outcome}</b>\n"
                f"📈 {symbol} | {side}\n"
                f"💰 P/L: <b>{profit:+.2f}</b>\n"
                f"📡 Source: {src_name}"
            )

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
    |(?:\bI[’']?M\s+SEEING\s+(?:BUYS|SELLS)\b)
    |(?:\bDID\s+YOU\s+GUYS\s+SEE\b)
    |(?:\bWHAT\s+AN\s+AMAZING\s+WEEK\b)
    |(?:\bREACT\s+HERE\b)
    |(?:\bGOOD\s+LUCK\b)
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


def classify_source_message(text: str):
    t = clean_signal_text(text)
    if not t:
        return "UNKNOWN", "empty_text"

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
last_trade_ts = 0.0

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
    global last_trade_ts

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
        if DEBUG_INTAKE_FILTER:
            preview = clean_signal_text(text)[:180].replace("\n", " | ")
            log_event(f"🚫 FILTER SPAM src={chat_id} reason={class_reason} text={preview}")
        return

    if classification == "UNKNOWN":
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

    if COOLDOWN_SECONDS > 0 and (now - last_trade_ts) < COOLDOWN_SECONDS:
        log_event("Cooldown: skipping")
        return

    try:

        async with MT5_ASYNC_LOCK:
            res = await asyncio.to_thread(process_signal_sync, sig)

        if (
            res is not None
            and getattr(res, "retcode", None)
            in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, 10009)
        ):
            last_trade_ts = time.time()
            if EXECUTION_CHAT_ID:
                side   = (sig.get("side") or "").upper()
                icon   = "🟢" if side == "BUY" else "🔴"
                sym    = sig.get("raw_symbol", "?")
                ticket = getattr(res, "order", 0)
                sl     = sig.get("sl", 0)
                tps    = sig.get("tps", [])
                tp1    = tps[0] if len(tps) > 0 else 0
                tp2    = tps[1] if len(tps) > 1 else 0
                tp3    = tps[2] if len(tps) > 2 else 0
                src    = CHANNEL_NAME_MAP.get(str(chat_id), str(chat_id))
                notify = (
                    f"✅ <b>Trade Executed</b>\n"
                    f"{icon} <b>{side}</b> {sym}\n"
                    f"━━━━━━━━━━━━━━━━━━━━\n"
                    f"🎫 Ticket: {ticket}\n"
                    f"🛑 SL:  {sl}\n"
                    f"🎯 TP1: {tp1}\n"
                    f"🎯 TP2: {tp2}\n"
                    f"🎯 TP3: {tp3}\n"
                    f"━━━━━━━━━━━━━━━━━━━━\n"
                    f"📡 Source: {src}"
                )
                await safe_send(int(EXECUTION_CHAT_ID), notify)

        if res is not None:
            log_event(
                f"MT5 result retcode={res.retcode} "
                f"comment={getattr(res,'comment',None)}"
            )

    except Exception:
        log_event("Exception:\n" + traceback.format_exc())

def process_signal_sync(sig):
    state = load_state()
    try:
        mt5_connect_safe()
        enforce_account_lock()
        res = place_trade(sig, state)
        save_state(state)
        return res
    finally:
        mt5_disconnect_safe()

def process_manager_sync():
    state = load_state()
    notifications = []
    try:
        mt5_connect_safe()
        enforce_account_lock()
        expire_pending_orders(state)
        manage_positions_once(state)
        log_new_closed_deals(state, notifications)
        save_state(state)
    finally:
        mt5_disconnect_safe()
    return notifications

async def safe_send(chat_id: int, message: str):
    try:
        if not client.is_connected():
            await client.connect()
        await client.send_message(chat_id, message)
        return True
    except Exception:
        log_event("Telegram send failed:\n" + traceback.format_exc())
        return False

async def manager_loop():
    last_report_day = None
    rep_hh, rep_mm = parse_hhmm(DAILY_REPORT_SEND_TIME)

    while True:
        try:
            async with MT5_ASYNC_LOCK:
                notifications = await asyncio.to_thread(process_manager_sync)
            if EXECUTION_CHAT_ID and notifications:
                for msg in notifications:
                    await safe_send(int(EXECUTION_CHAT_ID), msg)
        except Exception:
            log_event("Manager exception:\n" + traceback.format_exc())

        if DAILY_REPORT_ENABLED:
            now = datetime.now()
            today = now.date()
            if now.hour > rep_hh or (now.hour == rep_hh and now.minute >= rep_mm):
                if last_report_day != today:
                    report_day = (today - timedelta(days=1)).isoformat()
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

        await asyncio.sleep(MANAGER_INTERVAL_SECONDS)

async def main_async():
    has_sources = bool(CHANNEL_IDS) or bool(CHANNEL_USERNAME)
    if LIVE_MODE and not has_sources:
        raise RuntimeError("LIVE_MODE=true but no CHANNEL_IDS/CHANNEL_USERNAME set. Refusing to run.")

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
        f"MULTI_PENDING: ENABLED={MULTI_PENDING_ENABLED} ONLY_DEMO={MULTI_PENDING_ONLY_DEMO} "
        f"SOURCES={sorted(MULTI_PENDING_SOURCE_IDS) if MULTI_PENDING_SOURCE_IDS else '(none)'} "
        f"FRACTIONS={MULTI_PENDING_FRACTIONS}"
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
    await client.run_until_disconnected()

def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        log_event("Shutdown requested (Ctrl+C).")

if __name__ == "__main__":
    main()

# ----------------- STEP 4 PARSER OVERRIDES -----------------
def _pip_size_for_symbol(raw_symbol: str) -> float:
    sym = normalize_raw_symbol(raw_symbol)
    if sym in ("XAU", "XAUUSD", "GOLD"):
        return 0.1
    if sym in ("XAG", "XAGUSD", "SILVER"):
        return 0.01
    if sym in ("BTC", "BTCUSD"):
        return 1.0
    if sym.endswith("JPY"):
        return 0.01
    if looks_like_fx(sym):
        return 0.0001
    return 0.1


def _extract_numeric_tp_values(raw_symbol: str, text: str):
    vals = re.findall(r"\bTP\d*\b\s*[:;=@-]?\s*(\d+(?:\.\d+)?)", text, flags=re.IGNORECASE)
    out = []
    for v in vals[:4]:
        try:
            out.append(float(normalize_price_str(raw_symbol, v)))
        except Exception:
            pass
    return out


def _extract_pip_tp_values(raw_symbol: str, side: str, zone_low: float, zone_high: float, text: str):
    m = re.search(r"\bTP\b\s*[:;=@-]?\s*(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?(?:\s+(\d+(?:\.\d+)?))?\s*PIPS?", text, flags=re.IGNORECASE)
    if not m:
        return []
    pip_values = [x for x in m.groups() if x]
    if not pip_values:
        return []
    pip_size = _pip_size_for_symbol(raw_symbol)
    anchor = zone_high if side.upper() == 'BUY' else zone_low
    out = []
    for pv in pip_values[:3]:
        dist = float(pv) * pip_size
        tp = anchor + dist if side.upper() == 'BUY' else anchor - dist
        out.append(float(tp))
    return out


def _find_symbol_side_anywhere(text: str):
    patterns = [
        r"#?(?P<symbol>GOLD|XAU(?:USD)?|[A-Z0-9/._-]{3,15})\s+(?P<side>BUY|SELL)\b",
        r"(?P<side>BUY|SELL)\s+(?P<symbol>GOLD|XAU(?:USD)?|[A-Z0-9/._-]{3,15})\b",
    ]
    for p in patterns:
        m = re.search(p, text, flags=re.IGNORECASE)
        if m:
            raw_symbol = normalize_raw_symbol((m.group('symbol') or '').upper())
            side = (m.group('side') or '').upper()
            if raw_symbol and side:
                return raw_symbol, side
    return None, None


def _find_entry_range(raw_symbol: str, text: str):
    patterns = [
        r"\bENTRY\b\s*[:;=@-]?\s*(\d+(?:\.\d+)?)(?:\s*[-]\s*(\d+(?:\.\d+)?))?",
        r"@\s*(\d+(?:\.\d+)?)(?:\s*[-]\s*(\d+(?:\.\d+)?))?",
        r"\b(?:BUY|SELL)\b[^\n]*?\b(?:GOLD|XAU(?:USD)?)\b[^\n@]*?(\d+(?:\.\d+)?)\s*[-]\s*(\d+(?:\.\d+)?)",
        r"\b(?:GOLD|XAU(?:USD)?)\b[^\n]*?\b(?:BUY|SELL)\b[^\n@]*?(\d+(?:\.\d+)?)\s*[-]\s*(\d+(?:\.\d+)?)",
    ]
    for p in patterns:
        m = re.search(p, text, flags=re.IGNORECASE | re.DOTALL)
        if m:
            a = m.group(1)
            b = m.group(2) if m.lastindex and m.lastindex >= 2 and m.group(2) else a
            try:
                z1 = float(normalize_price_str(raw_symbol, a))
                z2 = float(normalize_price_str(raw_symbol, b))
                return min(z1, z2), max(z1, z2)
            except Exception:
                pass
    return None, None


def _find_sl_value(raw_symbol: str, text: str):
    m = re.search(r"\bSL\b\s*[:;=@-]?\s*(\d+(?:\.\d+)?)", text, flags=re.IGNORECASE)
    if not m:
        return None
    try:
        return float(normalize_price_str(raw_symbol, m.group(1)))
    except Exception:
        return None


def parse_gold_range_full_signal(t: str, upper: str):
    raw_symbol, side = _find_symbol_side_anywhere(t)
    if raw_symbol not in ('XAU', 'XAUUSD', 'GOLD') or not side:
        return None
    zone_low, zone_high = _find_entry_range(raw_symbol, t)
    sl = _find_sl_value(raw_symbol, t)
    if zone_low is None or sl is None:
        return None
    tps = _extract_numeric_tp_values(raw_symbol, t)
    if len(tps) < 2:
        return None
    while len(tps) < 3:
        tps.append(tps[-1])
    return _mk_sig('FULL', raw_symbol, side, zone_low, zone_high, tps[:3], sl, t, high_risk=(('HIGH RISK' in upper) or ('HIGHRISK' in upper)))


def parse_gold_range_simple_signal(t: str, upper: str):
    raw_symbol, side = _find_symbol_side_anywhere(t)
    if raw_symbol not in ('XAU', 'XAUUSD', 'GOLD') or not side:
        return None
    zone_low, zone_high = _find_entry_range(raw_symbol, t)
    sl = _find_sl_value(raw_symbol, t)
    if zone_low is None or sl is None:
        return None
    # If there are numeric TP labels, let the FULL parser own it.
    if len(_extract_numeric_tp_values(raw_symbol, t)) >= 2:
        return None
    return _mk_sig('SIMPLE', raw_symbol, side, zone_low, zone_high, [0.0, 0.0, 0.0], sl, t, high_risk=(('HIGH RISK' in upper) or ('HIGHRISK' in upper)))


def parse_structured_entry_signal(t: str, upper: str):
    raw_symbol, side = _find_symbol_side_anywhere(t)
    if not raw_symbol or not side:
        return None
    zone_low, zone_high = _find_entry_range(raw_symbol, t)
    sl = _find_sl_value(raw_symbol, t)
    if zone_low is None or sl is None:
        return None

    # Pending-style structured signal
    ptype_match = re.search(r"\b(LIMIT|STOP)\b", t, flags=re.IGNORECASE)
    tps = _extract_numeric_tp_values(raw_symbol, t)
    if ptype_match:
        ptype = ptype_match.group(1).upper()
        if tps:
            while len(tps) < 3:
                tps.append(tps[-1])
        else:
            tps = [0.0, 0.0, 0.0]
        return _mk_sig('PENDING', raw_symbol, side, zone_low, zone_high, tps[:3], sl, t, pending_type=ptype, high_risk=(('HIGH RISK' in upper) or ('HIGHRISK' in upper)))

    if tps:
        while len(tps) < 3:
            tps.append(tps[-1])
        return _mk_sig('FULL', raw_symbol, side, zone_low, zone_high, tps[:3], sl, t, high_risk=(('HIGH RISK' in upper) or ('HIGHRISK' in upper)))

    # TP in pips shorthand: parse it as SIMPLE so the engine can compute its own TP ladder.
    if re.search(r"\bTP\b\s*[:;=@-]?\s*\d+(?:\.\d+)?(?:\s+\d+(?:\.\d+)?)*\s*PIPS?", t, flags=re.IGNORECASE):
        return _mk_sig('SIMPLE', raw_symbol, side, zone_low, zone_high, [0.0, 0.0, 0.0], sl, t, high_risk=(('HIGH RISK' in upper) or ('HIGHRISK' in upper)))

    return None


def parse_generic_pending_sltp_signal(t: str, upper: str):
    t2 = clean_signal_text(t).replace("|", " | ")
    m = re.search(
        r"\b(?P<symbol>GOLD|XAU(?:USD)?|[A-Z0-9/._-]+)\b\s+"
        r"(?P<side>BUY|SELL)\s+"
        r"(?P<ptype>LIMIT|STOP)\b"
        r"(?:\s+AT|\s+@|\s+ENTRY\s*[:;=@-]?|\s+)?\s*"
        r"(?P<entry>\d+(?:\.\d+)?)"
        r".*?\bSL\b\s*[:;=@-]?\s*(?P<sl>\d+(?:\.\d+)?)"
        r"(?P<tail>.*)$",
        t2,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return None
    raw_symbol = normalize_raw_symbol(m.group('symbol').upper())
    side = m.group('side').upper()
    ptype = m.group('ptype').upper()
    entry = float(normalize_price_str(raw_symbol, m.group('entry')))
    sl = float(normalize_price_str(raw_symbol, m.group('sl')))
    tail = m.group('tail') or ''
    tps = _extract_numeric_tp_values(raw_symbol, tail)
    if not tps:
        for tp_m in re.finditer(r"\bTP\d*\b\s*[:;=@-]?\s*(\d+(?:\.\d+)?)", tail, flags=re.IGNORECASE):
            try:
                tps.append(float(normalize_price_str(raw_symbol, tp_m.group(1))))
            except Exception:
                pass
    if not tps:
        tps = _extract_pip_tp_values(raw_symbol, side, entry, entry, tail)
    if not tps:
        tps = [0.0, 0.0, 0.0]
    while len(tps) < 3:
        tps.append(tps[-1])
    return _mk_sig('PENDING', raw_symbol, side, entry, entry, tps[:3], sl, t, pending_type=ptype, high_risk=(('HIGH RISK' in upper) or ('HIGHRISK' in upper)))
