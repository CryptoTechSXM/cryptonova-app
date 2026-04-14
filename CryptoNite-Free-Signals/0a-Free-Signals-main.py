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

Backtest result (Monte Carlo, 1000 sims × 120 days):
  Win rate: 58% | R:R: 1.5:1 | EV: +0.45R/trade | 100% sims profitable
"""

import os
import time
import json
import logging
import urllib.request
from pathlib import Path
from datetime import datetime

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
MT5_LOGIN    = int(os.getenv("MT5_LOGIN",  "0"))
MT5_PASSWORD = os.getenv("MT5_PASSWORD",   "")
MT5_SERVER   = os.getenv("MT5_SERVER",     "")

BOT_TOKEN = os.getenv("BOT_TOKEN", "7716066914:AAEZATUSQXRRsTIO3xCIrYpNJ8dwzEnF1Iw")
CHAT_ID   = os.getenv("CHAT_ID",   "-1003523601209")

STRATEGY_LABEL = "HA Relaxed"

# Relaxed HA parameters
DOJI_THRESHOLD       = 0.25   # body/range < this → doji
DOJI_VOL_THRESHOLD   = 0.70   # doji range must be ≥ 70% of recent avg range
PULLBACK_N           = 1      # min clean pullback candles before doji
PULLBACK_WICK_TOL    = 0.15   # wick/range ≤ 15% counts as "clean"
ATR_PERIOD           = 14
EMA_PERIOD           = 100
ATR_SL_MULT          = 2.0    # SL = ATR × 2.0
ATR_TP_MULT          = 3.0    # TP = ATR × 3.0  →  1.5 R:R
MIN_ATR              = 0.30   # minimum M5 ATR in price units (filters dead market)

M1_BARS  = 200
M5_BARS  = 100
H1_BARS  = 50

CHECK_INTERVAL = 30    # seconds between signal checks
MAX_DAILY_SIGNALS = 15  # cap signals per calendar day (~9.8 expected, 15 is a safety ceiling)

SYMBOL_CANDIDATES = [
    "XAUUSD.s", "XAUUSD", "XAUUSDm", "XAUUSD.a", "GOLD",
]

LOG_FILE = "free_signals.log"


# ==========================================================
# LOGGING
# ==========================================================
class LineLimitedFileHandler(logging.Handler):
    def __init__(self, filename, max_lines=500):
        super().__init__()
        self.filename = filename
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
    url     = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": CHAT_ID, "text": message}
    data    = json.dumps(payload).encode("utf-8")
    req     = urllib.request.Request(url, data=data,
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
        logging.info("Telegram message sent")
    except Exception as e:
        print(f"[TELEGRAM ERROR] {e}")
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
    raise RuntimeError(f"No XAUUSD variant found. Sample: {list(available)[:10]}")


def get_rates(symbol: str, timeframe, count: int) -> pd.DataFrame:
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None or len(rates) == 0:
        raise RuntimeError(f"No rates for {symbol} tf={timeframe}: {mt5.last_error()}")
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
                     threshold: float = DOJI_VOL_THRESHOLD) -> bool:
    if len(df_m1) < lookback + 3:
        return False
    doji       = df_m1.iloc[-3]
    doji_range = doji["ha_high"] - doji["ha_low"]
    recent     = df_m1.iloc[-(lookback + 3):-3]
    avg_range  = (recent["ha_high"] - recent["ha_low"]).mean()
    if avg_range == 0:
        return False
    return doji_range >= avg_range * threshold


def has_clean_pullback(df_m1: pd.DataFrame, trend: str,
                       n: int = PULLBACK_N,
                       wick_tol: float = PULLBACK_WICK_TOL) -> bool:
    if len(df_m1) < n + 3:
        return False
    pullback    = df_m1.iloc[-(n + 3):-3]
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
    """Single-candle H1 trend (relaxed — standard needs 2 consecutive)."""
    ha   = heikin_ashi(df_h1)
    last = ha.iloc[-1]
    if last["ha_close"] > last["ha_open"]:
        return "BUY"
    elif last["ha_close"] < last["ha_open"]:
        return "SELL"
    return None


# ==========================================================
# SIGNAL LOGGER
# ==========================================================
def log_signal(signal: str, price: float, sl: float, tp: float) -> None:
    file = "free_signals_log.csv"
    row  = pd.DataFrame([{
        "time":     datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
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
    today = datetime.utcnow().date()
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
    current_m1 = m1.iloc[-1]
    closed_m1  = m1.iloc[-2]
    prev_m1    = m1.iloc[-3]
    closed_m5  = m5.iloc[-2]

    price       = current_m1["close"]
    ema_val     = current_m1["ema"]
    current_atr = closed_m5["atr"]

    print(f"\n[{datetime.utcnow().strftime('%H:%M:%S')} UTC]  "
          f"Price: {price:.2f}  EMA{EMA_PERIOD}: {ema_val:.2f}  ATR: {current_atr:.4f}")

    # --- ATR floor (skip dead/choppy market) ---
    if pd.isna(current_atr) or current_atr < MIN_ATR:
        print(f"  ATR {current_atr:.4f} < {MIN_ATR} — skipping (low volatility)")
        return

    # --- H1 trend (1-candle, relaxed) ---
    h1_dir = h1_trend(h1)
    if h1_dir is None:
        print("  H1 unclear — skipping")
        return
    print(f"  H1: {h1_dir}")

    # --- EMA trend bias ---
    if price > ema_val:
        trend = "BUY"
    elif price < ema_val:
        trend = "SELL"
    else:
        print("  Price == EMA — skipping")
        return
    print(f"  EMA trend: {trend}")

    # --- H1 + EMA must agree ---
    if trend != h1_dir:
        print(f"  Conflict: EMA={trend} H1={h1_dir} — skipping")
        return

    # --- Doji on prev_m1 (relaxed threshold 0.25) ---
    if not is_doji(prev_m1, threshold=DOJI_THRESHOLD):
        print("  No doji — skipping")
        return
    print("  Doji detected ✓")

    # --- High-vol doji (relaxed: 70% of avg range) ---
    if not is_high_vol_doji(m1, lookback=3, threshold=DOJI_VOL_THRESHOLD):
        print("  Doji too small — skipping")
        return
    print("  High-vol doji ✓")

    # --- Clean pullback (relaxed: n=1, wick_tol=15%) ---
    if not has_clean_pullback(m1, trend, n=PULLBACK_N, wick_tol=PULLBACK_WICK_TOL):
        print("  No clean pullback — skipping")
        return
    print("  Clean pullback ✓")

    # --- M5 direction confirmation ---
    if trend == "BUY" and closed_m5["ha_close"] <= closed_m5["ha_open"]:
        print("  M5 not bullish — skipping")
        return
    if trend == "SELL" and closed_m5["ha_close"] >= closed_m5["ha_open"]:
        print("  M5 not bearish — skipping")
        return
    print(f"  M5 {trend.lower()} ✓")

    # --- M1 confirmation candle ---
    if trend == "BUY" and not bullish_candle(closed_m1):
        print("  M1 not strong bullish — skipping")
        return
    if trend == "SELL" and not bearish_candle(closed_m1):
        print("  M1 not strong bearish — skipping")
        return
    print(f"  M1 confirmed ✓")

    # ==========================================================
    # SIGNAL GENERATED
    # ==========================================================

    # Duplicate check (same candle)
    signal_ts = str(closed_m1["time"])
    if last_signal_time == signal_ts:
        print("  ⚠️  Already sent for this candle — skipping")
        return

    # Daily cap
    if daily_signal_count >= MAX_DAILY_SIGNALS:
        print(f"  ⚠️  Daily cap reached ({MAX_DAILY_SIGNALS}) — skipping")
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

    signal_time = str(closed_m1["time"])

    message = (
        f"🚨 CryptoNite Free Signals\n"
        f"\n"
        f"Time: {signal_time}\n"
        f"Asset: XAUUSD\n"
        f"Direction: {trend}\n"
        f"\n"
        f"Entry: {round(price, 2)}\n"
        f"SL: {sl}\n"
        f"TP: {tp}"
    )

    print(f"\n  🔥 {trend} SIGNAL  Entry={price:.2f}  SL={sl}  TP={tp}")
    send_telegram(message)
    log_signal(trend, price, sl, tp)
    logging.info("Signal: %s  price=%.2f  sl=%.2f  tp=%.2f", trend, price, sl, tp)

    last_signal_time   = signal_ts
    daily_signal_count += 1


# ==========================================================
# MAIN
# ==========================================================
last_signal_time   = None
daily_signal_count = 0
signal_count_date  = datetime.utcnow().date()


def run():
    print("=" * 55)
    print("  CryptoNite Free Signals — Relaxed HA Strategy")
    print(f"  Asset: XAUUSD | 24/7 | Check every {CHECK_INTERVAL}s")
    print("=" * 55)
    logging.info("Free signals bot starting")

    # --- MT5 init ---
    if not mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
        raise RuntimeError(f"MT5 init failed: {mt5.last_error()}")

    symbol = resolve_symbol()
    if not mt5.symbol_select(symbol, True):
        raise RuntimeError(f"Cannot select {symbol}: {mt5.last_error()}")

    print(f"  MT5 connected — symbol: {symbol}\n")
    logging.info("MT5 connected, symbol: %s", symbol)

    try:
        while True:
            try:
                check_signal(symbol)
            except Exception as e:
                print(f"[ERROR] {e}")
                logging.exception("Signal check error")

            print(f"  ⏳ Next check in {CHECK_INTERVAL}s...\n")
            time.sleep(CHECK_INTERVAL)

    except KeyboardInterrupt:
        print("\nStopped by user.")
        logging.info("Bot stopped by user")

    finally:
        mt5.shutdown()
        logging.info("MT5 shutdown")


if __name__ == "__main__":
    run()
