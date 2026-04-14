"""
main_manual.py — ETH HA Bot V1 (Manual Trade Manager)

HOW TO USE
----------
1. Open a trade manually on ETHUSD in MT5 (any direction, any size).
2. Run this script:  python main_manual.py
3. The bot immediately finds your open position and starts managing it.
4. Stop at any time with Ctrl+C — your position stays open, just unmanaged.

WHAT THIS SCRIPT MANAGES
-------------------------
  - Sets SL and TP if your manual trade has none (uses ATR from config)
  - Moves SL to break-even once 1 ATR profit is reached
  - Trails the SL as price moves in your favour (3× ATR distance)
  - Closes the trade if 2 consecutive M5 HA candles reverse against you
  - Logs every closed trade to eth_trade_log.csv

WHAT IT DOES NOT DO
-------------------
  - Does NOT open new trades
  - Does NOT block you for being outside session hours
  - Does NOT enforce the daily loss limit on existing positions
    (limit is tracked and printed but won't force-close your trade)

DIFFERENCE FROM main.py
------------------------
  main.py      → fully automated: finds signals AND manages trades
  main_manual.py → management only: you enter, the bot manages
"""

import time
from datetime import datetime, timezone
import MetaTrader5 as mt5

import config
from data            import get_data, initialize
from logger          import init_log
from manual_manager  import ManualTradeManager


def safe_initialize(max_retries=5, wait=10):
    for attempt in range(1, max_retries + 1):
        try:
            initialize()
            print("✅ MT5 connected")
            return True
        except Exception as e:
            print(f"⚠️  MT5 connect attempt {attempt}/{max_retries} failed: {e}")
            time.sleep(wait)
    print("❌ Could not connect to MT5 after retries — exiting")
    return False


def run():
    print("=" * 55)
    print("  ETH HA BOT V1 — MANUAL TRADE MANAGER")
    print(f"  Symbol         : {config.SYMBOL}")
    print(f"  SL             : {config.ATR_MULTIPLIER}× ATR")
    print(f"  TP             : {config.TP_ATR_MULTIPLIER}× ATR")
    print(f"  Trailing stop  : {config.TRAILING_ATR_MULTIPLIER}× ATR")
    print(f"  Break-even     : after 1× ATR profit")
    print(f"  Reversal exit  : {config.REVERSAL_CANDLES_REQUIRED} consecutive M5 HA candles")
    print(f"  ATR period     : {config.ATR_PERIOD}")
    print("  Mode           : MANUAL — bot manages, you enter")
    print("=" * 55)
    print()
    print("  Open a trade in MT5 then this bot will manage it.")
    print("  Press Ctrl+C to stop (your position stays open).")
    print()

    if not safe_initialize():
        return

    init_log()

    manager          = ManualTradeManager()
    last_candle_time = None
    consecutive_errors = 0

    try:
        while True:
            try:
                df_m1 = get_data(config.SYMBOL, config.TIMEFRAMES["M1"])

                consecutive_errors = 0

                # Only act on new M1 candles — same gate as the auto bot
                current_candle_time = df_m1.iloc[-1]['time']
                if last_candle_time == current_candle_time:
                    time.sleep(config.CHECK_INTERVAL)
                    continue
                last_candle_time = current_candle_time

                now_utc = datetime.now(timezone.utc).strftime("%H:%M:%S")
                print(f"\n🕯️  New M1 candle: {current_candle_time}  (UTC {now_utc})")

                count = manager.scan_and_manage()

                if count == 0:
                    print("   Waiting for a manual trade to appear on ETHUSD...")

            except Exception as e:
                consecutive_errors += 1
                print(f"❌ Error ({consecutive_errors}): {e}")

                if consecutive_errors >= 3:
                    print("🔄 Multiple errors — attempting MT5 reconnect...")
                    if not safe_initialize():
                        print("❌ Reconnect failed — stopping")
                        break
                    consecutive_errors = 0

            time.sleep(config.CHECK_INTERVAL)

    except KeyboardInterrupt:
        print("\n🛑 Manager stopped by user — your position is still open in MT5")


if __name__ == "__main__":
    run()
