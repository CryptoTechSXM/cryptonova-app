import asyncio
import MetaTrader5 as mt5

from logger import log
from lot import calculate_lot
from config import settings


class TradeExecutor:
    def __init__(self, manager):
        self.manager = manager

    # =========================
    # AUTO SYMBOL DETECTION
    # =========================
    def resolve_symbol(self, base_symbol):
        candidates = [
            base_symbol,
            base_symbol + ".pro",
            base_symbol + ".f",
            base_symbol + ".s"
        ]

        for symbol in candidates:
            info = mt5.symbol_info(symbol)
            if info is not None:
                if not info.visible:
                    mt5.symbol_select(symbol, True)
                log(f"[SYMBOL] Using {symbol}", "INFO")
                return symbol

        log(f"[SYMBOL] No valid symbol found for {base_symbol}", "ERROR")
        return None

    # =========================
    # EMA FILTER (M5 EMA 100)
    # Blocks trades that go against the medium-term trend.
    # BUY only above EMA100, SELL only below EMA100.
    # =========================
    def ema_filter(self, symbol, side):
        rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, 120)

        if rates is None or len(rates) < 100:
            log("[EMA] Not enough data — skipping filter", "ERROR")
            return True   # fail open so we don't miss trades on data issues

        closes = [r["close"] for r in rates[-100:]]

        # EMA 100 calculation
        ema = closes[0]
        k = 2 / (100 + 1)
        for price in closes[1:]:
            ema = price * k + ema * (1 - k)

        tick = mt5.symbol_info_tick(symbol)
        if not tick:
            return True

        current_price = tick.bid if side == "BUY" else tick.ask

        if side == "BUY" and current_price < ema:
            log(f"[EMA FILTER] Blocked BUY on {symbol} — price {current_price:.5f} < EMA {ema:.5f}", "INFO")
            return False

        if side == "SELL" and current_price > ema:
            log(f"[EMA FILTER] Blocked SELL on {symbol} — price {current_price:.5f} > EMA {ema:.5f}", "INFO")
            return False

        log(f"[EMA FILTER] Passed — {side} on {symbol}, EMA={ema:.5f}", "INFO")
        return True

    # =========================
    # MARKET FALLBACK LEVELS
    # Used when a signal has no SL/TP or comes in as a pure MARKET order.
    # =========================
    def build_market_levels(self, symbol, price, side):
        if "BTC" in symbol:
            risk = 100
        elif "XAU" in symbol:
            risk = 5
        elif "NAS" in symbol:
            risk = 30
        else:
            risk = 10

        reward = risk * 2

        if side == "BUY":
            sl = price - risk
            tp = price + reward
        else:
            sl = price + risk
            tp = price - reward

        return sl, tp, risk

    # =========================
    # NORMALIZE SIGNAL LEVELS
    # Enforces minimum SL distance so we never trade tiny stops.
    # Recalculates TP at 2R if SL had to be widened.
    # =========================
    def normalize_signal(self, symbol, entry, sl, tp, side):
        risk = abs(entry - sl)

        if "BTC" in symbol:
            min_sl = 100
        elif "XAU" in symbol:
            min_sl = 5
        elif "NAS" in symbol:
            min_sl = 30
        else:
            min_sl = 10

        if risk < min_sl:
            log(f"[ADJUST] SL too small ({risk:.2f}) - widening to {min_sl}", "INFO")
            risk = min_sl

        reward = risk * 2

        if side == "BUY":
            sl = entry - risk
            tp = entry + reward
        else:
            sl = entry + risk
            tp = entry - reward

        log(f"[NORMALIZED] {symbol} | Entry={entry:.5f} SL={sl:.5f} TP={tp:.5f}", "INFO")
        return sl, tp, risk

    # =========================
    # MAIN EXECUTION
    # =========================
    def execute_signal(self, signal):
        try:
            base_symbol = signal["symbol"]
            symbol = self.resolve_symbol(base_symbol)

            if not symbol:
                return {"ok": False, "message": f"Invalid symbol {base_symbol}"}

            side        = signal["side"]
            entry       = signal.get("entry", 0.0)
            sl          = signal.get("sl", -1.0)
            tp          = signal.get("tp", -1.0)
            signal_type = signal.get("type", "NORMAL")
            source_channel = signal.get("source_channel", "")

            tick = mt5.symbol_info_tick(symbol)
            if not tick:
                return {"ok": False, "message": "No tick data"}

            price = tick.ask if side == "BUY" else tick.bid

            # =========================
            # BUILD / NORMALIZE LEVELS
            # =========================
            if signal_type == "MARKET" or sl <= 0 or tp <= 0 or entry <= 0:
                entry = price
                sl, tp, sl_distance = self.build_market_levels(symbol, price, side)
                mode = "MARKET_AUTO"
                log("[MARKET] Auto SL/TP applied", "INFO")
            else:
                sl, tp, sl_distance = self.normalize_signal(symbol, entry, sl, tp, side)
                mode = "NORMALIZED"

            # =========================
            # MANAGER FILTER
            # Checks: trading_enabled, cooldown, per-symbol cap, duplicates
            # =========================
            if not self.manager.can_trade(symbol):
                log(f"[FILTER] Trade blocked by manager ({symbol})", "INFO")
                return {"ok": False, "message": "Filtered by manager"}

            # =========================
            # EMA FILTER
            # =========================
            if not self.ema_filter(symbol, side):
                return {"ok": False, "message": "Blocked by EMA filter"}

            # =========================
            # LOT SIZE
            # Three multipliers combined:
            #   1. Base risk from settings.base_risk_pct
            #   2. Streak multiplier from manager (win/loss streak)
            #   3. Per-channel risk multiplier from CHANNEL_RISK in .env
            # All three feed into calculate_lot which also hard-caps the result.
            # =========================
            channel_risk_mult = settings.get_channel_risk(source_channel)
            if channel_risk_mult != 1.0:
                log(f"[LOT] Channel risk multiplier: x{channel_risk_mult}", "INFO")

            lot = calculate_lot(symbol, sl_distance, self.manager, channel_risk_mult)

            order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL

            request = {
                "action":       mt5.TRADE_ACTION_DEAL,
                "symbol":       symbol,
                "volume":       lot,
                "type":         order_type,
                "price":        price,
                "sl":           sl,
                "tp":           tp,
                "deviation":    20,
                "magic":        settings.mt5_magic_number,
                "comment":      "CryptoNite Bot",
                "type_time":    mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }

            log(f"[EXECUTION] Sending order: {request}", "INFO")

            result = mt5.order_send(request)

            if result is None:
                return {"ok": False, "message": "No response from MT5"}

            if result.retcode != mt5.TRADE_RETCODE_DONE:
                return {"ok": False, "message": f"Order failed retcode={result.retcode}"}

            ticket = result.order

            # =========================
            # REGISTER TRADE
            # tp_levels holds all TP targets from the parser (TP1, TP2, TP3...).
            # The manager uses this list to know when to fire partial closes.
            # If there was only one TP, tp_levels is just [tp].
            # =========================
            tp_levels = signal.get("tp_levels", [tp] if tp > 0 else [])

            registered_signal = {
                "symbol":         symbol,
                "side":           side,
                "entry":          price,
                "sl":             sl,
                "tp":             tp,
                "tp_levels":      tp_levels,
                "lot":            lot,
                "mode":           mode,
                "source_channel": source_channel,
                "channel_risk":   channel_risk_mult,
            }

            self.manager.register_trade(ticket, registered_signal)

            # =========================
            # SEND EXECUTION NOTIFICATION
            # =========================
            if hasattr(self, "tg"):
                import asyncio
                asyncio.create_task(
                    self.tg.send_execution({
                        "symbol":     symbol,
                        "side":       side,
                        "entry":      price,
                        "sl":         sl,
                        "tp_levels":  tp_levels,
                        "lot":        lot,
                        "order_type": mode,
                        "source_channel": source_channel,
                    })
                )

            log(f"[EXECUTION] Order filled: ticket={ticket} {symbol} {side} lot={lot}", "INFO")
            return {"ok": True, "ticket": ticket}

        except Exception as e:
            log(f"[EXECUTION ERROR] {e}", "ERROR")
            return {"ok": False, "message": str(e)}
