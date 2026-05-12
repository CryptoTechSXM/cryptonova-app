"""
force_close_nflx.py
====================
Emergency script — closes ALL open NFLX/Netflix positions immediately.
Run this from the 9-Quick-Scalp-NFLX folder:

    python force_close_nflx.py

If the market is currently closed it will print a clear error.
It does NOT care about magic number, profit/loss, or direction.
"""

import sys
import time
import MetaTrader5 as mt5

# ── config ────────────────────────────────────────────────────────────────────
# All known broker symbol names for Netflix — edit if your broker uses another
NETFLIX_SYMBOLS = ["NETFLIX", "NFLX", "NETFLIX.s", "NFLXm", "NFLX.s", "US_NFLX"]

DEVIATION   = 30   # max price deviation (points)
MAX_RETRIES = 3    # retry attempts per position on retryable errors

RETRYABLE_CODES = {
    mt5.TRADE_RETCODE_REQUOTE,
    mt5.TRADE_RETCODE_PRICE_CHANGED,
    mt5.TRADE_RETCODE_PRICE_OFF,
    mt5.TRADE_RETCODE_OFF_QUOTES,
    mt5.TRADE_RETCODE_TIMEOUT,
}

# ── MT5 init ──────────────────────────────────────────────────────────────────
print("Connecting to MT5 ...")
if not mt5.initialize():
    print(f"ERROR: MT5 init failed — is MetaTrader 5 running? Code: {mt5.last_error()}")
    sys.exit(1)

print(f"MT5 connected  terminal={mt5.terminal_info().name}")

# ── find open positions ───────────────────────────────────────────────────────
all_positions = mt5.positions_get() or []
nflx_positions = [
    p for p in all_positions
    if any(sym.lower() in p.symbol.lower() or p.symbol.lower() in sym.lower()
           for sym in NETFLIX_SYMBOLS)
]

if not nflx_positions:
    print("\nNo open NFLX/Netflix positions found. Nothing to close.")
    mt5.shutdown()
    sys.exit(0)

print(f"\nFound {len(nflx_positions)} NFLX position(s):\n")
for p in nflx_positions:
    direction = "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL"
    print(f"  ticket={p.ticket}  {p.symbol}  {direction}  vol={p.volume}  "
          f"entry={p.price_open:.4f}  pnl={p.profit:+.2f}  magic={p.magic}")

print()

# ── close each position ───────────────────────────────────────────────────────
success = 0
failed  = 0

for pos in nflx_positions:
    symbol   = pos.symbol
    ticket   = pos.ticket
    volume   = pos.volume
    is_buy   = pos.type == mt5.ORDER_TYPE_BUY
    close_type = mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY

    for attempt in range(1, MAX_RETRIES + 1):
        tick = mt5.symbol_info_tick(symbol)
        if not tick:
            print(f"  [FAIL] ticket={ticket} — cannot get tick for {symbol}.")
            print("         The market may be closed (Netflix only trades NYSE hours).")
            print("         Wait until 13:30 UTC (09:30 ET) and try again.")
            failed += 1
            break

        price = tick.bid if is_buy else tick.ask

        req = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "symbol":       symbol,
            "volume":       volume,
            "type":         close_type,
            "position":     ticket,
            "price":        price,
            "deviation":    DEVIATION,
            "magic":        pos.magic,
            "comment":      "force_close_nflx",
            "type_time":    mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        res = mt5.order_send(req)
        code = res.retcode if res else None

        if res and code == mt5.TRADE_RETCODE_DONE:
            print(f"  [OK]   ticket={ticket}  {symbol}  closed @ {price:.4f}  "
                  f"pnl={pos.profit:+.2f}")
            success += 1
            break
        elif code in RETRYABLE_CODES and attempt < MAX_RETRIES:
            print(f"  [RETRY {attempt}] ticket={ticket}  code={code} — retrying ...")
            time.sleep(0.5)
        else:
            comment = res.comment if res else "no response"
            print(f"  [FAIL] ticket={ticket}  code={code}  reason={comment}")
            if code == mt5.TRADE_RETCODE_MARKET_CLOSED:
                print("         Market is CLOSED — Netflix only trades 13:30–20:00 UTC.")
                print("         Run this script during NYSE hours to close the position.")
            failed += 1
            break

# ── summary ───────────────────────────────────────────────────────────────────
print(f"\nDone.  Closed: {success}   Failed: {failed}")
mt5.shutdown()
