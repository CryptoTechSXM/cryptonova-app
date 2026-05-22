"""
CryptoNite Free Signals Bot — Relaxed HA Strategy
===================================================
Asset:    XAUUSD (24/7, no session filter)
Strategy: Heikin-Ashi with relaxed parameters for higher signal frequency
Source:   Direct MT5 data pull (no CSV dependency)
Channel:  CryptoNite Free Signals (configured in .env)

RELAXED PARAMETERS vs the premium HA bots:
  - Doji threshold:   0.25   (premium: 0.15)
  - Pullback candles: 1      (premium: 2)
  - Wick tolerance:  15%     (premium: 5%)
  - Doji vol min:    70%     (premium: 85%)
  - H1 trend:        1 candle (premium: 2 consecutive)
  - Session:         24/7    (premium: session-filtered)

Backtest result (Monte Carlo, 1000 sims x 120 days):
  Win rate: 58% | R:R: 1.5:1 | EV: +0.45R/trade | 100% sims profitable
"""

import os
import time
import json
import logging
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

import MetaTrader5 as mt5
import pandas as pd

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv optional; fall back to os.environ / hardcoded


# ==========================================================
# CONFIG — edit here or via .env file
# ==========================================================
MT5_LOGIN    = int(os.getenv("MT5_LOGIN",  "0") or "0")
MT5_PASSWORD = os.getenv("MT5_PASSWORD",   "") or ""
MT5_SERVER   = os.getenv("MT5_SERVER",     "") or ""

BOT_TOKEN = os.getenv("BOT_TOKEN", "7716066914:AAEZATUSQXRRsTIO3xCIrYpNJ8dwzEnF1Iw")
CHAT_ID   = os.getenv("CHAT_ID",   "-1003523601209")

STRATEGY_LABEL = "Free"   # heading -> "CryptoNite Free Signals"
SILENT         = os.getenv("SILENT_MODE", "false").lower() == "true"

# Relaxed HA parameters
DOJI_THRESHOLD       = 0.25   # body/range < this -> doji  (Option B 2026-05-21, was 0.20)
DOJI_VOL_THRESHOLD   = 0.60   # doji range must be >= 60% of recent avg range (Option B 2026-05-21, was 0.70)
PULLBACK_N           = 2      # 2 HA pullback candles required (unchanged)
PULLBACK_WICK_TOL    = 0.15   # wick/range <= 15% counts as "clean" (unchanged)
ATR_PERIOD           = 14
EMA_PERIOD           = 100
ATR_SL_MULT          = 2.0    # SL = ATR x 2.0
ATR_TP_MULT          = 3.0    # TP = ATR x 3.0  ->  1.5 R:R
MIN_ATR              = 4.0    # absolute floor — block when market is dead quiet (was 0.30, raised 2026-05-19)
MIN_ATR_RATIO        = 0.85   # block if ATR < 85% of 20-bar rolling avg (Option B 2026-05-21, was 0.70)
H1_CONSECUTIVE       = 2      # consecutive same-direction H1 HA candles required (Option B 2026-05-21, was 1)
MIN_SIGNAL_GAP_MIN   = 30     # minimum minutes between any two signals — kills rapid-fire reversals (Option B 2026-05-21)

M1_BARS  = 200
M5_BARS  = 100
H1_BARS  = 50

CHECK_INTERVAL    = 30    # seconds between signal checks
MAX_DAILY_SIGNALS = 15    # cap signals per calendar day (~9.8 expected, 15 is a safety ceiling)

SYMBOL_CANDIDATES = [
    "XAUUSD.s", "XAUUSD.f", "XAUUSD.pro", "XAUUSD", "XAUUSDm", "XAUUSD.a", "GOLD",
]

LOG_FILE = "free_signals.log"


# ==========================================================
# LOGGING
# ==========================================================
class LineLimitedFileHandler(logging.Handler):
    def __init__(self, filename, max_lines=500):
        super().__init__()
        self.filename  = filename
        self.max_lines = max_lines

    def emit(self, record):
        try:
            msg = self.format(record)
            with open(self.filename, "a", encoding="utf-8") as f:
                f.write(msg + "\n")
            self._trim()
        except Exception:
            self.handleError(record)

    def _trim(self):
        try:
            with open(self.filename, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
            if len(lines) > self.max_lines:
                with open(self.filename, "w", encoding="utf-8") as f:
                    f.writelines(lines[-self.max_lines:])
        except FileNotFoundError:
            pass


logging.basicConfig(level=logging.INFO)
root = logging.getLogger()
root.handlers.clear()
h = LineLimitedFileHandler(LOG_FILE)
h.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
root.addHandler(h)


# ==========================================================
# TELEGRAM
# ==========================================================
def send_telegram(message: str) -> None:
    url     = "https://api.telegram.org/bot{}/sendMessage".format(BOT_TOKEN)
    payload = {"chat_id": CHAT_ID, "text": message, "parse_mode": "HTML"}
    data    = json.dumps(payload).encode("utf-8")
    req     = urllib.request.Request(url, data=data,
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
        logging.info("Telegram message sent")
    except Exception as e:
        print("[TELEGRAM ERROR] {}".format(e))
        logging.error("Telegram send failed: %s", e)


# ==========================================================
# MT5 HELPERS
# ==========================================================
def resolve_symbol() -> str:
    symbols = mt5.symbols_get()
    if not symbols:
        raise RuntimeError("No symbols returned from MT5")
    available = {s.name for s in symbols}
    for sym in SYMBOL_CANDIDATES:
        if sym in available:
            logging.info("Using symbol: %s", sym)
            return sym
    raise RuntimeError("No XAUUSD variant found. Sample: {}".format(list(available)[:10]))


def get_rates(symbol: str, timeframe, count: int) -> pd.DataFrame:
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None or len(rates) == 0:
        raise RuntimeError("No rates for {} tf={}: {}".format(symbol, timeframe, mt5.last_error()))
    df = pd.DataFrame(rates)
    df["time"] = pd.to_datetime(df["time"], unit="s")
    return df[["time", "open", "high", "low", "close"]]


# ==========================================================
# INDICATORS
# ==========================================================
def heikin_ashi(df: pd.DataFrame) -> pd.DataFrame:
    ha = df.copy()
    ha["ha_close"] = (df["open"] + df["high"] + df["low"] + df["close"]) / 4
    ha_open = [(df["open"].iloc[0] + df["close"].iloc[0]) / 2]
    for i in range(1, len(df)):
        ha_open.append((ha_open[i - 1] + ha["ha_close"].iloc[i - 1]) / 2)
    ha["ha_open"] = ha_open
    ha["ha_high"] = ha[["high", "ha_open", "ha_close"]].max(axis=1)
    ha["ha_low"]  = ha[["low",  "ha_open", "ha_close"]].min(axis=1)
    return ha


def calc_ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def calc_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    d = df.copy()
    d["prev_close"] = d["close"].shift(1)
    d["tr"] = d.apply(
        lambda x: max(
            x["high"] - x["low"],
            abs(x["high"] - x["prev_close"]) if pd.notna(x["prev_close"]) else 0,
            abs(x["low"]  - x["prev_close"]) if pd.notna(x["prev_close"]) else 0,
        ), axis=1
    )
    return d["tr"].rolling(period).mean()


def is_doji(candle, threshold: float = DOJI_THRESHOLD) -> bool:
    body   = abs(candle["ha_close"] - candle["ha_open"])
    range_ = candle["ha_high"] - candle["ha_low"]
    if range_ == 0:
        return False
    return (body / range_) < threshold


def is_high_vol_doji(df_m1: pd.DataFrame, lookback: int = 3,
                     threshold: float = DOJI_VOL_THRESHOLD,
                     doji_pos: int = 4) -> bool:
    """doji_pos=4 when 2 confirmation candles sit between doji and current."""
    if len(df_m1) < lookback + doji_pos:
        return False
    doji       = df_m1.iloc[-doji_pos]
    doji_range = doji["ha_high"] - doji["ha_low"]
    recent     = df_m1.iloc[-(lookback + doji_pos):-doji_pos]
    avg_range  = (recent["ha_high"] - recent["ha_low"]).mean()
    if avg_range == 0:
        return False
    return doji_range >= avg_range * threshold


def has_clean_pullback(df_m1: pd.DataFrame, trend: str,
                       n: int = PULLBACK_N,
                       wick_tol: float = PULLBACK_WICK_TOL,
                       doji_pos: int = 4) -> bool:
    """doji_pos=4 when 2 confirmation candles sit between doji and current."""
    if len(df_m1) < n + doji_pos:
        return False
    pullback    = df_m1.iloc[-(n + doji_pos):-doji_pos]
    clean_count = 0
    for _, c in pullback.iterrows():
        rng = c["ha_high"] - c["ha_low"]
        if rng == 0:
            continue
        if trend == "BUY":
            if c["ha_close"] < c["ha_open"]:
                upper_wick = c["ha_high"] - c["ha_open"]
                if (upper_wick / rng) <= wick_tol:
                    clean_count += 1
        else:
            if c["ha_close"] > c["ha_open"]:
                lower_wick = c["ha_open"] - c["ha_low"]
                if (lower_wick / rng) <= wick_tol:
                    clean_count += 1
    return clean_count >= n


def bullish_candle(c) -> bool:
    return (c["ha_close"] > c["ha_open"] and
            c["ha_low"] == min(c["ha_open"], c["ha_close"]))


def bearish_candle(c) -> bool:
    return (c["ha_close"] < c["ha_open"] and
            c["ha_high"] == max(c["ha_open"], c["ha_close"]))


def h1_trend(df_h1: pd.DataFrame):
    """H1 trend direction, or None if unclear.

    H1_CONSECUTIVE controls how many back-to-back same-direction H1 HA candles
    are required before a trend is declared:
      1 = single candle (original — faster, noisier)
      2 = two consecutive candles (Option B — blocks flip-flop entries)
    """
    required = H1_CONSECUTIVE
    ha = heikin_ashi(df_h1)
    if len(ha) < required:
        return None
    dirs = []
    for i in range(1, required + 1):
        c = ha.iloc[-i]
        if   c["ha_close"] > c["ha_open"]: dirs.append("BUY")
        elif c["ha_close"] < c["ha_open"]: dirs.append("SELL")
        else: return None   # doji H1 candle — no clear trend
    return dirs[0] if len(set(dirs)) == 1 else None


# ==========================================================
# SIGNAL LOGGER
# ==========================================================
def log_signal(signal: str, price: float, sl: float, tp: float) -> None:
    file = "free_signals_log.csv"
    row  = pd.DataFrame([{
        "time":     datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "strategy": STRATEGY_LABEL,
        "signal":   signal,
        "price":    price,
        "sl":       sl,
        "tp":       tp,
    }])
    if not os.path.exists(file):
        row.to_csv(file, index=False)
    else:
        row.to_csv(file, mode="a", header=False, index=False)


# ==========================================================
# STRATEGY
# ==========================================================
def check_signal(symbol: str) -> None:
    global last_signal_time, daily_signal_count, signal_count_date

    # Reset daily counter at midnight UTC
    today = datetime.now(timezone.utc).date()
    if signal_count_date != today:
        signal_count_date  = today
        daily_signal_count = 0

    # --- Fetch data directly from MT5 ---
    m1 = get_rates(symbol, mt5.TIMEFRAME_M1, M1_BARS)
    m5 = get_rates(symbol, mt5.TIMEFRAME_M5, M5_BARS)
    h1 = get_rates(symbol, mt5.TIMEFRAME_H1, H1_BARS)

    # --- Apply HA transform ---
    m1 = heikin_ashi(m1)
    m5 = heikin_ashi(m5)

    # --- Compute indicators ---
    m1["ema"] = calc_ema(m1["close"], EMA_PERIOD)
    m5["atr"] = calc_atr(m5, ATR_PERIOD)

    # Reference candles
    # Doji at [-3], M1 confirmation at [-2], live candle at [-1]
    current_m1  = m1.iloc[-1]   # live forming candle
    confirm_m1  = m1.iloc[-2]   # M1 confirmation candle (must agree with trend)
    doji_candle = m1.iloc[-3]   # doji / indecision candle
    closed_m5   = m5.iloc[-2]

    price       = current_m1["close"]
    ema_val     = current_m1["ema"]
    current_atr = closed_m5["atr"]

    if not SILENT:
        print("\n[{} UTC]  Price: {:.2f}  EMA{}: {:.2f}  ATR: {:.4f}".format(
            datetime.now(timezone.utc).strftime("%H:%M:%S"),
            price, EMA_PERIOD, ema_val, current_atr))

    # --- ATR floor (skip dead/choppy market) ---
    if pd.isna(current_atr) or current_atr < MIN_ATR:
        if not SILENT:
            print("  ATR {:.4f} < {} -- skipping (ATR floor)".format(current_atr, MIN_ATR))
        return
    atr_series = m5["atr"].dropna()
    if len(atr_series) >= 20:
        atr_avg = float(atr_series.iloc[-20:].mean())
        if current_atr < MIN_ATR_RATIO * atr_avg:
            if not SILENT:
                print("  ATR {:.4f} < {:.0f}% of {:.4f} avg -- skipping (ATR ratio)".format(
                    current_atr, MIN_ATR_RATIO * 100, atr_avg))
            return

    # --- H1 trend (consecutive candles per H1_CONSECUTIVE) ---
    h1_dir = h1_trend(h1)
    if h1_dir is None:
        if not SILENT: print("  H1 unclear -- skipping")
        return
    if not SILENT: print("  H1: {}".format(h1_dir))

    # --- EMA trend bias ---
    if price > ema_val:
        trend = "BUY"
    elif price < ema_val:
        trend = "SELL"
    else:
        print("  Price == EMA -- skipping")
        return
    if not SILENT: print("  EMA trend: {}".format(trend))

    # --- H1 + EMA must agree ---
    if trend != h1_dir:
        if not SILENT: print("  Conflict: EMA={} H1={} -- skipping".format(trend, h1_dir))
        return

    # --- Doji at iloc[-3] ---
    if not is_doji(doji_candle, threshold=DOJI_THRESHOLD):
        if not SILENT: print("  No doji -- skipping")
        return
    if not SILENT: print("  Doji detected OK")

    # --- High-vol doji (doji_pos=3) ---
    if not is_high_vol_doji(m1, lookback=3, threshold=DOJI_VOL_THRESHOLD, doji_pos=3):
        if not SILENT: print("  Doji too small -- skipping")
        return
    if not SILENT: print("  High-vol doji OK")

    # --- Clean pullback (doji_pos=3) ---
    if not has_clean_pullback(m1, trend, n=PULLBACK_N, wick_tol=PULLBACK_WICK_TOL, doji_pos=3):
        if not SILENT: print("  No clean pullback -- skipping")
        return
    if not SILENT: print("  Clean pullback OK")

    # --- M5 direction confirmation ---
    if trend == "BUY" and closed_m5["ha_close"] <= closed_m5["ha_open"]:
        if not SILENT: print("  M5 not bullish -- skipping")
        return
    if trend == "SELL" and closed_m5["ha_close"] >= closed_m5["ha_open"]:
        if not SILENT: print("  M5 not bearish -- skipping")
        return
    if not SILENT: print("  M5 {} OK".format(trend.lower()))

    # --- M1 confirmation candle (relaxed -- direction only, 15% wick tolerance) ---
    if trend == "BUY":
        if confirm_m1["ha_close"] <= confirm_m1["ha_open"]:
            if not SILENT: print("  M1 not confirming BUY -- skipping")
            return
    else:
        if confirm_m1["ha_close"] >= confirm_m1["ha_open"]:
            if not SILENT: print("  M1 not confirming SELL -- skipping")
            return
    if not SILENT: print("  M1 confirmed ({}) OK".format(trend))

    # ==========================================================
    # SIGNAL GENERATED
    # ==========================================================

    # Duplicate check (same confirmation candle)
    signal_ts = str(confirm_m1["time"])
    if last_signal_time == signal_ts:
        if not SILENT: print("  Already sent for this candle -- skipping")
        return

    # 30-min cooldown between signals (Option B) — blocks rapid-fire reversals
    now_utc = datetime.now(timezone.utc)
    if last_signal_datetime is not None and MIN_SIGNAL_GAP_MIN > 0:
        gap_mins = (now_utc - last_signal_datetime).total_seconds() / 60
        if gap_mins < MIN_SIGNAL_GAP_MIN:
            if not SILENT:
                print("  Cooldown: {:.1f}/{} min elapsed -- skipping".format(gap_mins, MIN_SIGNAL_GAP_MIN))
            return

    # Daily cap
    if daily_signal_count >= MAX_DAILY_SIGNALS:
        if not SILENT: print("  Daily cap reached ({}) -- skipping".format(MAX_DAILY_SIGNALS))
        return

    # SL / TP
    atr_val = float(current_atr)
    sl_dist = atr_val * ATR_SL_MULT
    tp_dist = atr_val * ATR_TP_MULT

    if trend == "BUY":
        sl = round(price - sl_dist, 2)
        tp = round(price + tp_dist, 2)
    else:
        sl = round(price + sl_dist, 2)
        tp = round(price - tp_dist, 2)

    signal_time = str(confirm_m1["time"])

    dir_icon = "\U0001f4c8" if trend == "BUY" else "\U0001f4c9"
    message = (
        "\U0001f6a8 <b>CryptoNite Signal</b>\n"
        "\U0001f4e1 CryptoNite Free Signals\n"
        "\n"
        "{} <b>XAUUSD | {}</b>\n"
        "⏰ {}\n"
        "\n"
        "\U0001f4cd Entry:  {}\n"
        "\U0001f6d1 SL:     {}\n"
        "\U0001f3af TP:     {}"
    ).format(dir_icon, trend, signal_time, round(price, 2), sl, tp)

    print("\n  SIGNAL: {}  Entry={:.2f}  SL={}  TP={}".format(trend, price, sl, tp))
    send_telegram(message)
    log_signal(trend, price, sl, tp)
    logging.info("Signal: %s  price=%.2f  sl=%.2f  tp=%.2f", trend, price, sl, tp)

    last_signal_time     = signal_ts
    last_signal_datetime = now_utc
    daily_signal_count  += 1


# ==========================================================
# MAIN
# ==========================================================
last_signal_time     = None
last_signal_datetime = None   # datetime of last fired signal — used for MIN_SIGNAL_GAP_MIN cooldown
daily_signal_count   = 0
signal_count_date    = datetime.now(timezone.utc).date()


def run():
    print("=" * 55)
    print("  CryptoNite Free Signals -- Relaxed HA Strategy")
    print("  Asset: XAUUSD | 24/7 | Check every {}s".format(CHECK_INTERVAL))
    print("=" * 55)
    logging.info("Free signals bot starting")

    # --- MT5 init ---
    # Connect to whatever MT5 terminal is already running — no login needed.
    # If credentials are set in .env they are used, otherwise attach to open terminal.
    if MT5_LOGIN and MT5_PASSWORD and MT5_SERVER:
        ok = mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER)
    else:
        ok = mt5.initialize()
    if not ok:
        raise RuntimeError("MT5 init failed: {}".format(mt5.last_error()))

    symbol = resolve_symbol()
    if not mt5.symbol_select(symbol, True):
        raise RuntimeError("Cannot select {}: {}".format(symbol, mt5.last_error()))

    print("  MT5 connected -- symbol: {}\n".format(symbol))
    logging.info("MT5 connected, symbol: %s", symbol)

    try:
        while True:
            try:
                check_signal(symbol)
            except Exception as e:
                logging.error("Scan error: %s", e)
            time.sleep(CHECK_INTERVAL)
    except KeyboardInterrupt:
        print("Stopped by user.")
        logging.info("Bot stopped by user.")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    run()
