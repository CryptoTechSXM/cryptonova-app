# =============================================================
# MAIN — Entry Point
# =============================================================
# Run this file to start the bot:
#   python main.py
#
# What happens:
#   1. Connects to MetaTrader 5
#   2. Prints your account details so you can confirm it's right
#   3. Enters a loop that runs every 5 seconds:
#      a. Generates signals (parser.py)
#      b. Manages any open positions (manager.py)
#      c. Executes new trades if signal conditions are met (executor.py)
#   4. Shuts down cleanly on Ctrl+C
# =============================================================

import time
import MetaTrader5 as mt5

from config import SYMBOL_CONFIGS, BOT_SETTINGS
from bot.logger import log
from bot.adopter import adopt_manual_trades
from bot.manager import manage_positions
from executor import execute_trade
from parser import generate_signals


def _local(utc_h, utc_m=0):
    from datetime import datetime
    off  = int((datetime.now() - datetime.utcnow()).total_seconds() / 60)
    mins = utc_h * 60 + utc_m + off
    tz   = datetime.now().astimezone().strftime('%Z')
    return f"{(mins // 60) % 24:02d}:{mins % 60:02d} {tz}"

last_signals = {}


def connect_mt5():
    if not mt5.initialize():
        log(f"❌ MT5 init failed: {mt5.last_error()}")
        return False

    acc = mt5.account_info()
    if acc is None:
        log(f"❌ Account info failed: {mt5.last_error()}")
        return False

    log("=" * 50)
    log("✅ MT5 connected")
    log(f"   Login:   {acc.login}")
    log(f"   Server:  {acc.server}")
    log(f"   Balance: ${acc.balance:,.2f}")
    log(f"   Equity:  ${acc.equity:,.2f}")
    log("=" * 50)
    return True


def run_bot():
    syms = [s for s, c in SYMBOL_CONFIGS.items() if c.get("enabled")]
    cfg0 = SYMBOL_CONFIGS[syms[0]] if syms else {}
    log("=" * 55)
    log("  GOLD HA BOT V2")
    log(f"  Asset       : {', '.join(syms)}")
    log(f"  Risk/trade  : {cfg0.get('risk_percent', 1.0)}% of balance")
    log(f"  Daily limit : {BOT_SETTINGS['max_trades_per_day']} trades | -{BOT_SETTINGS['max_daily_loss_percent']}% loss")
    log(f"  Max spread  : {cfg0.get('max_spread', 60)} pts")
    log(f"  Min ATR     : {cfg0.get('min_atr', 1.0)}")
    log(f"  Session     : 07:00–21:00 UTC  ({_local(7)}–{_local(21)} local)")
    log("=" * 55)
    log("Starting...")

    try:
        while True:
            log(f"[{', '.join(syms)}] scanning...")

            # Adopt any manual trades before doing anything else
            adopt_manual_trades()

            # Generate signals for all symbols
            signal_map = generate_signals(SYMBOL_CONFIGS)

            # Manage any open positions first
            manage_positions(signal_map)

            # Check for new trade entries
            for symbol, cfg in SYMBOL_CONFIGS.items():

                if not cfg.get("enabled", False):
                    continue

                signal = signal_map.get(symbol)

                # No signal this scan — nothing to do
                if not signal:
                    continue

                # If no position is open, clear the signal lock so a new entry
                # is allowed on the same direction after a trade has closed.
                if last_signals.get(symbol) == signal:
                    open_pos = mt5.positions_get(symbol=symbol)
                    if not open_pos:
                        last_signals.pop(symbol, None)
                        log(f"{symbol}: position closed — signal lock cleared, re-evaluating")
                    else:
                        log(f"{symbol}: signal unchanged ({signal}) — position still open")
                        continue

                log(f"{symbol}: NEW SIGNAL → {signal}")

                result = execute_trade(symbol, signal, cfg)

                if result == "STARTUP":
                    pass  # not ready yet — don't lock, retry next scan

                elif result == "COOLDOWN":
                    pass  # cooling down — don't lock, retry when cooldown expires

                elif result == "IN_POSITION":
                    # Active trade — lock signal so we don't try to add another entry
                    last_signals[symbol] = signal

                elif result == "DAILY_LIMIT":
                    # Hit the daily cap — lock for today
                    last_signals[symbol] = signal

                elif result == "SKIPPED":
                    # Spread or ATR filter fired — conditions may improve
                    pass  # don't lock, retry next scan

                elif result:
                    # Ticket number returned — trade placed successfully
                    last_signals[symbol] = signal
                    log(f"{symbol}: ✅ Trade placed | ticket={result}")

                else:
                    # MT5 returned None — order error, don't lock, retry next scan
                    log(f"{symbol}: ❌ Trade failed — will retry next scan")

            time.sleep(BOT_SETTINGS["scan_interval_seconds"])

    except KeyboardInterrupt:
        log("🛑 Bot stopped (Ctrl+C)")

    finally:
        mt5.shutdown()
        log("🔌 MT5 disconnected — goodbye")


if __name__ == "__main__":
    if connect_mt5():
        run_bot()
