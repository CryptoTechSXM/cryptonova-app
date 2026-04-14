"""
manager.py - Trade Manager

Central hub that tracks everything the bot has open and enforces all
the safety rules around what can or cannot be traded next.

Responsibilities:
  - Per-symbol trade cap (MAX_TRADES_PER_SYMBOL)
  - Cooldown between trades on the same symbol
  - Daily loss limit with kill switch
  - Win/loss streak tracking for risk multiplier
  - Partial close at each TP level
  - Trailing stop (Phase 1: breakeven, Phase 2: trail in 0.5R steps)
  - Cancel stale pending orders after N minutes
  - Daily reset at midnight UTC
  - CSV logging via trade_logger
"""

import asyncio
import MetaTrader5 as mt5
from datetime import datetime, date, timezone

from config import settings
from logger import log
from trade_logger import log_opened_trade, log_closed_trade


class TradeManager:
    def __init__(self):
        self.active_trades   = {}   # ticket -> signal dict
        self.symbol_data     = {}   # symbol -> {last_trade_time, trade_count}
        self.win_streak      = 0
        self.loss_streak     = 0
        self.daily_loss      = 0
        self.today_pnl       = 0.0
        self.trading_enabled = True
        self.tg              = None  # set by main.py after TelegramSender is created

        # Limits loaded from config (can be overridden at runtime via /risk)
        self.max_daily_loss  = settings.max_daily_loss_trades
        self.max_per_symbol  = settings.max_trades_per_symbol
        self.cooldown_secs   = settings.cooldown_seconds

        # Daily reset tracking
        self._last_reset_date = date.today()

    # =========================
    # INITIALISE
    # Called once on startup to load any positions already open in MT5
    # so the bot doesn't lose track of trades that survived a restart.
    # =========================
    def initialize(self):
        positions = mt5.positions_get()
        if positions:
            for pos in positions:
                if pos.magic == settings.mt5_magic_number:
                    ticket = pos.ticket

                    # Try to recover the ORIGINAL SL from order history.
                    # pos.sl may already be at breakeven after a trail fired,
                    # which would make sl_distance=0 and break the trail logic.
                    orig_sl = pos.sl
                    try:
                        from_dt = datetime(2000, 1, 1)
                        hist_orders = mt5.history_orders_get(from_dt, datetime.now())
                        if hist_orders:
                            for order in reversed(hist_orders):
                                if order.position_id == ticket and order.sl > 0:
                                    orig_sl = order.sl
                                    break
                    except Exception:
                        pass

                    self.active_trades[ticket] = {
                        "symbol":         pos.symbol,
                        "side":           "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL",
                        "entry":          pos.price_open,
                        "sl":             orig_sl,   # original SL, not current (may be at BE)
                        "tp":             pos.tp,
                        "tp_levels":      [pos.tp] if pos.tp > 0 else [],
                        "partial_close_done": [],
                        "lot":            pos.volume,
                        "mode":           "RESUMED",
                        "source_channel": "",
                        "open_time":      datetime.now(),
                    }

                    sym = pos.symbol
                    if sym not in self.symbol_data:
                        self.symbol_data[sym] = {"last_trade_time": None, "trade_count": 0}
                    self.symbol_data[sym]["trade_count"] += 1

            log(f"[INIT] Resumed {len(self.active_trades)} open position(s)", "INFO")
        else:
            log("[INIT] No open positions to resume", "INFO")

    # =========================
    # DAILY RESET
    # Runs inside can_trade() and check_trades() so it fires automatically
    # at the first call after midnight UTC without needing a timer.
    # =========================
    def _check_daily_reset(self):
        today = date.today()
        if today != self._last_reset_date:
            self._last_reset_date = today
            self.daily_loss       = 0
            self.today_pnl        = 0.0
            self.trading_enabled  = True

            for sym in self.symbol_data:
                self.symbol_data[sym]["trade_count"] = 0

            log("[RESET] Daily counters reset (new UTC day)", "INFO")

    # =========================
    # CAN WE TRADE THIS SYMBOL?
    # =========================
    def can_trade(self, symbol: str) -> bool:
        self._check_daily_reset()

        if not self.trading_enabled:
            log(f"[BLOCK] Trading disabled (daily loss limit hit)", "INFO")
            return False

        data = self.symbol_data.get(symbol, {})

        # Per-symbol trade cap
        if data.get("trade_count", 0) >= self.max_per_symbol:
            log(f"[BLOCK] {symbol} at max trades ({self.max_per_symbol})", "INFO")
            return False

        # Cooldown
        last = data.get("last_trade_time")
        if last:
            elapsed = (datetime.now() - last).total_seconds()
            if elapsed < self.cooldown_secs:
                log(f"[BLOCK] {symbol} cooldown {elapsed:.0f}s/{self.cooldown_secs}s", "INFO")
                return False

        return True

    # =========================
    # REGISTER A NEW TRADE
    # Called by executor.py after a successful order_send.
    # =========================
    def register_trade(self, ticket: int, signal: dict):
        symbol = signal["symbol"]

        signal["partial_close_done"] = []
        signal["open_time"]          = datetime.now()

        self.active_trades[ticket] = signal

        if symbol not in self.symbol_data:
            self.symbol_data[symbol] = {"last_trade_time": None, "trade_count": 0}

        self.symbol_data[symbol]["last_trade_time"] = datetime.now()
        self.symbol_data[symbol]["trade_count"]     += 1

        log_opened_trade(ticket, signal)
        log(f"[REGISTER] ticket={ticket} {symbol} {signal['side']}", "INFO")

    # =========================
    # PAUSE / RESUME (bot commands)
    # =========================
    def pause_trading(self):
        self.trading_enabled = False
        log("[MANAGER] Trading PAUSED by command", "INFO")

    def resume_trading(self):
        self.trading_enabled = True
        log("[MANAGER] Trading RESUMED by command", "INFO")

    # =========================
    # STREAK-BASED RISK MULTIPLIER
    # Returns a float that lot.py applies on top of base risk.
    #
    # Loss streak reduces size to protect capital during drawdown.
    # Win streak gently increases size to press a hot streak.
    # =========================
    def get_risk_multiplier(self, symbol: str = None) -> float:
        if self.loss_streak >= 4:
            return 0.50     # -50% after 4 consecutive losses
        elif self.loss_streak == 3:
            return 0.75     # -25% after 3 losses
        elif self.loss_streak == 2:
            return 0.90     # -10% after 2 losses
        elif self.win_streak >= 3:
            return 1.20     # +20% after 3 consecutive wins
        elif self.win_streak == 2:
            return 1.10     # +10% after 2 wins
        else:
            return 1.00     # neutral

    # =========================
    # CHECK CLOSED TRADES
    # Detects positions that are no longer in MT5's open list,
    # fetches the realised P&L from history, updates streaks,
    # enforces the daily loss kill switch.
    # =========================
    def check_trades(self):
        self._check_daily_reset()

        if not self.active_trades:
            return

        open_tickets = set()
        positions = mt5.positions_get()
        if positions:
            for p in positions:
                open_tickets.add(p.ticket)

        closed = [t for t in list(self.active_trades.keys()) if t not in open_tickets]

        for ticket in closed:
            trade = self.active_trades.pop(ticket, {})
            symbol = trade.get("symbol", "?")

            # Decrement symbol trade count
            if symbol in self.symbol_data:
                cnt = self.symbol_data[symbol].get("trade_count", 1)
                self.symbol_data[symbol]["trade_count"] = max(0, cnt - 1)

            # Fetch P&L from MT5 deal history
            profit     = 0.0
            exit_price = None

            from_dt = datetime(2000, 1, 1)
            to_dt   = datetime.now()

            deals = mt5.history_deals_get(from_dt, to_dt)
            if deals:
                for deal in deals:
                    if deal.position_id == ticket and deal.entry == 1:
                        profit     += deal.profit
                        exit_price  = deal.price

            self.today_pnl += profit

            # Update streak
            if profit > 0:
                self.win_streak  += 1
                self.loss_streak  = 0
                log(f"[CLOSE] WIN ticket={ticket} {symbol} profit={profit:.2f} "
                    f"(streak W{self.win_streak})", "INFO")
            else:
                self.loss_streak += 1
                self.win_streak   = 0
                self.daily_loss  += 1
                log(f"[CLOSE] LOSS ticket={ticket} {symbol} profit={profit:.2f} "
                    f"(streak L{self.loss_streak})", "INFO")

                # Kill switch
                if self.daily_loss >= self.max_daily_loss:
                    self.trading_enabled = False
                    log(f"[KILL SWITCH] Daily loss limit hit ({self.daily_loss}). "
                        f"Trading PAUSED for today.", "INFO")

                    if self.tg:
                        asyncio.create_task(
                            self.tg.send_kill_switch_alert(self.daily_loss)
                        )

            # Log to CSV
            log_closed_trade(ticket, trade, profit, exit_price)

            # Send report notification
            report_data = {
                "event":            "TRADE_CLOSED",
                "daily_loss":       self.daily_loss,
                "daily_loss_limit": self.max_daily_loss,
            }
            if self.tg:
                asyncio.create_task(self.tg.send_report(report_data))

    # =========================
    # PARTIAL CLOSE
    # Checks each open position against its TP levels.
    # When price reaches a TP, closes partial_close_percent% of the lot,
    # moves SL to breakeven, marks that TP as done.
    # =========================
    def check_partial_close(self):
        if not settings.partial_close_enabled:
            return

        positions = mt5.positions_get()
        if not positions:
            return

        pos_map = {p.ticket: p for p in positions}

        for ticket, trade in list(self.active_trades.items()):
            pos = pos_map.get(ticket)
            if not pos:
                continue

            tp_levels = trade.get("tp_levels", [])
            done      = trade.get("partial_close_done", [])

            if not tp_levels:
                continue

            side   = trade.get("side", "")
            entry  = trade.get("entry", 0)
            sl_orig = trade.get("sl", 0)

            tick = mt5.symbol_info_tick(pos.symbol)
            if not tick:
                continue

            current_price = tick.bid if side == "BUY" else tick.ask

            for i, tp in enumerate(tp_levels):
                if i in done:
                    continue

                # Has price reached this TP?
                hit = (side == "BUY"  and current_price >= tp) or \
                      (side == "SELL" and current_price <= tp)

                if not hit:
                    continue

                # How much to close
                close_pct = settings.partial_close_percent / 100.0
                close_vol = round(pos.volume * close_pct, 2)

                info = mt5.symbol_info(pos.symbol)
                if info:
                    step = info.volume_step
                    close_vol = max(step, round(close_vol / step) * step)

                remaining = round(pos.volume - close_vol, 2)

                # Execute partial close (opposite direction deal)
                close_type = mt5.ORDER_TYPE_SELL if side == "BUY" else mt5.ORDER_TYPE_BUY
                close_price = tick.bid if side == "BUY" else tick.ask

                close_req = {
                    "action":       mt5.TRADE_ACTION_DEAL,
                    "symbol":       pos.symbol,
                    "volume":       close_vol,
                    "type":         close_type,
                    "position":     ticket,
                    "price":        close_price,
                    "deviation":    20,
                    "magic":        settings.mt5_magic_number,
                    "comment":      f"Partial TP{i+1}",
                    "type_time":    mt5.ORDER_TIME_GTC,
                    "type_filling": mt5.ORDER_FILLING_IOC,
                }

                res = mt5.order_send(close_req)
                if not res or res.retcode != mt5.TRADE_RETCODE_DONE:
                    log(f"[PARTIAL] Close failed ticket={ticket} retcode="
                        f"{res.retcode if res else 'None'}", "ERROR")
                    continue

                # Move SL to breakeven (entry + small buffer)
                sl_distance = abs(entry - sl_orig)
                be_buffer   = sl_distance * 0.1

                if side == "BUY":
                    new_sl = entry + be_buffer
                else:
                    new_sl = entry - be_buffer

                # Keep current TP on the position
                current_tp = pos.tp

                modify_req = {
                    "action":   mt5.TRADE_ACTION_SLTP,
                    "symbol":   pos.symbol,
                    "position": ticket,
                    "sl":       new_sl,
                    "tp":       current_tp,
                }
                mt5.order_send(modify_req)

                # Mark TP as done
                self.active_trades[ticket]["partial_close_done"].append(i)

                # Next TP target for notification
                next_tp = tp_levels[i + 1] if i + 1 < len(tp_levels) else None

                log(f"[PARTIAL] TP{i+1} hit ticket={ticket} {pos.symbol} "
                    f"closed={close_vol} remaining={remaining} BE={new_sl:.5f}", "INFO")

                if self.tg:
                    asyncio.create_task(
                        self.tg.send_partial_close({
                            "symbol":        pos.symbol,
                            "side":          side,
                            "tp_hit":        tp,
                            "closed_lot":    close_vol,
                            "remaining_lot": remaining,
                            "new_sl":        new_sl,
                            "next_tp":       next_tp,
                        })
                    )

                break   # only process one TP level per cycle

    # =========================
    # TRAILING STOP
    # Phase 1 (breakeven): when profit >= 0.75R, move SL to entry.
    # Phase 2 (continuous trail): when profit >= 1.0R, trail SL continuously
    #   at entry + (profit_r - 0.5) * sl_distance — always 0.5R behind peak.
    # =========================
    def apply_trailing_stop(self):
        positions = mt5.positions_get()
        if not positions:
            return

        pos_map = {p.ticket: p for p in positions}

        for ticket, trade in list(self.active_trades.items()):
            pos = pos_map.get(ticket)
            if not pos:
                continue

            side  = trade.get("side", "")
            entry = trade.get("entry", 0)
            sl    = trade.get("sl", 0)

            if not entry or not sl:
                continue

            sl_distance = abs(entry - sl)
            if sl_distance == 0:
                continue

            tick = mt5.symbol_info_tick(pos.symbol)
            if not tick:
                continue

            current_price = tick.bid if side == "BUY" else tick.ask

            if side == "BUY":
                profit_distance = current_price - entry
            else:
                profit_distance = entry - current_price

            profit_r = profit_distance / sl_distance   # how many R in profit
            current_sl = pos.sl
            current_tp = pos.tp

            new_sl = None

            # Phase 1: breakeven at 0.75R (earlier protection)
            if profit_r >= 0.75:
                be_sl = entry
                if side == "BUY" and current_sl < be_sl:
                    new_sl = be_sl
                elif side == "SELL" and (current_sl == 0 or current_sl > be_sl):
                    new_sl = be_sl

            # Phase 2: continuous trail — always 0.5R behind current profit
            # trail_sl = entry + (profit_r - 0.5) * sl_distance
            # e.g. at 1.0R → +0.5R lock, at 1.6R → +1.1R lock, at 2.0R → +1.5R lock
            if profit_r >= 1.0:
                locked_r = profit_r - 0.5
                if side == "BUY":
                    trail_sl = entry + locked_r * sl_distance
                    if trail_sl > current_sl:
                        new_sl = trail_sl
                else:
                    trail_sl = entry - locked_r * sl_distance
                    if current_sl == 0 or trail_sl < current_sl:
                        new_sl = trail_sl

            if new_sl is not None:
                modify_req = {
                    "action":   mt5.TRADE_ACTION_SLTP,
                    "symbol":   pos.symbol,
                    "position": ticket,
                    "sl":       new_sl,
                    "tp":       current_tp,
                }
                res = mt5.order_send(modify_req)
                if res and res.retcode == mt5.TRADE_RETCODE_DONE:
                    log(f"[TRAIL] SL moved to {new_sl:.5f} on {pos.symbol} "
                        f"ticket={ticket} (profit={profit_r:.2f}R, locked={(profit_r-0.5):.2f}R)", "INFO")
                else:
                    retcode = res.retcode if res else "None"
                    log(f"[TRAIL] SL modify FAILED ticket={ticket} {pos.symbol} "
                        f"new_sl={new_sl:.5f} retcode={retcode}", "ERROR")

    # =========================
    # CANCEL STALE PENDING ORDERS
    # Any pending order (LIMIT/STOP) that has been sitting for more than
    # 60 minutes without filling gets cancelled automatically.
    # =========================
    def cancel_expired_orders(self, max_age_minutes: int = 60):
        orders = mt5.orders_get()
        if not orders:
            return

        now = datetime.now(timezone.utc)

        for order in orders:
            if order.magic != settings.mt5_magic_number:
                continue

            # order.time_setup is a Unix timestamp (UTC)
            setup_time = datetime.fromtimestamp(order.time_setup, tz=timezone.utc)
            age_minutes = (now - setup_time).total_seconds() / 60

            if age_minutes > max_age_minutes:
                cancel_req = {
                    "action": mt5.TRADE_ACTION_REMOVE,
                    "order":  order.ticket,
                }
                res = mt5.order_send(cancel_req)
                if res and res.retcode == mt5.TRADE_RETCODE_DONE:
                    log(f"[CANCEL] Stale order removed ticket={order.ticket} "
                        f"age={age_minutes:.0f}min {order.symbol}", "INFO")

    # =========================
    # STATS (for /stats bot command)
    # =========================
    def get_stats(self) -> dict:
        account = mt5.account_info()
        balance = account.balance if account else 0.0
        equity  = account.equity  if account else 0.0

        return {
            "trading_enabled": self.trading_enabled,
            "daily_losses":    self.daily_loss,
            "daily_loss_limit": self.max_daily_loss,
            "open_trades":     len(self.active_trades),
            "today_pnl":       self.today_pnl,
            "win_streak":      self.win_streak,
            "loss_streak":     self.loss_streak,
            "balance":         balance,
            "equity":          equity,
        }

    # =========================
    # OPEN TRADES SUMMARY (for /trades bot command)
    # =========================
    def get_open_trades_summary(self) -> list:
        result    = []
        positions = mt5.positions_get()

        if not positions:
            return result

        pos_map = {p.ticket: p for p in positions}

        for ticket, trade in self.active_trades.items():
            pos = pos_map.get(ticket)
            if not pos:
                continue

            tick = mt5.symbol_info_tick(pos.symbol)
            current_price = tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask \
                            if tick else 0

            result.append({
                "ticket":  ticket,
                "symbol":  pos.symbol,
                "side":    trade.get("side", ""),
                "lot":     pos.volume,
                "entry":   pos.price_open,
                "sl":      pos.sl,
                "tp":      pos.tp,
                "current": current_price,
                "pnl":     pos.profit,
            })

        return result

    # =========================
    # DAILY TRADE HISTORY (for daily_report.py)
    # Returns all deals closed today (UTC midnight to now).
    # =========================
    def get_daily_trade_history(self) -> list:
        today_start = datetime.combine(date.today(), datetime.min.time())
        now         = datetime.now()

        deals = mt5.history_deals_get(today_start, now)
        if not deals:
            return []

        # Group closing deals by position_id
        history_map = {}
        for deal in deals:
            if deal.magic != settings.mt5_magic_number:
                continue
            if deal.entry != 1:   # entry==1 means closing deal
                continue

            pos_id = deal.position_id
            if pos_id not in history_map:
                history_map[pos_id] = {
                    "ticket":  pos_id,
                    "symbol":  deal.symbol,
                    "profit":  0.0,
                    "price":   deal.price,
                }
            history_map[pos_id]["profit"] += deal.profit

        return list(history_map.values())
