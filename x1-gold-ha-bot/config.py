# =============================================================
# GOLD HK SCALPER BOT V2 — CONFIGURATION
# =============================================================
# This file controls everything about how the bot trades.
# Start here when you want to change behaviour.
# =============================================================


# Gold symbol config — shared across all broker symbol variants.
# Edit here once; every variant picks up the change automatically.
_GOLD_CFG = {
    # --- Enable / Disable this symbol ---
    "enabled": True,

    # --- LOT SIZING ---
    # "fixed"  -> always trade the same lot size (lot_size below)
    # "risk"   -> calculate lot size so you never lose more than
    #             risk_percent of your balance on one trade
    "lot_mode": "risk",
    "lot_size": 0.01,       # only used if lot_mode = "fixed"
    "risk_percent": 1.0,    # 1% of balance per trade

    # --- EXECUTION FILTERS ---
    # Max spread in points before the bot skips the trade.
    # Gold spread is usually 20-40. Spike to 80+ means bad conditions.
    "max_spread": 60,

    # --- STRATEGY SETTINGS ---
    # ATR = how much Gold moves on average per candle.
    # min_atr: skip trade if market is too quiet
    "min_atr": 1.0,
    # sl_atr_multiplier: stop loss = ATR x this number
    "sl_atr_multiplier": 1.5,

    # --- PULLBACK SETTINGS ---
    # How close price must get to the EMA to count as a pullback.
    # 0.003 = within 0.3% of EMA  (~$9.60 at $3200 gold)  → fewer signals
    # 0.005 = within 0.5% of EMA  (~$16   at $3200 gold)  → more signals
    # 0.008 = within 0.8% of EMA  (~$25.6 at $3200 gold)  → too loose
    # RAISED from 0.003 to 0.005 — original threshold was too tight and
    # produced only ~0.4 trades/day. 0.005 targets 1-2 trades/session.
    "pullback_threshold": 0.005,

    # --- SESSION FILTER ---
    # Gold moves most during London (07:00-16:00 UTC) and
    # New York (12:00-21:00 UTC). Outside these hours the bot sleeps.
    "session": {
        "enabled": True,
        "london_start": 7,
        "london_end": 16,
        "newyork_start": 12,
        "newyork_end": 19,
    },
}

# All broker-specific Gold symbol variants point to the same config.
# Brokers use different suffixes: .s (spot), .p (prime), .pro, .f (future), or plain.
# The adopter detects manual trades on ANY of these and manages them identically.
SYMBOL_CONFIGS = {
    "XAUUSD.s":   _GOLD_CFG,
    "XAUUSD.p":   _GOLD_CFG,
    "XAUUSD.pro": _GOLD_CFG,
    "XAUUSD.f":   _GOLD_CFG,
    "XAUUSD":     _GOLD_CFG,
}


# =============================================================
# STRATEGY CONSTANTS (used by strategy.py check_signal)
# =============================================================
BASE_SYMBOL     = "XAUUSD"    # broker-agnostic base name
SYMBOL          = BASE_SYMBOL  # resolved to broker symbol at startup
EMA_PERIOD      = 100
ATR_MULTIPLIER  = 1.5   # SL = ATR × this (proper breathing room)
TP_ATR_MULTIPLIER  = 1.5   # TP = ATR × this (1.5R gives better expectancy than 1:1)
ATR_PERIOD      = 14
DOJI_THRESHOLD  = 0.15
MIN_ATR         = 1.0
MAX_ATR         = 8.0   # skip entry if ATR > 8pts — high volatility / news event
SESSION_CLOSE_BUFFER = 30  # minutes — no new entries within 30min of session end
MAGIC_NUMBER    = 20260331
RISK_PERCENT    = 1.0
MAX_SPREAD      = 60
CHECK_INTERVAL  = 5
TRADE_COOLDOWN  = 300
MAX_DAILY_TRADES = 5
MAX_DAILY_LOSS_PCT = 6.0  # raised from 3% — min lot floors real risk at 2-4% per trade
TRAIL_ATR_TRIGGER = 0.75  # fire trail when profit >= 75% of ATR (~4.5pts at ATR=6)
TRAIL_ATR_BUFFER  = 0.50  # SL trails 0.50x ATR behind price (~3pts at ATR=6)
BE_BUFFER_PTS     = 8.0   # SL placed 8pts above entry when trail first fires (XAU floor)

TIMEFRAMES = {"M1": 1, "M5": 5, "H1": 60}


# =============================================================
# BOT-WIDE SETTINGS
# =============================================================
BOT_SETTINGS = {
    # Magic number tags every order so the bot only manages its own trades.
    # Don't change this once you have open trades.
    "magic_number": 20260331,

    # How often (in seconds) the bot checks the market.
    "scan_interval_seconds": 5,

    # Wait this long after launch before placing the first trade (seconds).
    "startup_delay_seconds": 60,

    # Minimum gap between trades on the same symbol (seconds).
    # 300 = 5 minutes. Prevents rapid re-entry after a loss.
    "cooldown_seconds": 300,

    # --- DAILY SAFETY LIMITS ---
    # Maximum number of entries per symbol per day.
    # Enforces the "2-3 quality trades" target in code. Resets at midnight UTC.
    "max_trades_per_day": 5,

    # Maximum daily loss as a % of account balance before the bot stops
    # trading for the rest of the day. Protects against losing streaks and
    # bad market conditions. Resets at midnight UTC.
    # Raised to 6% because minimum lot (0.01) floors real risk at 2-4% per
    # trade regardless of the 1% risk setting — 3% was stopping the bot after
    # just ONE loss. At 6% the bot can absorb 2-3 filtered losses before
    # shutting down for the day.
    # Example: 6.0 on a $188 account = stop after losing ~$11 in one day.
    "max_daily_loss_percent": 6.0,

    # --- TRAILING STOP ---
    # At TRAIL_START_R profit, SL moves to entry (breakeven) AND the trail
    # begins simultaneously. From that point the SL always sits
    # TRAIL_PCT x original_sl_distance behind the current price.
    #
    # Examples at TRAIL_PCT = 0.20 (20%):
    #   0.75R profit -> SL = entry (breakeven)
    #   1.0R  profit -> SL locked at +0.80R
    #   1.5R  profit -> SL locked at +1.30R
    #   2.0R  profit -> SL locked at +1.80R
    #
    # Increase TRAIL_PCT for a looser trail (more room for retracements).
    # Decrease for a tighter trail (captures more profit, stops out easier).
    "trail_atr_trigger": 0.75,
    "trail_atr_buffer":  0.50,
    "be_buffer_pts":     8.0,   # price-point buffer above entry when SL first moves to BE
}
