# CryptoNite MT5 Bots — Cowork Session Brief
**Last updated: 2026-05-11 | Start here for any new Cowork session**

---

## Active Bots (all running on PUPrime demo)

| Folder | Strategy | Symbol | Status |
|--------|----------|--------|--------|
| `0-tg-mt5-bot` | XAUUSD main scalper (news + time filter) | XAUUSD.s | ✅ Running |
| `0-mt5-247-bot` | XAUUSD 24/7 multi-channel signal executor | XAUUSD.s | ✅ Running |
| `0-CryptoNite-Free-Signals-Executor` | Free signals executor (CNFS) | XAUUSD.s | ✅ Running |
| `1-btc-ha-bot` | BTC Heikin-Ashi scalper (M1 HA + EMA100 + ATR) | BTCUSD | ✅ Running |
| `2-eurusd-ha-bot` | EURUSD Heikin-Ashi scalper | EURUSD | ✅ Running |
| `3-Quick-Scalp-TSLA` | TSLA engulfing reversal off opening range | TSLA | ✅ Running |
| `4-Quick-Scalp-META` | META engulfing reversal off opening range | META | ✅ Running |
| `5-Quick-Scalp-NFLX` | NFLX engulfing reversal off opening range | NFLX | ✅ Running |
| `6-Quick-Scalp-NAS100` | NAS100 opening range breakout (QFS) | NAS100.s | ✅ Running |
| `7-Quick-Scalp-GER40` | GER40 Frankfurt open breakout (QFS) | GER40.s | ✅ Running |
| `CryptoNite-Free-Signals` | Signal source (not a trading bot) | — | ✅ Running |

---

## Retired Bots (do not restart)
Stored in `C:\CryptoNite-MT5-Bots\` with `x` prefix or original name — main.py replaced with retirement stub.

- `x1-gold-ha-bot` — Gold HA bot (retired: 3 XAUUSD bots already running)
- `x3-eth-ha-bot` — ETH HA bot (retired: ETH not in broker lineup)
- `x4-nas100-ha-bot` — NAS100 HA bot (retired: QFS outperforms HA on NAS100)
- `x8-Quick-Scalp-XAUUSD` — XAUUSD quick scalp (retired: redundant with existing XAUUSD bots)

---

## Syncthing Setup (resolved 2026-05-11)

### Final ignore rules (applied on ALL devices via Syncthing folder → Edit → Ignore Patterns)
```
**/heartbeat.txt
**/heartbeat.sync-conflict-*.txt
**/events.log
**/bot.log
**/free_signals.log
**/free_signals_pre_fix_*.log
**/state.json
signal_bridge.json
**/backups/
**/stignore_NEW.txt
**/*.session
**/*.session-journal
**/__pycache__
**/*.pyc / **/*.pyo / **/*.pyd
**/*.sync-conflict-*
**/*.tmp / **/*.bak / **/*~
**/.DS_Store / **/Thumbs.db / **/*.swp
**/trade_log*.txt
**/trade_log*.csv
.git/
```
**Root causes of perpetual "stuck at 90-92%":**
1. `heartbeat.txt` written every 10s by each bot — Syncthing chased a moving target
2. `trade_log.txt` (856 KiB) actively written by `0-tg-mt5-bot` — file changed faster than it could sync
3. `.git/` folder (544 KiB) — git sync to GitHub rewrites index/objects constantly
4. Remote devices had old ignore rules — fix required manually pasting rules into each device's Syncthing UI (Folder → Edit → Ignore Patterns), NOT just editing `.stignore` on LT01

**SyncTrayzor note:** incompatible with Syncthing v2.0.16 (removed `-n` flag). Access Syncthing directly at `http://localhost:8384` in browser.

---

## Key Fixes Applied (2026-05-10)

### EURUSD HA Bot (`2-eurusd-ha-bot`)
- **Root cause of 0% win rate**: Trade log showed close times (03:00–06:00 UTC) — trades opened correctly during London/NY but Asia session HA candles triggered reversal exit overnight
- **Fix 1**: `session_close_guard()` now closes ALL positions at session end (no overnight holds)
- **Fix 2**: Reversal exit counter gated to session hours only — resets to 0 outside session so Asia candles don't count
- **Fix 3**: Weekend guard added to main loop
- Old trade log archived as `trade_log_pre_fix_20260510.csv`, fresh log started

### Symbol Name Fixes (TMFinancials → PUPrime)
- TSLA: `BASE_SYMBOL` changed from `"TESLA"` → `"TSLA"`
- NFLX: `BASE_SYMBOL` changed from `"NETFLIX"` → `"NFLX"`
- GER40: `BASE_SYMBOL` changed from `"DE30"` → `"GER40"` (broker uses `GER40.s`, resolver finds via suffix)
- TSLA `resolver.py`: removed bad reverse-contains logic that matched "A" (Agilent) to "TESLA"

### Lot Sizing
- `1-btc-ha-bot/lot.py` and `2-eurusd-ha-bot/lot.py` updated to include balance-tier scaling (copied from `6-Quick-Scalp-NAS100/lot.py`)
- Balance tiers: <$500=0.10x | <$1000=0.25x | <$2000=0.50x | <$5000=0.75x | ≥$5000=1.00x

### Weekend Guard
- Added to all session-based bots (3-TSLA, 4-META, 5-NFLX, 6-NAS100, 7-GER40) and `0-tg-mt5-bot/time_filter.py`
- Pattern: `if now.weekday() >= 5: time.sleep(60); continue`

### Folder Renames (cosmetic, no code changes)
- `2-btc-ha-bot` → `1-btc-ha-bot`
- `5-eurusd-ha-bot` → `2-eurusd-ha-bot`
- `5-Quick-Scalp-META` → `4-Quick-Scalp-META`
- `9-Quick-Scalp-NFLX` → `5-Quick-Scalp-NFLX`

---

## Data Collection Status
- **Start date**: 2026-05-10 (all logs cleaned and reset)
- **Target**: Minimum 20 trades per bot before any strategy changes
- **Review date**: ~2026-05-24 (2-week mark)
- **Rule**: No strategy changes until review — monitor daily P&L only

---

## What to Watch
- **EURUSD win rate** — should improve now overnight bug is fixed
- **GER40 signal frequency** — new symbol name, confirm it finds trades at Frankfurt open (07:00 UTC)
- **retcode=10018** errors — "market closed" means weekend guard missed something
- **Lot sizes** — confirm they scale with current balance tier

---

## Post-Review Candidates (after 2-week data)
- Evaluate session time filters for CNFS executor (currently trades 24/7)
- Consider loosening HA bot filters toward CNFS style if HA trade frequency too low
- Implement trade adoption for bots 2–9 (ATR-based SL detection, like 0-CNFS)

---

## Architecture Notes
- All bots use `resolver.py` — tries exact symbol name then suffixes (.s, .p, .pro, .f) then broker-wide search
- Heartbeat: each bot writes a unix timestamp to `heartbeat.txt` each loop — used to verify bot is alive (note: skipped during weekend sleep loop, so GER40/session bots will show last Friday's timestamp on weekends — this is normal)
- Magic numbers are unique per bot to prevent cross-bot interference
- `risk.py` / `DailyRiskManager`: tracks daily P&L, max daily loss %, consecutive loss kill switch

---

## Broker
**PUPrime** demo account — all bots confirmed connected and resolving symbols correctly as of 2026-05-10
