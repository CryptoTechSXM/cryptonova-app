# ============================================================
# CNMS — CryptoNite MACD Signals
# main.py — Single-file async MT5 bot
#
# Strategy : MACD(12,26,9) on M15 | H1 trend filter
# Entry    : Bar-close crossover (BUY/SELL on MACD ✕ Signal)
# Exit     : Layer 1 Scalp lock → Layer 2 ATR trail → Layer 3 MACD unwind
# ============================================================

import os, math, json, asyncio, csv, traceback, time, signal, urllib.request, urllib.parse
from datetime import datetime, timezone, date, timedelta

from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession
import MetaTrader5 as mt5


# ── ENV LOADING ──────────────────────────────────────────────────────────────
DOTENV_FILE = os.getenv("DOTENV_FILE", "cryptonite_bot.env")
load_dotenv(DOTENV_FILE, override=True)

if not os.getenv("API_ID"):
    raise SystemExit(f"API_ID missing — check DOTENV_FILE={DOTENV_FILE}")


# ── IDENTITY ─────────────────────────────────────────────────────────────────
INSTANCE_NAME = os.getenv("INSTANCE_NAME", "CNMS").strip()
API_ID        = int(os.getenv("API_ID"))
API_HASH      = os.getenv("API_HASH", "")
SESSION_NAME  = os.getenv("SESSION_NAME", "mt5_cnms_bot").strip()
LIVE_MODE     = os.getenv("LIVE_MODE", "false").lower() == "true"
ACCOUNT_MODE  = os.getenv("ACCOUNT_MODE", "DEMO").upper()


# ── MT5 CONNECTION ────────────────────────────────────────────────────────────
MT5_LOGIN             = int(os.getenv("MT5_LOGIN") or 0)
MT5_PASSWORD          = os.getenv("MT5_PASSWORD") or ""
MT5_SERVER            = os.getenv("MT5_SERVER") or ""
ALLOWED_ACCOUNT_LOGIN = os.getenv("ALLOWED_ACCOUNT_LOGIN", "").strip()


# ── SYMBOLS ───────────────────────────────────────────────────────────────────
_syms_raw            = os.getenv("SYMBOLS", "XAUUSD")
SYMBOLS              = [s.strip().upper() for s in _syms_raw.split(",") if s.strip()]
SYMBOL_XAU           = os.getenv("SYMBOL_XAU", "XAUUSD.s").strip()
SYMBOL_SUFFIX_FORCE  = os.getenv("SYMBOL_SUFFIX_FORCE", "").strip()
SYMBOL_SUFFIX_PREFER = [x.strip() for x in os.getenv("SYMBOL_SUFFIX_PREFER", ".s,.pro,.f").split(",") if x.strip()]


# ── MACD CONFIG ───────────────────────────────────────────────────────────────
MACD_FAST              = int(os.getenv("MACD_FAST", "12"))
MACD_SLOW              = int(os.getenv("MACD_SLOW", "26"))
MACD_SIGNAL_PERIOD     = int(os.getenv("MACD_SIGNAL_PERIOD", "9"))
MACD_TIMEFRAME         = os.getenv("MACD_TIMEFRAME", "M15").upper()
H1_FILTER_ENABLED      = os.getenv("H1_FILTER_ENABLED", "true").lower() == "true"
ZERO_LINE_FILTER_ENABLED = os.getenv("ZERO_LINE_FILTER_ENABLED", "false").lower() == "true"


# ── SL / ATR ──────────────────────────────────────────────────────────────────
SL_MODEL              = os.getenv("SL_MODEL", "HYBRID").upper()
ATR_TIMEFRAME         = os.getenv("ATR_TIMEFRAME", "M15").upper()
ATR_PERIOD            = int(os.getenv("ATR_PERIOD", "14"))
ATR_MULTIPLIER        = float(os.getenv("ATR_MULTIPLIER", "1.5"))
SIMPLE_SL_FIXED_XAU   = float(os.getenv("SIMPLE_SL_FIXED_XAU", "3.0"))
SIMPLE_SL_FIXED_INDEX = float(os.getenv("SIMPLE_SL_FIXED_INDEX", "3.0"))
SIMPLE_SL_FIXED_BTC   = float(os.getenv("SIMPLE_SL_FIXED_BTC", "50.0"))
SIMPLE_SL_FIXED_FX    = float(os.getenv("SIMPLE_SL_FIXED_FX", "0.001"))
SIMPLE_SL_FIXED_DEFAULT = float(os.getenv("SIMPLE_SL_FIXED_DEFAULT", "5.0"))

# Wide safety TP at broker side — actual exit handled by the 3-layer manager
SAFETY_TP_R = float(os.getenv("SAFETY_TP_R", "5.0"))


# ── RISK / LOT ────────────────────────────────────────────────────────────────
RISK_BASE          = float(os.getenv("RISK_BASE", "0.005"))   # 0.5% of balance
RISK_DD1           = float(os.getenv("RISK_DD1", "0.003"))
RISK_DD2           = float(os.getenv("RISK_DD2", "0.002"))
RISK_DD3           = float(os.getenv("RISK_DD3", "0.001"))
DD1_PCT            = float(os.getenv("DD1_PCT", "2.0"))
DD2_PCT            = float(os.getenv("DD2_PCT", "4.0"))
DD3_PCT            = float(os.getenv("DD3_PCT", "6.0"))
USE_FIXED_LOT      = os.getenv("USE_FIXED_LOT", "false").lower() == "true"
FIXED_LOT          = float(os.getenv("FIXED_LOT", "0.01"))
MAX_LOT_DEFAULT    = float(os.getenv("MAX_LOT_DEFAULT", "0.10"))
MAX_LOT_XAU        = float(os.getenv("MAX_LOT_XAU", str(MAX_LOT_DEFAULT)))
SELL_LOT_MULTIPLIER = float(os.getenv("SELL_LOT_MULTIPLIER", "1.0"))


# ── POSITION LIMITS ───────────────────────────────────────────────────────────
MAX_OPEN_POSITIONS_PER_SYMBOL = int(os.getenv("MAX_OPEN_POSITIONS_PER_SYMBOL", "1"))
MAX_OPEN_POSITIONS_TOTAL      = int(os.getenv("MAX_OPEN_POSITIONS_TOTAL", "3"))
COOLDOWN_SECONDS              = int(os.getenv("COOLDOWN_SECONDS", "0"))


# ── SPREAD LIMITS ─────────────────────────────────────────────────────────────
MAX_SPREAD_PRICE_XAU     = float(os.getenv("MAX_SPREAD_PRICE_XAU", "2.5"))
MAX_SPREAD_PRICE_INDEX   = float(os.getenv("MAX_SPREAD_PRICE_INDEX", "30"))
MAX_SPREAD_PRICE_DEFAULT = float(os.getenv("MAX_SPREAD_PRICE_DEFAULT", "5"))
SPREAD_RECHECK_ENABLED   = os.getenv("SPREAD_RECHECK_ENABLED", "true").lower() == "true"
SPREAD_RECHECK_SECONDS   = int(os.getenv("SPREAD_RECHECK_SECONDS", "2"))


# ── EXIT LAYERS ───────────────────────────────────────────────────────────────
MANAGER_INTERVAL_SECONDS = int(os.getenv("MANAGER_INTERVAL_SECONDS", "5"))

# Layer 1 — Scalp lock
SCALP_LOCK_ENABLED     = os.getenv("SCALP_LOCK_ENABLED", "true").lower() == "true"
SCALP_LOCK_TRIGGER_R   = float(os.getenv("SCALP_LOCK_TRIGGER_R", "0.40"))   # fire at 0.4× SL distance
SCALP_LOCK_AMOUNT_R    = float(os.getenv("SCALP_LOCK_AMOUNT_R", "0.20"))    # lock 0.2× SL distance of profit

# Layer 2 — ATR trail
ATR_TRAIL_ENABLED  = os.getenv("ATR_TRAIL_ENABLED", "true").lower() == "true"
ATR_TRAIL_DIST_PCT = float(os.getenv("ATR_TRAIL_DIST_PCT", "0.80"))   # trail = 0.8× ATR(14)
MIN_TRAIL_PRICE    = float(os.getenv("MIN_TRAIL_PRICE", "1.5"))        # price-unit floor for trail dist

# Layer 3 — MACD unwind
MACD_UNWIND_ENABLED = os.getenv("MACD_UNWIND_ENABLED", "true").lower() == "true"


# ── DAILY LIMITS ──────────────────────────────────────────────────────────────
MAX_DAILY_LOSS_PCT     = float(os.getenv("MAX_DAILY_LOSS_PCT", "5.0"))
MAX_CONSECUTIVE_LOSSES = int(os.getenv("MAX_CONSECUTIVE_LOSSES", "5"))
MAX_TRADES_PER_DAY     = int(os.getenv("MAX_TRADES_PER_DAY", "10"))
MONTHLY_MAX_DD_PCT     = float(os.getenv("MONTHLY_MAX_DD_PCT", "10.0"))


# ── NEWS FILTER ───────────────────────────────────────────────────────────────
NEWS_FILTER_ENABLED    = os.getenv("NEWS_FILTER_ENABLED", "true").lower() == "true"
NEWS_FILTER_COUNTRIES  = [c.strip().upper() for c in os.getenv("NEWS_FILTER_COUNTRIES", "US,EU,GB").split(",") if c.strip()]
NEWS_FILTER_IMPORTANCE = [v.strip().upper() for v in os.getenv("NEWS_FILTER_IMPORTANCE", "RED,ORANGE").split(",") if v.strip()]
NEWS_FILTER_BEFORE_MIN = int(os.getenv("NEWS_FILTER_BEFORE_MIN", "30"))
NEWS_FILTER_AFTER_MIN  = int(os.getenv("NEWS_FILTER_AFTER_MIN", "30"))
NEWS_CLOSE_BEFORE_MIN  = int(os.getenv("NEWS_CLOSE_BEFORE_MIN", "10"))


# ── TIME FILTER ───────────────────────────────────────────────────────────────
TIME_FILTER_ENABLED    = os.getenv("TIME_FILTER_ENABLED", "false").lower() == "true"
TIME_FILTER_START_HOUR = int(os.getenv("TIME_FILTER_START_HOUR", "4"))
TIME_FILTER_END_HOUR   = int(os.getenv("TIME_FILTER_END_HOUR", "22"))
BLOCKED_HOURS          = [int(h.strip()) for h in os.getenv("BLOCKED_HOURS", "").split(",") if h.strip().isdigit()]


# ── TELEGRAM ──────────────────────────────────────────────────────────────────
BOT_TOKEN         = os.getenv("BOT_TOKEN", "").strip()
EXECUTION_CHAT_ID = os.getenv("EXECUTION_CHAT_ID", "").strip()
CONTROL_CHAT_ID   = os.getenv("CONTROL_CHAT_ID", "").strip()
# Channel where CNMS mirrors signals in the 🚨 icon format so 247A/B can trade them.
SIGNAL_MIRROR_ID  = os.getenv("SIGNAL_MIRROR_ID", "").strip()


# ── DAILY REPORT ──────────────────────────────────────────────────────────────
DAILY_REPORT_ENABLED    = os.getenv("DAILY_REPORT_ENABLED", "true").lower() == "true"
DAILY_REPORT_CHAT_ID    = os.getenv("DAILY_REPORT_CHAT_ID", "").strip()
DAILY_REPORT_SEND_TIME  = os.getenv("DAILY_REPORT_SEND_TIME", "17:00").strip()
DAILY_PROFIT_TARGET_PCT = float(os.getenv("DAILY_PROFIT_TARGET_PCT", "3.0"))
DAILY_PROFIT_LOCK       = os.getenv("DAILY_PROFIT_LOCK", "false").lower() == "true"


# ── INTERNALS ─────────────────────────────────────────────────────────────────
TRADES_CSV     = os.getenv("TRADES_CSV", "trades.csv").strip()
STATE_FILE     = os.getenv("STATE_FILE", "cnms_state.json").strip()
EVENT_LOG      = "cnms_events.log"
MAGIC          = int(os.getenv("MAGIC_NUMBER", "20250521"))   # unique CNMS magic
MT5_ASYNC_LOCK  = asyncio.Lock()
_MT5_CONNECTED  = False   # True once successfully initialised; prevents repeat log spam

# Symbol cache (populated on connect)
MT5_SYMBOLS_ALL   = []
MT5_SYMBOLS_UPPER = set()


# ════════════════════════════════════════════════════════════════════════════════
# LOGGING
# ════════════════════════════════════════════════════════════════════════════════

def log_event(msg: str):
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with open(EVENT_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ════════════════════════════════════════════════════════════════════════════════
# STATE MANAGEMENT
# ════════════════════════════════════════════════════════════════════════════════

def _default_state() -> dict:
    return {
        "managed_positions": {},   # ticket_str → metadata dict
        "manual_pause":      False,
        "last_bar_times":    {},   # symbol → last processed bar open_time (int unix)
        "last_signal_times": {},   # symbol → unix timestamp of last entry
        "daily_stats":       {},   # date_str → stats bucket
        "trades_today_date": "",   # date_str for today's trade-open counter
        "trades_today_count": 0,   # number of trades opened today
    }


def load_state() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            s = json.load(f)
        merged = _default_state()
        merged.update(s)
        return merged
    except FileNotFoundError:
        return _default_state()
    except Exception:
        log_event("State load error:\n" + traceback.format_exc())
        return _default_state()


def save_state(state: dict):
    try:
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, STATE_FILE)
    except Exception:
        log_event("State save error:\n" + traceback.format_exc())


# ════════════════════════════════════════════════════════════════════════════════
# TELEGRAM SEND (HTTP Bot API — no Telethon session needed for sends)
# ════════════════════════════════════════════════════════════════════════════════

async def safe_send(chat_id: int, text: str):
    if not BOT_TOKEN:
        return
    try:
        url  = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id":                  str(chat_id),
            "text":                     text[:4096],
            "parse_mode":               "HTML",
            "disable_web_page_preview": "true",
        }).encode()
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception:
        log_event("Telegram send failed:\n" + traceback.format_exc())


async def _post_signal_to_mirror(symbol: str, side: str, entry: float, sl: float):
    """
    Post a 🚨 CryptoNite Signal message to SIGNAL_MIRROR_ID so that 247A/B bots
    can pick it up via their cryptonite_icon parser.

    Format must match CRYPTONITE_ICON_RE in the 247 bots:
        (?:📈|📉)\\s*SYMBOL\\s*[|\\n]\\s*(BUY|SELL)
        ...📍 Entry: ...  🛑 SL: ...  🎯 TP: ...
    TP is computed at 1R (entry ± sl_delta) to give 247 bots a first target;
    their own scalp-lock + trail stack takes over from there.
    """
    if not SIGNAL_MIRROR_ID or not BOT_TOKEN:
        return
    try:
        sl_delta = abs(entry - sl)
        if sl_delta == 0:
            return
        tp1 = round(entry + sl_delta, 5) if side == "BUY" else round(entry - sl_delta, 5)
        side_icon = "📈" if side == "BUY" else "📉"
        ts_str    = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        # Strip broker suffix (e.g. XAUUSD.s → XAUUSD) so 247 bots resolve the
        # symbol through their own SYMBOL_MAP / SYMBOL_SUFFIX_PREFER chain cleanly.
        clean_sym = re.sub(r'\.[a-zA-Z0-9]+$', '', symbol) or symbol

        msg = (
            f"🚨 CryptoNite Signal\n"
            f"📡 CryptoNite CNMS Signals\n"
            f"{side_icon} {clean_sym} | {side}\n"
            f"⏰ {ts_str}\n"
            f"📍 Entry:  {entry:.5f}\n"
            f"🛑 SL:     {sl:.5f}\n"
            f"🎯 TP:     {tp1:.5f}"
        )
        await safe_send(int(SIGNAL_MIRROR_ID), msg)
        log_event(f"[MIRROR] Signal posted → {SIGNAL_MIRROR_ID}: {clean_sym} {side} E={entry:.5f} SL={sl:.5f} TP={tp1:.5f}")
    except Exception:
        log_event("[MIRROR] Post failed:\n" + traceback.format_exc())


def parse_hhmm(s: str):
    try:
        hh, mm = s.split(":")
        return int(hh), int(mm)
    except Exception:
        return 17, 0


# ════════════════════════════════════════════════════════════════════════════════
# MT5 CONNECTION
# ════════════════════════════════════════════════════════════════════════════════

def mt5_connect(retries: int = 3) -> bool:
    global _MT5_CONNECTED
    # Fast path: already connected — skip re-init and skip the log line so we
    # don't fill the log with "[MT5] Connected" every 5-second manager tick.
    if _MT5_CONNECTED and mt5.account_info() is not None:
        return True

    was_connected  = _MT5_CONNECTED
    _MT5_CONNECTED = False

    for attempt in range(retries):
        try:
            if MT5_LOGIN:
                ok = mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER)
            else:
                ok = mt5.initialize()
            if ok:
                acc = mt5.account_info()
                if acc:
                    label = "Reconnected" if was_connected else "Connected"
                    log_event(f"[MT5] {label} #{acc.login} balance={acc.balance:.2f} mode={ACCOUNT_MODE}")
                _MT5_CONNECTED = True
                _refresh_symbol_cache()
                return True
        except Exception:
            log_event(f"[MT5] Connect attempt {attempt+1} failed:\n" + traceback.format_exc())
        time.sleep(1)
    log_event("[MT5] All connect attempts failed.")
    return False


def mt5_disconnect():
    global _MT5_CONNECTED
    _MT5_CONNECTED = False
    try:
        mt5.shutdown()
    except Exception:
        pass


def _refresh_symbol_cache():
    global MT5_SYMBOLS_ALL, MT5_SYMBOLS_UPPER
    syms = mt5.symbols_get()
    if syms:
        MT5_SYMBOLS_ALL   = [s.name for s in syms if getattr(s, "name", None)]
        MT5_SYMBOLS_UPPER = set(x.upper() for x in MT5_SYMBOLS_ALL)


def enforce_account_lock():
    """Raise if we're connected to the wrong account."""
    if not ALLOWED_ACCOUNT_LOGIN:
        return
    acc = mt5.account_info()
    if acc and str(acc.login) != str(ALLOWED_ACCOUNT_LOGIN):
        raise RuntimeError(
            f"[LOCK] Connected to account #{acc.login} but ALLOWED_ACCOUNT_LOGIN={ALLOWED_ACCOUNT_LOGIN}. "
            "Refusing to trade."
        )


# ════════════════════════════════════════════════════════════════════════════════
# SYMBOL RESOLUTION
# ════════════════════════════════════════════════════════════════════════════════

def resolve_symbol(raw: str) -> str:
    """Resolve a raw symbol name to the broker's exact symbol string."""
    base = raw.upper().replace("/", "").strip()
    # XAU special mapping
    if base in ("XAU", "GOLD", "XAUUSD"):
        if SYMBOL_XAU and SYMBOL_XAU.upper() in MT5_SYMBOLS_UPPER:
            return SYMBOL_XAU
    # Direct match
    if base in MT5_SYMBOLS_UPPER:
        return base
    # Force suffix
    if SYMBOL_SUFFIX_FORCE:
        c = base + SYMBOL_SUFFIX_FORCE
        if c.upper() in MT5_SYMBOLS_UPPER:
            return c
    # Preferred suffixes
    for suf in SYMBOL_SUFFIX_PREFER:
        c = base + suf
        if c.upper() in MT5_SYMBOLS_UPPER:
            return c
    # Prefix match (e.g. XAUUSD → XAUUSD.s)
    starts = sorted(
        [s for s in MT5_SYMBOLS_ALL if s.upper().startswith(base)],
        key=lambda x: (len(x), x)
    )
    if starts:
        return starts[0]
    return base   # return as-is; MT5 will reject if invalid


def symbol_class(sym: str) -> str:
    s = sym.upper()
    if "XAU" in s or "GOLD" in s:
        return "XAU"
    if "XAG" in s or "SILVER" in s:
        return "XAG"
    if "BTC" in s:
        return "BTC"
    if any(k in s for k in ("NAS", "US100", "NDX", "GER", "DAX", "SPX", "US30", "US500", "DE40", "UK100")):
        return "INDEX"
    base = s.split(".")[0].split("#")[0]
    if len(base) == 6 and base.isalpha():
        return "FX"
    return "DEFAULT"


# ════════════════════════════════════════════════════════════════════════════════
# TIMEFRAME MAP
# ════════════════════════════════════════════════════════════════════════════════

TF_MAP = {
    "M1":  mt5.TIMEFRAME_M1,  "M5":  mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30,
    "H1":  mt5.TIMEFRAME_H1,  "H4":  mt5.TIMEFRAME_H4,
    "D1":  mt5.TIMEFRAME_D1,
}

def tf_to_mt5(tf: str):
    return TF_MAP.get(tf.upper(), mt5.TIMEFRAME_M15)


def _tf_minutes(tf: str) -> int:
    """Return the number of minutes in a timeframe string (M15→15, H1→60, D1→1440)."""
    tf = tf.upper()
    if tf.startswith("M"):
        return int(tf[1:])
    if tf.startswith("H"):
        return int(tf[1:]) * 60
    if tf == "D1":
        return 1440
    return 15


async def _sleep_until_next_bar_close(timeframe_minutes: int = 15, buffer_seconds: float = 2.0):
    """
    Sleep until `buffer_seconds` after the next bar close on the given timeframe.

    Example for M15: wakes at HH:00:02, HH:15:02, HH:30:02, HH:45:02 (UTC).
    This is far cleaner than a fixed polling interval — the bot wakes up exactly
    when there is something new to check, and never wastes a tick mid-bar.
    """
    now              = datetime.now(timezone.utc)
    total_secs       = now.minute * 60 + now.second + now.microsecond / 1_000_000
    bar_secs         = timeframe_minutes * 60
    secs_into_bar    = total_secs % bar_secs
    secs_until_close = bar_secs - secs_into_bar + buffer_seconds

    next_close = now + timedelta(seconds=secs_until_close)
    log_event(
        f"[SIGNAL] ⏱ Next {timeframe_minutes}m bar close at "
        f"{next_close.strftime('%H:%M:%S')} UTC ({secs_until_close:.0f}s)"
    )
    await asyncio.sleep(secs_until_close)


# ════════════════════════════════════════════════════════════════════════════════
# ATR CALCULATION
# ════════════════════════════════════════════════════════════════════════════════

def atr_value(symbol: str, timeframe: str, period: int) -> float:
    rates = mt5.copy_rates_from_pos(symbol, tf_to_mt5(timeframe), 0, period + 10)
    if rates is None or len(rates) < period + 2:
        return 0.0
    trs = []
    prev_close = float(rates[0]["close"])
    for i in range(1, len(rates)):
        h = float(rates[i]["high"])
        l = float(rates[i]["low"])
        c = float(rates[i]["close"])
        trs.append(max(h - l, abs(h - prev_close), abs(l - prev_close)))
        prev_close = c
    if len(trs) < period:
        return 0.0
    return sum(trs[-period:]) / float(period)


def sl_delta(symbol: str) -> float:
    """Return SL distance in price units (HYBRID model: max of fixed floor and ATR-based)."""
    cls = symbol_class(symbol)
    if cls == "XAU":
        floor = SIMPLE_SL_FIXED_XAU
    elif cls == "INDEX":
        floor = SIMPLE_SL_FIXED_INDEX
    elif cls == "BTC":
        floor = SIMPLE_SL_FIXED_BTC
    elif cls == "FX":
        floor = SIMPLE_SL_FIXED_FX
    else:
        floor = SIMPLE_SL_FIXED_DEFAULT

    if SL_MODEL == "FIXED":
        return float(floor)

    a = atr_value(symbol, ATR_TIMEFRAME, ATR_PERIOD)
    if a <= 0:
        return float(floor)

    atr_based = a * ATR_MULTIPLIER
    if SL_MODEL == "ATR":
        return atr_based
    return max(float(floor), atr_based)   # HYBRID


# ════════════════════════════════════════════════════════════════════════════════
# MACD ENGINE
# ════════════════════════════════════════════════════════════════════════════════

def _ema(prices: list, span: int) -> list:
    """Exponential moving average. Returns list of same length as input."""
    k      = 2.0 / (span + 1)
    result = [prices[0]]
    for p in prices[1:]:
        result.append(p * k + result[-1] * (1.0 - k))
    return result


def compute_macd(symbol: str, timeframe: str, fast: int, slow: int, signal_period: int):
    """
    Compute MACD for the given symbol/timeframe.

    Returns (macd_line, signal_line, histogram, bar_open_times) as lists of floats.
    Returns (None, None, None, None) on data failure.

    NOTE: All lists aligned to the same bar index.
    Bar index -1 = current (live) bar — never use for signals.
    Bar index -2 = last *completed* bar — use for crossover detection.
    Bar index -3 = bar before the last completed — use as 'previous' state.
    """
    bars_needed = max(slow * 3 + signal_period + 30, 250)
    rates = mt5.copy_rates_from_pos(symbol, tf_to_mt5(timeframe), 0, bars_needed)
    if rates is None or len(rates) < slow + signal_period + 10:
        return None, None, None, None

    closes = [float(r["close"]) for r in rates]
    times  = [int(r["time"])    for r in rates]

    ema_fast    = _ema(closes, fast)
    ema_slow    = _ema(closes, slow)
    macd_line   = [f - s for f, s in zip(ema_fast, ema_slow)]
    signal_line = _ema(macd_line, signal_period)
    histogram   = [m - s for m, s in zip(macd_line, signal_line)]

    return macd_line, signal_line, histogram, times


def detect_crossover(macd_line: list, signal_line: list) -> str | None:
    """
    Detect crossover on the LAST COMPLETED BAR (index -2 vs -3).
    Returns 'BUY', 'SELL', or None.
    """
    if len(macd_line) < 3 or len(signal_line) < 3:
        return None

    prev_m = macd_line[-3];  prev_s = signal_line[-3]
    last_m = macd_line[-2];  last_s = signal_line[-2]

    if prev_m <= prev_s and last_m > last_s:
        return "BUY"
    if prev_m >= prev_s and last_m < last_s:
        return "SELL"
    return None


def h1_macd_direction(symbol: str) -> int:
    """
    H1 trend filter: returns +1 (MACD > 0 = bullish), -1 (MACD < 0 = bearish), 0 (unavailable).
    Uses the last completed H1 bar (index -2).
    """
    macd, sig, hist, times = compute_macd(symbol, "H1", MACD_FAST, MACD_SLOW, MACD_SIGNAL_PERIOD)
    if macd is None or len(macd) < 2:
        return 0
    val = macd[-2]   # last completed H1 bar
    if val > 0:
        return 1
    if val < 0:
        return -1
    return 0


# ════════════════════════════════════════════════════════════════════════════════
# LOT SIZING
# ════════════════════════════════════════════════════════════════════════════════

def floor_to_step(lots: float, step: float) -> float:
    if step <= 0:
        return lots
    return math.floor(lots / step) * step


def max_lot_for_symbol(symbol: str) -> float:
    cls = symbol_class(symbol)
    if cls == "XAU":
        return MAX_LOT_XAU
    return MAX_LOT_DEFAULT


def lot_from_risk(symbol: str, entry: float, sl: float, risk_frac: float, side: str = "BUY") -> float:
    """Risk-based lot sizing using tick_value/tick_size."""
    acc  = mt5.account_info()
    info = mt5.symbol_info(symbol)
    if acc is None or info is None:
        raise RuntimeError(f"[LOT] Missing MT5 info for {symbol}")

    risk_amount        = float(acc.balance) * float(risk_frac)
    tick_value         = float(info.trade_tick_value)
    tick_size          = float(info.trade_tick_size)
    if tick_size <= 0:
        raise RuntimeError(f"[LOT] Bad tick_size for {symbol}")

    value_per_price_unit = tick_value / tick_size
    stop_dist            = abs(entry - sl)
    if stop_dist <= 0:
        raise ValueError(f"[LOT] Invalid SL distance (entry={entry} sl={sl})")

    ideal_lots = risk_amount / (stop_dist * value_per_price_unit)
    ideal_lots = min(ideal_lots, max_lot_for_symbol(symbol))

    if side == "SELL":
        ideal_lots *= SELL_LOT_MULTIPLIER

    step = float(info.volume_step) if info.volume_step > 0 else 0.01
    lots = round(ideal_lots / step) * step
    if lots <= 0:
        lots = step
    lots = min(lots, float(info.volume_max))
    lots = max(float(info.volume_min), lots)

    log_event(
        f"[LOT] {symbol} {side} bal={acc.balance:.2f} risk={risk_frac:.4f} "
        f"stop={stop_dist:.4f} val/pt={value_per_price_unit:.4f} → lots={lots:.4f}"
    )
    return round(lots, 8)


def fixed_lot_size(symbol: str, side: str = "BUY") -> float:
    info = mt5.symbol_info(symbol)
    l    = FIXED_LOT
    if side == "SELL":
        l *= SELL_LOT_MULTIPLIER
    if info:
        l = max(float(info.volume_min), min(l, float(info.volume_max)))
        l = floor_to_step(l, float(info.volume_step) if info.volume_step > 0 else 0.01)
    return l


def current_risk_frac(acc_equity: float, start_equity: float) -> float:
    """Scale risk down with drawdown."""
    if start_equity <= 0:
        return RISK_BASE
    dd_pct = max(0.0, (start_equity - acc_equity) / start_equity * 100.0)
    if dd_pct < DD1_PCT:
        return RISK_BASE
    if dd_pct < DD2_PCT:
        return RISK_DD1
    if dd_pct < DD3_PCT:
        return RISK_DD2
    return RISK_DD3


# ════════════════════════════════════════════════════════════════════════════════
# SPREAD CHECK
# ════════════════════════════════════════════════════════════════════════════════

def max_spread(symbol: str) -> float:
    cls = symbol_class(symbol)
    if cls == "XAU":
        return MAX_SPREAD_PRICE_XAU
    if cls == "INDEX":
        return MAX_SPREAD_PRICE_INDEX
    return MAX_SPREAD_PRICE_DEFAULT


def check_spread(symbol: str, retries: int = 3) -> bool:
    """Return True if spread is within limit (with optional recheck)."""
    for attempt in range(retries if SPREAD_RECHECK_ENABLED else 1):
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            return False
        spread = abs(float(tick.ask) - float(tick.bid))
        limit  = max_spread(symbol)
        if spread <= limit:
            return True
        log_event(f"[SPREAD] {symbol} spread={spread:.4f} > limit={limit:.4f} (attempt {attempt+1})")
        if attempt < retries - 1:
            time.sleep(SPREAD_RECHECK_SECONDS)
    return False


# ════════════════════════════════════════════════════════════════════════════════
# DAILY STATS
# ════════════════════════════════════════════════════════════════════════════════

def day_key() -> str:
    return date.today().isoformat()


def get_day_bucket(state: dict, dk: str = None) -> dict:
    if dk is None:
        dk = day_key()
    state.setdefault("daily_stats", {})
    state["daily_stats"].setdefault(dk, {
        "trades": 0, "wins": 0, "losses": 0,
        "be_plus": 0, "breakeven": 0,
        "profit": 0.0, "sum_win": 0.0, "sum_loss": 0.0,
    })
    return state["daily_stats"][dk]


def record_trade_close(state: dict, profit: float):
    """Record a closed trade outcome in daily stats."""
    b = get_day_bucket(state)
    b["trades"] += 1
    b["profit"]  = round(b.get("profit", 0.0) + profit, 4)
    BE_PLUS_MAX  = 5.0
    if profit >= BE_PLUS_MAX:
        b["wins"]    += 1
        b["sum_win"]  = round(b.get("sum_win", 0.0) + profit, 4)
    elif profit > 0:
        b["be_plus"] = b.get("be_plus", 0) + 1
    elif profit < 0:
        b["losses"]   += 1
        b["sum_loss"]  = round(b.get("sum_loss", 0.0) + profit, 4)
    else:
        b["breakeven"] += 1


def increment_trades_opened(state: dict):
    """Track how many trades were opened today (for MAX_TRADES_PER_DAY cap)."""
    today = day_key()
    if state.get("trades_today_date") != today:
        state["trades_today_date"]  = today
        state["trades_today_count"] = 0
    state["trades_today_count"] = state.get("trades_today_count", 0) + 1


def trades_opened_today(state: dict) -> int:
    if state.get("trades_today_date") != day_key():
        return 0
    return state.get("trades_today_count", 0)


def count_consecutive_losses() -> int:
    """Count CNMS losses today via MT5 deal history."""
    now   = datetime.now()
    start = datetime(now.year, now.month, now.day)
    deals = mt5.history_deals_get(start, now + timedelta(seconds=1))
    if deals is None:
        return 0
    losses = 0
    for d in deals:
        if getattr(d, "magic", None) != MAGIC:
            continue
        if getattr(d, "entry", None) not in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
            continue
        losses += 1 if float(getattr(d, "profit", 0.0)) < 0 else 0
    return losses


# ════════════════════════════════════════════════════════════════════════════════
# NEWS FILTER  (delegates to news_filter.py in the same folder)
# ════════════════════════════════════════════════════════════════════════════════

try:
    from news_filter import is_news_blackout as _ff_is_news_blackout

    class _NewsSettings:
        news_filter_enabled    = NEWS_FILTER_ENABLED
        news_filter_countries  = NEWS_FILTER_COUNTRIES
        news_filter_importance = NEWS_FILTER_IMPORTANCE
        news_filter_before_min = NEWS_FILTER_BEFORE_MIN
        news_filter_after_min  = NEWS_FILTER_AFTER_MIN
        news_close_before_min  = NEWS_CLOSE_BEFORE_MIN

    _news_settings = _NewsSettings()

    def is_news_blocked() -> bool:
        if not NEWS_FILTER_ENABLED:
            return False
        blocked, reason = _ff_is_news_blackout(_news_settings)
        if blocked:
            log_event(f"[NEWS] Blocked: {reason}")
        return blocked

except ImportError:
    log_event("[NEWS] news_filter.py not found — news filter disabled.")
    def is_news_blocked() -> bool:
        return False


# ════════════════════════════════════════════════════════════════════════════════
# TIME FILTER
# ════════════════════════════════════════════════════════════════════════════════

def is_time_blocked() -> bool:
    if not TIME_FILTER_ENABLED:
        return False
    h = datetime.now(timezone.utc).hour
    if h in BLOCKED_HOURS:
        return True
    if not (TIME_FILTER_START_HOUR <= h < TIME_FILTER_END_HOUR):
        return True
    return False


# ════════════════════════════════════════════════════════════════════════════════
# MT5 ORDER UTILITIES
# ════════════════════════════════════════════════════════════════════════════════

def round_price(symbol: str, price: float) -> float:
    info = mt5.symbol_info(symbol)
    digits = int(getattr(info, "digits", 5)) if info else 5
    return round(price, digits)


def get_filling_mode(symbol: str) -> int:
    info = mt5.symbol_info(symbol)
    if info is None:
        return mt5.ORDER_FILLING_IOC
    fm = getattr(info, "filling_mode", 0)
    if fm & 1:
        return mt5.ORDER_FILLING_FOK
    if fm & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def modify_sl_tp(ticket: int, symbol: str, new_sl: float, new_tp: float):
    req = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "position": ticket,
        "symbol":   symbol,
        "sl":       round_price(symbol, new_sl),
        "tp":       round_price(symbol, new_tp),
    }
    return mt5.order_send(req)


def close_position_market(ticket: int, symbol: str, pos_type: int, volume: float, comment: str = "CNMS_CLOSE"):
    """Close a position at market price."""
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return None
    price      = float(tick.bid) if pos_type == 0 else float(tick.ask)
    order_type = mt5.ORDER_TYPE_SELL if pos_type == 0 else mt5.ORDER_TYPE_BUY
    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "position":     ticket,
        "symbol":       symbol,
        "volume":       volume,
        "type":         order_type,
        "price":        price,
        "deviation":    20,
        "magic":        MAGIC,
        "comment":      comment,
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": get_filling_mode(symbol),
    }
    return mt5.order_send(req)


def log_trade_csv(row: dict):
    fields = ["time", "ticket", "symbol", "side", "lots", "entry", "sl",
              "tp", "close_price", "profit", "exit_reason"]
    new_file = not os.path.exists(TRADES_CSV)
    try:
        with open(TRADES_CSV, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            if new_file:
                w.writeheader()
            w.writerow(row)
    except Exception:
        log_event("CSV write error:\n" + traceback.format_exc())


# ════════════════════════════════════════════════════════════════════════════════
# PLACE MACD TRADE
# ════════════════════════════════════════════════════════════════════════════════

def place_macd_trade(symbol: str, side: str, state: dict):
    """
    Open a MACD-generated trade on symbol in direction side ('BUY'|'SELL').
    Returns (ticket: int, pos_meta: dict) on success, None on failure.
    """
    mt5_connect()
    enforce_account_lock()

    # ── Spread check ────────────────────────────────────────────────────────
    if not check_spread(symbol):
        return None

    # ── Current price ───────────────────────────────────────────────────────
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        log_event(f"[TRADE] No tick for {symbol}")
        return None
    entry = float(tick.ask) if side == "BUY" else float(tick.bid)

    # ── SL / safety TP ──────────────────────────────────────────────────────
    d = sl_delta(symbol)
    if side == "BUY":
        sl = entry - d
        tp = entry + (SAFETY_TP_R * d)
    else:
        sl = entry + d
        tp = entry - (SAFETY_TP_R * d)

    # ── Lot sizing ──────────────────────────────────────────────────────────
    acc = mt5.account_info()
    if acc is None:
        log_event("[TRADE] MT5 account_info() returned None")
        return None

    if USE_FIXED_LOT:
        lots = fixed_lot_size(symbol, side)
    else:
        start_eq  = float(acc.equity)   # use live equity; state tracking is secondary
        risk_frac = current_risk_frac(float(acc.equity), start_eq)
        try:
            lots = lot_from_risk(symbol, entry, sl, risk_frac, side)
        except Exception as e:
            log_event(f"[TRADE] Lot calc failed: {e}")
            return None

    if lots <= 0:
        log_event(f"[TRADE] Computed lot=0 for {symbol}")
        return None

    # ── Send order ──────────────────────────────────────────────────────────
    order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       lots,
        "type":         order_type,
        "price":        round_price(symbol, entry),
        "sl":           round_price(symbol, sl),
        "tp":           round_price(symbol, tp),
        "deviation":    20,
        "magic":        MAGIC,
        "comment":      f"CNMS_{side}",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": get_filling_mode(symbol),
    }

    log_event(f"[TRADE] → {side} {symbol} lots={lots:.4f} entry≈{entry:.4f} SL={sl:.4f} safetyTP={tp:.4f}")
    res = mt5.order_send(req)

    if res is None:
        log_event("[TRADE] order_send returned None")
        return None

    retcode = getattr(res, "retcode", None)
    if retcode not in (mt5.TRADE_RETCODE_DONE, 10009):
        log_event(f"[TRADE] Failed: retcode={retcode} comment={getattr(res,'comment','?')}")
        return None

    ticket     = int(getattr(res, "order", 0))
    deal_price = float(getattr(res, "price", entry))
    log_event(f"[TRADE] ✅ Ticket={ticket} {side} {symbol} @{deal_price:.4f} SL={sl:.4f} lots={lots:.4f}")

    pos_meta = {
        "symbol":          symbol,
        "type":            0 if side == "BUY" else 1,
        "side":            side,
        "entry":           deal_price,
        "sl_init":         round(sl, 5),
        "tp_init":         round(tp, 5),
        "lots":            lots,
        "sl_delta":        d,
        "opened_at":       datetime.now().isoformat(),
        "moved_be":        False,
        "trail_on":        False,
        "scalp_locked":    False,
        "peak_profit_pts": 0.0,
        "source":          f"MACD_{MACD_TIMEFRAME}",
    }
    return ticket, pos_meta


# ════════════════════════════════════════════════════════════════════════════════
# POSITION MANAGER  — Layers 1 & 2 (runs every MANAGER_INTERVAL_SECONDS)
# ════════════════════════════════════════════════════════════════════════════════

def _recover_orphan_positions(state: dict) -> int:
    """
    On startup, scan MT5 for any open positions with our MAGIC number that are
    NOT already tracked in managed_positions (e.g. after a crash mid-session).
    Re-adopt them with minimal metadata so all exit layers can resume immediately.
    Returns the number of positions recovered.
    """
    mt5_connect()
    poss    = mt5.positions_get() or []
    managed = state.setdefault("managed_positions", {})
    recovered = 0

    for p in poss:
        if getattr(p, "magic", None) != MAGIC:
            continue
        ticket_str = str(p.ticket)
        if ticket_str in managed:
            continue  # already tracked

        symbol   = p.symbol
        pos_type = int(p.type)           # 0=BUY, 1=SELL
        entry    = float(p.price_open)
        cur_sl   = float(p.sl) if p.sl else 0.0
        cur_tp   = float(p.tp) if p.tp else 0.0
        sl_delta = abs(entry - cur_sl) if cur_sl else 0.0

        managed[ticket_str] = {
            "symbol":          symbol,
            "type":            pos_type,
            "side":            "BUY" if pos_type == 0 else "SELL",
            "entry":           entry,
            "sl_init":         cur_sl,
            "tp_init":         cur_tp,
            "lots":            float(p.volume),
            "sl_delta":        sl_delta,
            "opened_at":       datetime.utcfromtimestamp(int(p.time)).isoformat() if p.time else "",
            "moved_be":        False,   # conservative — assume layers haven't fired
            "trail_on":        False,
            "scalp_locked":    False,
            "peak_profit_pts": 0.0,
            "source":          "RECOVERED",
        }
        log_event(
            f"[RECOVER] Adopted orphan ticket={p.ticket} "
            f"{'BUY' if pos_type==0 else 'SELL'} {symbol} "
            f"@{entry:.4f}  SL={cur_sl:.4f}  lots={float(p.volume):.2f}"
        )
        recovered += 1

    return recovered


def manage_positions_once(state: dict) -> list[str]:
    """
    One management tick. Returns list of Telegram notification strings.

    Layer 1 — Scalp lock: moves SL to entry + fraction of sl_delta once
              floating profit reaches SCALP_LOCK_TRIGGER_R * sl_delta.
    Layer 2 — ATR trail: trails SL once the scalp lock is in place.
    Layer 3 (MACD unwind) is handled in signal_loop on bar close.
    """
    notifications = []
    managed       = state.get("managed_positions", {})
    if not managed:
        return notifications

    mt5_connect()
    poss = mt5.positions_get()
    if poss is None:
        mt5_disconnect()
        return notifications

    pos_by_ticket = {str(p.ticket): p for p in poss}

    for ticket_str, meta in list(managed.items()):
        p = pos_by_ticket.get(ticket_str)

        if p is None:
            # Position has closed — record it and remove from tracking
            managed.pop(ticket_str, None)
            notif = _record_closed_position(state, int(ticket_str), meta)
            if notif:
                notifications.append(notif)
            continue

        symbol   = meta["symbol"]
        pos_type = int(meta["type"])   # 0=BUY, 1=SELL
        entry    = float(meta["entry"])
        d        = float(meta.get("sl_delta", 0.0))

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            continue

        bid, ask   = float(tick.bid), float(tick.ask)
        cur_price  = bid if pos_type == 0 else ask
        cur_sl     = float(p.sl) if p.sl else 0.0
        cur_tp     = float(p.tp) if p.tp else 0.0
        info       = mt5.symbol_info(symbol)
        point      = float(getattr(info, "point", 0.0) or 0.0) if info else 0.0
        eps        = max(point * 2.0, 0.0001)

        float_dist = (cur_price - entry) if pos_type == 0 else (entry - cur_price)
        if float_dist > float(meta.get("peak_profit_pts", 0.0)):
            meta["peak_profit_pts"] = round(float_dist, 4)

        # ── LAYER 1: SCALP LOCK ─────────────────────────────────────────────
        if SCALP_LOCK_ENABLED and not meta.get("scalp_locked", False) and d > 0:
            trigger_dist = SCALP_LOCK_TRIGGER_R * d
            lock_dist    = SCALP_LOCK_AMOUNT_R   * d

            if float_dist >= trigger_dist:
                new_sl = (entry + lock_dist) if pos_type == 0 else (entry - lock_dist)
                ok = (
                    (pos_type == 0 and (cur_sl == 0.0 or new_sl > cur_sl + eps) and new_sl < cur_price - eps)
                    or
                    (pos_type == 1 and (cur_sl == 0.0 or new_sl < cur_sl - eps) and new_sl > cur_price + eps)
                )
                if ok:
                    res = modify_sl_tp(int(p.ticket), symbol, round_price(symbol, new_sl), cur_tp)
                    if getattr(res, "retcode", None) in (mt5.TRADE_RETCODE_DONE, 10009):
                        meta["scalp_locked"] = True
                        meta["moved_be"]     = True
                        cur_sl               = new_sl
                        log_event(f"🔒 Scalp lock: ticket={p.ticket} {symbol} SL→{new_sl:.4f}")

        # ── LAYER 2: ATR TRAIL (only after scalp lock activated) ────────────
        if ATR_TRAIL_ENABLED and meta.get("moved_be", False):
            _atr       = atr_value(symbol, ATR_TIMEFRAME, ATR_PERIOD)
            trail_dist = max(MIN_TRAIL_PRICE, _atr * ATR_TRAIL_DIST_PCT) if _atr > 0 else MIN_TRAIL_PRICE

            if pos_type == 0:
                desired_sl = cur_price - trail_dist
                ok = (cur_sl == 0.0 or desired_sl > cur_sl + eps) and desired_sl < cur_price - eps
            else:
                desired_sl = cur_price + trail_dist
                ok = (cur_sl == 0.0 or desired_sl < cur_sl - eps) and desired_sl > cur_price + eps

            if ok:
                res = modify_sl_tp(int(p.ticket), symbol, round_price(symbol, desired_sl), cur_tp)
                if getattr(res, "retcode", None) in (mt5.TRADE_RETCODE_DONE, 10009):
                    meta["trail_on"] = True
                    log_event(f"🏃 ATR trail: ticket={p.ticket} SL→{desired_sl:.4f}")

    save_state(state)
    mt5_disconnect()
    return notifications


def _record_closed_position(state: dict, ticket: int, meta: dict) -> str | None:
    """Look up closed deal in history, record outcome, return Telegram notification string."""
    try:
        now   = datetime.now()
        start = now - timedelta(hours=4)
        deals = mt5.history_deals_get(start, now + timedelta(seconds=5))
        if deals is None:
            return None
        for d in deals:
            if getattr(d, "magic", None) != MAGIC:
                continue
            if getattr(d, "position_id", None) != ticket:
                continue
            if getattr(d, "entry", None) not in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
                continue
            profit      = float(getattr(d, "profit", 0.0))
            close_price = float(getattr(d, "price", 0.0))
            symbol      = meta.get("symbol", "")
            side        = meta.get("side", "")
            entry       = float(meta.get("entry", 0.0))
            d_val       = float(meta.get("sl_delta", 0.0))

            log_event(f"[CLOSE] ticket={ticket} {symbol} {side} profit={profit:+.2f}")
            record_trade_close(state, profit)
            log_trade_csv({
                "time":        now.strftime("%Y-%m-%d %H:%M:%S"),
                "ticket":      ticket,
                "symbol":      symbol,
                "side":        side,
                "lots":        meta.get("lots", 0.0),
                "entry":       entry,
                "sl":          meta.get("sl_init", 0.0),
                "tp":          meta.get("tp_init", 0.0),
                "close_price": close_price,
                "profit":      profit,
                "exit_reason": str(getattr(d, "comment", "")),
            })

            # Build standard close notification
            _BE_PLUS_MAX = 5.0
            if profit >= _BE_PLUS_MAX:
                close_icon, outcome_s = "✅", "WIN"
            elif profit > 0:
                close_icon, outcome_s = "🛡️", "BE+"
            elif profit < 0:
                close_icon, outcome_s = "❌", "LOSS"
            else:
                close_icon, outcome_s = "➖", "BE"
            dir_icon  = "📈" if side == "BUY" else "📉"
            clean_sym = symbol.split(".")[0] if "." in symbol else symbol
            now_str   = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
            rr_line   = ""
            if d_val > 0 and entry > 0:
                price_diff = (close_price - entry) if side == "BUY" else (entry - close_price)
                rr_val  = round(price_diff / d_val, 2)
                rr_line = f"📊 R:R:    {rr_val:+.2f}R\n"
            return (
                f"{close_icon} <b>Trade Closed — {outcome_s}</b>\n"
                f"📊 {INSTANCE_NAME}  |  📡 MACD {MACD_TIMEFRAME}\n"
                f"\n"
                f"{dir_icon} <b>{clean_sym} | {side}</b>\n"
                f"⏰ {now_str}\n"
                f"\n"
                f"📍 Entry:  {entry:.5f}\n"
                f"🏁 Exit:   {close_price:.5f}\n"
                f"{rr_line}"
                f"💰 P/L:    <b>{profit:+.2f}</b>\n"
                f"🎫 Ticket: {ticket}"
            )
    except Exception:
        log_event("_record_closed_position error:\n" + traceback.format_exc())
    return None


# ════════════════════════════════════════════════════════════════════════════════
# SIGNAL LOOP  — polls every 10 s, acts on M15 bar closes
# ════════════════════════════════════════════════════════════════════════════════

async def signal_loop():
    log_event(f"[SIGNAL] Starting. Watching: {', '.join(SYMBOLS)}")
    _last_bar_time: dict = {}   # symbol → last processed bar open_time (int unix)
    tf_minutes = _tf_minutes(MACD_TIMEFRAME)

    # ── Initialise bar times to avoid re-firing the stale last bar at startup ─
    async with MT5_ASYNC_LOCK:
        await asyncio.to_thread(_init_bar_times, _last_bar_time)

    log_event(f"[SIGNAL] Bar times initialised — listening for {MACD_TIMEFRAME} closes.")

    while True:
        try:
            # Sleep precisely until 2 s after the next bar close — no blind polling.
            await _sleep_until_next_bar_close(tf_minutes, buffer_seconds=2.0)

            async with MT5_ASYNC_LOCK:
                result = await asyncio.to_thread(_signal_tick, _last_bar_time)

            for msg in result.get("alerts", []):
                if EXECUTION_CHAT_ID:
                    await safe_send(int(EXECUTION_CHAT_ID), msg)

            # Mirror new signals to SIGNAL_MIRROR_ID so 247A/B bots can trade them.
            for sym, side, entry, sl in result.get("mirrors", []):
                await _post_signal_to_mirror(sym, side, entry, sl)

        except asyncio.CancelledError:
            log_event("[SIGNAL] Cancelled — exiting.")
            raise
        except Exception:
            log_event("[SIGNAL] Exception:\n" + traceback.format_exc())
            await asyncio.sleep(60)   # back off one minute on unexpected error


def _init_bar_times(last_bar_time: dict):
    """Populate last_bar_time for all symbols so startup doesn't trigger stale signals."""
    mt5_connect()
    for raw_sym in SYMBOLS:
        symbol = resolve_symbol(raw_sym)
        try:
            _, _, _, times = compute_macd(symbol, MACD_TIMEFRAME, MACD_FAST, MACD_SLOW, MACD_SIGNAL_PERIOD)
            if times and len(times) >= 2:
                last_bar_time[symbol] = int(times[-2])
                bar_str = datetime.utcfromtimestamp(int(times[-2])).strftime("%Y-%m-%d %H:%M")
                log_event(f"[INIT] {symbol} last bar set to {bar_str} UTC")
        except Exception:
            log_event(f"[INIT] {symbol} failed:\n" + traceback.format_exc())
    mt5_disconnect()


def _signal_tick(last_bar_time: dict) -> dict:
    """Synchronous work for signal_loop — called via asyncio.to_thread."""
    alerts  = []
    mirrors = []   # list of (symbol, side, entry, sl) to post async after returning
    state   = load_state()

    # Weekend guard
    if datetime.now(timezone.utc).weekday() >= 5:
        return {"alerts": alerts, "mirrors": mirrors}

    mt5_connect()

    for raw_sym in SYMBOLS:
        try:
            symbol = resolve_symbol(raw_sym)
            _process_symbol(symbol, state, last_bar_time, alerts, mirrors)
        except Exception:
            log_event(f"[SIGNAL] Error processing {raw_sym}:\n" + traceback.format_exc())

    save_state(state)
    mt5_disconnect()
    return {"alerts": alerts, "mirrors": mirrors}


def _process_symbol(symbol: str, state: dict, last_bar_time: dict, alerts: list, mirrors: list = None):
    """Process one symbol for one signal tick."""
    managed = state.setdefault("managed_positions", {})

    # ── Fetch MACD data ──────────────────────────────────────────────────────
    macd_line, signal_line, histogram, times = compute_macd(
        symbol, MACD_TIMEFRAME, MACD_FAST, MACD_SLOW, MACD_SIGNAL_PERIOD
    )
    if macd_line is None or len(times) < 3:
        return

    # ── New bar detection ────────────────────────────────────────────────────
    last_closed_time = int(times[-2])   # bar index -1 is live; -2 is last completed
    prev_processed   = last_bar_time.get(symbol, 0)

    if last_closed_time <= prev_processed:
        return   # same bar — nothing new

    last_bar_time[symbol] = last_closed_time
    bar_dt  = datetime.utcfromtimestamp(last_closed_time)
    bar_str = bar_dt.strftime("%Y-%m-%d %H:%M")
    log_event(f"[BAR] {symbol} new {MACD_TIMEFRAME} bar closed at {bar_str} UTC")

    # ── Detect crossover on this bar ──────────────────────────────────────
    cross = detect_crossover(macd_line, signal_line)

    # ── LAYER 3: MACD UNWIND — always runs even when paused ──────────────
    if MACD_UNWIND_ENABLED and cross is not None:
        _macd_unwind(symbol, cross, managed, state, alerts)

    # ── Entry gate checks ────────────────────────────────────────────────
    if cross is None:
        return

    if state.get("manual_pause", False):
        log_event(f"[SIGNAL] {symbol} — bot is manually paused")
        return

    if is_time_blocked():
        log_event(f"[SIGNAL] {symbol} {cross} — time blocked")
        return

    if is_news_blocked():
        return

    # Daily trade cap
    if MAX_TRADES_PER_DAY > 0 and trades_opened_today(state) >= MAX_TRADES_PER_DAY:
        log_event(f"[SIGNAL] {symbol} — daily trade cap ({MAX_TRADES_PER_DAY}) reached")
        return

    # Consecutive loss cap
    if MAX_CONSECUTIVE_LOSSES > 0 and count_consecutive_losses() >= MAX_CONSECUTIVE_LOSSES:
        log_event(f"[SIGNAL] {symbol} — consecutive loss cap ({MAX_CONSECUTIVE_LOSSES}) reached")
        return

    # Position caps
    all_poss  = mt5.positions_get() or []
    cnms_poss = [p for p in all_poss if getattr(p, "magic", None) == MAGIC]
    if MAX_OPEN_POSITIONS_TOTAL > 0 and len(cnms_poss) >= MAX_OPEN_POSITIONS_TOTAL:
        log_event(f"[SIGNAL] Total cap ({MAX_OPEN_POSITIONS_TOTAL}) reached")
        return
    sym_poss = [p for p in cnms_poss if getattr(p, "symbol", "") == symbol]
    if len(sym_poss) >= MAX_OPEN_POSITIONS_PER_SYMBOL:
        log_event(f"[SIGNAL] {symbol} per-symbol cap ({MAX_OPEN_POSITIONS_PER_SYMBOL}) reached")
        return

    # Cooldown
    if COOLDOWN_SECONDS > 0:
        last_ts = state.get("last_signal_times", {}).get(symbol, 0)
        if time.time() - last_ts < COOLDOWN_SECONDS:
            log_event(f"[SIGNAL] {symbol} — cooldown active ({COOLDOWN_SECONDS}s)")
            return

    log_event(f"[SIGNAL] {symbol} {cross} crossover on bar {bar_str}")

    # ── H1 trend filter ───────────────────────────────────────────────────
    if H1_FILTER_ENABLED:
        h1_dir = h1_macd_direction(symbol)
        if h1_dir != 0:
            if cross == "BUY" and h1_dir < 0:
                log_event(f"[H1 FILTER] {symbol} BUY blocked — H1 MACD bearish")
                return
            if cross == "SELL" and h1_dir > 0:
                log_event(f"[H1 FILTER] {symbol} SELL blocked — H1 MACD bullish")
                return
        # h1_dir == 0 means H1 data unavailable → allow through

    # ── Zero-line filter ──────────────────────────────────────────────────
    if ZERO_LINE_FILTER_ENABLED:
        last_m = macd_line[-2]
        if cross == "BUY" and last_m > 0:
            log_event(f"[ZERO LINE] {symbol} BUY blocked — crossover above zero ({last_m:.6f})")
            return
        if cross == "SELL" and last_m < 0:
            log_event(f"[ZERO LINE] {symbol} SELL blocked — crossover below zero ({last_m:.6f})")
            return

    # ── MACD debug info ───────────────────────────────────────────────────
    last_macd = macd_line[-2];  last_sig = signal_line[-2]
    prev_macd = macd_line[-3];  prev_sig = signal_line[-3]
    log_event(
        f"[MACD] {symbol} {MACD_TIMEFRAME} bar={bar_str} "
        f"prev({prev_macd:+.6f},{prev_sig:+.6f}) → "
        f"last({last_macd:+.6f},{last_sig:+.6f}) cross={cross}"
    )

    # ── Place trade ───────────────────────────────────────────────────────
    result = place_macd_trade(symbol, cross, state)
    if result is None:
        log_event(f"[SIGNAL] {symbol} — trade placement failed")
        return

    ticket, pos_meta = result
    managed[str(ticket)] = pos_meta
    state.setdefault("last_signal_times", {})[symbol] = time.time()
    increment_trades_opened(state)

    # ── Build Telegram alert ──────────────────────────────────────────────
    side_icon = "🟢" if cross == "BUY" else "🔴"
    entry_val = pos_meta["entry"]
    sl_val    = pos_meta["sl_init"]
    d_val     = pos_meta["sl_delta"]
    lots_val  = pos_meta["lots"]
    h1_icon   = "✅" if H1_FILTER_ENABLED else "—"

    open_icon = "🟢" if cross == "BUY" else "🔴"
    clean_sym = symbol.split(".")[0] if "." in symbol else symbol
    tp_val    = pos_meta.get("tp_init", 0.0)
    tp_str    = f"{tp_val:.5f}" if tp_val else "—"
    now_str   = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    alerts.append(
        f"{open_icon} <b>Trade Opened</b>\n"
        f"📊 {INSTANCE_NAME}  |  📡 MACD {MACD_TIMEFRAME}\n"
        f"\n"
        f"{side_icon} <b>{clean_sym} | {cross}</b>\n"
        f"⏰ {now_str}\n"
        f"\n"
        f"📍 Entry:  {entry_val:.5f}\n"
        f"🛑 SL:     {sl_val:.5f}\n"
        f"🎯 TP:     {tp_str}\n"
        f"📦 Lots:   {lots_val:.2f}\n"
        f"🎫 Ticket: {ticket}"
    )

    # Queue mirror signal for async posting by signal_loop after this thread returns.
    if mirrors is not None:
        mirrors.append((symbol, cross, entry_val, sl_val))


def _macd_unwind(symbol: str, cross: str, managed: dict, state: dict, alerts: list):
    """
    Layer 3 exit: close CNMS positions that are now against the new MACD direction.
    BUY positions → close on SELL crossover.
    SELL positions → close on BUY crossover.
    """
    poss = mt5.positions_get()
    if poss is None:
        return

    for p in poss:
        if getattr(p, "magic", None) != MAGIC:
            continue
        if getattr(p, "symbol", "") != symbol:
            continue

        pos_type = int(p.type)   # 0=BUY, 1=SELL
        should_close = (pos_type == 0 and cross == "SELL") or \
                       (pos_type == 1 and cross == "BUY")
        if not should_close:
            continue

        ticket_str = str(p.ticket)
        meta       = managed.get(ticket_str, {})
        side_str   = "BUY" if pos_type == 0 else "SELL"

        log_event(f"[UNWIND] MACD {cross} → closing {side_str} ticket={p.ticket} {symbol}")
        res = close_position_market(int(p.ticket), symbol, pos_type, float(p.volume), "CNMS_UNWIND")

        retcode = getattr(res, "retcode", None) if res else None
        if retcode in (mt5.TRADE_RETCODE_DONE, 10009):
            profit = float(getattr(p, "profit", 0.0))
            log_event(f"[UNWIND] ✅ ticket={p.ticket} profit={profit:+.2f}")
            record_trade_close(state, profit)
            log_trade_csv({
                "time":        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "ticket":      p.ticket,
                "symbol":      symbol,
                "side":        side_str,
                "lots":        float(p.volume),
                "entry":       float(p.price_open),
                "sl":          meta.get("sl_init", 0.0),
                "tp":          meta.get("tp_init", 0.0),
                "close_price": float(tick.bid if pos_type == 0 else tick.ask)
                               if (tick := mt5.symbol_info_tick(symbol)) else 0.0,
                "profit":      profit,
                "exit_reason": f"MACD_UNWIND_{cross}",
            })
            managed.pop(ticket_str, None)
            _BE_PLUS_MAX = 5.0
            if profit >= _BE_PLUS_MAX:
                close_icon, outcome_s = "✅", "WIN"
            elif profit > 0:
                close_icon, outcome_s = "🛡️", "BE+"
            elif profit < 0:
                close_icon, outcome_s = "❌", "LOSS"
            else:
                close_icon, outcome_s = "➖", "BE"
            dir_icon   = "📈" if side_str == "BUY" else "📉"
            clean_sym  = symbol.split(".")[0] if "." in symbol else symbol
            entry_v    = float(meta.get("entry", p.price_open))
            exit_v     = float(getattr(mt5.symbol_info_tick(symbol), "bid" if pos_type == 0 else "ask", 0.0))
            d_v        = float(meta.get("sl_delta", 0.0))
            rr_line    = ""
            if d_v > 0 and entry_v > 0:
                price_diff = (exit_v - entry_v) if pos_type == 0 else (entry_v - exit_v)
                rr_val  = round(price_diff / d_v, 2)
                rr_line = f"📊 R:R:    {rr_val:+.2f}R\n"
            now_str  = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
            alerts.append(
                f"{close_icon} <b>Trade Closed — {outcome_s}</b>\n"
                f"📊 {INSTANCE_NAME}  |  📡 MACD {MACD_TIMEFRAME}\n"
                f"\n"
                f"{dir_icon} <b>{clean_sym} | {side_str}</b>\n"
                f"⏰ {now_str}\n"
                f"\n"
                f"📍 Entry:  {entry_v:.5f}\n"
                f"🏁 Exit:   {exit_v:.5f}\n"
                f"{rr_line}"
                f"💰 P/L:    <b>{profit:+.2f}</b>\n"
                f"🎫 Ticket: {p.ticket}"
            )
        else:
            log_event(f"[UNWIND] Close failed: retcode={retcode} "
                      f"comment={getattr(res,'comment','?') if res else 'None'}")


# ════════════════════════════════════════════════════════════════════════════════
# MANAGER LOOP  — position management (Layers 1 & 2) + daily report
# ════════════════════════════════════════════════════════════════════════════════

async def manager_loop():
    last_report_day = None
    rep_hh, rep_mm  = parse_hhmm(DAILY_REPORT_SEND_TIME)
    _mt5_was_down   = False
    _mt5_fail_count = 0

    log_event("[MANAGER] Manager loop started.")

    while True:
        # Weekend guard
        if datetime.now(timezone.utc).weekday() >= 5:
            await asyncio.sleep(60)
            continue

        try:
            async with MT5_ASYNC_LOCK:
                state         = await asyncio.to_thread(load_state)
                notifications = await asyncio.to_thread(manage_positions_once, state)

            if _mt5_was_down:
                log_event("[MT5] Connection recovered.")
                if EXECUTION_CHAT_ID:
                    await safe_send(int(EXECUTION_CHAT_ID),
                        f"✅ MT5 connection RECOVERED — {INSTANCE_NAME} is trading again.")
                _mt5_was_down   = False
                _mt5_fail_count = 0

            for msg in notifications:
                if EXECUTION_CHAT_ID:
                    await safe_send(int(EXECUTION_CHAT_ID), msg)

        except Exception:
            _mt5_fail_count += 1
            log_event("[MANAGER] Exception:\n" + traceback.format_exc())
            if not _mt5_was_down or _mt5_fail_count % 60 == 0:
                if EXECUTION_CHAT_ID:
                    await safe_send(int(EXECUTION_CHAT_ID),
                        f"⚠️ <b>MT5 issue</b> — {INSTANCE_NAME} manager exception.\nCheck the terminal.")
            _mt5_was_down = True

        # ── Daily report ───────────────────────────────────────────────────
        if DAILY_REPORT_ENABLED:
            now   = datetime.now()
            today = now.date()
            if now.hour > rep_hh or (now.hour == rep_hh and now.minute >= rep_mm):
                if last_report_day != today:
                    # Afternoon report (≥12) covers today; midnight covers yesterday
                    report_day = today.isoformat() if rep_hh >= 12 else (today - timedelta(days=1)).isoformat()
                    st  = load_state()
                    msg = format_daily_report(st, report_day)
                    log_event(msg.replace("\n", " | "))
                    if DAILY_REPORT_CHAT_ID:
                        try:
                            await safe_send(int(DAILY_REPORT_CHAT_ID), msg)
                            log_event("📤 Daily report sent.")
                        except Exception:
                            log_event("Daily report send failed:\n" + traceback.format_exc())
                    last_report_day = today

        await asyncio.sleep(MANAGER_INTERVAL_SECONDS)


# ════════════════════════════════════════════════════════════════════════════════
# DAILY REPORT
# ════════════════════════════════════════════════════════════════════════════════

def format_daily_report(state: dict, day_str: str) -> str:
    b = state.get("daily_stats", {}).get(day_str, {})

    tot_trades  = int(b.get("trades",    0))
    tot_wins    = int(b.get("wins",      0))
    tot_losses  = int(b.get("losses",    0))
    tot_be_plus = int(b.get("be_plus",   0))
    tot_be      = int(b.get("breakeven", 0))
    tot_profit  = float(b.get("profit",  0.0))

    pnl_sign = "+" if tot_profit >= 0 else ""
    denom    = tot_wins + tot_losses
    winrate  = (tot_wins / denom * 100.0) if denom > 0 else 0.0

    # Account snapshot
    acc_line = ""
    try:
        mt5_connect()
        acc = mt5.account_info()
        if acc:
            acc_line = (
                f"💼 Balance: <b>${acc.balance:.2f}</b>  "
                f"Equity: <b>${acc.equity:.2f}</b>"
            )
        mt5_disconnect()
    except Exception:
        pass

    lines = [
        "📊 <b>End-of-Day Report</b>",
        f"📡 {INSTANCE_NAME}",
        f"📅 {day_str}",
        "",
    ]

    if tot_trades > 0:
        lines += [
            f"🔢 Trades: <b>{tot_trades}</b>  "
            f"({tot_wins}W / {tot_losses}L / {tot_be_plus}BE+ / {tot_be}BE)",
            f"💰 P&L: <b>{pnl_sign}{tot_profit:.2f}</b>",
            f"🎯 Win rate: <b>{winrate:.1f}%</b>",
            "",
        ]
    else:
        lines += ["ℹ️ No trades logged today.", ""]

    if acc_line:
        lines += [acc_line, ""]

    lines += [
        "📈 <b>Strategy</b>",
        f"MACD({MACD_FAST},{MACD_SLOW},{MACD_SIGNAL_PERIOD}) on {MACD_TIMEFRAME}",
        f"H1 trend filter: {'✅ ON' if H1_FILTER_ENABLED else '❌ OFF'}  "
        f"Zero-line filter: {'✅ ON' if ZERO_LINE_FILTER_ENABLED else '❌ OFF'}",
        f"Exit: Scalp lock → ATR trail → MACD unwind",
    ]

    return "\n".join(lines).rstrip()


# ════════════════════════════════════════════════════════════════════════════════
# BOT COMMAND HANDLER  (Telethon — receives /commands via bot token)
# ════════════════════════════════════════════════════════════════════════════════

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
            log_event(f"[BOT CMD] Command interface active. Chat: {CONTROL_CHAT_ID}")
            await self._send(
                f"🤖 <b>{INSTANCE_NAME} is ONLINE</b>\n\n"
                f"MACD({MACD_FAST},{MACD_SLOW},{MACD_SIGNAL_PERIOD}) on {MACD_TIMEFRAME} | "
                f"H1 filter {'✅' if H1_FILTER_ENABLED else '❌'}\n\n"
                f"Send /help to see commands."
            )
        except Exception as e:
            log_event(f"[BOT CMD] Failed to start: {e}")
            self.bot_client = None

    def _auth(self, event) -> bool:
        try:
            return str(event.chat_id) == CONTROL_CHAT_ID
        except Exception:
            return False

    async def _send(self, text: str):
        try:
            await self.bot_client.send_message(int(CONTROL_CHAT_ID), text, parse_mode="html")
        except Exception:
            log_event("[BOT CMD] Send failed:\n" + traceback.format_exc())

    def _register(self):

        @self.bot_client.on(events.NewMessage(pattern=r"^/help"))
        async def _(event):
            if not self._auth(event): return
            await self._send(
                f"📋 <b>{INSTANCE_NAME} Commands</b>\n\n"
                "/status  — Bot state, open trades, today's P&L\n"
                "/pause   — Stop opening new positions\n"
                "/resume  — Re-enable signal processing\n"
                "/daily   — Today's full P&L breakdown\n"
                "/trades  — All open CNMS positions\n"
                "/stats   — Account snapshot\n"
                "/help    — Show this message"
            )

        @self.bot_client.on(events.NewMessage(pattern=r"^/status"))
        async def _(event):
            if not self._auth(event): return
            msg = await asyncio.to_thread(self._build_status)
            await self._send(msg)

        @self.bot_client.on(events.NewMessage(pattern=r"^/pause"))
        async def _(event):
            if not self._auth(event): return
            def _do():
                s = load_state(); s["manual_pause"] = True; save_state(s)
            await asyncio.to_thread(_do)
            await self._send(
                "⏸ <b>Trading PAUSED</b>\n\n"
                "No new signals will be executed.\n"
                "Open positions continue to be managed.\n\n"
                "Send /resume to re-enable."
            )
            log_event("[BOT CMD] Manual pause activated.")

        @self.bot_client.on(events.NewMessage(pattern=r"^/resume"))
        async def _(event):
            if not self._auth(event): return
            def _do():
                s = load_state(); s["manual_pause"] = False; save_state(s)
            await asyncio.to_thread(_do)
            await self._send("▶️ <b>Trading RESUMED</b>\n\nBot is now accepting MACD signals.")
            log_event("[BOT CMD] Manual pause cleared.")

        @self.bot_client.on(events.NewMessage(pattern=r"^/daily"))
        async def _(event):
            if not self._auth(event): return
            msg = await asyncio.to_thread(self._build_daily)
            await self._send(msg)

        @self.bot_client.on(events.NewMessage(pattern=r"^/trades"))
        async def _(event):
            if not self._auth(event): return
            msg = await asyncio.to_thread(self._build_trades)
            await self._send(msg)

        @self.bot_client.on(events.NewMessage(pattern=r"^/stats"))
        async def _(event):
            if not self._auth(event): return
            msg = await asyncio.to_thread(self._build_stats)
            await self._send(msg)

    # ── Status builders (run sync in thread) ─────────────────────────────────

    def _build_status(self) -> str:
        s      = load_state()
        paused = "⏸ PAUSED" if s.get("manual_pause") else "▶️ RUNNING"
        b      = get_day_bucket(s)
        profit = float(b.get("profit", 0.0))
        pnl_s  = f"+{profit:.2f}" if profit >= 0 else f"{profit:.2f}"

        try:
            mt5_connect()
            poss      = mt5.positions_get() or []
            cnms_poss = [p for p in poss if getattr(p, "magic", None) == MAGIC]
            n_open    = len(cnms_poss)
            live_pnl  = sum(float(p.profit) for p in cnms_poss)
            mt5_disconnect()
        except Exception:
            n_open = 0; live_pnl = 0.0

        return (
            f"📊 <b>{INSTANCE_NAME} Status</b>\n\n"
            f"State:          <b>{paused}</b>\n"
            f"Open positions: <b>{n_open}</b>  (live P&L: {live_pnl:+.2f})\n"
            f"Traded today:   <b>{trades_opened_today(s)}</b>\n"
            f"Today's P&L:    <b>{pnl_s}</b>\n\n"
            f"📈 MACD({MACD_FAST},{MACD_SLOW},{MACD_SIGNAL_PERIOD}) on {MACD_TIMEFRAME}\n"
            f"H1 filter: {'✅' if H1_FILTER_ENABLED else '❌'}  "
            f"Zero-line: {'✅' if ZERO_LINE_FILTER_ENABLED else '❌'}\n"
            f"Symbols: {', '.join(SYMBOLS)}"
        )

    def _build_daily(self) -> str:
        s = load_state()
        return format_daily_report(s, day_key())

    def _build_trades(self) -> str:
        try:
            mt5_connect()
            poss      = mt5.positions_get() or []
            cnms_poss = [p for p in poss if getattr(p, "magic", None) == MAGIC]
            mt5_disconnect()
        except Exception:
            return "⚠️ Could not fetch positions."

        if not cnms_poss:
            return "📭 No open CNMS positions."

        lines = [f"📂 <b>{INSTANCE_NAME} Open Positions</b>\n"]
        for p in cnms_poss:
            side_str = "BUY" if p.type == 0 else "SELL"
            icon     = "🟢" if p.type == 0 else "🔴"
            pnl      = float(p.profit)
            pnl_s    = f"+{pnl:.2f}" if pnl >= 0 else f"{pnl:.2f}"
            lines.append(
                f"{icon} {p.symbol} {side_str}\n"
                f"  Ticket: {p.ticket}  Lots: {p.volume:.2f}\n"
                f"  Entry: {p.price_open:.4f}  SL: {p.sl:.4f}\n"
                f"  P&L: <b>{pnl_s}</b>"
            )
        return "\n\n".join(lines)

    def _build_stats(self) -> str:
        try:
            mt5_connect()
            acc = mt5.account_info()
            mt5_disconnect()
        except Exception:
            acc = None
        if acc is None:
            return "⚠️ MT5 unavailable."
        return (
            f"💼 <b>{INSTANCE_NAME} Account</b>\n\n"
            f"Balance:  <b>${acc.balance:.2f}</b>\n"
            f"Equity:   <b>${acc.equity:.2f}</b>\n"
            f"Margin:   ${acc.margin:.2f}\n"
            f"Free:     ${acc.margin_free:.2f}\n"
            f"Mode:     {ACCOUNT_MODE}"
        )

    async def run(self):
        if self.bot_client:
            await self.bot_client.run_until_disconnected()


# ════════════════════════════════════════════════════════════════════════════════
# SHUTDOWN
# ════════════════════════════════════════════════════════════════════════════════

async def _shutdown(tasks: list, cmd_handler: "BotCommandHandler"):
    """
    Cancel all running tasks, save state, disconnect MT5, and send a farewell
    Telegram message. Called from main() whether shutdown is triggered by a
    signal handler or a KeyboardInterrupt.
    """
    log_event(f"[SHUTDOWN] Shutting down {INSTANCE_NAME} cleanly…")

    # 1. Cancel every task and wait for them to finish
    for t in tasks:
        if not t.done():
            t.cancel()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for r in results:
        if isinstance(r, Exception) and not isinstance(r, asyncio.CancelledError):
            log_event(f"[SHUTDOWN] Task error during teardown: {r}")

    # 2. Gracefully disconnect the Telethon bot client
    try:
        if cmd_handler.bot_client:
            await cmd_handler.bot_client.disconnect()
            log_event("[SHUTDOWN] Telethon bot client disconnected.")
    except Exception:
        pass

    # 3. Save state one final time
    try:
        save_state(load_state())
        log_event("[SHUTDOWN] State saved.")
    except Exception:
        log_event("[SHUTDOWN] State save failed:\n" + traceback.format_exc())

    # 4. Disconnect MT5
    try:
        mt5_disconnect()
        log_event("[SHUTDOWN] MT5 disconnected.")
    except Exception:
        pass

    # 5. Send farewell Telegram message (best-effort — don't crash if offline)
    if EXECUTION_CHAT_ID and BOT_TOKEN:
        try:
            await safe_send(
                int(EXECUTION_CHAT_ID),
                f"🔴 <b>{INSTANCE_NAME} OFFLINE</b>\n\nBot shut down cleanly."
            )
        except Exception:
            pass

    log_event(f"[SHUTDOWN] {INSTANCE_NAME} stopped.")


# ════════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════════

async def main():
    log_event(
        f"\n{'='*60}\n"
        f"  {INSTANCE_NAME} — CryptoNite MACD Signals\n"
        f"  Symbols  : {', '.join(SYMBOLS)}\n"
        f"  MACD     : ({MACD_FAST},{MACD_SLOW},{MACD_SIGNAL_PERIOD}) on {MACD_TIMEFRAME}\n"
        f"  H1 filter: {H1_FILTER_ENABLED}  Zero-line: {ZERO_LINE_FILTER_ENABLED}\n"
        f"  Exit     : scalp_lock={SCALP_LOCK_ENABLED}  "
        f"atr_trail={ATR_TRAIL_ENABLED}  macd_unwind={MACD_UNWIND_ENABLED}\n"
        f"  Risk     : {'FIXED_LOT='+str(FIXED_LOT) if USE_FIXED_LOT else 'RISK_BASE='+str(RISK_BASE)}\n"
        f"  Mode     : {ACCOUNT_MODE}  live={LIVE_MODE}\n"
        f"{'='*60}"
    )

    # ── Startup Telegram announcement ────────────────────────────────────────
    if EXECUTION_CHAT_ID and BOT_TOKEN:
        await safe_send(
            int(EXECUTION_CHAT_ID),
            f"🚀 <b>{INSTANCE_NAME} ONLINE</b>\n\n"
            f"MACD({MACD_FAST},{MACD_SLOW},{MACD_SIGNAL_PERIOD}) on {MACD_TIMEFRAME}\n"
            f"H1 filter: {'✅' if H1_FILTER_ENABLED else '❌'}  "
            f"Symbols: {', '.join(SYMBOLS)}\n"
            f"Risk: {'fixed ' + str(FIXED_LOT) + ' lot' if USE_FIXED_LOT else str(RISK_BASE*100) + '% per trade'}"
        )

    # ── Recover orphaned positions from a previous crash ─────────────────────
    try:
        _st = load_state()
        if mt5_connect():
            _n = _recover_orphan_positions(_st)
            if _n > 0:
                save_state(_st)
                log_event(f"[RECOVER] {_n} position(s) re-adopted into managed_positions.")
                if EXECUTION_CHAT_ID and BOT_TOKEN:
                    await safe_send(
                        int(EXECUTION_CHAT_ID),
                        f"♻️ <b>{INSTANCE_NAME} — {_n} orphaned position(s) recovered</b>\n"
                        f"Scalp lock / ATR trail / MACD unwind monitoring has resumed."
                    )
    except Exception:
        log_event("[RECOVER] Startup position recovery failed:\n" + traceback.format_exc())

    # ── Shutdown event — set by OS signal handlers ────────────────────────────
    shutdown_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, shutdown_event.set)
        except (NotImplementedError, RuntimeError):
            # Windows: add_signal_handler not supported — KeyboardInterrupt
            # will be caught by the except block below instead.
            pass

    # ── Start command bot ────────────────────────────────────────────────────
    cmd_handler = BotCommandHandler()
    await cmd_handler.start()

    # ── Launch background tasks ───────────────────────────────────────────────
    tasks = [
        asyncio.create_task(signal_loop(),   name="signal_loop"),
        asyncio.create_task(manager_loop(),  name="manager_loop"),
    ]
    if cmd_handler.bot_client:
        tasks.append(asyncio.create_task(cmd_handler.run(), name="bot_commands"))

    # ── Run until a shutdown signal arrives ───────────────────────────────────
    try:
        await shutdown_event.wait()
        log_event("[MAIN] Shutdown event received.")
    except (asyncio.CancelledError, KeyboardInterrupt):
        log_event("[MAIN] KeyboardInterrupt / CancelledError — shutting down.")
    finally:
        await _shutdown(tasks, cmd_handler)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        # Ctrl-C on Windows before the event loop picks it up
        pass
