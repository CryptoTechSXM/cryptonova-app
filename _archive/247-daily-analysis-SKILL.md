Analyse today's trade outcomes for the two 247 Telegram signal executor bots (0-mt5-247A-bot and 0-mt5-247B-bot) and produce a combined A/B comparison report.

These bots listen to the same Telegram channels and execute trades from those signals. They are intentional A/B variants:
- **247A**: TRAIL_DISTANCE_USD=2.0, SCALP_LOCK_TRIGGER=1.2, SCALP_LOCK_AMOUNT=0.6
- **247B**: TRAIL_DISTANCE_USD=3.0, SCALP_LOCK_TRIGGER=2.4, SCALP_LOCK_AMOUNT=0.8

## Files to read

### Bot A
- Trades:  `C:\CryptoNite-MT5-Bots\0-mt5-247A-bot\trades.csv`
- Signals: `C:\CryptoNite-MT5-Bots\0-mt5-247A-bot\signal_intake.csv`
- Events:  `C:\CryptoNite-MT5-Bots\0-mt5-247A-bot\events.log`

### Bot B
- Trades:  `C:\CryptoNite-MT5-Bots\0-mt5-247B-bot\trades.csv`
- Signals: `C:\CryptoNite-MT5-Bots\0-mt5-247B-bot\signal_intake.csv`
- Events:  `C:\CryptoNite-MT5-Bots\0-mt5-247B-bot\events.log`

## What to analyse

### 1. Today's trade summary (per bot)
Filter `trades.csv` for today's date (match `time_utc` starting with YYYY-MM-DD). For each bot calculate:
- Total trades closed today
- Wins (profit > 0), Losses (profit < 0), BEs (profit == 0)
- Net P&L for the day
- Win rate (excl BE)
- Avg profit on wins, avg loss on losses
- Any trades where `mfe_pips > 0` but profit < 0 (price moved in favour but still lost — trail too tight)

### 2. Signal-to-execution comparison
From `signal_intake.csv`, count signals where `classification == ENTRY_SIGNAL` for today. Compare to trades executed today. Calculate execution rate (trades / entry signals × 100%). If execution rate < 50%, note likely causes:
- Kill-switch triggered (check events.log for KILL_SWITCH, MAX_DAILY_LOSS, DAILY_TARGET_HIT)
- Trade cap hit (WINNING cap or AFTER_LOSS cap)
- Signal parse failures (check events.log for PARSE_FAIL lines)
- Position already open / pending cap hit

### 3. Channel performance breakdown
Group today's closed trades by `channel_id`. For each channel:
- Trade count, W/L split, net P&L
- Flag channels with 0% win rate and 2+ trades as underperformers
- Note: `channel_id=RECOVERED` means source channel was lost on restart; `channel_id=UNKNOWN` means it was never captured. Count these separately and flag if they're a large proportion — it means channel attribution tracking needs a fix.

### 4. A vs B comparison
Side-by-side for today (and all-time if today has <3 trades each):
- Net P&L: A vs B
- Win rate: A vs B
- Avg profit per trade: A vs B
- Any trade where both bots took the same signal (same approximate time_utc within 60s) — did they get different outcomes? This is the core A/B signal. Note the trail difference impact.

### 5. Kill-switch and risk status
From `events.log` for each bot:
- Search for: KILL_SWITCH, MAX_DAILY_LOSS, DAILY_TARGET_HIT, DRAWDOWN_ALERT, MAX_CONSEC
- Report whether any risk limits were hit today
- Report current consecutive loss count if visible in logs
- Note the limits: MAX_DAILY_LOSS=75%, MAX_CONSEC_LOSSES=20, DAILY_PROFIT_TARGET=3%

### 6. Bot health check
From `events.log` tail (last 50 non-empty lines) for each bot:
- Is the bot currently running? (look for "Listening for signals" and recent timestamps)
- How many restarts today? (count "DOTENV_FILE=" lines dated today)
- Last known MT5 login and server
- Any error lines (look for ERROR, Exception, Traceback, disconnected)

### 7. Recommendation flags
- If execution rate < 30% → investigate kill-switch or cap trigger in events.log
- If channel_id=UNKNOWN or RECOVERED > 50% of trades → channel attribution broken, note it
- If Bot A net P&L > Bot B net P&L → tighter trail ($2) performing better today; consider narrowing B
- If Bot B net P&L > Bot A net P&L → wider trail ($3) performing better today; consider widening A
- If both bots show same losing pattern (same hour, same side) → signal quality issue from that channel, not a config issue
- If mfe_pips > 10 but profit < 0 → trail is too tight relative to volatility; flag for trail review

## Output
Create the `daily_reports` folder under each bot's directory if it doesn't exist.

Write a combined markdown report to:
`C:\CryptoNite-MT5-Bots\0-mt5-247A-bot\daily_reports\YYYY-MM-DD_analysis.md`

Also write the same report to:
`C:\CryptoNite-MT5-Bots\0-mt5-247B-bot\daily_reports\YYYY-MM-DD_analysis.md`

(Use today's date in the filename. Both files should be identical — it's a shared A/B report.)

The report should include:
- A one-line headline verdict covering both bots (e.g. "Bot B wins today — wider trail captured $8.20 vs A's -$2.10; 18/22 signals executed")
- All seven sections above with real numbers
- A concise "what to watch tomorrow" note focused on: which bot is ahead, whether channel attribution is fixed, and any kill-switch proximity

If `trades.csv` is empty or has no trades for today, still run the signal and health checks and write a brief status report.
