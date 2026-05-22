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
    (["XAUUSD", "XAU/USD", "GOLD"],         "XAUUSD"),
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
# MAIN ENTRY POINT
# Called from main.py for every Telegram message.
# =========================
def parse_signal_by_source(chat_id: str, text: str):
    """
    Look up the parser mode configured for this channel, then delegate
    to parse_signal() with the correct mode.

    Returns a signal dict on success, None if the message isn't a signal.
    """
    mode = settings.get_parser_mode(str(chat_id))
    log(f"[PARSER] Channel {chat_id} → mode: {mode}", "INFO")
    return parse_signal(text, mode, chat_id)


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

    # Extract labelled numbers
    entry = _extract_labelled(text, ["ENTRY", "PRICE", "AT"])
    sl    = _extract_labelled(text, ["SL", "STOP", "STOPLOSS"])

    # Collect all TP levels (TP1, TP2, TP3... or just TP)
    tp_levels = []
    for match in re.finditer(r"TP\d*\s*[:\-]?\s*([\d]+\.?[\d]*)", text):
        try:
            tp_levels.append(float(match.group(1)))
        except ValueError:
            pass

    # Also try generic TP label if no numbered TPs found
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
# Handles compact one-liner formats:
#
#   XAUUSD BUY 1920.50 SL 1910 TP 1940
#   GOLD SELL @ 1925 / SL 1935 / TP 1905
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

    # Try to find SL and TP by keyword position
    sl = _extract_labelled(text, ["SL", "STOP"])
    tp = _extract_labelled(text, ["TP", "TARGET"])

    if not sl or not tp:
        # Fallback: assume 1st = entry, 2nd = sl, 3rd = tp
        if len(numbers) >= 3:
            entry, sl, tp = numbers[0], numbers[1], numbers[2]
        else:
            return None
    else:
        # Entry is any number that isn't sl or tp
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
# Handles immediate-execution signals:
#
#   XAUUSD BUY NOW
#   GOLD SELL MARKET
#   BUY BTC ASAP
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
    """
    Find a number following one of the given label keywords.
    e.g. _extract_labelled(text, ["SL", "STOP"]) finds the number after "SL:" or "SL "
    """
    for label in labels:
        pattern = label + r"\s*[:\-]?\s*([\d]+\.?[\d]*)"
        match = re.search(pattern, text)
        if match:
            try:
                return float(match.group(1))
            except ValueError:
                continue
    return None
