"""
parser.py - Signal Parsing Engine

Converts raw Telegram message text into a structured signal dict.

Parser modes (configured per-channel in .env via CHANNEL_ROUTING):
  auto         - try all three strategies in order (default)
  structured   - only try the ASSET/ENTRY/SL/TP label format
  inline       - only try the compact one-liner format
  market_only  - only try BUY/SELL NOW patterns
  strict       - structured only; returns None if incomplete

A parsed signal dict looks like:
  {
    "symbol":         "XAUUSD",
    "side":           "BUY",
    "entry":          1920.50,
    "sl":             1910.00,
    "tp":             1940.00,
    "tp_levels":      [1930.00, 1940.00, 1955.00],
    "type":           "NORMAL",   # or "MARKET"
    "source_channel": "-100123456",
  }
"""

import re
from logger import log
from config import settings

# -----------------------------------------------------------------------
# COMMENTARY FILTER — messages that contain a symbol+side phrase but are NOT
# trade signals.  These are checked before any parser runs and cause an early
# return of None so they are never accidentally executed.
# -----------------------------------------------------------------------
_COMMENTARY_RE = re.compile(
    r"""
    # Question / status phrases that precede or follow a symbol+side mention
    (?:\bARE\s+WE\s+(?:ALL\s+)?IN\b)              # "Are we all in Gold buy"
    |(?:\bWITHIN\s+(?:THE\s+)?ENTRY\s+ZONE\b)     # "Within entry zone XAUUSD Buy"
    |(?:\bNOW\s+ACTIVE\b)                          # "Now active — entry zone..."
    |(?:\bRESULTS?\s+SO\s+FAR\b)                   # "Today's results so far"
    |(?:\bTODAY['']?S\s+RESULTS?\b)                # "Today's results"
    # symbol+side followed immediately by a +/- pnl number — always a results summary
    |(?:(?:XAU(?:USD)?|GOLD|GBPJPY|EURUSD)\s+(?:BUY|SELL)\s+[+\-]\d)
    # Generic commentary starters
    |(?:\bGOOD\s+MORNING\b)
    |(?:\bGOOD\s+LUCK\b)
    |(?:\bGET\s+READY\b)
    |(?:\bWHO\s+(?:TOOK|IS\s+IN)\b)
    |(?:\bWAITING\s+FOR\s+(?:A\s+)?CONFIRMATION\b)
    |(?:\bI['']?M\s+SEEING\s+(?:BUYS|SELLS)\b)
    |(?:\bWE\s+(?:ARE|WERE)\s+(?:NOW\s+)?(?:IN\s+)?(?:PROFIT|PIPS?)\b)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)


# =========================
# CHANNEL -> PARSER PROFILE
# Channels with non-standard formats get their own parser list that runs
# BEFORE the generic auto fallback so their signals are caught first.
# =========================
_CHANNEL_PROFILES = {
    # Free TAG Signals -- several formats observed:
    #   "XAUUSD 3320-3310 buy"  (symbol-first, side-last)
    #   "BUY GOLD 3320-3310"    (side-first)
    #   "GOLD BUY 3320-3310"    (symbol+side adjacent, then range)
    #   "Liking buys ... 3320-3310"
    #   Also forwards CryptoNite icon signals
    "-1002717527369": ["cryptonite_icon", "tag_range", "gold_range", "liking_range", "auto"],
    # Limitless 2.0 — posts direction first ("XAU USD SELL"), setup details in a follow-up.
    # "directional" fires on symbol+side alone and executes immediately at market price
    # using bot ATR-calculated SL/TP/trail — no need to wait for the setup message.
    "-1003882026187": ["limitless_emoji", "directional", "auto"],  # emoji FIRST — captures zone+TP+SL before directional steals it
    # Limitless Abundance VIP -- directional fires on bare "XAUUSD Buy now" immediately;
    #   limitless_vip_pipe then captures the follow-up full pipe signal (Direction|Currency|ENTRY|TP|SL)
    "-1003889406756": ["directional", "limitless_vip_pipe", "cryptonite_icon", "limitless_full", "limitless_market", "gold_range", "auto"],
    # Limitless Abundance Free -- same format as VIP
    "-1003731092037": ["cryptonite_icon", "limitless_vip_pipe", "limitless_full", "limitless_market", "gold_range", "auto"],
}

# -----------------------------------------------------------------------
# TAG RANGE: "XAUUSD 3320-3310 buy" / "XAUUSD | 3325.5-3310 | sell"
# -----------------------------------------------------------------------
_TAG_RANGE_RE = re.compile(
    r"""
    ^\s*
    (?P<symbol>XAU(?:USD)?|GOLD|BTC(?:USD)?|NAS(?:DAQ|100)?|US30|GER\d*|EUR(?:USD)?|GBP(?:USD)?)
    \s*(?:\|\s*)?
    (?P<z1>\d{3,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{3,5}(?:\.\d+)?)
    \s*(?:\|\s*)?
    (?P<side>BUY|SELL)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# -----------------------------------------------------------------------
# LIKING RANGE: "Liking buys | 3320-3310 | XAUUSD buy"
#               "Liking sells | 3320-3340 XAUUSD"
#               "Liking buys again XAUUSD | 3320-3310"
# -----------------------------------------------------------------------
_LIKING_RANGE_RE = re.compile(
    r"""
    (?:liking|like)\s+(?P<side>buy(?:s)?|sell(?:s)?)
    .*?
    (?P<z1>\d{3,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{3,5}(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# GOLD RANGE (side-first or symbol+adjacent-side):
#   "BUY GOLD 3320-3310"  /  "GOLD BUY 3320-3310"  /  "BUY XAUUSD 3320-3310"
# Complements tag_range (symbol-first, side-last).
# -----------------------------------------------------------------------
_GOLD_RANGE_RE = re.compile(
    r"""
    (?:(?P<side1>BUY|SELL)\s+(?:GOLD|XAU(?:USD)?)|(?:GOLD|XAU(?:USD)?)\s+(?P<side2>BUY|SELL))
    (?:\s+NOW)?\s*@?\s*
    (?P<z1>\d{3,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{3,5}(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# CRYPTONITE ICON FORMAT:
#   "CryptoNite Signal | XAUUSD | BUY | Entry: X | SL: X | TP: X"
# -----------------------------------------------------------------------
_CRYPTONITE_ICON_RE = re.compile(
    r"(?:[\U0001F4C8\U0001F4C9])\s*(?P<symbol>[A-Z0-9./]+)\s*[|\n]\s*(?P<side>BUY|SELL)"
    r".*?\U0001F4CD\s*Entry:\s*(?P<entry>[\d.]+)"
    r".*?\U0001F6D1\s*SL:\s*(?P<sl>[\d.]+)"
    r".*?\U0001F3AF\s*TP:\s*(?P<tp>[\d.]+)",
    re.IGNORECASE | re.DOTALL,
)

# -----------------------------------------------------------------------
# LIMITLESS FULL:
# "Sell Gold 3320 - 3310 | Stop Loss 3325 | TP1 3305 | TP2 3300 | TP3 3295"
# -----------------------------------------------------------------------
_LIMITLESS_FULL_RE = re.compile(
    r"""
    # Allow emoji/headers before BUY/SELL line -- use search not match
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
# LIMITLESS MARKET: "Sell market | XAUUSD | 3320-3310"
# More permissive pipe handling -- allows optional text between pipes.
# -----------------------------------------------------------------------
_LIMITLESS_MARKET_RE = re.compile(
    r"""
    (?P<side>BUY|SELL)\s+MARKET\s*
    (?:\|[^|]*)?\|?\s*
    (?:XAU(?:USD)?|GOLD)\s*
    (?:\|[^|]*)?\|?\s*
    (?P<z1>\d{3,5}(?:\.\d+)?)\s*[-]\s*(?P<z2>\d{3,5}(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)

# -----------------------------------------------------------------------
# DIRECTIONAL — fires on symbol + BUY/SELL alone, no price required.
# Used for channels (e.g. Limitless 2.0) that post direction first, setup later.
# Executes immediately at market price using bot's own ATR-calculated SL/TP/trail.
#   "XAU USD SELL"  /  "XAUUSD BUY"  /  "GOLD SELL"  /  "BUY XAUUSD"
# -----------------------------------------------------------------------
_DIRECTIONAL_RE = re.compile(
    r"""
    (?:
        \b(?P<sym1>XAU(?:USD)?|XAUEUR|GOLD|GBP(?:JPY|USD|CHF)?|EUR(?:USD|JPY|GBP)?|USD(?:JPY|CHF|CAD)?|AUD(?:USD|JPY)?|NZD(?:USD)?|BTC(?:USD)?|NAS(?:DAQ|100)?|US30)\b
        [\s,|]*
        (?P<side1>BUY|SELL)\b
    |
        \b(?P<side2>BUY|SELL)\b
        [\s,|]*
        \b(?P<sym2>XAU(?:USD)?|XAUEUR|GOLD|GBP(?:JPY|USD|CHF)?|EUR(?:USD|JPY|GBP)?|USD(?:JPY|CHF|CAD)?|AUD(?:USD|JPY)?|NZD(?:USD)?|BTC(?:USD)?|NAS(?:DAQ|100)?|US30)\b
    )
    """,
    re.IGNORECASE | re.VERBOSE,)

# -----------------------------------------------------------------------
# LIMITLESS EMOJI (Limitless Abundance 2.0):
#   "XAUUSD SELL NOW4537.50-4541.50🥇TP1 4535🥈TP2 4533🥉TP3 4531🏅TP4 4529TP5 4525"
#   "XAUUSD BUY NOW4537-4533🥇TP1 4540🥈TP2 4542🥉TP3 4544🏅TP4 4546TP5 4550🚫SL 4527"
# Must run BEFORE directional — directional would steal the signal and lose zone/TP/SL.
# -----------------------------------------------------------------------
_LIMITLESS_EMOJI_RE = re.compile(
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
# LIMITLESS VIP PIPE:
#   "Direction BUY | Currency: XAUUSD | ENTRY: 4690-4688 | TP1: 4691 | TP2: 4692"
# No SL provided — executor auto-calculates via build_market_levels().
# -----------------------------------------------------------------------
_LIMITLESS_VIP_PIPE_RE = re.compile(
    r"""
    (?:direction|dir)\s*[:|]\s*(?P<side>BUY|SELL)
    .*?
    (?:currency|asset|symbol|instrument)\s*[:|]\s*(?P<symbol>[A-Z0-9]+(?:/[A-Z0-9]+)?)
    .*?
    (?:entry|enter)\s*[:|]\s*(?P<z1>\d{3,5}(?:\.\d+)?)\s*[-–]\s*(?P<z2>\d{3,5}(?:\.\d+)?)
    """,
    re.IGNORECASE | re.DOTALL | re.VERBOSE,
)


# =========================
# SYMBOL MAP
# Order matters - more specific entries should come first.
# Add new instruments here without changing anything else.
# =========================
SYMBOL_MAP = [
    # Crypto
    (["BTCUSD", "BTC/USD", "BITCOIN"],      "BTCUSD"),
    (["ETHUSD", "ETH/USD", "ETHEREUM"],     "ETHUSD"),
    (["LTCUSD", "LTC/USD", "LITECOIN"],     "LTCUSD"),
    (["XRPUSD", "XRP/USD", "RIPPLE"],       "XRPUSD"),
    (["BNBUSD", "BNB/USD"],                 "BNBUSD"),
    (["SOLUSD", "SOL/USD", "SOLANA"],       "SOLUSD"),
    (["DOGEUSD", "DOGE/USD", "DOGECOIN"],   "DOGEUSD"),

    # Metals
    (["XAUUSD", "XAU/USD", "XAU USD", "GOLD"],  "XAUUSD"),
    (["XAGUSD", "XAG/USD", "SILVER"],       "XAGUSD"),

    # Indices
    (["NAS100", "NASDAQ", "NAS", "NDX"],    "NAS100"),
    (["US30", "DOW", "DJIA"],               "US30"),
    (["SPX500", "SP500", "S&P"],            "SPX500"),
    (["GER40", "DAX", "GER30"],             "GER40"),
    (["UK100", "FTSE"],                     "UK100"),

    # Forex majors
    (["EURUSD", "EUR/USD"],                 "EURUSD"),
    (["GBPUSD", "GBP/USD", "CABLE"],        "GBPUSD"),
    (["USDJPY", "USD/JPY"],                 "USDJPY"),
    (["USDCHF", "USD/CHF"],                 "USDCHF"),
    (["AUDUSD", "AUD/USD"],                 "AUDUSD"),
    (["NZDUSD", "NZD/USD"],                 "NZDUSD"),
    (["USDCAD", "USD/CAD"],                 "USDCAD"),

    # Forex crosses
    (["GBPJPY", "GBP/JPY"],                 "GBPJPY"),
    (["EURJPY", "EUR/JPY"],                 "EURJPY"),
    (["EURGBP", "EUR/GBP"],                 "EURGBP"),
    (["GBPCHF", "GBP/CHF"],                 "GBPCHF"),
    (["CADJPY", "CAD/JPY"],                 "CADJPY"),
    (["AUDCHF", "AUD/CHF"],                 "AUDCHF"),
    (["AUDCAD", "AUD/CAD"],                 "AUDCAD"),
    (["AUDNZD", "AUD/NZD"],                 "AUDNZD"),

    # Oil
    (["XTIUSD", "WTI", "CRUDEOIL", "OIL"], "XTIUSD"),
    (["XBRUSD", "BRENT"],                   "XBRUSD"),
]


def extract_symbol(text: str):
    """Scan uppercased text against SYMBOL_MAP. Returns MT5 symbol or None."""
    for keywords, mt5_symbol in SYMBOL_MAP:
        for kw in keywords:
            if kw in text:
                return mt5_symbol
    return None


def extract_numbers(text: str):
    """Pull all decimal/integer numbers from text. Returns list of floats."""
    return [float(n) for n in re.findall(r"\d+\.?\d*", text)]


# =========================
# CHANNEL-SPECIFIC PARSERS
# =========================

def _try_parse_tag_range(text: str):
    """TAG: 'XAUUSD 3320-3310 buy' / 'XAUUSD | 3325.5-3310 | sell'"""
    m = _TAG_RANGE_RE.search(text)
    if not m:
        return None
    raw = m.group("symbol").upper().replace("/", "")
    symbol = extract_symbol(raw) or "XAUUSD"
    side = m.group("side").upper()
    z1, z2 = float(m.group("z1")), float(m.group("z2"))
    entry = (z1 + z2) / 2
    return {"symbol": symbol, "side": side, "entry": entry, "sl": 0, "tp": 0,
            "tp_levels": [], "type": "MARKET"}


def _try_parse_liking_range(text: str):
    """TAG: 'Liking buys guys ... 3320-3310 XAUUSD' (multi-line OK via DOTALL)"""
    m = _LIKING_RANGE_RE.search(text)
    if not m:
        return None
    raw_side = m.group("side").upper()
    side = "BUY" if raw_side.startswith("BUY") else "SELL"
    z1, z2 = float(m.group("z1")), float(m.group("z2"))
    entry = (z1 + z2) / 2
    sym_m = re.search(r"\b(XAU(?:USD)?|GOLD|BTC(?:USD)?|NAS(?:100)?|US30)\b",
                      text, re.IGNORECASE)
    symbol = extract_symbol((sym_m.group(1) if sym_m else "XAUUSD").upper()) or "XAUUSD"
    return {"symbol": symbol, "side": side, "entry": entry, "sl": 0, "tp": 0,
            "tp_levels": [], "type": "MARKET"}


def _try_parse_gold_range(text: str):
    """Side-first or symbol+adjacent-side gold range: 'BUY GOLD 3320-3310' / 'GOLD BUY 3320-3310'"""
    m = _GOLD_RANGE_RE.search(text)
    if not m:
        return None
    side = (m.group("side1") or m.group("side2") or "").upper()
    if not side:
        return None
    z1, z2 = float(m.group("z1")), float(m.group("z2"))
    entry = (z1 + z2) / 2
    return {"symbol": "XAUUSD", "side": side, "entry": entry, "sl": 0, "tp": 0,
            "tp_levels": [], "type": "MARKET"}


def _try_parse_cryptonite_icon(text: str):
    """CryptoNite icon format: emoji XAUUSD | BUY | Entry: X | SL: X | TP: X"""
    m = _CRYPTONITE_ICON_RE.search(text)
    if not m:
        return None
    raw = m.group("symbol").upper().replace("/", "")
    symbol = extract_symbol(raw) or "XAUUSD"
    side   = m.group("side").upper()
    entry  = float(m.group("entry"))
    sl     = float(m.group("sl"))
    tp     = float(m.group("tp"))
    return {"symbol": symbol, "side": side, "entry": entry, "sl": sl,
            "tp": tp, "tp_levels": [tp], "type": "NORMAL"}


def _try_parse_limitless_full(text: str):
    """Limitless: 'Sell Gold 3320 - 3310 | Stop Loss 3325 | TP1 3305 | TP2 3300 | TP3 3295'"""
    m = _LIMITLESS_FULL_RE.search(text)
    if not m:
        return None
    side = m.group("side").upper()
    z1, z2 = float(m.group("z1")), float(m.group("z2"))
    entry = (min(z1, z2) + max(z1, z2)) / 2
    sl   = float(m.group("sl"))
    tp1  = float(m.group("tp1"))
    tp2  = float(m.group("tp2"))
    tp3  = float(m.group("tp3"))
    tp4_m = re.search(r"TP4\s+Open\s*\(\s*(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    tp4 = float(tp4_m.group(1)) if tp4_m else tp3
    return {"symbol": "XAUUSD", "side": side, "entry": entry, "sl": sl,
            "tp": tp1, "tp_levels": [tp1, tp2, tp3, tp4], "type": "NORMAL"}


def _try_parse_limitless_market(text: str):
    """Limitless: 'Sell market | XAUUSD | 3320-3310'"""
    m = _LIMITLESS_MARKET_RE.search(text)
    if not m:
        return None
    side = m.group("side").upper()
    z1, z2 = float(m.group("z1")), float(m.group("z2"))
    entry = (z1 + z2) / 2
    return {"symbol": "XAUUSD", "side": side, "entry": entry, "sl": 0, "tp": 0,
            "tp_levels": [], "type": "MARKET"}


def _try_parse_limitless_vip_pipe(text: str):
    """Limitless VIP: 'Direction BUY | Currency: XAUUSD | ENTRY: 4690-4688 | TP1: 4691 | TP2: 4692'
    No SL provided — sl=0 causes executor to auto-calculate via build_market_levels()."""
    m = _LIMITLESS_VIP_PIPE_RE.search(text)
    if not m:
        return None
    side   = m.group("side").upper()
    z1, z2 = float(m.group("z1")), float(m.group("z2"))
    entry  = (z1 + z2) / 2
    raw    = m.group("symbol").upper().replace("/", "")
    symbol = extract_symbol(raw) or "XAUUSD"
    # Collect any TP levels present — useful for context even though sl=0 triggers auto-calc
    tp_levels = [float(tp_m.group(1))
                 for tp_m in re.finditer(r"TP\d*\s*[:|]?\s*(\d{3,5}(?:\.\d+)?)", text, re.IGNORECASE)]
    tp = tp_levels[0] if tp_levels else 0
    return {"symbol": symbol, "side": side, "entry": entry, "sl": 0, "tp": tp,
            "tp_levels": tp_levels, "type": "MARKET"}


def _try_parse_limitless_emoji(text: str):
    """Handles Limitless Abundance 2.0 emoji format (input should be clean/upper):
    'XAUUSD SELL NOW4537.50-4541.50🥇TP1 4535🥈TP2 4533🥉TP3 4531'
    'XAUUSD BUY NOW4537-4533🥇TP1 4540🥈TP2 4542🥉TP3 4544🚫SL 4527'
    SL is optional — executor falls back to ATR SL when sl=0."""
    m = _LIMITLESS_EMOJI_RE.search(text)
    if not m:
        return None
    side = m.group("side").upper()
    z1 = float(m.group("z1")); z2 = float(m.group("z2"))
    zone_low, zone_high = min(z1, z2), max(z1, z2)
    tp1 = float(m.group("tp1")) if m.group("tp1") else 0.0
    tp2 = float(m.group("tp2")) if m.group("tp2") else tp1
    tp3 = float(m.group("tp3")) if m.group("tp3") else tp2
    sl  = float(m.group("sl"))  if m.group("sl")  else 0.0
    return {
        "symbol":    "XAUUSD",
        "side":      side,
        "entry":     zone_low,
        "sl":        sl,
        "tp":        tp1,
        "tp_levels": [tp1, tp2, tp3],
        "type":      "NORMAL",
    }


def _try_parse_directional(text: str):
    """Fires on symbol + BUY/SELL alone — no price, no 'MARKET' keyword required.
    Used for channels that post direction first and setup details later.
    Executes immediately at market price; bot's ATR-calculated SL/TP/trail take over.
    Examples: 'XAU USD SELL' / 'XAUUSD BUY' / 'GOLD SELL' / 'BUY XAUUSD'"""
    m = _DIRECTIONAL_RE.search(text)
    if not m:
        return None
    side   = (m.group("side1") or m.group("side2") or "").upper()
    sym    = (m.group("sym1")  or m.group("sym2")  or "").upper().replace(" ", "")
    if not side:
        return None
    symbol = extract_symbol(sym) or "XAUUSD"
    return {"symbol": symbol, "side": side, "entry": 0, "sl": 0, "tp": 0,
            "tp_levels": [], "type": "MARKET"}


# =========================
# MAIN ENTRY POINT
# Called from main.py for every Telegram message.
# =========================
def parse_signal_by_source(chat_id: str, text: str):
    """
    Check for a channel-specific parser profile first (TAG, Limitless etc.),
    then fall back to the mode configured in CHANNEL_ROUTING / DEFAULT_PARSER_MODE.

    Returns a signal dict on success, None if the message isn't a signal.
    """
    ch = str(chat_id)
    # Normalise Spanish direction words before any parser sees the text
    text = re.sub(r'\bventa\b', 'sell', text, flags=re.IGNORECASE)
    text = re.sub(r'\bcompra\b', 'buy',  text, flags=re.IGNORECASE)
    # Normalise "XAU USD" (space) → "XAUUSD" so all parsers see standard form
    text = re.sub(r'\bXAU\s+USD\b', 'XAUUSD', text, flags=re.IGNORECASE)
    upper = text.upper().strip()

    # Commentary / results-update messages — bail out before any parser runs.
    # These messages contain a symbol+side phrase but are NOT trade entries
    # (e.g. "Are we all in Gold buy", "Within entry zone", "results so far").
    if _COMMENTARY_RE.search(text):
        log(f"[PARSER] Channel {ch} — commentary message suppressed", "INFO")
        return None

    profile = _CHANNEL_PROFILES.get(ch)
    if profile:
        log(f"[PARSER] Channel {ch} -> profile: {profile}", "INFO")
        for step in profile:
            result = None
            if step == "cryptonite_icon":
                result = _try_parse_cryptonite_icon(text)  # preserve emoji (not uppercased)
            elif step == "tag_range":
                result = _try_parse_tag_range(upper)
            elif step == "gold_range":
                result = _try_parse_gold_range(upper)
            elif step == "liking_range":
                result = _try_parse_liking_range(upper)
            elif step == "limitless_emoji":
                result = _try_parse_limitless_emoji(text)
            elif step == "directional":
                result = _try_parse_directional(text.upper())
            elif step == "limitless_vip_pipe":
                result = _try_parse_limitless_vip_pipe(text)  # preserve case for Direction/Currency labels
            elif step == "limitless_full":
                result = _try_parse_limitless_full(text)   # preserve case for "Stop Loss"
            elif step == "limitless_market":
                result = _try_parse_limitless_market(upper)
            elif step == "auto":
                result = parse_signal(text, "auto", ch)
            if result:
                result["source_channel"] = ch
                log(f"[PARSER] Signal parsed via {step}: {result}", "INFO")
                return result
        log(f"[PARSER] No signal found for channel {ch}", "INFO")
        return None

    mode = settings.get_parser_mode(ch)
    log(f"[PARSER] Channel {ch} -> mode: {mode}", "INFO")
    return parse_signal(text, mode, ch)


def parse_signal(message: str, mode: str = "auto", chat_id: str = ""):
    """
    Route to the correct sub-parser based on mode.
    Attaches source_channel to the result so executor/manager can use it.
    """
    text = message.upper().strip()

    result = None

    if mode == "structured":
        result = _try_parse_structured(text)

    elif mode == "inline":
        result = _try_parse_inline(text)

    elif mode == "market_only":
        result = _try_parse_market_now(text)

    elif mode == "strict":
        result = _try_parse_structured(text)
        # strict mode: discard if any required field is missing
        if result and (not result.get("sl") or not result.get("tp_levels")):
            log("[PARSER] Strict mode: incomplete signal rejected", "INFO")
            return None

    else:   # auto - try all parsers in priority order
        result = _try_parse_structured(text)
        if not result:
            result = _try_parse_inline(text)
        if not result:
            result = _try_parse_market_now(text)

    if result:
        result["source_channel"] = str(chat_id)
        log(f"[PARSER] Signal parsed: {result}", "INFO")
    else:
        log(f"[PARSER] No signal found in message (mode={mode})", "INFO")

    return result


# =========================
# SUB-PARSER: STRUCTURED
# Handles the label-based format:
#
#   XAUUSD BUY
#   ENTRY: 1920.50
#   SL: 1910.00
#   TP1: 1930.00
#   TP2: 1945.00
#   TP3: 1960.00
# =========================
def _try_parse_structured(text: str):
    symbol = extract_symbol(text)
    if not symbol:
        return None

    if "BUY" in text:
        side = "BUY"
    elif "SELL" in text:
        side = "SELL"
    else:
        return None

    entry = _extract_labelled(text, ["ENTRY", "PRICE", "AT"])
    sl    = _extract_labelled(text, ["SL", "STOP", "STOPLOSS"])

    tp_levels = []
    for match in re.finditer(r"TP\d*\s*[:\-]?\s*([\d]+\.?[\d]*)", text):
        try:
            tp_levels.append(float(match.group(1)))
        except ValueError:
            pass

    if not tp_levels:
        tp = _extract_labelled(text, ["TP", "TARGET", "TAKE"])
        if tp:
            tp_levels = [tp]

    if not entry or not sl or not tp_levels:
        return None

    return {
        "symbol":    symbol,
        "side":      side,
        "entry":     entry,
        "sl":        sl,
        "tp":        tp_levels[0],
        "tp_levels": tp_levels,
        "type":      "NORMAL",
    }


# =========================
# SUB-PARSER: INLINE
# =========================
def _try_parse_inline(text: str):
    symbol = extract_symbol(text)
    if not symbol:
        return None

    if "BUY" in text:
        side = "BUY"
    elif "SELL" in text:
        side = "SELL"
    else:
        return None

    numbers = extract_numbers(text)
    if len(numbers) < 3:
        return None

    sl = _extract_labelled(text, ["SL", "STOP"])
    tp = _extract_labelled(text, ["TP", "TARGET"])

    if not sl or not tp:
        if len(numbers) >= 3:
            entry, sl, tp = numbers[0], numbers[1], numbers[2]
        else:
            return None
    else:
        remaining = [n for n in numbers if n != sl and n != tp]
        entry = remaining[0] if remaining else 0

    return {
        "symbol":    symbol,
        "side":      side,
        "entry":     entry,
        "sl":        sl,
        "tp":        tp,
        "tp_levels": [tp],
        "type":      "NORMAL",
    }


# =========================
# SUB-PARSER: MARKET NOW
# =========================
def _try_parse_market_now(text: str):
    market_keywords = ["NOW", "MARKET", "ASAP", "IMMEDIATELY", "INSTANT"]
    if not any(kw in text for kw in market_keywords):
        return None

    symbol = extract_symbol(text)
    if not symbol:
        return None

    if "BUY" in text:
        side = "BUY"
    elif "SELL" in text:
        side = "SELL"
    else:
        return None

    return {
        "symbol":    symbol,
        "side":      side,
        "entry":     0,
        "sl":        0,
        "tp":        0,
        "tp_levels": [],
        "type":      "MARKET",
    }


# =========================
# HELPER
# =========================
def _extract_labelled(text: str, labels: list):
    """Find a number following one of the given label keywords."""
    for label in labels:
        pattern = label + r"\s*[:\-]?\s*([\d]+\.?[\d]*)"
        match = re.search(pattern, text)
        if match:
            try:
                return float(match.group(1))
            except ValueError:
                continue
    return None
