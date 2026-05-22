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
import json
import os
import time
import MetaTrader5 as mt5
from datetime import datetime, date, timezone, timedelta

from config import settings
from logger import log
from trade_logger import log_opened_trade, log_closed_trade


def _get_atr_pips(symbol, period=14, pip_size=None):
    """Fetch ATR in pips for any symbol using M5 bars.
    pip_size: price units per pip (e.g. 0.10 for XAUUSD, 0.0001 for FX).
    Falls back to 50 pips if data unavailable."""
    try:
        import pandas as pd
        rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, period + 5)
        if rates is None or len(rates) < period:
            return 50.0
        df = pd.DataFrame(rates)
        df["prev_close"] = df["close"].shift(1)
        df["tr"] = df.apply(lambda x: max(
            x["high"] - x["low"],
            abs(x["high"] - x["prev_close"]) if pd.notna(x["prev_close"]) else 0,
            abs(x["low"]  - x["prev_close"]) if pd.notna(x["prev_close"]) else 0,
        ), axis=1)
        atr_val = df["tr"].rolling(period).mean().iloc[-1]
        if pd.isna(atr_val) or atr_val <= 0:
            return 50.0
        # Determine pip size
        if pip_size is None:
            sym = symbol.upper()
            if "XAU" in sym or "GOLD" in sym:
                pip_size = 0.10
            elif "BTC" in sym or "ETH" in sym:
                pip_size = 1.0
            elif "NAS" in sym or "US100" in sym or "GER" in sym or "US30" in sym:
                pip_size = 1.0
            elif "XAG" in sym:
                pip_size = 0.01
            else:
                pip_size = 0.0001  # FX default
        return atr_val / pip_size
    except Exception as e:
        log(f"[ATR] Calculation error for {symbol}: {e}", "WARNING")
        return 50.0

STATE_FILE = "state.json"


def _load_state() -> dict:
    """Load persisted state from disk. Returns empty dict if file missing or corrupt."""
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except Exception as e:
        log(f"[STATE] Failed to load {STATE_FILE}: {e}", "WARNING")
        return {}


def _save_state(state: dict):
    """Atomically save state to disk (write to .tmp then rename)."""
    tmp = STATE_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2, default=str)
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        log(f"[STATE] Failed to save {STATE_FILE}: {e}", "WARNING")


class TradeManager:
    def __init__(self):
        self.active_trades   = {}   # ticket -> signal dict
        self.symbol_data     = {}   # symbol -> {last_trade_time, trade_count}
        self._channel_last_trade = {}  # channel_id -> last trade timestamp
        self.win_streak      = 0
        self.loss_streak     = 0
        self.daily_loss      = 0
        self.daily_wins      = 0
        self.daily_be        = 0
        self.daily_be_plus   = 0   # protected BE exits with small profit (0 < profit < $5)
        self.today_pnl       = 0.0
        self.trading_enabled = True
        self.tg              = None  # set by main.py after TelegramSender is created
        self._tg_queue: list = []   # (kind, data) pairs — drained by async manager_loop each tick

        # Limits loaded from config (can be overridden at runtime via /risk)
        self.max_daily_loss       = settings.max_daily_loss_trades
        self.max_consecutive_loss = settings.max_consecutive_losses
        self.max_per_symbol       = settings.max_trades_per_symbol
        self.cooldown_secs        = settings.cooldown_seconds

        # Alert state — reset daily
        self._dd_alerted          = False   # drawdown alert fired today
        self._profit_alerted      = False   # profit target alert fired today
        self._session_brief_sent  = False   # session open snapshot sent today
        self._alerted_orders      = set()   # tickets already alerted for timeout

        # Daily reset tracking
        self._last_reset_date = date.today()

        # Restore persisted state (streaks, daily counters, partial_close_done).
        # This survives bot restarts so we don't re-fire partial closes or
        # lose streak/daily-loss info.
        self._restore_state()

    # =========================
    # STATE PERSISTENCE
    # Saves/restores streaks, daily counters, and partial_close_done so
    # a bot restart doesn't re-fire partial closes or reset risk sizing.
    # =========================
    def _restore_state(self):
        state = _load_state()
        if not state:
            return

        today_str = date.today().isoformat()
        if state.get("date") == today_str:
            self.daily_loss      = state.get("daily_loss",    0)
            self.daily_wins      = state.get("daily_wins",    0)
            self.daily_be        = state.get("daily_be",      0)
            self.daily_be_plus   = state.get("daily_be_plus", 0)
            self.today_pnl       = state.get("today_pnl",    0.0)
            self.trading_enabled = state.get("trading_enabled", True)
            log(f"[STATE] Restored today's counters: "
                f"wins={self.daily_wins} losses={self.daily_loss} "
                f"be+={self.daily_be_plus} be={self.daily_be} pnl={self.today_pnl:.2f}", "INFO")

        self.win_streak  = state.get("win_streak",  0)
        self.loss_streak = state.get("loss_streak", 0)
        if self.win_streak or self.loss_streak:
            log(f"[STATE] Restored streaks: win={self.win_streak} loss={self.loss_streak}", "INFO")

        # Restore partial_close_done lists keyed by ticket (stored as strings in JSON).
        self._saved_partial_done = {
            int(k): v for k, v in state.get("partial_close_done", {}).items()
        }

    # =========================
    # PROJECT & APPLY SL/TP FOR ADOPTED TRADES
    # Called during initialize() for manual positions that are missing SL or TP.
    # Uses the same per-symbol minimum risk distances as the executor so adopted
    # trades get the same protection as bot-placed ones.
    #
    # Rules:
    #   - SL missing or too small  → project from entry using symbol minimum
    #   - TP missing               → set to 2R from entry (using resolved SL distance)
    #   - TP present               → keep it (don't override a deliberate target)
    # After resolving, sends an MT5 SLTP modify so the levels are visible in
    # the terminal and enforced by the broker.
    # =========================
    def _project_and_apply_levels(self, pos) -> tuple:
        """
        Returns (sl, tp, risk) with guaranteed valid SL and TP.
        Also sends the MT5 modify request to set them on the open position.
        """
        symbol = pos.symbol
        entry  = pos.price_open
        side   = "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL"
        sl     = pos.sl
        tp     = pos.tp

        # Per-symbol minimum risk distance (mirrors executor.py)
        if "BTC" in symbol:
            min_risk = 100
        elif "XAU" in symbol:
            min_risk = 20   # gold moves 5 pts in seconds — 20 is a realistic floor
        elif "NAS" in symbol:
            min_risk = 30
        else:
            min_risk = 10

        # Resolve SL — project if missing or inside the minimum
        risk = abs(entry - sl) if sl > 0 else 0
        if risk < min_risk:
            risk = min_risk
            sl = (entry - risk) if side == "BUY" else (entry + risk)
            log(f"[ADOPT] Projected SL for ticket={pos.ticket} {symbol} {side} "
                f"→ {sl:.5f} ({risk} pts)", "INFO")

        # Resolve TP — only project if missing; keep existing otherwise
        if tp <= 0:
            reward = risk * 2
            tp = (entry + reward) if side == "BUY" else (entry - reward)
            log(f"[ADOPT] Projected TP for ticket={pos.ticket} {symbol} {side} "
                f"→ {tp:.5f} (2R)", "INFO")

        # Apply to MT5 so the levels are live in the terminal
        modify_req = {
            "action":   mt5.TRADE_ACTION_SLTP,
            "symbol":   symbol,
            "position": pos.ticket,
            "sl":       sl,
            "tp":       tp,
        }
        res = mt5.order_send(modify_req)
        # Retry once on IPC timeout (retcode=10025 — broker temporarily unreachable)
        if (not res or res.retcode == 10025):
            time.sleep(2)
            res = mt5.order_send(modify_req)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            log(f"[ADOPT] SL/TP set on ticket={pos.ticket} {symbol} "
                f"SL={sl:.5f} TP={tp:.5f}", "INFO")
        else:
            retcode = res.retcode if res else "None"
            log(f"[ADOPT] SLTP modify FAILED ticket={pos.ticket} retcode={retcode}", "WARNING")

        return sl, tp, risk

    def _persist_state(self):
        """Write current state to disk. Called after every trade event."""
        partial_done = {
            str(t): trade.get("partial_close_done", [])
            for t, trade in self.active_trades.items()
        }
        _save_state({
            "date":            date.today().isoformat(),
            "daily_loss":      self.daily_loss,
            "daily_wins":      self.daily_wins,
            "daily_be":        self.daily_be,
            "daily_be_plus":   self.daily_be_plus,
            "today_pnl":       self.today_pnl,
            "trading_enabled": self.trading_enabled,
            "win_streak":      self.win_streak,
            "loss_streak":     self.loss_streak,
            "partial_close_done": partial_done,
        })

    # =========================
    # INITIALISE
    # Called once on startup to load any positions already open in MT5
    # so the bot doesn't lose track of trades that survived a restart.
    # Also adopts manually opened positions when ADOPT_MANUAL_TRADES=true.
    # =========================
    def initialize(self):
        positions = mt5.positions_get()
        if not positions:
            log("[INIT] No open positions to resume", "INFO")
            return

        # Fetch order history once for SL recovery
        orig_sl_map = {}
        try:
            hist_orders = mt5.history_orders_get(datetime(2000, 1, 1), datetime.now())
            if hist_orders:
                for order in reversed(hist_orders):
                    pid = order.position_id
                    if pid not in orig_sl_map and order.sl > 0:
                        orig_sl_map[pid] = order.sl
        except Exception:
            pass

        adopted = 0
        resumed = 0

        for pos in positions:
            ticket   = pos.ticket
            is_bot   = (pos.magic == settings.mt5_magic_number)
            is_manual = not is_bot

            # Skip non-bot trades unless adoption is enabled
            if is_manual and not settings.adopt_manual_trades:
                continue

            # Restore partial_close_done from saved state if available
            saved_done = getattr(self, "_saved_partial_done", {}).get(ticket, [])

            side = "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL"

            if is_manual:
                # For manual trades: ensure valid SL and TP are set.
                # _project_and_apply_levels() fills in missing/too-small levels
                # using per-symbol minimums and also sends the MT5 SLTP modify.
                sl, tp, _ = self._project_and_apply_levels(pos)
            else:
                # For bot trades: recover original SL from order history
                # (SL may already be at BE after a trail fired, which would
                # make sl_distance=0 and break further trail calculations).
                sl = orig_sl_map.get(ticket, pos.sl)
                tp = pos.tp

            # Direction-guard the tp_levels list (same rule as check_partial_close)
            if tp > 0:
                if side == "BUY" and tp > pos.price_open:
                    tp_levels = [tp]
                elif side == "SELL" and tp < pos.price_open:
                    tp_levels = [tp]
                else:
                    tp_levels = []
            else:
                tp_levels = []

            self.active_trades[ticket] = {
                "symbol":             pos.symbol,
                "side":               side,
                "entry":              pos.price_open,
                "sl":                 sl,
                "tp":                 tp,
                "tp_levels":          tp_levels,
                "partial_close_done": saved_done,
                "lot":                pos.volume,
                "mode":               "MANUAL" if is_manual else "RESUMED",
                "source_channel":     "",
                "open_time":          datetime.now(),
            }

            sym = pos.symbol
            if sym not in self.symbol_data:
                self.symbol_data[sym] = {"last_trade_time": None, "trade_count": 0}
            self.symbol_data[sym]["trade_count"] += 1

            if is_manual:
                adopted += 1
                log(f"[INIT] Adopted manual trade ticket={ticket} {pos.symbol} {side}", "INFO")
            else:
                resumed += 1

        if resumed:
            log(f"[INIT] Resumed {resumed} bot position(s)", "INFO")
        if adopted:
            log(f"[INIT] Adopted {adopted} manual position(s)", "INFO")
        if not resumed and not adopted:
            log("[INIT] No open positions to resume", "INFO")

    # =========================
    # LIVE ADOPTION SCAN
    # Runs every manager cycle (every 2 seconds) so manual trades opened
    # while the bot is already running are picked up immediately — not just
    # at the next restart.
    #
    # Also catches any bot trade that somehow slipped out of active_trades
    # (e.g. a race condition on a very fast open/restart).
    #
    # For manual trades: calls _project_and_apply_levels() so SL and TP are
    # always set before the trail or partial close logic runs on them.
    # =========================
    def adopt_open_positions(self):
        if not settings.adopt_manual_trades:
            return

        positions = mt5.positions_get()
        if not positions:
            return

        for pos in positions:
            ticket = pos.ticket

            # Already tracked — nothing to do
            if ticket in self.active_trades:
                continue

            is_bot    = (pos.magic == settings.mt5_magic_number)
            is_manual = not is_bot
            side      = "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL"

            if is_manual:
                # Project and apply SL/TP if missing, then register
                sl, tp, _ = self._project_and_apply_levels(pos)
                mode = "MANUAL"
                log(f"[ADOPT] Live-adopted manual trade ticket={ticket} "
                    f"{pos.symbol} {side} SL={sl:.5f} TP={tp:.5f}", "INFO")
            else:
                # Bot trade not yet in active_trades — recover levels from MT5
                sl = pos.sl
                tp = pos.tp

                # Try to get original SL from order history in case it was
                # already moved to BE (sl_distance=0 would break trail logic)
                try:
                    hist = mt5.history_orders_get(datetime(2000, 1, 1), datetime.now())
                    if hist:
                        for order in reversed(hist):
                            if order.position_id == ticket and order.sl > 0:
                                sl = order.sl
                                break
                except Exception:
                    pass

                mode = "RESUMED"
                log(f"[ADOPT] Live-resumed bot trade ticket={ticket} "
                    f"{pos.symbol} {side}", "INFO")

            # Direction-guard the TP before storing
            if tp > 0:
                if (side == "BUY" and tp > pos.price_open) or \
                   (side == "SELL" and tp < pos.price_open):
                    tp_levels = [tp]
                else:
                    tp_levels = []
            else:
                tp_levels = []

            self.active_trades[ticket] = {
                "symbol":             pos.symbol,
                "side":               side,
                "entry":              pos.price_open,
                "sl":                 sl,
                "tp":                 tp,
                "tp_levels":          tp_levels,
                "partial_close_done": [],
                "lot":                pos.volume,
                "mode":               mode,
                "source_channel":     "",
                "open_time":          datetime.now(),
            }

            sym = pos.symbol
            if sym not in self.symbol_data:
                self.symbol_data[sym] = {"last_trade_time": None, "trade_count": 0}
            self.symbol_data[sym]["trade_count"] += 1

            self._persist_state()

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
            self.daily_wins       = 0
            self.daily_be         = 0
            self.daily_be_plus    = 0
            self.today_pnl        = 0.0
            self.trading_enabled     = True
            self._dd_alerted         = False
            self._profit_alerted     = False
            self._session_brief_sent = False
            self._alerted_orders     = set()

            for sym in self.symbol_data:
                self.symbol_data[sym]["trade_count"] = 0

            log("[RESET] Daily counters reset (new UTC day)", "INFO")
            self._persist_state()

    # =========================
    # CAN WE TRADE THIS SYMBOL?
    # =========================
    def can_trade(self, symbol: str, source_channel: str = "") -> bool:
        self._check_daily_reset()

        if not self.trading_enabled:
            log(f"[BLOCK] Trading disabled (daily loss limit hit)", "INFO")
            return False

        data = self.symbol_data.get(symbol, {})

        # Per-symbol trade cap
        if data.get("trade_count", 0) >= self.max_per_symbol:
            log(f"[BLOCK] {symbol} at max trades ({self.max_per_symbol})", "INFO")
            return False

        # Per-channel cooldown
        if source_channel:
            ch_last = self._channel_last_trade.get(source_channel)
            if ch_last is not None:
                ch_elapsed = (datetime.now() - ch_last).total_seconds()
                if ch_elapsed < self.cooldown_secs:
                    log(f"[BLOCK] channel {source_channel} cooldown {ch_elapsed:.0f}s/{self.cooldown_secs}s", "INFO")
                    return False

        # Per-symbol cooldown
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

        # Store ATR at entry for ATR-based trailing stop
        if "atr_pips" not in signal:
            signal["atr_pips"] = _get_atr_pips(symbol, settings.atr_period)

        self.active_trades[ticket] = signal

        if symbol not in self.symbol_data:
            self.symbol_data[symbol] = {"last_trade_time": None, "trade_count": 0}

        self.symbol_data[symbol]["last_trade_time"] = datetime.now()
        self.symbol_data[symbol]["trade_count"]     += 1
        # Per-channel cooldown timestamp
        src_ch = signal.get("source_channel", "")
        if src_ch:
            self._channel_last_trade[src_ch] = datetime.now()

        log_opened_trade(ticket, signal)
        log(f"[REGISTER] ticket={ticket} {symbol} {signal['side']} ATR={signal['atr_pips']:.1f}p", "INFO")
        self._persist_state()

    # =========================
    # PAUSE / RESUME (bot commands)
    # =========================
    def pause_trading(self):
        self.trading_enabled = False
        log("[MANAGER] Trading PAUSED by command", "INFO")
        self._persist_state()

    def resume_trading(self):
        self.trading_enabled = True
        log("[MANAGER] Trading RESUMED by command", "INFO")
        self._persist_state()

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

        if not closed:
            return

        # =========================
        # DEAL HISTORY QUERY — hoisted before per-ticket loop for efficiency.
        # PUPrime (and many brokers) do NOT reliably set position_id on deals,
        # so matching by position_id alone always fails. Instead we fetch ALL
        # closing deals placed by this bot (magic number) in the last 48 hours,
        # then match each closed ticket by position_id OR order ticket.
        # This mirrors the approach used in 0-mt5-247-bot which works correctly.
        # =========================
        _deal_from = datetime.now() - timedelta(hours=48)
        _deal_to   = datetime.now() + timedelta(minutes=5)
        _all_raw   = mt5.history_deals_get(_deal_from, _deal_to) or []
        _magic_exit_deals = [
            d for d in _all_raw
            if getattr(d, 'magic', 0) == settings.mt5_magic_number
            and d.entry in (1, 3)   # DEAL_ENTRY_OUT or DEAL_ENTRY_OUT_BY
        ]
        log(
            f"[CLOSE] Deal pool: {len(_all_raw)} total deals, "
            f"{len(_magic_exit_deals)} magic-exit deals in 48h window",
            "INFO",
        )

        for ticket in closed:
            trade = self.active_trades.pop(ticket, {})
            symbol = trade.get("symbol", "?")

            # Decrement symbol trade count
            if symbol in self.symbol_data:
                cnt = self.symbol_data[symbol].get("trade_count", 1)
                self.symbol_data[symbol]["trade_count"] = max(0, cnt - 1)

            # Match closing deals for this ticket.
            # Priority 1: position_id matches our stored ticket (standard brokers).
            # Priority 2: deal.order matches our ticket (some brokers swap the two).
            profit     = 0.0
            exit_price = None

            for d in _magic_exit_deals:
                if d.position_id == ticket or d.order == ticket:
                    profit    += d.profit
                    exit_price = d.price
                    log(
                        f"[CLOSE] Deal matched ticket={ticket} {symbol} "
                        f"deal_pos_id={d.position_id} deal_order={d.order} "
                        f"deal_entry={d.entry} profit={d.profit:.2f}",
                        "INFO",
                    )

            # Fallback: if still no match, try symbol+time on the full 48h window.
            # Catches brokers where neither position_id nor order aligns with ticket.
            if exit_price is None:
                open_time = trade.get("open_time")
                open_ts   = open_time.timestamp() if open_time else 0
                candidates = [
                    d for d in _all_raw
                    if getattr(d, "symbol", "") == symbol
                    and d.entry in (1, 3)
                    and d.time >= open_ts - 60
                ]
                if candidates:
                    best       = max(candidates, key=lambda d: d.time)
                    profit     = best.profit
                    exit_price = best.price
                    log(
                        f"[CLOSE] Symbol-time fallback ticket={ticket} {symbol} "
                        f"deal_pos_id={best.position_id} deal_order={best.order} "
                        f"profit={profit:.2f}",
                        "INFO",
                    )

            if exit_price is None:
                log(
                    f"[CLOSE] WARNING ticket={ticket} {symbol} — no closing deal found "
                    f"in history. Profit recorded as 0. Verify in MT5 terminal.",
                    "WARNING"
                )

            self.today_pnl += profit

            # Update streak / daily counters
            # profit >= BE_PLUS_MAX  → WIN  (genuine profit — TP or good trail)
            # 0 < profit < BE_PLUS_MAX → BE+ (protected exit — small profit from BE buffer)
            # profit < -BE_THRESHOLD → LOSS (counts toward kill switch)
            # |profit| <= BE_THRESHOLD → BE (SL at exactly entry; swap/commission noise)
            BE_THRESHOLD = 0.05   # ±$0.05 = true breakeven noise floor
            BE_PLUS_MAX  = 5.00   # below this + above BE_THRESHOLD = protected BE exit

            if profit >= BE_PLUS_MAX:
                self.win_streak  += 1
                self.loss_streak  = 0
                self.daily_wins  += 1
                log("[CLOSE] WIN ticket={} {} profit={:.2f} (streak W{})".format(
                    ticket, symbol, profit, self.win_streak), "INFO")
            elif profit > BE_THRESHOLD:
                # Protected exit — BE buffer closed with small profit; doesn't reset loss streak
                self.daily_be_plus += 1
                log("[CLOSE] BE+ ticket={} {} profit={:.2f} (protected exit)".format(
                    ticket, symbol, profit), "INFO")
            elif profit < -BE_THRESHOLD:
                self.loss_streak += 1
                self.win_streak   = 0
                self.daily_loss  += 1
                log("[CLOSE] LOSS ticket={} {} profit={:.2f} (streak L{})".format(
                    ticket, symbol, profit, self.loss_streak), "INFO")

                # Kill switch — daily total
                if self.daily_loss >= self.max_daily_loss:
                    self.trading_enabled = False
                    log("[KILL SWITCH] Daily loss limit hit ({}). Trading PAUSED for today.".format(
                        self.daily_loss), "INFO")
                    if self.tg:
                        self._tg_queue.append(('kill_switch', self.daily_loss))

                # Kill switch — consecutive streak
                if self.loss_streak >= self.max_consecutive_loss:
                    self.trading_enabled = False
                    log("[KILL SWITCH] Consecutive loss limit hit ({} in a row). Trading PAUSED for today.".format(
                        self.loss_streak), "INFO")
                    if self.tg:
                        self._tg_queue.append(('kill_switch', self.loss_streak))
            else:
                # True breakeven — SL was at entry, closed at $0
                self.daily_be += 1
                log("[CLOSE] BE ticket={} {} profit={:.2f} (within ±{:.2f} threshold)".format(
                    ticket, symbol, profit, BE_THRESHOLD), "INFO")

            # Log to CSV
            log_closed_trade(ticket, trade, profit, exit_price)

            # Determine result label for notification
            if profit >= BE_PLUS_MAX:
                result = "WIN"
            elif profit > BE_THRESHOLD:
                result = "BE+"
            elif profit < -BE_THRESHOLD:
                result = "LOSS"
            else:
                result = "BE"

            # R:R for the notification
            entry_p = trade.get("entry", 0)
            sl_p    = trade.get("sl", 0)
            sl_dist = abs(entry_p - sl_p) if sl_p else 0
            reward  = abs((exit_price or 0) - entry_p) if entry_p else 0
            rr_str  = "{:.2f}R".format(reward / sl_dist) if sl_dist > 0 else ""

            # Infer exit type from result + whether SL was trailed.
            # "sl_moved" is set on the trade dict by apply_trailing_stop when it fires.
            sl_was_trailed = trade.get("sl_trailed", False)
            if result == "WIN" and sl_was_trailed:
                exit_type = "🔒 Trailing stop"
            elif result == "WIN":
                exit_type = "🎯 Take profit"
            elif result == "BE+":
                exit_type = "🛡️ BE+ protected"
            elif result == "BE":
                exit_type = "🛡️ BE protected"
            else:
                exit_type = "🛑 Stop loss"

            # BE buffer info for notification
            be_buf = self._be_buffer_for_symbol(symbol)

            # Send rich close notification with source channel
            close_data = {
                "symbol":           trade.get("symbol", symbol),
                "side":             trade.get("side", ""),
                "entry":            trade.get("entry", 0),
                "exit":             exit_price or 0,
                "profit":           profit,
                "result":           result,
                "rr":               rr_str,
                "exit_type":        exit_type,
                "be_buffer":        be_buf,
                "source_channel":   trade.get("source_channel", ""),
                "daily_loss":       self.daily_loss,
                "daily_loss_limit": self.max_daily_loss,
            }
            if self.tg:
                self._tg_queue.append(('close_trade', close_data))

        # Persist after processing any closed trades
        self._persist_state()

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

                # Direction guard — skip any TP level on the wrong side of
                # entry.  This prevents parser-supplied TPs that are above
                # entry on a SELL (or below entry on a BUY) from triggering
                # an instant partial close.
                if side == "BUY"  and tp <= entry:
                    log(f"[PARTIAL] Skipping invalid TP{i+1}={tp:.5f} for BUY "
                        f"entry={entry:.5f} ticket={ticket}", "WARNING")
                    self.active_trades[ticket]["partial_close_done"].append(i)
                    continue
                if side == "SELL" and tp >= entry:
                    log(f"[PARTIAL] Skipping invalid TP{i+1}={tp:.5f} for SELL "
                        f"entry={entry:.5f} ticket={ticket}", "WARNING")
                    self.active_trades[ticket]["partial_close_done"].append(i)
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

                # Skip partial close if the full position would be consumed —
                # this happens when lot = min_lot (e.g. 0.01) and 50% rounds
                # back up to the same min_lot. Instead, just move SL to BE
                # so the position is protected without closing the runner.
                if remaining <= 0:
                    sl_distance = abs(entry - sl_orig)
                    be_buffer   = sl_distance * 0.1
                    new_sl = (entry + be_buffer) if side == "BUY" else (entry - be_buffer)
                    mt5.order_send({
                        "action":   mt5.TRADE_ACTION_SLTP,
                        "symbol":   pos.symbol,
                        "position": ticket,
                        "sl":       new_sl,
                        "tp":       pos.tp,
                    })
                    self.active_trades[ticket]["partial_close_done"].append(i)
                    self._persist_state()
                    log(f"[PARTIAL] TP{i+1} hit ticket={ticket} {pos.symbol} "
                        f"— lot at minimum ({pos.volume}), skipped close, SL moved to BE={new_sl:.5f}", "INFO")
                    continue

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

                # Mark TP as done and persist so restart doesn't re-fire it
                self.active_trades[ticket]["partial_close_done"].append(i)
                self._persist_state()

                # Next TP target for notification
                next_tp = tp_levels[i + 1] if i + 1 < len(tp_levels) else None

                log(f"[PARTIAL] TP{i+1} hit ticket={ticket} {pos.symbol} "
                    f"closed={close_vol} remaining={remaining} BE={new_sl:.5f}", "INFO")

                if self.tg:
                    self._tg_queue.append(('partial_close', {
                        "symbol":        pos.symbol,
                        "side":          side,
                        "tp_hit":        tp,
                        "closed_lot":    close_vol,
                        "remaining_lot": remaining,
                        "new_sl":        new_sl,
                        "next_tp":       next_tp,
                    }))

                break   # only process one TP level per cycle

    # =========================
    # BE BUFFER — PER SYMBOL
    # Returns the fixed price-point buffer placed above/below entry when SL
    # moves to breakeven.  Sized so the close is worth a small but real profit
    # on typical lot sizes for each instrument.
    #
    # Rationale (approximate 0.3–0.4× minimum SL distance):
    #   BTC  100pt min SL → 30pt buffer  (~0.30R of min SL)
    #   XAU   20pt min SL →  8pt buffer  (~0.40R of min SL)
    #   NAS   30pt min SL → 10pt buffer  (~0.33R of min SL)
    #   other 10pt min SL →  3pt buffer  (~0.30R of min SL)
    # =========================
    def _be_buffer_for_symbol(self, symbol: str) -> float:
        # If BE_BUFFER_DOLLARS is set in .env (non-zero), use it as a flat override
        # so a single config value controls the buffer across all instruments.
        if settings.be_buffer_dollars and settings.be_buffer_dollars > 0:
            return float(settings.be_buffer_dollars)
        # Fallback: symbol-specific defaults (price-point buffers sized to each instrument)
        #   BTC  100pt min SL → 30pt buffer  (~0.30R of min SL)
        #   XAU   20pt min SL →  8pt buffer  (~0.40R of min SL)
        #   NAS   30pt min SL → 10pt buffer  (~0.33R of min SL)
        #   other 10pt min SL →  3pt buffer  (~0.30R of min SL)
        if "BTC" in symbol:
            return 30.0
        elif "XAU" in symbol:
            return 8.0
        elif "NAS" in symbol:
            return 10.0
        else:
            return 3.0

    def _trail_pips_for_symbol(self, symbol: str) -> float:
        """Fixed trail distance in price-points behind current price.
        TRAIL_FIXED_PIPS in .env overrides all symbols when > 0.
        Per-asset defaults are tight enough to lock profit quickly
        without getting stopped on normal noise."""
        override = getattr(settings, 'trail_fixed_pips', 0.0)
        if override and override > 0:
            return float(override)
        sym = symbol.upper()
        if "BTC" in sym:
            return 50.0    # BTC: $50 trail (~0.1% on $50k)
        if "ETH" in sym:
            return 5.0     # ETH: $5 trail
        if "XAU" in sym or "GOLD" in sym:
            return 3.0     # XAU: 3pt trail — locks profit fast on tight SLs
        if "NAS" in sym or "US100" in sym or "NDX" in sym:
            return 8.0     # NAS100: 8pt trail
        if "GER" in sym or "DAX" in sym:
            return 8.0
        if "SPX" in sym or "SP500" in sym or "US500" in sym:
            return 8.0
        if "NFLX" in sym or "NETFLIX" in sym or "AAPL" in sym:
            return 0.50    # US stocks: $0.50 trail
        return 0.00050     # Default FX: 5 pips

    # =========================
    # TRAILING STOP
    # Phase 1 (breakeven): when profit >= 0.75R, move SL to entry ± buffer.
    #   Buffer is capped at 50% of current profit distance so SL never
    #   overshoots current price on small moves.
    # Phase 2 (continuous trail): when profit >= TRAIL_TRIGGER_R, trail SL
    #   at a fixed pip distance behind current price (TRAIL_FIXED_PIPS or
    #   per-symbol defaults). Fixed-pip trail gives back the same absolute
    #   amount regardless of SL width — far tighter than R-based on wide SLs.
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

            tick = mt5.symbol_info_tick(pos.symbol)
            if not tick:
                continue

            current_price = tick.bid if side == "BUY" else tick.ask
            current_sl    = pos.sl
            current_tp    = pos.tp
            new_sl        = None

            # -------------------------------------------------------
            # ATR-based trail (primary path when ATR_TRAIL_ENABLED)
            # -------------------------------------------------------
            if settings.atr_trail_enabled:
                atr_pips = trade.get("atr_pips") or _get_atr_pips(pos.symbol, settings.atr_period)
                if "atr_pips" not in trade:
                    self.active_trades[ticket]["atr_pips"] = atr_pips

                # Determine pip size for this symbol
                sym = pos.symbol.upper()
                if "XAU" in sym or "GOLD" in sym:
                    pip_sz = 0.10
                elif "BTC" in sym or "ETH" in sym or "NAS" in sym or "US100" in sym \
                        or "GER" in sym or "US30" in sym or "SPX" in sym:
                    pip_sz = 1.0
                elif "XAG" in sym:
                    pip_sz = 0.01
                else:
                    pip_sz = 0.0001  # FX

                be_trigger  = max(settings.min_be_pips,  atr_pips * settings.atr_be_trigger_pct) * pip_sz
                trail_dist  = max(settings.min_trail_pips, atr_pips * settings.atr_trail_dist_pct) * pip_sz

                if side == "BUY":
                    float_dist = current_price - entry
                    # Phase 1 — BE lock: SL → entry + buffer (10 pips / $1 above entry)
                    if float_dist >= be_trigger and current_sl < entry:
                        be_buf = self._be_buffer_for_symbol(pos.symbol)
                        new_sl = entry + min(be_buf, float_dist * 0.5)
                    # Phase 2 — trail behind price
                    elif current_sl >= entry:
                        ideal_sl = current_price - trail_dist
                        if ideal_sl > current_sl + pip_sz:
                            new_sl = ideal_sl
                else:
                    float_dist = entry - current_price
                    # Phase 1 — BE lock: SL → entry - buffer (10 pips / $1 below entry)
                    if float_dist >= be_trigger and (current_sl == 0 or current_sl > entry):
                        be_buf = self._be_buffer_for_symbol(pos.symbol)
                        new_sl = entry - min(be_buf, float_dist * 0.5)
                    # Phase 2 — trail behind price
                    elif current_sl > 0 and current_sl <= entry:
                        ideal_sl = current_price + trail_dist
                        if current_sl == 0 or ideal_sl < current_sl - pip_sz:
                            new_sl = ideal_sl

                float_pips = float_dist / pip_sz

            else:
                # -------------------------------------------------------
                # Legacy R-based trail (fallback when ATR_TRAIL_ENABLED=false)
                # -------------------------------------------------------
                sl_distance = abs(entry - sl)
                if sl_distance == 0:
                    continue
                if side == "BUY":
                    profit_distance = current_price - entry
                else:
                    profit_distance = entry - current_price
                profit_r   = profit_distance / sl_distance
                raw_buffer = self._be_buffer_for_symbol(pos.symbol)
                be_buffer  = min(raw_buffer, 0.5 * max(profit_distance, 0))
                trail_pips = self._trail_pips_for_symbol(pos.symbol)
                float_pips = profit_r  # display as R

                if profit_r >= 0.75:
                    if side == "BUY":
                        be_sl = entry + be_buffer
                        if current_sl < be_sl:
                            new_sl = be_sl
                    else:
                        be_sl = entry - be_buffer
                        if current_sl == 0 or current_sl > be_sl:
                            new_sl = be_sl

                if profit_r >= settings.trail_trigger_r:
                    if side == "BUY":
                        trail_sl = current_price - trail_pips
                        if trail_sl > current_sl:
                            new_sl = trail_sl
                    else:
                        trail_sl = current_price + trail_pips
                        if current_sl == 0 or trail_sl < current_sl:
                            new_sl = trail_sl

            if new_sl is not None:
                new_sl = round(new_sl, 2)
                # Remove TP once trail/BE is active — let the trailing SL manage the exit
                # so winners aren't capped by the original TP target.
                modify_req = {
                    "action":   mt5.TRADE_ACTION_SLTP,
                    "symbol":   pos.symbol,
                    "position": ticket,
                    "sl":       new_sl,
                    "tp":       0.0,
                }
                res = mt5.order_send(modify_req)
                if res and res.retcode == mt5.TRADE_RETCODE_DONE:
                    be_note = " [BE LOCKED]" if new_sl == entry else ""
                    tp_note = " [TP REMOVED]" if current_tp and current_tp > 0 else ""
                    log(f"[TRAIL] ticket={ticket} {pos.symbol} SL→{new_sl:.2f} "
                        f"float={float_pips:.1f}p{be_note}{tp_note}", "INFO")
                    self.active_trades[ticket]["sl_trailed"] = True
                else:
                    retcode = res.retcode if res else "None"
                    log(f"[TRAIL] SL modify FAILED ticket={ticket} {pos.symbol} "
                        f"new_sl={new_sl:.2f} retcode={retcode}", "ERROR")

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
                    if order.ticket not in self._alerted_orders:
                        self._alerted_orders.add(order.ticket)
                        _side = "BUY" if order.type in (mt5.ORDER_TYPE_BUY, mt5.ORDER_TYPE_BUY_STOP, mt5.ORDER_TYPE_BUY_LIMIT) else "SELL"
                        _msg = (
                            f"🗑️ <b>Stale Order Cancelled</b>\n"
                            f"📡 CryptoNite Signal Bot\n"
                            f"📌 {order.symbol} {_side}\n"
                            f"⏱ Pending for <b>{age_minutes:.0f} min</b> (limit: {max_age_minutes}min)\n"
                            f"🎫 Ticket: {order.ticket}\n"
                            f"⏰ {self._now_utc()}"
                        )
                        if self.tg:
                            self._tg_queue.append(('alert', _msg))

    # =========================
    # STATS (for /stats bot command)
    # =========================
    def get_stats(self) -> dict:
        account = mt5.account_info()
        balance = account.balance if account else 0.0
        equity  = account.equity  if account else 0.0

        total = self.daily_wins + self.daily_loss + self.daily_be
        win_rate = round(self.daily_wins / total * 100) if total > 0 else 0

        return {
            "trading_enabled":  self.trading_enabled,
            "daily_wins":       self.daily_wins,
            "daily_losses":     self.daily_loss,
            "daily_be":         self.daily_be,
            "daily_total":      total,
            "daily_win_rate":   win_rate,
            "daily_loss_limit": self.max_daily_loss,
            "open_trades":      len(self.active_trades),
            "today_pnl":        self.today_pnl,
            "win_streak":       self.win_streak,
            "loss_streak":      self.loss_streak,
            "balance":          balance,
            "equity":           equity,
        }

    # =========================
    # SESSION CLOSE GUARD
    # Fires once per day at TIME_FILTER_END_HOUR UTC.
    # Closes any open positions that are in profit but have NOT yet had
    # their SL moved to breakeven — they still carry full original downside
    # risk and could give back gains during the post-session fakeout window.
    # Positions with SL already at/above entry are left for the trail.
    # =========================
    def session_close_guard(self):
        from datetime import timezone
        now_utc = datetime.now(timezone.utc)
        end_hour = settings.time_filter_end_hour

        # Only fire at or after the session end hour
        if now_utc.hour < end_hour:
            return

        # Fire once per calendar day only
        today = now_utc.date()
        if getattr(self, "_session_close_fired_date", None) == today:
            return
        self._session_close_fired_date = today

        positions = mt5.positions_get()
        if not positions:
            return

        pos_map = {p.ticket: p for p in positions}
        closed = 0

        for ticket, trade in list(self.active_trades.items()):
            pos = pos_map.get(ticket)
            if not pos:
                continue

            # Skip if not in profit — only guard profitable positions
            if pos.profit <= 0:
                continue

            entry = trade.get("entry", pos.price_open)
            side  = trade.get("side", "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL")
            sl    = pos.sl
            eps   = 0.00001

            # Check if SL is still on the wrong side of entry (not yet at BE)
            sl_unprotected = (
                (side == "BUY"  and (sl == 0 or sl < entry - eps)) or
                (side == "SELL" and (sl == 0 or sl > entry + eps))
            )
            if not sl_unprotected:
                log(f"[SESSION GUARD] ticket={ticket} {pos.symbol} SL protected at {sl:.5f} — leaving for trail", "INFO")
                continue

            # Close the unprotected profitable position
            tick = mt5.symbol_info_tick(pos.symbol)
            if not tick:
                continue

            close_type  = mt5.ORDER_TYPE_SELL if side == "BUY" else mt5.ORDER_TYPE_BUY
            close_price = tick.bid              if side == "BUY" else tick.ask
            pnl_sign    = "+" if pos.profit >= 0 else ""

            req = {
                "action":       mt5.TRADE_ACTION_DEAL,
                "position":     int(ticket),
                "symbol":       pos.symbol,
                "volume":       float(pos.volume),
                "type":         close_type,
                "price":        float(close_price),
                "deviation":    30,
                "magic":        settings.mt5_magic_number,
                "comment":      "session close guard",
                "type_time":    mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }
            res = mt5.order_send(req)
            if res and res.retcode == mt5.TRADE_RETCODE_DONE:
                log(f"[SESSION GUARD] Closed ticket={ticket} {pos.symbol} {side} "
                    f"P&L={pnl_sign}{pos.profit:.2f} (SL not at BE — protected at session end)", "INFO")
                self.active_trades.pop(ticket, None)
                self._persist_state()
                closed += 1
            else:
                retcode = res.retcode if res else "None"
                log(f"[SESSION GUARD] Close FAILED ticket={ticket} retcode={retcode}", "ERROR")

        if closed:
            log(f"[SESSION GUARD] Secured {closed} unprotected position(s) at session end ({end_hour:02d}:00 UTC)", "INFO")
            if self.tg:
                self._tg_queue.append(('alert',
                    f"🔒 Session Close Guard: secured {closed} unprotected position(s) at {end_hour:02d}:00 UTC"
                ))


    # =========================
    # DRAWDOWN ALERT
    # Fires once per day if live equity drops DRAWDOWN_ALERT_PCT% below balance.
    # =========================
    def check_drawdown_alert(self):
        if self._dd_alerted:
            return
        pct = settings.drawdown_alert_pct
        if pct <= 0:
            return
        account = mt5.account_info()
        if not account:
            return
        balance = account.balance
        equity  = account.equity
        if balance <= 0:
            return
        dd_pct = (balance - equity) / balance * 100
        if dd_pct >= pct:
            self._dd_alerted = True
            msg = (
                f"⚠️ <b>Drawdown Alert</b>\n"
                f"📉 Equity has dropped <b>{dd_pct:.1f}%</b> below balance\n"
                f"💰 Balance: <b>{balance:.2f}</b>  |  Equity: <b>{equity:.2f}</b>\n"
                f"⏰ {self._now_utc()}\n"
                f"💡 Consider pausing — use /pause to stop new entries."
            )
            log(f"[DRAWDOWN ALERT] {dd_pct:.1f}% drawdown detected", "WARNING")
            if self.tg:
                self._tg_queue.append(('alert', msg))

    # =========================
    # DAILY PROFIT TARGET ALERT
    # Fires once per day when today_pnl hits DAILY_PROFIT_TARGET_PCT% of balance.
    # =========================
    def check_profit_target(self):
        if self._profit_alerted:
            return
        pct = settings.daily_profit_target_pct
        if pct <= 0:
            return
        account = mt5.account_info()
        if not account or account.balance <= 0:
            return
        target_usd = account.balance * pct / 100
        if self.today_pnl >= target_usd:
            self._profit_alerted = True
            msg = (
                f"🎯 <b>Daily Profit Target Hit</b>\n"
                f"📡 CryptoNite Signal Bot\n"
                f"✅ Today\'s P&L: <b>+{self.today_pnl:.2f}</b> "
                f"({self.today_pnl / account.balance * 100:.1f}% of balance)\n"
                f"🏆 Target: +{target_usd:.2f} ({pct:.1f}%)\n"
                f"⏰ {self._now_utc()}\n"
                f"💡 Consider calling it a day — use /pause to lock in gains."
            )
            log(f"[PROFIT TARGET] Hit {self.today_pnl:.2f} (target {target_usd:.2f})", "INFO")
            if self.tg:
                self._tg_queue.append(('alert', msg))

    # =========================
    # SESSION OPEN SNAPSHOT
    # Fires once per day at session open — balance, equity, P&L so far.
    # =========================
    def session_open_brief(self, force: bool = False):
        if self._session_brief_sent:
            return
        now_h = datetime.now(timezone.utc).hour
        # Allow forced call (e.g. on startup) to bypass the session-hour gate.
        # Normal loop calls still respect the time filter.
        if not force and now_h < settings.time_filter_start_hour:
            return
        self._session_brief_sent = True
        account = mt5.account_info()
        if not account:
            return
        total    = self.daily_wins + self.daily_loss + self.daily_be_plus + self.daily_be
        pnl_sign = "+" if self.today_pnl >= 0 else ""
        status   = "\u2705 Trading enabled" if self.trading_enabled else "\u26d4 Trading PAUSED"
        msg = (
            f"\U0001f4ca <b>Session Open</b>\n"
            f"\U0001f4e1 CryptoNite Signal Bot\n"
            f"\u23f0 {self._now_utc()}\n"
            f"\U0001f4b0 Balance: <b>{account.balance:.2f}</b>  |  Equity: <b>{account.equity:.2f}</b>\n"
            f"\U0001f4c8 Today P&L: <b>{pnl_sign}{self.today_pnl:.2f}</b>\n"
            f"\U0001f522 Trades: {total} ({self.daily_wins}W / {self.daily_loss}L / {self.daily_be_plus}BE+ / {self.daily_be}BE)\n"
            f"{status}"
        )
        log(f"[SESSION BRIEF] Sent at {now_h:02d}:00 UTC", "INFO")
        if self.tg:
            self._tg_queue.append(('alert', msg))

    # =========================
    # PENDING ORDER TIMEOUT ALERT
    # Alerts (and cancels) stale pending orders beyond ORDER_TIMEOUT_MINUTES.
    # =========================
    def _now_utc(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

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
