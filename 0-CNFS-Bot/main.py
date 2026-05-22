"""
CNFS Bot
========
Generates signals using the relaxed HA strategy,
then executes them directly in MT5 with a trailing stop profit lock.

Trailing stop rules:
  - Once floating profit >= max(MIN_BE_PIPS, 20% ATR)  → move SL to entry (breakeven)  [MIN_BE_PIPS=20 / $2.00]
  - Once floating profit trails further                 → trail SL max(MIN_TRAIL_PIPS, 15% ATR) behind  [MIN_TRAIL_PIPS=20 / $2.00]

Concurrent position rules:
  - At-risk positions (SL still at original) >= 2  → block new signal
  - Total open positions >= 5                       → block new signal (margin guard)
  - Positions at breakeven or better               → don't count toward at-risk limit

Telegram control:
  - Set CTRL_BOT_TOKEN + CTRL_CHAT_ID in .env to enable /status /pause /resume /positions
  - Trade reports sent to REPORT_CHAT_ID
"""

import re
import time
import json
import ssl
import csv
import os
import urllib.request
import threading
from datetime import datetime, timezone, timedelta
try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:
    _ET = timezone(timedelta(hours=-4))  # EDT fallback if tzdata not installed

# Bypass SSL verification — fixes self-signed certificate errors on some networks
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode    = ssl.CERT_NONE

import MetaTrader5 as mt5
import pandas as pd

import config
from lot import calculate_lot_size
from telegram_control import TelegramControl


# =============================================================
# EVENT LOGGER  (writes to events.log + console, syncs via Syncthing)
# =============================================================
_SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
_EVENT_FILE  = os.path.join(_SCRIPT_DIR, "events.log")
_EVENT_MAX_LINES = 3000

def log_event(msg: str) -> None:
    """Timestamped log to events.log AND console."""
    import sys
    now_utc = datetime.now(timezone.utc)
    now_et  = now_utc.astimezone(_ET)
    now     = now_utc.strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")
    et_str  = now_et.strftime("%H:%M %Z")
    line = "{} ({}) | {}".format(now, et_str, msg)
    print(line, flush=True)
    try:
        with open(_EVENT_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        # Rotate to keep file manageable
        with open(_EVENT_FILE, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
        if len(lines) > _EVENT_MAX_LINES:
            with open(_EVENT_FILE, "w", encoding="utf-8") as f:
                f.writelines(lines[-_EVENT_MAX_LINES:])
    except Exception as e:
        print("[LOG ERROR] {}".format(e), file=sys.stderr)


# =============================================================
# GLOBAL STATE
# =============================================================
_paused          = False
_symbol          = None
_last_signal_candle = None
_LAST_TRADE_FILE    = "last_trade_time.txt"
def _load_last_trade_time():
    """Read persisted last-trade timestamp so cooldown survives restarts."""
    try:
        with open(_LAST_TRADE_FILE) as f:
            ts = float(f.read().strip())
            return datetime.fromtimestamp(ts, tz=timezone.utc)
    except Exception:
        return None

_last_trade_time    = _load_last_trade_time()   # wall-clock time of last executed trade (cooldown guard)
_daily_count     = 0
_daily_count_date = None

# ticket -> { entry, original_sl, current_sl, tp, atr_pips, direction, be_done }
_positions      = {}
_positions_lock = threading.Lock()

_ctrl = None   # TelegramControl instance (set in run())


# =============================================================
# TELEGRAM — report channel (simple urllib, no library needed)
# =============================================================
def _tg_send(token, chat_id, text):
    url  = "https://api.telegram.org/bot{}/sendMessage".format(token)
    data = json.dumps({"chat_id": str(chat_id), "text": text,
                       "parse_mode": "HTML"}).encode()
    req  = urllib.request.Request(url, data=data,
                                  headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10, context=_SSL_CTX)
    except Exception as e:
        print("[TG ERROR] {}".format(e))


def report(text):
    """Send to the report channel (uses CTRL bot token if available, else signal token)."""
    token   = config.CTRL_BOT_TOKEN or config.BOT_TOKEN
    chat_id = config.REPORT_CHAT_ID
    _tg_send(token, chat_id, text)


def send_status(status):
    report("🤖 <b>CNFS Bot</b> — {}".format(status))


# =============================================================
# TODAY'S TRADE TALLY  — reads MT5 deal history as primary source.
# Falls back to trades_log.csv if MT5 is unavailable.
#
# Why MT5 history?  trades_log.csv is only written when the trail
# monitor detects a close during the CURRENT session.  Any trade
# that opened and closed while the bot was down (e.g. an SL hit
# overnight) is invisible to the CSV.  MT5 deal history captures
# everything, regardless of bot uptime.
# =============================================================
def _tally_today_trades():
    """
    Returns (wins, losses, be_plus, be, total_pnl) for today (ET date).
    BE_PLUS_MAX = $5: anything >= $5 counts as a win, $0–$4.99 is BE+.
    Reads MT5 deal history first; falls back to trades_log.csv.
    """
    BE_PLUS_MAX = 5.0
    wins = losses = be_plus = be = 0
    total_pnl = 0.0

    # ── Primary: MT5 deal history ─────────────────────────────
    try:
        now_et      = datetime.now(timezone.utc).astimezone(_ET)
        et_midnight = now_et.replace(hour=0, minute=0, second=0, microsecond=0)
        utc_from    = et_midnight.astimezone(timezone.utc)
        utc_to      = datetime.now(timezone.utc) + timedelta(minutes=1)
        deals = mt5.history_deals_get(utc_from, utc_to)
        if deals is not None:
            for d in deals:
                # Only closing legs; skip deposits, adjustments, commissions
                if d.entry != mt5.DEAL_ENTRY_OUT:
                    continue
                # Skip zero-value book entries (some brokers emit these)
                if d.profit == 0.0 and d.commission == 0.0 and d.swap == 0.0:
                    continue
                pnl = round(d.profit + d.commission + d.swap, 2)
                total_pnl += pnl
                if pnl >= BE_PLUS_MAX:
                    wins += 1
                elif pnl > 0:
                    be_plus += 1
                elif pnl < 0:
                    losses += 1
                else:
                    be += 1
            return wins, losses, be_plus, be, round(total_pnl, 2)
    except Exception as _e:
        print("[TALLY] MT5 history unavailable, falling back to CSV: {}".format(_e))

    # ── Fallback: trades_log.csv ──────────────────────────────
    today_str = datetime.now(timezone.utc).astimezone(_ET).strftime("%Y-%m-%d")
    try:
        with open(TRADES_LOG, newline="") as f:
            for row in csv.DictReader(f):
                if not row.get("date", "").startswith(today_str):
                    continue
                pnl = float(row.get("pnl", 0) or 0)
                total_pnl += pnl
                if pnl >= BE_PLUS_MAX:
                    wins += 1
                elif pnl > 0:
                    be_plus += 1
                elif pnl < 0:
                    losses += 1
                else:
                    be += 1
    except Exception:
        pass
    return wins, losses, be_plus, be, round(total_pnl, 2)


def send_session_open():
    """Send a uniform session-open card matching the tg-bot format."""
    acc = mt5.account_info()
    if not acc:
        send_status("ONLINE")
        return

    # Tally today's closed trades — MT5 history is the source of truth
    t_wins, t_losses, t_be_plus, t_be, today_pnl = _tally_today_trades()
    total    = t_wins + t_losses + t_be_plus + t_be
    pnl_sign = "+" if today_pnl >= 0 else ""
    now_utc  = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    paused   = "⛔ PAUSED" if _paused else "✅ Trading enabled"

    report(
        "📊 <b>Session Open</b>\n"
        "📡 CNFS Bot\n"
        "⏰ {}\n"
        "💰 Balance: <b>{:.2f}</b>  |  Equity: <b>{:.2f}</b>\n"
        "📈 Today P&amp;L: <b>{}{:.2f}</b>\n"
        "🔢 Trades: {} ({}W / {}L / {}BE+ / {}BE)\n"
        "{}".format(
            now_utc,
            acc.balance, acc.equity,
            pnl_sign, today_pnl,
            total, t_wins, t_losses, t_be_plus, t_be,
            paused
        )
    )



def _post_signal_to_free_channel(symbol, direction, entry, sl, tp):
    """
    Broadcast the fired signal to the Free Signals customer channel
    in the standard CryptoNite icon format so members receive it and
    247A/B can also parse it.
    """
    try:
        token   = config.BOT_TOKEN
        chat_id = config.CHAT_ID   # -1003523601209 — Free Signals channel
        if not token or not chat_id:
            return
        sl_delta  = abs(entry - sl)
        side_icon = "📈" if direction == "BUY" else "📉"
        ts_str    = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        clean_sym = re.sub(r'\.[a-zA-Z0-9]+$', '', symbol) or symbol
        msg = (
            "🚨 CryptoNite Signal\n"
            "📡 CryptoNite CNFS Signals\n"
            "{} {} | {}\n"
            "⏰ {}\n"
            "📍 Entry:  {:.2f}\n"
            "🛑 SL:     {:.2f}\n"
            "🎯 TP:     {:.2f}"
        ).format(side_icon, clean_sym, direction, ts_str, entry, sl, tp)
        _tg_send(token, chat_id, msg)
        log_event("[SIGNAL] Broadcast → Free Signals channel: {} {} E={:.2f}".format(
            clean_sym, direction, entry))
    except Exception as e:
        log_event("[SIGNAL] Broadcast failed: {}".format(e))

def send_trade_open(symbol, direction, entry, sl, tp, lot, ticket):
    open_icon = "🟢" if direction == "BUY" else "🔴"
    dir_icon  = "📈" if direction == "BUY" else "📉"
    clean_sym = symbol.split(".")[0] if "." in symbol else symbol
    now_str   = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    report(
        "{} <b>Trade Opened</b>\n"
        "📊 CNFS  |  📡 HA Signal\n"
        "\n"
        "{} <b>{} | {}</b>\n"
        "⏰ {}\n"
        "\n"
        "📍 Entry:  {:.2f}\n"
        "🛑 SL:     {:.2f}\n"
        "🎯 TP:     {:.2f}\n"
        "📦 Lots:   {}\n"
        "🎫 Ticket: {}".format(
            open_icon, dir_icon, clean_sym, direction,
            now_str, entry, sl, tp, lot, ticket)
    )


def send_trade_close(symbol, direction, entry, close_price, pips, pnl, ticket, reason):
    _BE_PLUS_MAX = 5.0
    if pnl >= _BE_PLUS_MAX:
        close_icon, outcome = "✅", "WIN"
    elif pnl > 0:
        close_icon, outcome = "🛡️", "BE+"
    elif pnl < 0:
        close_icon, outcome = "❌", "LOSS"
    else:
        close_icon, outcome = "➖", "BE"
    dir_icon  = "📈" if direction == "BUY" else "📉"
    clean_sym = symbol.split(".")[0] if "." in symbol else symbol
    now_str   = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    report(
        "{} <b>Trade Closed — {}</b>\n"
        "📊 CNFS  |  📡 HA Signal\n"
        "\n"
        "{} <b>{} | {}</b>\n"
        "⏰ {}\n"
        "\n"
        "📍 Entry:  {:.2f}\n"
        "🏁 Exit:   {:.2f}\n"
        "💰 P/L:    <b>{:+.2f}</b>\n"
        "🎫 Ticket: {}".format(
            close_icon, outcome, dir_icon, clean_sym, direction,
            now_str, entry, close_price, pnl, ticket)
    )


def send_be_locked(symbol, ticket, entry, float_pips):
    report(
        "🔒 <b>Breakeven Locked</b>\n"
        "📊 {} ticket={}\n"
        "📍 Entry: {:.2f}\n"
        "✅ SL moved to entry (+{:.1f} pips profit)".format(
            symbol, ticket, entry, float_pips)
    )


# =============================================================
# DAILY END-OF-DAY REPORT  (fires once at 21:00 UTC)
# =============================================================
_eod_report_date = None   # date string of last sent report (YYYY-MM-DD)

def send_daily_report():
    """Read today's closed trades from MT5 history (primary) and send a summary."""
    global _eod_report_date

    today_str = datetime.now(timezone.utc).astimezone(_ET).strftime("%Y-%m-%d")
    _eod_report_date = today_str   # mark as sent even if history read fails

    # Core counts from MT5 history — catches trades closed while bot was down
    wins, losses, be_plus, be, total_pnl = _tally_today_trades()

    # Duration / TP-hit stats still come from CSV (richer metadata)
    tp_hits = 0
    durations = []
    try:
        with open(TRADES_LOG, newline="") as f:
            for row in csv.DictReader(f):
                if not row.get("date", "").startswith(today_str):
                    continue
                if str(row.get("tp_hit", "")).lower() == "true":
                    tp_hits += 1
                try:
                    durations.append(float(row.get("duration_min", 0) or 0))
                except Exception:
                    pass
    except Exception:
        pass

    total = wins + losses + be_plus + be
    if total == 0:
        report(
            "📊 <b>End-of-Day Report</b>\n"
            "📡 CNFS Bot\n"
            "📅 {}\n"
            "ℹ️ No trades logged today.".format(today_str)
        )
        return

    win_rate  = round(wins / total * 100, 1)
    pnl_sign  = "+" if total_pnl >= 0 else ""
    avg_dur   = round(sum(durations) / len(durations), 1) if durations else 0
    tp_rate   = round(tp_hits / total * 100, 1)

    lines = [
        "📊 <b>End-of-Day Report</b>",
        "📡 CNFS Bot",
        "📅 {}".format(today_str),
        "",
        "🔢 Trades: <b>{}</b>  ({}W / {}L / {}BE+ / {}BE)".format(
            total, wins, losses, be_plus, be),
        "💰 P&L: <b>{}{:.2f}</b>".format(pnl_sign, total_pnl),
        "🎯 Win rate: <b>{:.1f}%</b>  |  TP hit: <b>{:.1f}%</b>".format(win_rate, tp_rate),
        "⏱ Avg duration: <b>{:.1f} min</b>".format(avg_dur),
    ]
    if _paused:
        lines.append("⛔ Bot currently PAUSED")

    report("\n".join(lines))
    log_event("[EOD] Daily report sent ({} trades, P&L={}{:.2f})".format(
        total, pnl_sign, total_pnl))


def _maybe_send_eod_report():
    """Call from main loop — sends EOD report once per day at 21:00 UTC (5 PM ET)."""
    global _eod_report_date
    now_utc   = datetime.now(timezone.utc)
    today_str = now_utc.astimezone(_ET).strftime("%Y-%m-%d")
    if now_utc.hour == 21 and _eod_report_date != today_str:
        send_daily_report()


# =============================================================
# PAUSE / RESUME
# =============================================================
def pause_trading():
    global _paused
    _paused = True
    print("[CTRL] Trading PAUSED")


def resume_trading():
    global _paused
    _paused = False
    print("[CTRL] Trading RESUMED")


# =============================================================
# STATE FOR /status AND /positions
# =============================================================
def get_bot_state():
    sym    = _symbol or config.BASE_SYMBOL
    acc    = mt5.account_info()
    open_pos = get_open_positions(sym) if sym else []

    positions_detail = []
    at_risk  = 0
    be_count = 0

    for pos in open_pos:
        with _positions_lock:
            meta = _positions.get(pos.ticket, {})
        direction  = "BUY" if pos.type == 0 else "SELL"
        entry      = pos.price_open
        current_sl = meta.get("current_sl", pos.sl)
        tp         = pos.tp
        be_done    = meta.get("be_done", False)

        tick = mt5.symbol_info_tick(sym)
        cur_price  = (tick.bid if direction == "BUY" else tick.ask) if tick else entry
        float_pips = (cur_price - entry) / config.PIP_SIZE if direction == "BUY" \
                     else (entry - cur_price) / config.PIP_SIZE
        float_usd  = pos.profit

        locked_pips = (current_sl - entry) / config.PIP_SIZE if direction == "BUY" \
                      else (entry - current_sl) / config.PIP_SIZE

        if be_done:
            be_count += 1
        else:
            at_risk += 1

        positions_detail.append({
            "ticket":      pos.ticket,
            "direction":   direction,
            "entry":       entry,
            "current_sl":  current_sl,
            "tp":          tp,
            "float_pips":  float_pips,
            "float_usd":   float_usd,
            "locked_pips": locked_pips,
            "be_done":     be_done,
        })

    return {
        "paused":           _paused,
        "symbol":           sym,
        "total_positions":  len(open_pos),
        "at_risk":          at_risk,
        "be_locked":        be_count,
        "balance":          acc.balance if acc else 0,
        "equity":           acc.equity  if acc else 0,
        "positions_detail": positions_detail,
    }


# =============================================================
# MT5 HELPERS
# =============================================================
def resolve_symbol():
    symbols = {s.name for s in (mt5.symbols_get() or [])}
    for sym in config.SYMBOL_CANDIDATES:
        if sym in symbols:
            return sym
    raise RuntimeError("No XAUUSD variant found")


def get_rates(symbol, timeframe, count):
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None or len(rates) == 0:
        raise RuntimeError("No rates: {} tf={}".format(symbol, timeframe))
    df = pd.DataFrame(rates)
    df["time"] = pd.to_datetime(df["time"], unit="s")
    return df[["time", "open", "high", "low", "close"]]


# =============================================================
# INDICATORS  (identical to Free Signals bot)
# =============================================================
def heikin_ashi(df):
    ha = df.copy()
    ha["ha_close"] = (df["open"] + df["high"] + df["low"] + df["close"]) / 4
    ha_open = [(df["open"].iloc[0] + df["close"].iloc[0]) / 2]
    for i in range(1, len(df)):
        ha_open.append((ha_open[i-1] + ha["ha_close"].iloc[i-1]) / 2)
    ha["ha_open"] = ha_open
    ha["ha_high"] = ha[["high", "ha_open", "ha_close"]].max(axis=1)
    ha["ha_low"]  = ha[["low",  "ha_open", "ha_close"]].min(axis=1)
    return ha


def get_current_atr_pips(symbol, default=50.0):
    """Fetch a fresh ATR (in pips) for any symbol — used when adopting manual trades."""
    try:
        rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, config.ATR_PERIOD + 5)
        if rates is None or len(rates) < config.ATR_PERIOD:
            return default
        df = pd.DataFrame(rates)
        df.rename(columns={"open": "open", "high": "high", "low": "low", "close": "close"}, inplace=True)
        atr_series = calc_atr(df, config.ATR_PERIOD)
        val = atr_series.iloc[-1]
        if pd.isna(val) or val <= 0:
            return default
        return val / config.PIP_SIZE
    except Exception:
        return default


def calc_ema(series, period):
    return series.ewm(span=period, adjust=False).mean()


def calc_atr(df, period=14):
    d = df.copy()
    d["prev_close"] = d["close"].shift(1)
    d["tr"] = d.apply(lambda x: max(
        x["high"] - x["low"],
        abs(x["high"] - x["prev_close"]) if pd.notna(x["prev_close"]) else 0,
        abs(x["low"]  - x["prev_close"]) if pd.notna(x["prev_close"]) else 0,
    ), axis=1)
    return d["tr"].rolling(period).mean()


def is_doji(candle):
    body = abs(candle["ha_close"] - candle["ha_open"])
    rng  = candle["ha_high"] - candle["ha_low"]
    return rng > 0 and (body / rng) < config.DOJI_THRESHOLD


def is_high_vol_doji(df_m1, lookback=3, doji_pos=3):
    if len(df_m1) < lookback + doji_pos:
        return False
    doji       = df_m1.iloc[-doji_pos]
    doji_range = doji["ha_high"] - doji["ha_low"]
    recent     = df_m1.iloc[-(lookback + doji_pos):-doji_pos]
    avg_range  = (recent["ha_high"] - recent["ha_low"]).mean()
    return avg_range > 0 and doji_range >= avg_range * config.DOJI_VOL_THRESHOLD


def has_clean_pullback(df_m1, trend, doji_pos=3):
    n = config.PULLBACK_N
    if len(df_m1) < n + doji_pos:
        return False
    pullback = df_m1.iloc[-(n + doji_pos):-doji_pos]
    clean    = 0
    for _, c in pullback.iterrows():
        rng = c["ha_high"] - c["ha_low"]
        if rng == 0:
            continue
        if trend == "BUY":
            if c["ha_close"] < c["ha_open"]:
                if (c["ha_high"] - c["ha_open"]) / rng <= config.PULLBACK_WICK_TOL:
                    clean += 1
        else:
            if c["ha_close"] > c["ha_open"]:
                if (c["ha_open"] - c["ha_low"]) / rng <= config.PULLBACK_WICK_TOL:
                    clean += 1
    return clean >= n


def h1_trend(df_h1):
    """Return H1 trend direction, or None if unclear.

    config.H1_CONSECUTIVE controls how many back-to-back same-direction
    H1 HA candles are required before a trend is declared:
      1 = single candle (original — faster but noisier)
      2 = two consecutive candles (backtest Option B — blocks flip-flop entries)
    """
    required = getattr(config, "H1_CONSECUTIVE", 1)
    ha = heikin_ashi(df_h1)
    if len(ha) < required:
        return None
    dirs = []
    for i in range(1, required + 1):
        c = ha.iloc[-i]
        if   c["ha_close"] > c["ha_open"]: dirs.append("BUY")
        elif c["ha_close"] < c["ha_open"]: dirs.append("SELL")
        else: return None                  # doji H1 candle — no trend
    # All required candles must point the same way
    return dirs[0] if len(set(dirs)) == 1 else None


# =============================================================
# POSITION TRACKING
# =============================================================
def get_open_positions(symbol):
    """Bot-opened positions only (magic number filter)."""
    return [p for p in (mt5.positions_get(symbol=symbol) or [])
            if p.magic == config.MAGIC_NUMBER]

def get_all_positions(symbol):
    """All positions matching the base symbol — includes manual trades on any variant."""
    all_pos = mt5.positions_get() or []
    base = config.BASE_SYMBOL.upper()
    return [p for p in all_pos if base in p.symbol.upper()]


def count_at_risk(symbol):
    # Use get_all_positions so manual trades count toward the at-risk cap.
    # Positions not yet in _positions (not adopted) are treated as at-risk (conservative).
    # Positions adopted with be_done=True are protected and don't count.
    with _positions_lock:
        open_pos = get_all_positions(symbol)
        at_risk  = 0
        for p in open_pos:
            meta = _positions.get(p.ticket)
            if meta is None or not meta.get("be_done", False):
                at_risk += 1
        return at_risk


def can_open_new(symbol):
    if _paused:
        print("  [GATE] Bot is paused — skipping signal scan")
        return False
    # Trade cooldown — prevent re-entry cascade from persistent HA signals
    if _last_trade_time is not None:
        elapsed = (datetime.now(timezone.utc) - _last_trade_time).total_seconds()
        if elapsed < config.TRADE_COOLDOWN:
            remaining = int(config.TRADE_COOLDOWN - elapsed)
            print("  [GATE] Trade cooldown — {}s remaining".format(remaining))
            return False
    # Use get_all_positions so manual trades count toward total and at-risk caps.
    open_pos = get_all_positions(symbol)
    total    = len(open_pos)
    at_risk  = count_at_risk(symbol)
    if total >= config.MAX_TOTAL_POSITIONS:
        print("  [GATE] Total positions {} >= {} (margin guard — includes manual)".format(
            total, config.MAX_TOTAL_POSITIONS))
        return False
    if at_risk >= config.MAX_AT_RISK_POSITIONS:
        print("  [GATE] At-risk positions {} >= {} (risk budget full — includes manual)".format(
            at_risk, config.MAX_AT_RISK_POSITIONS))
        return False
    return True


def close_position(ticket, symbol, direction):
    """Market-close a single position by ticket."""
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return False
    price    = tick.bid if direction == "BUY" else tick.ask
    order_type = mt5.ORDER_TYPE_SELL if direction == "BUY" else mt5.ORDER_TYPE_BUY
    pos      = next((p for p in (mt5.positions_get(symbol=symbol) or []) if p.ticket == ticket), None)
    if not pos:
        return False
    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       pos.volume,
        "type":         order_type,
        "position":     ticket,
        "price":        round(price, 2),
        "deviation":    30,
        "magic":        config.MAGIC_NUMBER,
        "comment":      "CNFS-reversal",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    return result and result.retcode == mt5.TRADE_RETCODE_DONE


def close_opposite_at_risk(symbol, new_direction):
    """Close any at-risk positions in the opposite direction before a new entry.
    BE-locked positions are left to run — they're already protected."""
    opposite = "SELL" if new_direction == "BUY" else "BUY"
    closed   = []
    with _positions_lock:
        candidates = {t: m for t, m in _positions.items()
                      if m["direction"] == opposite and not m.get("be_done", False)}
    for ticket, meta in candidates.items():
        print("  [REVERSAL] Closing at-risk {} ticket={} before new {}".format(
            opposite, ticket, new_direction))
        if close_position(ticket, symbol, opposite):
            print("  [REVERSAL] Closed ticket={}".format(ticket))
            closed.append(ticket)
            if _ctrl:
                _ctrl.send_report(
                    "🔄 <b>Reversal — position closed</b>\n"
                    "Closed at-risk {} ticket={} to open {} signal".format(
                        opposite, ticket, new_direction))
        else:
            print("  [REVERSAL] Failed to close ticket={}".format(ticket))
    return closed


def modify_sl(ticket, symbol, new_sl, tp):
    req = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "symbol":   symbol,
        "position": ticket,
        "sl":       round(new_sl, 2),
        "tp":       round(tp, 2),
        "magic":    config.MAGIC_NUMBER,
    }
    result = mt5.order_send(req)
    return result and result.retcode == mt5.TRADE_RETCODE_DONE


# =============================================================
# TRADE OUTCOME LOGGER

# =============================================================
# DEAL HISTORY SYNC  — catches closes missed by trail_monitor
# =============================================================

_LAST_DEAL_FILE = os.path.join(_SCRIPT_DIR, "last_synced_deal_id.txt")

def _load_synced_deal_id():
    try:
        return int(open(_LAST_DEAL_FILE).read().strip())
    except Exception:
        return 0

def _save_synced_deal_id(deal_id):
    try:
        open(_LAST_DEAL_FILE, "w").write(str(deal_id))
    except Exception:
        pass

def _load_csv_tickets():
    """Return set of ticket IDs already in trades_log.csv (for dedup)."""
    tickets = set()
    try:
        if os.path.exists(TRADES_LOG):
            with open(TRADES_LOG, newline="") as f:
                for row in csv.DictReader(f):
                    t = row.get("ticket", "")
                    if t:
                        tickets.add(str(t))
    except Exception:
        pass
    return tickets

def _sync_closed_deals():
    """
    Query MT5 deal history (24h window) and write any CNFS closes
    not yet in trades_log.csv.  Called every scan tick.
    Returns count of new rows written.
    """
    try:
        from datetime import timedelta as _td
        now   = datetime.now(timezone.utc)
        since = now - _td(hours=24)
        deals = mt5.history_deals_get(
            since.replace(tzinfo=None), now.replace(tzinfo=None))
        if not deals:
            return 0

        last_id    = _load_synced_deal_id()
        csv_tix    = _load_csv_tickets()
        by_pos     = {}
        for d in deals:
            if d.magic != config.MAGIC_NUMBER:
                continue
            by_pos.setdefault(d.position_id, []).append(d)

        written     = 0
        new_last_id = last_id
        for pos_id, pos_deals in by_pos.items():
            open_deal  = next((d for d in pos_deals if d.entry == 0), None)
            close_deal = next((d for d in pos_deals if d.entry == 1), None)
            if not close_deal or not open_deal:
                continue
            if close_deal.ticket <= last_id:
                continue
            new_last_id = max(new_last_id, close_deal.ticket)
            if str(close_deal.ticket) in csv_tix:
                continue
            direction = "BUY" if open_deal.type == 0 else "SELL"
            open_time = datetime.fromtimestamp(open_deal.time, tz=timezone.utc)
            meta = {
                "direction":   direction,
                "entry":       open_deal.price,
                "original_sl": 0.0,
                "original_tp": 0.0,
                "be_done":     False,
                "open_time":   open_time,
                "ticket":      close_deal.ticket,
            }
            log_trade_outcome(meta, close_deal.price, close_deal.profit,
                              lot=close_deal.volume)
            log_event("[SYNC] Recorded missed close: ticket={} {} @ {:.2f} → {:.2f}  P&L={:.2f}".format(
                close_deal.ticket, direction, open_deal.price,
                close_deal.price, close_deal.profit))
            written += 1

        if new_last_id > last_id:
            _save_synced_deal_id(new_last_id)
        return written
    except Exception:
        import traceback as _tb
        log_event("[SYNC] _sync_closed_deals error:\n" + _tb.format_exc())
        return 0


def _backfill_historical_deals():
    """
    Startup: scan 30 days of MT5 history for CNFS closes missing from
    trades_log.csv (e.g. bot was down when the position closed).
    Returns count of rows written.
    """
    try:
        from datetime import timedelta as _td
        now   = datetime.now(timezone.utc)
        since = now - _td(days=30)
        deals = mt5.history_deals_get(
            since.replace(tzinfo=None), now.replace(tzinfo=None))
        if not deals:
            log_event("[BACKFILL] No deals in 30-day window.")
            return 0

        csv_tix = _load_csv_tickets()
        by_pos  = {}
        for d in deals:
            if d.magic != config.MAGIC_NUMBER:
                continue
            by_pos.setdefault(d.position_id, []).append(d)

        written     = 0
        max_deal_id = 0
        for pos_id, pos_deals in by_pos.items():
            open_deal  = next((d for d in pos_deals if d.entry == 0), None)
            close_deal = next((d for d in pos_deals if d.entry == 1), None)
            if not close_deal or not open_deal:
                continue
            max_deal_id = max(max_deal_id, close_deal.ticket)
            if str(close_deal.ticket) in csv_tix:
                continue
            direction = "BUY" if open_deal.type == 0 else "SELL"
            open_time = datetime.fromtimestamp(open_deal.time, tz=timezone.utc)
            meta = {
                "direction":   direction,
                "entry":       open_deal.price,
                "original_sl": 0.0,
                "original_tp": 0.0,
                "be_done":     False,
                "open_time":   open_time,
                "ticket":      close_deal.ticket,
            }
            log_trade_outcome(meta, close_deal.price, close_deal.profit,
                              lot=close_deal.volume)
            log_event("[BACKFILL] Recovered: ticket={} {} @ {:.2f} → {:.2f}  P&L={:.2f}".format(
                close_deal.ticket, direction, open_deal.price,
                close_deal.price, close_deal.profit))
            written += 1

        if max_deal_id > 0:
            _save_synced_deal_id(max_deal_id)
        log_event("[BACKFILL] Complete — {} deal(s) recovered.".format(written))
        return written
    except Exception:
        import traceback as _tb
        log_event("[BACKFILL] error:\n" + _tb.format_exc())
        return 0

# Appends one row per closed trade to trades_log.csv.
# Used for daily analysis: TP hit rate, duration by hour, P&L trends.
# =============================================================
TRADES_LOG = os.path.join(_SCRIPT_DIR, "trades_log.csv")
_TRADES_LOG_HEADER = [
    "date", "time_open", "time_close", "ticket",
    "direction", "entry", "close_price",
    "original_sl", "original_tp", "lot",
    "pnl", "pips", "duration_min",
    "tp_hit", "be_done", "hour_open",
]

def log_trade_outcome(meta, close_px, pnl, lot=0.01):
    """Write a single closed trade row to trades_log.csv."""
    try:
        now_utc   = datetime.now(timezone.utc)
        open_time = meta.get("open_time", now_utc)
        duration  = round((now_utc - open_time).total_seconds() / 60, 1)
        direction = meta["direction"]
        entry     = meta["entry"]
        orig_tp   = meta.get("original_tp", meta.get("tp", 0))
        orig_sl   = meta.get("original_sl", 0)
        be_done   = meta.get("be_done", False)
        pips      = round((close_px - entry) / config.PIP_SIZE if direction == "BUY"
                          else (entry - close_px) / config.PIP_SIZE, 1)
        # TP hit: close within $0.20 of original TP or beyond it
        if orig_tp and orig_tp > 0:
            tp_hit = (close_px >= orig_tp - 0.20) if direction == "BUY" \
                     else (close_px <= orig_tp + 0.20)
        else:
            tp_hit = False

        now_et = now_utc.astimezone(_ET)
        row = {
            "date":        now_et.strftime("%Y-%m-%d"),
            "time_open":   open_time.astimezone(_ET).strftime("%H:%M:%S"),
            "time_close":  now_et.strftime("%H:%M:%S"),
            "ticket":      meta.get("ticket", ""),
            "direction":   direction,
            "entry":       round(entry, 2),
            "close_price": round(close_px, 2),
            "original_sl": round(orig_sl, 2),
            "original_tp": round(orig_tp, 2),
            "lot":         lot,
            "pnl":         round(pnl, 2),
            "pips":        pips,
            "duration_min": duration,
            "tp_hit":      tp_hit,
            "be_done":     be_done,
            "hour_open":   open_time.hour,
        }
        write_header = not os.path.exists(TRADES_LOG)
        with open(TRADES_LOG, "a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=_TRADES_LOG_HEADER)
            if write_header:
                w.writeheader()
            w.writerow(row)
    except Exception as e:
        print("[LOG] trade_outcome error: {}".format(e))


# =============================================================
# TRAILING STOP MONITOR  (background thread)
# =============================================================
def trail_monitor(symbol):
    print("[TRAIL] Monitor started")
    while True:
        try:
            open_pos     = get_all_positions(symbol)   # includes manual trades
            open_tickets = {p.ticket for p in open_pos}

            # Detect closed positions — send close report
            with _positions_lock:
                closed = [t for t in _positions if t not in open_tickets]
                for ticket in closed:
                    meta = _positions.pop(ticket)
                    # Query closing deal directly by position ticket — more reliable
                    # than a time-range scan (avoids timing gaps and window limits).
                    pnl      = 0.0
                    close_px = meta["entry"]
                    pos_deals = mt5.history_deals_get(position=ticket)
                    if pos_deals:
                        for d in pos_deals:
                            if d.entry == mt5.DEAL_ENTRY_OUT:
                                pnl      = d.profit
                                close_px = d.price
                                break
                    # Fallback: time-range scan (handles brokers where position= is unsupported)
                    if close_px == meta["entry"]:
                        from datetime import timedelta
                        now   = datetime.utcnow()
                        deals = mt5.history_deals_get(now - timedelta(hours=12), now)
                        if deals:
                            for d in deals:
                                if d.position_id == ticket and d.entry == mt5.DEAL_ENTRY_OUT:
                                    pnl      = d.profit
                                    close_px = d.price
                                    break
                    direction = meta["direction"]
                    pips_val  = (close_px - meta["entry"]) / config.PIP_SIZE \
                                if direction == "BUY" \
                                else (meta["entry"] - close_px) / config.PIP_SIZE
                    reason = "Trail/SL" if meta.get("be_done") else "SL hit"
                    print("[TRAIL] ticket={} closed  P&L={:+.2f}  pips={:+.1f}  ({})".format(
                        ticket, pnl, pips_val, reason))
                    send_trade_close(symbol, direction,
                                     meta["entry"], close_px,
                                     pips_val, pnl, ticket, reason)
                    log_trade_outcome(meta, close_px, pnl)

            # Update trailing stop for each open position
            for pos in open_pos:
                ticket = pos.ticket
                with _positions_lock:
                    meta = _positions.get(ticket)
                if meta is None:
                    # Auto-adopt manually opened position
                    direction = "BUY" if pos.type == 0 else "SELL"
                    atr_pips  = get_current_atr_pips(symbol)
                    atr_val   = atr_pips * config.PIP_SIZE
                    sl = pos.sl if pos.sl and pos.sl > 0 else (
                        pos.price_open - atr_val * config.ATR_SL_MULT if direction == "BUY"
                        else pos.price_open + atr_val * config.ATR_SL_MULT)
                    tp = pos.tp if pos.tp and pos.tp > 0 else (
                        pos.price_open + atr_val * config.ATR_TP_MULT if direction == "BUY"
                        else pos.price_open - atr_val * config.ATR_TP_MULT)
                    sl = round(sl, 2)
                    tp = round(tp, 2)
                    if not (pos.sl and pos.sl > 0) or not (pos.tp and pos.tp > 0):
                        modify_sl(ticket, symbol, sl, tp)
                    adopted = {
                        "ticket":      pos.ticket,
                        "entry":       pos.price_open,
                        "original_sl": sl,
                        "original_tp": tp,
                        "current_sl":  sl,
                        "tp":          tp,
                        "atr_pips":    atr_pips,
                        "direction":   direction,
                        "be_done":     False,
                        "open_time":   datetime.fromtimestamp(pos.time, tz=timezone.utc),
                    }
                    with _positions_lock:
                        _positions[ticket] = adopted
                    print("[TRAIL] Auto-adopted manual trade ticket={} {} @ {:.2f}  SL={:.2f}  TP={:.2f}  ATR={:.1f}p".format(
                        ticket, direction, pos.price_open, sl, tp, atr_pips))
                    if _ctrl:
                        _ctrl.send_report(
                            "📋 <b>Manual Trade Adopted</b>\n"
                            "Ticket: {}\nDirection: {}\nEntry: {:.2f}\n"
                            "SL: {:.2f}  TP: {:.2f}\n"
                            "ATR: {:.1f}p — trailing stop now active".format(
                                ticket, direction, pos.price_open, sl, tp, atr_pips))
                    meta = _positions[ticket]

                entry     = meta["entry"]
                tp        = meta["tp"]
                atr_pips  = meta["atr_pips"]
                direction = meta["direction"]
                be_done   = meta.get("be_done", False)

                tick = mt5.symbol_info_tick(symbol)
                if not tick:
                    continue

                cur_price  = tick.bid if direction == "BUY" else tick.ask
                float_pips = (cur_price - entry) / config.PIP_SIZE if direction == "BUY" \
                             else (entry - cur_price) / config.PIP_SIZE

                be_trigger  = max(config.MIN_BE_PIPS,  atr_pips * config.BE_TRIGGER_PCT)
                trail_dist  = max(config.MIN_TRAIL_PIPS, atr_pips * config.TRAIL_DIST_PCT)
                trail_price = trail_dist * config.PIP_SIZE

                # --- Breakeven ---
                if not be_done and float_pips >= be_trigger:
                    be_sl  = entry + config.BE_BUFFER_PRICE if direction == "BUY" \
                             else entry - config.BE_BUFFER_PRICE
                    # Remove TP so the trail manages exit and winners can run past TP
                    new_tp = 0.0 if config.REMOVE_TP_ON_BE else tp
                    if modify_sl(ticket, symbol, be_sl, new_tp):
                        with _positions_lock:
                            _positions[ticket]["be_done"]    = True
                            _positions[ticket]["current_sl"] = be_sl
                            _positions[ticket]["tp"]         = new_tp
                        tp_note = " TP removed — trail now manages exit" if config.REMOVE_TP_ON_BE else ""
                        print("[TRAIL] ticket={} BE locked @ {:.2f} (+{:.1f}p buffer={:.1f}){}".format(
                            ticket, be_sl, float_pips, config.BE_BUFFER_PRICE, tp_note))
                        send_be_locked(symbol, ticket, be_sl, float_pips)
                    continue

                # --- Trail ---
                if be_done:
                    current_sl = meta.get("current_sl", entry)
                    if direction == "BUY":
                        ideal_sl = cur_price - trail_price
                        if ideal_sl > current_sl + config.PIP_SIZE:
                            if modify_sl(ticket, symbol, ideal_sl, tp):
                                with _positions_lock:
                                    _positions[ticket]["current_sl"] = ideal_sl
                                locked = (ideal_sl - entry) / config.PIP_SIZE
                                print("[TRAIL] ticket={} trail → {:.2f} (+{:.1f}p locked)".format(
                                    ticket, ideal_sl, locked))
                    else:
                        ideal_sl = cur_price + trail_price
                        if ideal_sl < current_sl - config.PIP_SIZE:
                            if modify_sl(ticket, symbol, ideal_sl, tp):
                                with _positions_lock:
                                    _positions[ticket]["current_sl"] = ideal_sl
                                locked = (entry - ideal_sl) / config.PIP_SIZE
                                print("[TRAIL] ticket={} trail → {:.2f} (+{:.1f}p locked)".format(
                                    ticket, ideal_sl, locked))

        except Exception as e:
            print("[TRAIL ERROR] {}".format(e))

        time.sleep(config.TRAIL_INTERVAL)


# =============================================================
# SIGNAL DETECTION
# =============================================================
def check_signal(symbol):
    global _last_signal_candle, _daily_count, _daily_count_date

    today = datetime.now(timezone.utc).date()
    if _daily_count_date != today:
        _daily_count_date = today
        _daily_count      = 0

    m1  = heikin_ashi(get_rates(symbol, mt5.TIMEFRAME_M1,  config.M1_BARS))
    m15 = heikin_ashi(get_rates(symbol, mt5.TIMEFRAME_M15, config.M15_BARS))
    h1  = get_rates(symbol, mt5.TIMEFRAME_H1, config.H1_BARS)

    m1["ema"]  = calc_ema(m1["close"], config.EMA_PERIOD)
    m15["atr"] = calc_atr(m15, config.ATR_PERIOD)

    current_m1  = m1.iloc[-1]
    confirm_m1  = m1.iloc[-2]
    doji_candle = m1.iloc[-3]
    closed_m15  = m15.iloc[-2]   # last fully-closed M15 candle

    price       = current_m1["close"]
    ema_val     = current_m1["ema"]
    current_atr = closed_m15["atr"]   # ATR sourced from M15 — less noisy than M5

    log_event("Scan  Price={:.2f}  ATR(M15)={:.2f}  EMA={:.2f}".format(
        price, current_atr or 0, ema_val))

    if pd.isna(current_atr) or current_atr < config.MIN_ATR:
        log_event("  skip: ATR too low — floor ({:.2f} < {})".format(current_atr or 0, config.MIN_ATR)); return None
    atr_series = m15["atr"].dropna()
    if len(atr_series) >= 20:
        atr_avg = float(atr_series.iloc[-20:].mean())
        if current_atr < config.MIN_ATR_RATIO * atr_avg:
            log_event("  skip: ATR too low — ratio ({:.2f} < {:.0f}% of {:.2f} avg)".format(
                current_atr, config.MIN_ATR_RATIO * 100, atr_avg)); return None
    h1_dir = h1_trend(h1)
    if h1_dir is None:
        log_event("  skip: H1 trend unclear"); return None
    trend = "BUY" if price > ema_val else ("SELL" if price < ema_val else None)
    if trend is None or trend != h1_dir:
        log_event("  skip: EMA says {} but H1 says {}".format(trend, h1_dir)); return None
    if not is_doji(doji_candle):
        log_event("  skip: no doji"); return None
    if not is_high_vol_doji(m1):
        log_event("  skip: doji too small"); return None
    if not has_clean_pullback(m1, trend):
        log_event("  skip: no clean pullback"); return None
    if trend == "BUY"  and closed_m15["ha_close"] <= closed_m15["ha_open"]:
        log_event("  skip: M15 HA not bullish"); return None
    if trend == "SELL" and closed_m15["ha_close"] >= closed_m15["ha_open"]:
        log_event("  skip: M15 HA not bearish"); return None
    if trend == "BUY"  and confirm_m1["ha_close"] <= confirm_m1["ha_open"]:
        log_event("  skip: M1 HA not confirming BUY"); return None
    if trend == "SELL" and confirm_m1["ha_close"] >= confirm_m1["ha_open"]:
        log_event("  skip: M1 HA not confirming SELL"); return None

    signal_ts = str(confirm_m1["time"])
    if _last_signal_candle == signal_ts:
        log_event("  skip: same candle already acted on"); return None

    atr_val  = float(current_atr)
    sl_dist  = atr_val * config.ATR_SL_MULT
    tp_dist  = atr_val * config.ATR_TP_MULT
    sl       = round(price - sl_dist, 2) if trend == "BUY" else round(price + sl_dist, 2)
    tp       = round(price + tp_dist, 2) if trend == "BUY" else round(price - tp_dist, 2)
    atr_pips = atr_val / config.PIP_SIZE

    log_event("  *** SIGNAL {} | Entry={:.2f} SL={:.2f} TP={:.2f} ATR={:.1f}p ***".format(
        trend, price, sl, tp, atr_pips))

    return {"direction": trend, "price": price,
            "sl": sl, "tp": tp, "atr_pips": atr_pips, "candle_ts": signal_ts}


# =============================================================
# ORDER EXECUTION
# =============================================================
def execute_signal(symbol, signal):
    global _last_signal_candle, _daily_count, _last_trade_time

    direction = signal["direction"]
    sl        = signal["sl"]
    tp        = signal["tp"]
    atr_pips  = signal["atr_pips"]

    sl_dist = abs(signal["price"] - sl)
    lot     = calculate_lot_size(symbol, sl_dist, config.RISK_PERCENT,
                                 config.MAX_ACTUAL_RISK_PCT, config.RISK_CAP_MODE)
    if not lot:
        print("  Lot=0 — skip"); return

    # Close any at-risk opposite positions before entering new direction
    close_opposite_at_risk(symbol, direction)

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        print("  No tick — skip"); return

    price = tick.ask if direction == "BUY" else tick.bid
    req   = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       lot,
        "type":         mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL,
        "price":        round(price, 2),
        "sl":           round(sl, 2),
        "tp":           round(tp, 2),
        "deviation":    30,
        "magic":        config.MAGIC_NUMBER,
        "comment":      "CNFS",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    if result and result.retcode == mt5.TRADE_RETCODE_DONE:
        ticket = result.order
        with _positions_lock:
            _positions[ticket] = {
                "ticket":      ticket,
                "entry":       price,
                "original_sl": sl,
                "original_tp": tp,
                "current_sl":  sl,
                "tp":          tp,
                "atr_pips":    atr_pips,
                "direction":   direction,
                "be_done":     False,
                "open_time":   datetime.now(timezone.utc),
            }
        _last_signal_candle = signal["candle_ts"]
        _last_trade_time    = datetime.now(timezone.utc)
        try:
            with open(_LAST_TRADE_FILE, "w") as f:
                f.write(str(_last_trade_time.timestamp()))
        except Exception:
            pass
        _daily_count       += 1
        print("  ✅ Order placed ticket={} lot={} @ {:.2f}".format(ticket, lot, price))
        send_trade_open(symbol, direction, price, sl, tp, lot, ticket)
        _post_signal_to_free_channel(symbol, direction, price, sl, tp)
    else:
        print("  ❌ Order FAILED retcode={} comment={}".format(
            getattr(result, "retcode", "?"), getattr(result, "comment", "?")))


# =============================================================
# MAIN
# =============================================================
def run():
    global _symbol, _ctrl

    print("=" * 55)
    print("  CRYPTONITE FREE SIGNALS EXECUTOR")
    print("  Strategy : Relaxed HA | XAUUSD | 24/7")
    print("  BE trigger: max({} pips, {}% ATR)".format(
        config.MIN_BE_PIPS, int(config.BE_TRIGGER_PCT * 100)))
    print("  Trail gap : max({} pips, {}% ATR)".format(
        config.MIN_TRAIL_PIPS, int(config.TRAIL_DIST_PCT * 100)))
    print("  At-risk cap: {}  |  Total cap: {}".format(
        config.MAX_AT_RISK_POSITIONS, config.MAX_TOTAL_POSITIONS))
    print("=" * 55)

    # MT5 init
    if config.MT5_LOGIN and config.MT5_PASSWORD and config.MT5_SERVER:
        ok = mt5.initialize(login=config.MT5_LOGIN,
                            password=config.MT5_PASSWORD,
                            server=config.MT5_SERVER)
    else:
        ok = mt5.initialize()
    if not ok:
        raise RuntimeError("MT5 init failed: {}".format(mt5.last_error()))

    _symbol = resolve_symbol()
    mt5.symbol_select(_symbol, True)

    acc = mt5.account_info()
    if acc:
        log_event("  Login  : {}".format(acc.login))
        log_event("  Server : {}".format(acc.server))
        log_event("  Balance: ${:,.2f}".format(acc.balance))
    log_event("  Symbol : {}".format(_symbol))
    if _last_trade_time is not None:
        elapsed = (datetime.now(timezone.utc) - _last_trade_time).total_seconds()
        remaining = max(0, int(config.TRADE_COOLDOWN - elapsed))
        if remaining > 0:
            log_event("  Trade cooldown active: {}s remaining (persisted from last run)".format(remaining))
        else:
            log_event("  Last trade: {:.0f}s ago — cooldown clear".format(elapsed))

    # Adopt existing positions (bot-opened AND manual)
    _all = get_all_positions(_symbol)
    log_event("  Found {} open position(s) to adopt".format(len(_all)))
    for pos in _all:
        with _positions_lock:
            if pos.ticket not in _positions:
                direction = "BUY" if pos.type == 0 else "SELL"
                atr_pips  = get_current_atr_pips(_symbol)
                atr_val   = atr_pips * config.PIP_SIZE
                # Use existing SL/TP if set, otherwise calculate from ATR
                sl = pos.sl if pos.sl and pos.sl > 0 else (
                    pos.price_open - atr_val * config.ATR_SL_MULT if direction == "BUY"
                    else pos.price_open + atr_val * config.ATR_SL_MULT)
                tp = pos.tp if pos.tp and pos.tp > 0 else (
                    pos.price_open + atr_val * config.ATR_TP_MULT if direction == "BUY"
                    else pos.price_open - atr_val * config.ATR_TP_MULT)
                sl = round(sl, 2)
                tp = round(tp, 2)
                # Apply SL/TP to MT5 if they were missing
                if not (pos.sl and pos.sl > 0) or not (pos.tp and pos.tp > 0):
                    modify_sl(pos.ticket, _symbol, sl, tp)
                    log_event("  Applied ATR SL={:.2f} TP={:.2f} to ticket={}".format(
                        sl, tp, pos.ticket))
                _positions[pos.ticket] = {
                    "ticket":      pos.ticket,
                    "entry":       pos.price_open,
                    "original_sl": sl,
                    "current_sl":  sl,
                    "tp":          tp,
                    "atr_pips":    atr_pips,
                    "direction":   direction,
                    "be_done":     False,
                }
                print("  Adopted existing position ticket={} {} @ {:.2f}  SL={:.2f}  TP={:.2f}".format(
                    pos.ticket, direction, pos.price_open, sl, tp))

    # Backfill any closes missed while bot was down (30-day window)
    _bf = _backfill_historical_deals()
    if _bf > 0:
        log_event("[BACKFILL] {} deal(s) recovered to trades_log.csv.".format(_bf))
        report("📂 <b>Backfill complete</b> — {} missed close(s) recovered from MT5 history.".format(_bf))

    # Start trailing stop monitor
    threading.Thread(target=trail_monitor, args=(_symbol,), daemon=True).start()

    # Start Telegram control bot if configured
    _ctrl = None
    if config.CTRL_BOT_TOKEN and config.CTRL_CHAT_ID:
        _ctrl = TelegramControl(
            bot_token       = config.CTRL_BOT_TOKEN,
            control_chat_id = config.CTRL_CHAT_ID,
            report_chat_id  = config.REPORT_CHAT_ID,
            get_state_fn    = get_bot_state,
            pause_fn        = pause_trading,
            resume_fn       = resume_trading,
        )
        _ctrl.start()
        print("  Telegram control bot: ACTIVE (chat={})".format(config.CTRL_CHAT_ID))
    else:
        print("  Telegram control bot: NOT configured (set CTRL_BOT_TOKEN + CTRL_CHAT_ID in .env)")

    send_session_open()
    print("\n  Running 24/7 — Ctrl+C to stop\n")

    try:
        while True:
            try:
                open('heartbeat.txt', 'w').write(str(time.time()))
            except Exception:
                pass
            try:
                _sync_closed_deals()
                if can_open_new(_symbol):
                    signal = check_signal(_symbol)
                    if signal:
                        execute_signal(_symbol, signal)
                else:
                    check_signal(_symbol)
                _maybe_send_eod_report()
            except Exception as e:
                print("[ERROR] {}".format(e))

            print("  Next check in {}s\n".format(config.CHECK_INTERVAL))
            time.sleep(config.CHECK_INTERVAL)

    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        send_status("STOPPED")
        if _ctrl:
            _ctrl.stop()
        mt5.shutdown()


if __name__ == "__main__":
    run()
