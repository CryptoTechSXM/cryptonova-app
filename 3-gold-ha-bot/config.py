# =============================================================
# GOLD HK SCALPER BOT V2 — CONFIGURATION
# =============================================================
# This file controls everything about how the bot trades.
# Start here when you want to change behaviour.
# =============================================================


SYMBOL_CONFIGS = {
    "XAUUSD.s": {
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
            "newyork_end": 21,
        },
    },
}


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
    # Example: 3.0 on a $1,000 account = stop after losing $30 in one day.
    "max_daily_loss_percent": 3.0,
}
