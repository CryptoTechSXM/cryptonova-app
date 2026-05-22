---
name: cnms-daily-analysis
description: Daily CNMS trade outcome analysis — exit-layer breakdown, H1 filter efficiency, P&L vs CNFS comparison
---

Analyse today's CNMS (CryptoNite MACD Signals) trade outcomes and bot health.

## Bot context
CNMS trades MACD(12,26,9) crossovers on M15 bars with an H1 MACD trend filter. Trades exit via a three-layer system: (1) scalp lock — moves SL to lock 0.20× SL profit once float reaches 0.40× SL; (2) ATR trail at 0.80× ATR(14) once scalp-lock is active; (3) MACD unwind — closes on the next opposite M15 crossover. A broker-side safety TP is set at 5× SL distance but is rarely the actual exit. This is a **DEMO** account on symbol XAUUSD.s (balance ~$100).

**Timezone note:** Timestamps in `cnms_events.log` and `trades.csv` are in local EDT (UTC−4). All "UTC" labels inside bracket messages (e.g. bar close times) are broker server time (approximately UTC+7), NOT true UTC. For hour-of-day analysis, derive the UTC hour from the `time` field by adding 4 hours.

## Files to read
- Trades:     `C:\CryptoNite-MT5-Bots\0-CNMS-Bot\trades.csv`
- Events log: `C:\CryptoNite-MT5-Bots\0-CNMS-Bot\cnms_events.log`
- State file: `C:\CryptoNite-MT5-Bots\0-CNMS-Bot\cnms_state.json`

## trades.csv schema
`time, ticket, symbol, side, lots, entry, sl, tp, close_price, profit, exit_reason`

- `time` — close time (EDT string, e.g. `2026-05-22 03:45:02`)
- `tp` — broker safety TP (5× SL distance), not the intended exit target; do **not** use as TP-hit indicator
- `exit_reason` — one of: `SCALP_LOCK`, `ATR_TRAIL`, `MACD_UNWIND_BUY`, `MACD_UNWIND_SELL`, `SL`

There is **no** `duration_min` or `hour_open` column. Compute duration by matching the close ticket in `trades.csv` to the corresponding `[TRADE] ✅ Ticket=NNN` open event in `cnms_events.log`. Derive `hour_open` (UTC) from the open timestamp + 4 hours.

## What to analyse

### 1. Today's trade summary
Filter `trades.csv` for rows where the date portion of `time` equals today. Calculate:
- Total trades closed today
- Wins (`profit > 0.50`), Losses (`profit < -0.50`), BEs (`|profit| ≤ 0.50`)
- Net P&L
- Win rate (excl. BE)
- Exit-layer breakdown: count of SCALP_LOCK / ATR_TRAIL / MACD_UNWIND_BUY / MACD_UNWIND_SELL / SL exits
- Avg profit by exit reason
- Avg duration (min) by exit reason — compute from log open times

### 2. Exit-layer analysis (CNMS-specific)
The three exit layers tell the story of how far each trade progressed before closing:
- `SCALP_LOCK` → trade moved ≥ 0.40× SL in favour, locked ~0.20× SL profit; scalp-locked but trail not active yet
- `ATR_TRAIL` → trade moved far enough for the ATR trail to trigger before MACD unwound
- `MACD_UNWIND_*` → opposite crossover closed the trade before scalp-lock or trail fired (fastest reversal exits)
- `SL` → full stop loss hit before any layer engaged

For each exit reason that occurred today: show count, avg profit, avg duration, and what fraction of total trades it represents.

Flag: if MACD_UNWIND exits consistently have negative avg profit (< -1.00), the MACD signal quality may be weak (whipsaws). If SL exits outnumber SCALP_LOCK + ATR_TRAIL exits, the bot is taking more full losses than protected wins.

### 3. H1 filter efficiency
From `cnms_events.log`, count for today:
- Raw M15 MACD crossover signals generated (`[SIGNAL] XAUUSD.s BUY/SELL crossover`)
- Signals blocked by H1 filter (`[H1 FILTER] ... blocked`)
- Signals executed (crossovers that led to `[TRADE] ✅`)
- Signals skipped for other reasons (spread, position cap, news filter — look for `[SPREAD]`, `[NEWS]`, `[POSITION]` log lines)

H1 filter block rate = blocked / raw signals. Flag if block rate > 70% (overly restrictive) or < 20% (filter may not be doing much).

### 4. Time-of-day breakdown (UTC)
For each trade today, derive hour_open in UTC (log open timestamp + 4h). Group by UTC hour:
- Trade count, W/L/BE split, avg profit, exit-reason mix
Flag any hour with 2+ losses and 0 wins as a potential weak period.

### 5. Bot health check
From the most recent lines of `cnms_events.log`:
- Is the bot actively scanning? (Look for `[BAR]` or `[SIGNAL] ⏱ Next 15m bar` within the last 20 minutes of log)
- Any repeated restart loops? (Multiple `============` banners within a short window = unstable)
- Any connection errors or MT5 disconnects?
- Report: account balance from the last `[MT5] Connected ... balance=` or `[LOT]` line
- Note: repeated `[MT5] Connected` lines every 5s are **normal** — this is the MANAGER_INTERVAL_SECONDS=5 heartbeat

### 6. Comparison with CNFS (today only)
Pull today's summary from `C:\CryptoNite-MT5-Bots\0-CryptoNite-Free-Signals-Executor\trades_log.csv` and compare side-by-side:

| Metric | CNMS | CNFS |
|---|---|---|
| Trades closed | | |
| Net P&L | | |
| Win rate (excl. BE) | | |
| Avg win ($) | | |
| Avg loss ($) | | |
| Largest single loss | | |

Note: CNMS is DEMO ($100 account, 0.01 lots), CNFS is live (~$1,200 account, 0.01 lots). Both trade XAUUSD. Do not draw capital-level comparisons, but R:R and win-rate patterns are comparable.

### 7. Recommendation flags
If you find:
- MACD_UNWIND exits with avg profit < -1.50 → whipsaws are damaging; consider enabling the zero-line filter (`ZERO_LINE_FILTER_ENABLED=true`)
- SL hit rate > 40% → scalp-lock not engaging; consider tightening the trigger from 0.40× to 0.30× SL
- H1 filter block rate > 70% → too restrictive; note how many signals were blocked that may have been profitable
- H1 filter block rate < 20% → filter is barely filtering; check if H1 MACD and M15 are nearly always aligned
- Bot restarting > 3 times per day → instability flag; note number of restart banners in the log
- Any hour (UTC) with 2+ losses and 0 wins → candidate for a time filter (note: `TIME_FILTER_ENABLED=false` currently)
- `cnms_state.json` trade count for today differs from `trades.csv` row count → CSV write may have been interrupted during a restart; note the discrepancy

## Output
Write a markdown report to:
`C:\CryptoNite-MT5-Bots\0-CNMS-Bot\daily_reports\YYYY-MM-DD_analysis.md`
(create `daily_reports` if it doesn't exist; use today's date in the filename)

The report must include:
- A one-line headline verdict
- All seven sections with real numbers
- A "what to watch tomorrow" note

If `trades.csv` has no rows for today (besides the header), write a brief note and check `cnms_events.log` for the reason (news block, no crossovers, spread rejection, etc.).
