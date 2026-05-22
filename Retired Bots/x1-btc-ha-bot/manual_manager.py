"""
manual_manager.py — BTC HA Bot V3 (Manual Trade Manager)

What this does:
  You open a trade manually in MT5 — any direction, any time.
  This script detects it and immediately takes over management:

    1. Initial SL/TP  — if your manual trade has no SL or TP set, the bot
                        calculates and sets them from ATR using your config.
    2. Break-even     — once price moves 1 ATR in your favour, SL is moved
                        to entry + spread so worst case = scratch.
    3. Trailing stop  — as the trade runs, SL trails price by 3× ATR,
                        locking in profit.
    4. Reversal exit  — if 2 consecutive M5 HA candles flip against your
                        position, the bot closes the trade and logs it.

How to use:
  1. Open a trade manually in MT5 on BTCUSD.
  2. Run:  python main_manual.py
  3. The bot finds your open position and starts managing it immediately.
  4. Stop with Ctrl+C at any time — your position stays open, just unmanaged.

What the bot does NOT do in manual mode:
  - It will NOT open new trades for you.
  - It will NOT block you from trading outside session hours.
    (You opened the trade — the bot respects that decision.)
  - The daily loss limit is tracked but only for informational logging.
    It does not block management of existing positions.

Config used (from config.py):
  ATR_MULTIPLIER          = 2.0   → initial SL distance
  TP_ATR_MULTIPLIER       = 3.0   → initial TP distance
  TRAILING_ATR_MULTIPLIER = 3.0   → trailing SL distance
  REVERSAL_CANDLES_REQUIRED = 2   → consecutive opposite M5 candles to exit
  ATR_PERIOD              = 14
"""

import MetaTrader5 as mt5
import config
from data       import get_data
from indicators import heikin_ashi, atr
from trader     import modify_sl, close_position
from logger     import log_trade
from risk       import DailyRiskManager


class ManualTradeManager:
    """
    Attaches to any open manual position on BTCUSD and manages it
    using the full bot logic: initial SL/TP → break-even → trailing → reversal exit.
    """

    def __init__(self):
        self.risk_manager     = DailyRiskManager(config)
        self.managed_tickets  = {}   # ticket → state dict
        self.closed_tickets   = set()

    # ── Public interface ───────────────────────────────────────────────────

    def scan_and_manage(self):
        """
        Call this every new M1 candle.
        Finds all open BTCUSD positions and manages each one.
        Returns the number of positions currently being managed.
        """
        df_m1 = get_data(config.SYMBOL, config.TIMEFRAMES["M1"])
        df_m5 = get_data(config.SYMBOL, config.TIMEFRAMES["M5"])

        positions = mt5.positions_get(symbol=config.SYMBOL)

        if not positions:
            print("📭 No open positions on BTCUSD")
            return 0

        for pos in positions:
            if pos.ticket in self.closed_tickets:
                continue

            # First time we see this ticket — attach and set initial levels
            if pos.ticket not in self.managed_tickets:
                self._attach(pos, df_m5)

            self._manage(pos, df_m1, df_m5)

        return len(positions)

    # ── Attach to a new position ───────────────────────────────────────────

    def _attach(self, position, df_m5):
        """
        Called the first time we see a ticket.
        Sets initial SL/TP if the position doesn't already have them.
        """
        ticket    = position.ticket
        direction = "BUY" if position.type == 0 else "SELL"
        entry     = position.price_open

        print(f"\n🔗 Attaching to manual {direction} position #{ticket} @ {entry:.2f}")

        # Compute current ATR
        df_m5_ha        = heikin_ashi(df_m5)
        df_m5_ha['atr'] = atr(df_m5_ha, config.ATR_PERIOD)
        current_atr     = df_m5_ha.iloc[-1]['atr']

        print(f"   M5 ATR: {current_atr:.2f}")

        self.managed_tickets[ticket] = {
            "direction":       direction,
            "entry":           entry,
            "reversal_count":  0,
            "be_triggered":    False,
        }

        # Only set SL/TP if they are missing (== 0.0 in MT5)
        needs_sl = (position.sl == 0.0)
        needs_tp = (position.tp == 0.0)

        if needs_sl or needs_tp:
            if direction == "BUY":
                new_sl = entry - (current_atr * config.ATR_MULTIPLIER) if needs_sl else position.sl
                new_tp = entry + (current_atr * config.TP_ATR_MULTIPLIER) if needs_tp else position.tp
            else:
                new_sl = entry + (current_atr * config.ATR_MULTIPLIER) if needs_sl else position.sl
                new_tp = entry - (current_atr * config.TP_ATR_MULTIPLIER) if needs_tp else position.tp

            self._set_sl_tp(position, new_sl, new_tp)
            print(f"   {'SL' if needs_sl else ''}{'/' if needs_sl and needs_tp else ''}{'TP' if needs_tp else ''} set → "
                  f"SL: {new_sl:.2f}  TP: {new_tp:.2f}  (ATR: {current_atr:.2f})")
        else:
            print(f"   Position already has SL: {position.sl:.2f}  TP: {position.tp:.2f} — keeping them")

    # ── Per-candle management ──────────────────────────────────────────────

    def _manage(self, position, df_m1, df_m5):
        """
        Runs every new M1 candle for an attached position.
        Order: break-even check → trailing stop → reversal exit.
        """
        ticket    = position.ticket
        state     = self.managed_tickets[ticket]
        direction = state["direction"]
        entry     = state["entry"]

        # Fresh ATR and HA data
        df_m5_ha        = heikin_ashi(df_m5)
        df_m5_ha['atr'] = atr(df_m5_ha, config.ATR_PERIOD)
        last_m5         = df_m5_ha.iloc[-1]
        current_atr     = last_m5['atr']
        current_price   = df_m1.iloc[-1]['close']

        # Spread for break-even offset
        tick   = mt5.symbol_info_tick(config.SYMBOL)
        spread = tick.ask - tick.bid

        # ── 1. Break-even ──────────────────────────────────────────────────
        if not state["be_triggered"]:
            if direction == "BUY":
                be_sl         = entry + spread
                profit_so_far = current_price - entry
                if profit_so_far > current_atr and position.sl < be_sl:
                    print(f"🟡 Break-even BUY #{ticket} → SL to {be_sl:.2f} (entry + spread)")
                    modify_sl(position, be_sl)
                    state["be_triggered"] = True

            else:
                be_sl         = entry - spread
                profit_so_far = entry - current_price
                if profit_so_far > current_atr and position.sl > be_sl:
                    print(f"🟡 Break-even SELL #{ticket} → SL to {be_sl:.2f} (entry - spread)")
                    modify_sl(position, be_sl)
                    state["be_triggered"] = True

        # ── 2. Trailing stop ───────────────────────────────────────────────
        if direction == "BUY":
            new_sl = current_price - (current_atr * config.TRAILING_ATR_MULTIPLIER)
            if new_sl > position.sl:
                print(f"🔒 Trail BUY #{ticket} → SL to {new_sl:.2f}")
                modify_sl(position, new_sl)

        else:
            new_sl = current_price + (current_atr * config.TRAILING_ATR_MULTIPLIER)
            if new_sl < position.sl:
                print(f"🔒 Trail SELL #{ticket} → SL to {new_sl:.2f}")
                modify_sl(position, new_sl)

        # ── 3. Reversal exit (M5 HA) ───────────────────────────────────────
        if direction == "BUY":
            if last_m5['ha_close'] < last_m5['ha_open']:
                state["reversal_count"] += 1
                print(f"⚠️  Bearish M5 candle #{state['reversal_count']} on #{ticket} "
                      f"(need {config.REVERSAL_CANDLES_REQUIRED} to exit BUY)")
            else:
                if state["reversal_count"] > 0:
                    print(f"↩️  #{ticket} reversal reset — M5 returned bullish")
                state["reversal_count"] = 0

            if state["reversal_count"] >= config.REVERSAL_CANDLES_REQUIRED:
                self._exit(position, direction, entry, current_price)

        else:
            if last_m5['ha_close'] > last_m5['ha_open']:
                state["reversal_count"] += 1
                print(f"⚠️  Bullish M5 candle #{state['reversal_count']} on #{ticket} "
                      f"(need {config.REVERSAL_CANDLES_REQUIRED} to exit SELL)")
            else:
                if state["reversal_count"] > 0:
                    print(f"↩️  #{ticket} reversal reset — M5 returned bearish")
                state["reversal_count"] = 0

            if state["reversal_count"] >= config.REVERSAL_CANDLES_REQUIRED:
                self._exit(position, direction, entry, current_price)

    # ── Exit ───────────────────────────────────────────────────────────────

    def _exit(self, position, direction, entry_price, current_price):
        """Closes the position, logs it, records P&L."""
        # Capture real USD P&L from MT5 BEFORE closing.
        profit_usd = position.profit

        print(f"❗ Closing manual {direction} #{position.ticket} — M5 reversal confirmed")
        close_position(position)

        price_diff = (current_price - entry_price) if direction == "BUY" else (entry_price - current_price)
        log_trade(direction, entry_price, position.sl, current_price, price_diff)
        self.risk_manager.record_trade(profit_usd)

        self.closed_tickets.add(position.ticket)
        self.managed_tickets.pop(position.ticket, None)
        print(f"   Closed. P&L: ${profit_usd:+.2f}")

    # ── Helpers ────────────────────────────────────────────────────────────

    def _set_sl_tp(self, position, sl, tp):
        """Sets both SL and TP in one MT5 request."""
        request = {
            "action":   mt5.TRADE_ACTION_SLTP,
            "position": position.ticket,
            "sl":       sl,
            "tp":       tp,
        }
        result = mt5.order_send(request)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            print(f"   ⚠️  Could not set SL/TP: retcode {result.retcode}")
        return result
