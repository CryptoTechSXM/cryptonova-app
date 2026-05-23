# ============================================================
# CNMS MACD Adaptive — Daily Report Generator
# macd_daily_report.py
#
# Reads today's closed BTC trades directly from MT5,
# generates a daily report (markdown + Telegram message),
# and saves it to the daily_reports folder.
#
# Run manually:  python macd_daily_report.py
# Scheduled:     Windows Task Scheduler → daily at 17:00
# ============================================================

import os, sys, csv, json, math, urllib.request, urllib.parse
from datetime import datetime, timezone, date, timedelta
from pathlib import Path

# ── Try to import MT5 library ─────────────────────────────────────────────────
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False

# ═══════════════════════════════════════════════════════════════
# SETTINGS  —  edit these to match your setup
# ═══════════════════════════════════════════════════════════════
MAGIC_NUMBER    = 202600          # Must match InpMagicNumber in the EA
SYMBOL          = "BTCUSD"        # Symbol the bot trades (partial match ok)
REPORT_DIR      = Path(__file__).parent / "daily_reports"
TRADES_CSV      = Path(__file__).parent / "trades.csv"

# Telegram — reuse same bot & chat as CNMS
BOT_TOKEN       = "7716066914:AAEZATUSQXRRsTIO3xCIrYpNJ8dwzEnF1Iw"
CHAT_ID         = "-1003660487270"

# Account targets (adjust to match your plan)
DAILY_TARGET_PCT = 2.0            # Flag if daily P&L > this % (positive)
MAX_DAILY_LOSS_PCT = 3.0          # Flag if daily loss > this %

# ═══════════════════════════════════════════════════════════════

REPORT_DIR.mkdir(exist_ok=True)

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

# ── Connect to MT5 ─────────────────────────────────────────────────────────────
def connect_mt5():
    if not MT5_AVAILABLE:
        log("MetaTrader5 library not installed. Run: pip install MetaTrader5")
        return False
    if not mt5.initialize():
        log(f"MT5 initialize failed: {mt5.last_error()}")
        return False
    log(f"MT5 connected — Account #{mt5.account_info().login}")
    return True

# ── Fetch today's closed trades from MT5 ──────────────────────────────────────
def get_todays_trades(report_date: date):
    day_start = datetime(report_date.year, report_date.month, report_date.day,
                         0, 0, 0, tzinfo=timezone.utc)
    day_end   = day_start + timedelta(days=1)

    deals = mt5.history_deals_get(day_start, day_end)
    if deals is None:
        deals = []

    trades = []
    for d in deals:
        # Only closing deals (entry == 1 = out) for our magic number on BTCUSD
        if d.magic != MAGIC_NUMBER and d.magic != 0:
            continue
        if SYMBOL.upper() not in d.symbol.upper():
            continue
        if d.entry != mt5.DEAL_ENTRY_OUT:
            continue

        side = "BUY"  if d.type == mt5.DEAL_TYPE_BUY  else "SELL"
        trades.append({
            "ticket":   d.position_id,
            "symbol":   d.symbol,
            "side":     side,
            "lots":     d.volume,
            "profit":   round(d.profit, 2),
            "time":     datetime.fromtimestamp(d.time, tz=timezone.utc).strftime("%H:%M"),
            "price":    d.price,
            "magic":    d.magic,
            "adopted":  d.magic != MAGIC_NUMBER,
        })

    return trades

# ── Get account info ───────────────────────────────────────────────────────────
def get_account_info():
    info = mt5.account_info()
    if info is None:
        return {}
    return {
        "login":    info.login,
        "balance":  round(info.balance, 2),
        "equity":   round(info.equity, 2),
        "margin":   round(info.margin, 2),
        "free_margin": round(info.margin_free, 2),
        "currency": info.currency,
        "leverage": info.leverage,
        "server":   info.server,
        "mode":     "DEMO" if info.trade_mode == 0 else "LIVE",
    }

# ── Get open positions ─────────────────────────────────────────────────────────
def get_open_positions():
    positions = mt5.positions_get(symbol=None)
    if positions is None:
        return []
    open_pos = []
    for p in positions:
        if SYMBOL.upper() not in p.symbol.upper():
            continue
        side  = "BUY" if p.type == 0 else "SELL"
        adopted = p.magic != MAGIC_NUMBER
        open_pos.append({
            "ticket": p.ticket,
            "side":   side,
            "lots":   p.volume,
            "entry":  p.price_open,
            "sl":     p.sl,
            "tp":     p.tp,
            "profit": round(p.profit, 2),
            "magic":  p.magic,
            "adopted": adopted,
        })
    return open_pos

# ── Write trades to CSV ────────────────────────────────────────────────────────
def append_trades_to_csv(trades, report_date):
    file_exists = TRADES_CSV.exists()
    with open(TRADES_CSV, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "date","time","ticket","symbol","side","lots","profit","price","adopted"
        ])
        if not file_exists:
            writer.writeheader()
        for t in trades:
            writer.writerow({
                "date":    report_date.isoformat(),
                "time":    t["time"],
                "ticket":  t["ticket"],
                "symbol":  t["symbol"],
                "side":    t["side"],
                "lots":    t["lots"],
                "profit":  t["profit"],
                "price":   t["price"],
                "adopted": t["adopted"],
            })

# ── Build the report ──────────────────────────────────────────────────────────
def build_report(trades, open_positions, account, report_date: date) -> tuple[str, str]:
    """Returns (markdown_text, telegram_text)"""

    day_str   = report_date.strftime("%Y-%m-%d")
    today_str = report_date.strftime("%A %d %B %Y")

    # ── Metrics
    n_trades  = len(trades)
    net_pnl   = round(sum(t["profit"] for t in trades), 2)
    wins      = [t for t in trades if t["profit"] > 0.10]
    losses    = [t for t in trades if t["profit"] < -0.10]
    bes       = [t for t in trades if abs(t["profit"]) <= 0.10]
    n_adopted = sum(1 for t in trades if t["adopted"])

    win_rate  = (len(wins) / n_trades * 100) if n_trades > 0 else 0
    avg_win   = (sum(t["profit"] for t in wins)   / len(wins))   if wins   else 0
    avg_loss  = (sum(t["profit"] for t in losses) / len(losses)) if losses else 0
    best      = max((t["profit"] for t in trades), default=0)
    worst     = min((t["profit"] for t in trades), default=0)

    balance   = account.get("balance", 0)
    equity    = account.get("equity", 0)
    mode      = account.get("mode", "DEMO")
    currency  = account.get("currency", "USD")
    login     = account.get("login", "N/A")

    pnl_pct   = (net_pnl / (balance - net_pnl) * 100) if (balance - net_pnl) != 0 else 0

    # ── Flags
    flags = []
    if n_trades == 0:
        flags.append("ℹ️ No trades closed today — market may be ranging or no signals fired")
    if pnl_pct < -MAX_DAILY_LOSS_PCT:
        flags.append(f"🚨 Daily loss ({pnl_pct:.1f}%) exceeded -{MAX_DAILY_LOSS_PCT}% threshold")
    if pnl_pct > DAILY_TARGET_PCT:
        flags.append(f"✅ Daily target hit! +{pnl_pct:.1f}%")
    if n_trades > 0 and win_rate < 40:
        flags.append(f"⚠️ Win rate low today ({win_rate:.0f}%) — review signal quality")
    if n_adopted > 0:
        flags.append(f"ℹ️ {n_adopted} manually-opened trade(s) were adopted and managed by the bot")
    if len(open_positions) > 0:
        flag_pos = ", ".join(f"#{p['ticket']} {p['side']} (P&L ${p['profit']:+.2f})" for p in open_positions)
        flags.append(f"📂 {len(open_positions)} position(s) still open: {flag_pos}")

    flags_md = "\n".join(f"- {f}" for f in flags) if flags else "- ✅ No flags raised today"

    # ── Trade table rows
    trade_rows = ""
    for t in trades:
        tag = " *(adopted)*" if t["adopted"] else ""
        icon = "✅" if t["profit"] > 0.10 else ("❌" if t["profit"] < -0.10 else "➖")
        trade_rows += (f"| {t['ticket']} | {t['side']} | {t['lots']} | "
                       f"{t['time']} UTC | {t['price']:.2f} | "
                       f"**{t['profit']:+.2f}**{tag} | {icon} |\n")

    if not trade_rows:
        trade_rows = "| — | — | — | — | — | — | — |\n"

    # ── Open positions table
    pos_rows = ""
    for p in open_positions:
        tag = " *(adopted)*" if p["adopted"] else ""
        pos_rows += (f"| {p['ticket']} | {p['side']} | {p['lots']} | "
                     f"{p['entry']:.2f} | {p['sl']:.2f} | {p['tp']:.2f} | "
                     f"**{p['profit']:+.2f}**{tag} |\n")

    if not pos_rows:
        pos_rows = "| — | — | — | — | — | — | — |\n"

    # ══════════════════════════════════════════════════════════════
    # MARKDOWN REPORT
    # ══════════════════════════════════════════════════════════════
    md = f"""# CNMS MACD Adaptive — Daily Report {day_str}

**{today_str}**  |  Account #{login} ({mode})  |  {SYMBOL}

---

## 1. Day Summary

| Metric | Value |
|---|---|
| Trades closed today | {n_trades} |
| Wins (profit > $0.10) | {len(wins)} |
| Losses (profit < −$0.10) | {len(losses)} |
| Breakevens | {len(bes)} |
| Adopted manual trades | {n_adopted} |
| Net P&L | **${net_pnl:+.2f}** |
| Net P&L (%) | **{pnl_pct:+.2f}%** |
| Win rate (excl. BE) | **{win_rate:.1f}%** ({len(wins)}/{n_trades}) |
| Avg win | ${avg_win:+.2f} |
| Avg loss | ${avg_loss:+.2f} |
| Best trade | ${best:+.2f} |
| Worst trade | ${worst:+.2f} |
| Account balance | ${balance:,.2f} {currency} |
| Account equity | ${equity:,.2f} {currency} |

---

## 2. Trade Log

| Ticket | Side | Lots | Close Time | Price | Profit | Result |
|---|---|---|---|---|---|---|
{trade_rows}
---

## 3. Open Positions at Report Time

| Ticket | Side | Lots | Entry | SL | TP | Float P&L |
|---|---|---|---|---|---|---|
{pos_rows}
---

## 4. Flags & Observations

{flags_md}

---

## 5. Strategy Reminder

- **Entry:** H4 MACD trend bias + H1 MACD crossover
- **Stop Loss:** 1.0 × ATR(14)  |  **Take Profit:** 2.0 × ATR(14)
- **Trail:** Activates at 0.8 × ATR profit, trails at 0.8 × ATR distance
- **Adoption:** Manual trades on {SYMBOL} without magic #{MAGIC_NUMBER} are auto-managed

---

*Automated report · CNMS MACD Adaptive · {SYMBOL} · H4 trend + H1 entry · Generated {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}*
"""

    # ══════════════════════════════════════════════════════════════
    # TELEGRAM MESSAGE  (shorter version)
    # ══════════════════════════════════════════════════════════════
    pnl_icon  = "🟢" if net_pnl >= 0 else "🔴"
    wr_icon   = "✅" if win_rate >= 50 else ("⚠️" if win_rate >= 35 else "🚨")

    tg_flags = "\n".join(f"  {f}" for f in flags) if flags else "  ✅ All clear"

    tg = f"""📊 *CNMS MACD Adaptive — Daily Report*
{day_str} | {SYMBOL} | {mode} #{login}

{pnl_icon} *Net P&L:* ${net_pnl:+.2f} ({pnl_pct:+.2f}%)
📈 *Trades:* {n_trades} closed | {len(open_positions)} open
{wr_icon} *Win Rate:* {win_rate:.0f}% ({len(wins)}W / {len(losses)}L)
💰 *Balance:* ${balance:,.2f} {currency}

*Top trade:* ${best:+.2f}  |  *Worst:* ${worst:+.2f}
{"📋 *Adopted:* " + str(n_adopted) + " manual trade(s) managed" if n_adopted > 0 else ""}

*Flags:*
{tg_flags}

_H4 trend + H1 entry | SL 1.0×ATR | TP 2.0×ATR_"""

    return md, tg

# ── Send Telegram message ─────────────────────────────────────────────────────
def send_telegram(text: str) -> bool:
    if not BOT_TOKEN or not CHAT_ID:
        log("Telegram not configured — skipping send")
        return False
    try:
        url  = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id":    CHAT_ID,
            "text":       text,
            "parse_mode": "Markdown",
        }).encode()
        req  = urllib.request.Request(url, data=data, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
            if resp.get("ok"):
                log("✅ Telegram report sent")
                return True
            else:
                log(f"Telegram error: {resp}")
                return False
    except Exception as e:
        log(f"Telegram send failed: {e}")
        return False

# ── Save markdown report ───────────────────────────────────────────────────────
def save_report(md: str, report_date: date):
    path = REPORT_DIR / f"{report_date.isoformat()}_macd_report.md"
    path.write_text(md, encoding="utf-8")
    log(f"Report saved → {path}")
    return path

# ══════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════
def main():
    # Determine report date
    # If run before noon → report on yesterday; after noon → report today
    now         = datetime.now(timezone.utc)
    report_date = now.date() if now.hour >= 12 else (now.date() - timedelta(days=1))

    # Allow manual override: python macd_daily_report.py 2026-05-22
    if len(sys.argv) > 1:
        try:
            report_date = date.fromisoformat(sys.argv[1])
        except ValueError:
            log(f"Invalid date argument: {sys.argv[1]} — using {report_date}")

    log(f"Generating MACD Adaptive report for {report_date}")

    # ── Connect MT5
    if not connect_mt5():
        log("Could not connect to MT5. Is MetaTrader 5 open?")
        sys.exit(1)

    # ── Pull data
    trades       = get_todays_trades(report_date)
    open_pos     = get_open_positions()
    account      = get_account_info()

    log(f"Found {len(trades)} closed trades, {len(open_pos)} open positions")

    # ── Save to CSV
    if trades:
        append_trades_to_csv(trades, report_date)

    # ── Build report
    md_text, tg_text = build_report(trades, open_pos, account, report_date)

    # ── Save markdown
    save_report(md_text, report_date)

    # ── Send Telegram
    send_telegram(tg_text)

    # ── Done
    mt5.shutdown()
    log("Done.")

if __name__ == "__main__":
    main()
