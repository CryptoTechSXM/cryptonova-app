# Gold HK Scalper Bot — V2

A modular Python MT5 scalper for XAUUSD, rebuilt for reliability and profitability.

---

## How the Strategy Works

The bot uses **3 conditions** that must ALL be true before entering a trade:

### Step 1 — H1 Trend Filter
- Calculates EMA-100 on the 1-hour chart
- If price is **above** EMA → only BUY signals allowed
- If price is **below** EMA → only SELL signals allowed
- This keeps you trading WITH the trend, not against it

### Step 2 — M5 Pullback
- Waits for price to pull back **close to the EMA** on the 5-minute chart
- Entering at a pullback gives a better price and tighter stop loss
- "Close" is defined by `pullback_threshold` in config.py (default 0.3%)

### Step 3 — Confirmation Candle
- Waits for the last M5 candle to close **back in the trend direction**
- A bullish close confirms a BUY bounce; bearish close confirms a SELL bounce
- This avoids entering during a candle that's still falling

---

## Position Management

Once a trade is open, the manager runs every 5 seconds:

| Rule | Trigger | Action |
|---|---|---|
| Loss Cut | RR reaches -0.5 | Close trade immediately |
| Break-Even | RR reaches +1.0 | Move SL to entry price (trade can't lose) |
| Trailing Stop | RR reaches +1.5 | Trail SL by 0.5× ATR |
| Reversal Close | Signal flips + RR > 0.5 | Close and take profit |

---

## Project Structure

```
gold_hk_scalper_bot/
├── main.py              # Entry point — run this
├── config.py            # All settings live here
├── executor.py          # Trade execution with safety filters
├── parser.py            # Signal generation (3-step logic)
├── telegram_sender.py   # Optional phone notifications
├── requirements.txt
└── bot/
    ├── executor.py      # ATR helper + position check
    ├── logger.py        # Runtime log + CSV trade log
    ├── lot.py           # Proper risk-based lot sizing
    └── manager.py       # BE, trailing stop, reversal close
```

---

## Setup

**1. Install dependencies:**
```
pip install -r requirements.txt
```

**2. Open MetaTrader 5** and log into your broker account.

**3. Check your symbol name** in `config.py`:
- Common names: `XAUUSD`, `XAUUSD.a`, `GOLD`
- Check MT5 → Market Watch to find your broker's exact name

**4. (Optional) Set up Telegram notifications:**
```
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_SIGNAL_CHAT_ID=your_chat_id
TELEGRAM_REPORT_CHAT_ID=your_chat_id
```

**5. Run:**
```
python main.py
```

---

## Key Settings (config.py)

| Setting | Default | What it does |
|---|---|---|
| `lot_mode` | `risk` | Size lots by % of balance |
| `risk_percent` | `1.0` | Risk 1% per trade |
| `max_spread` | `60` | Skip trade if spread too wide |
| `min_atr` | `1.0` | Skip trade if market too quiet |
| `sl_atr_multiplier` | `1.5` | SL = 1.5× ATR |
| `pullback_threshold` | `0.003` | Must be within 0.3% of EMA |

---

## Important Notes

- **Always test on demo first.** Never run live until you've seen it work for weeks.
- The bot targets **2-3 quality trades per day** during London/New York sessions.
- Do not change `magic_number` while trades are open.
- The `logs/` folder contains a full runtime log and a CSV of every trade.
