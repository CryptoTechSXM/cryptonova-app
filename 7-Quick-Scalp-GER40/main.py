import time
from datetime import datetime, timezone
import MetaTrader5 as mt5
import config
from data            import initialize, get_data, get_daily_atr
from resolver          import resolve_symbol
from strategy        import get_opening_range, validate_liquidity_candle, scan_for_signal
from lot             import calculate_lot_size
from risk            import DailyRiskManager
from logger          import log_trade, init_log, log_event
from telegram_sender import send_signal, send_status

STRATEGY_NAME = "QFS GER40"
risk_manager  = DailyRiskManager(config)

def _local(utc_h, utc_m=0):
    off  = int((datetime.now() - datetime.now(timezone.utc).replace(tzinfo=None)).total_seconds() / 60)
    mins = utc_h * 60 + utc_m + off
    tz   = datetime.now().astimezone().strftime('%Z')
    return '{:02d}:{:02d} {}'.format((mins // 60) % 24, mins % 60, tz)

today_box    = None
today_date   = None
today_traded     = False
last_scan_candle = None   # gate: only scan on new 5M candle



# --------------------------------------------------------------------------
# Position close detection
# QFS places pending orders — MT5 closes them via TP/SL automatically.
# This tracker detects closes and calls record_trade() so the P&L limit
# and consecutive loss kill switch actually fire.
# --------------------------------------------------------------------------
_tracked_tickets = {}   # ticket -> entry_price for positions we placed


def update_position_tracking():
    """Detect positions that closed since last scan and record their P&L."""
    global _tracked_tickets
    from datetime import timedelta
    open_pos = mt5.positions_get(symbol=config.SYMBOL) or []
    open_tickets = {p.ticket for p in open_pos if p.magic == config.MAGIC_NUMBER}

    # Add any newly adopted positions
    for p in open_pos:
        if p.magic == config.MAGIC_NUMBER and p.ticket not in _tracked_tickets:
            _tracked_tickets[p.ticket] = p.price_open

    # Check for tickets that are no longer open (TP/SL hit)
    for ticket in list(_tracked_tickets.keys()):
        if ticket not in open_tickets:
            now = datetime.now(timezone.utc)
            deals = mt5.history_deals_get(now - timedelta(days=1), now + timedelta(hours=1))
            pnl = 0.0
            if deals:
                for d in deals:
                    if d.position_id == ticket and d.entry == 1:  # ENTRY_OUT
                        pnl = d.profit
                        break
            risk_manager.record_trade(pnl)
            log_event('[{}] Position {} closed -- P&L: {:+.2f}'.format(
                config.SYMBOL, ticket, pnl))
            del _tracked_tickets[ticket]


_session_guard_fired = set()


def session_close_guard():
    """At SESSION_CLOSE_HOUR close any profitable open position — avoid overnight holds."""
    now = datetime.now(timezone.utc)
    if now.hour < config.SESSION_CLOSE_HOUR:
        return
    today = now.date()
    if today in _session_guard_fired:
        return
    _session_guard_fired.add(today)
    positions = mt5.positions_get(symbol=config.SYMBOL) or []
    for pos in [p for p in positions if p.magic == config.MAGIC_NUMBER]:
        entry = pos.price_open
        cur = mt5.symbol_info_tick(config.SYMBOL)
        if not cur:
            continue
        cur_price = cur.bid if pos.type == 0 else cur.ask
        profit = (cur_price - entry) if pos.type == 0 else (entry - cur_price)
        if profit > 0:
            req = {
                'action':       mt5.TRADE_ACTION_DEAL,
                'symbol':       config.SYMBOL,
                'volume':       pos.volume,
                'type':         mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY,
                'position':     pos.ticket,
                'price':        cur.bid if pos.type == 0 else cur.ask,
                'magic':        config.MAGIC_NUMBER,
                'comment':      'QFS session guard',
                'type_time':    mt5.ORDER_TIME_GTC,
                'type_filling': mt5.ORDER_FILLING_IOC,
            }
            result = mt5.order_send(req)
            if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                log_event('[{}] SESSION CLOSE GUARD: closed profitable pos @ {:.2f}'.format(
                    config.SYMBOL, cur_price))
                risk_manager.record_trade(pos.profit)
                _tracked_tickets.pop(pos.ticket, None)


def safe_initialize(max_retries=5, wait=10):
    for attempt in range(1, max_retries + 1):
        try:
            initialize()
            config.SYMBOL = resolve_symbol(config.BASE_SYMBOL)
            acc = mt5.account_info()
            print('=' * 55)
            print('  QUICK FLIP SCALPER - GER40')
            print('  Asset       : {}'.format(config.SYMBOL))
            print('  Strategy    : Engulfing reversal off opening range')
            print('  Session     : {:02d}:{:02d}-{:02d}:00 UTC  ({}-{} local)'.format(
                config.SESSION_OPEN_HOUR, config.SESSION_OPEN_MIN,
                config.SESSION_CLOSE_HOUR,
                _local(config.SESSION_OPEN_HOUR, config.SESSION_OPEN_MIN),
                _local(config.SESSION_CLOSE_HOUR)))
            print('  Window      : {} min from open'.format(config.WINDOW_MINUTES))
            print('  RR          : {}:1'.format(config.RR))
            print('  Risk/trade  : {}%'.format(config.RISK_PERCENT))
            print('  Liq range   : {}-{}% of daily ATR'.format(
                int(config.LIQ_PCT_MIN * 100), int(config.LIQ_PCT_MAX * 100)))
            print('  Log file    : events.log')
            if acc:
                print('  Login       : {}'.format(acc.login))
                print('  Server      : {}'.format(acc.server))
                print('  Balance     : ${:,.2f}'.format(acc.balance))
                print('  Equity      : ${:,.2f}'.format(acc.equity))
            print('=' * 55)
            send_status(STRATEGY_NAME, 'ONLINE')
            return True
        except Exception as e:
            print('MT5 attempt {}/{}: {}'.format(attempt, max_retries, e))
            time.sleep(wait)
    return False


def reset_day():
    global today_box, today_date, today_traded, last_scan_candle
    now = datetime.now(timezone.utc).date()
    if today_date == now:
        return
    today_date   = now
    today_box    = None
    today_traded     = False
    last_scan_candle = None
    risk_manager._reset_if_new_day()
    log_event('[{}] New trading day: {}'.format(config.SYMBOL, now))


def try_box_opening_range():
    global today_box
    if today_box is not None:
        return
    now = datetime.now(timezone.utc)
    if now.hour < config.SESSION_OPEN_HOUR:
        return
    if now.hour == config.SESSION_OPEN_HOUR and now.minute < config.SESSION_OPEN_MIN:
        return
    try:
        daily_atr = get_daily_atr(config.SYMBOL, config.ATR_PERIOD)
        df_15m    = get_data(config.SYMBOL, config.TF_15M, bars=50)
        result    = get_opening_range(df_15m, config.SESSION_OPEN_HOUR, config.SESSION_OPEN_MIN)
        if result is None:
            log_event('[{}] Opening range candle not found yet'.format(config.SYMBOL))
            return
        box_high, box_low, open_time = result
        valid, pct = validate_liquidity_candle(box_high, box_low, daily_atr,
                                               config.LIQ_PCT_MIN, config.LIQ_PCT_MAX)
        if not valid:
            log_event('[{}] Box INVALID -- {}% of ATR | threshold: {}-{}% | no trade today'.format(
                config.SYMBOL, pct,
                int(config.LIQ_PCT_MIN * 100), int(config.LIQ_PCT_MAX * 100)))
            today_box = 'invalid'
            return
        today_box = (box_high, box_low, open_time, daily_atr)
        log_event('[{}] Opening box VALID -- {:.1f}-{:.1f} | ATR {:.0f} | Range {}%'.format(
            config.SYMBOL, box_low, box_high, daily_atr, pct))
    except Exception as e:
        log_event('[{}] Box error: {}'.format(config.SYMBOL, e))


def run():
    global today_traded, last_scan_candle
    if not safe_initialize():
        return
    init_log()
    log_event('=' * 50)
    log_event('[{}] Bot started -- QFS GER40 strategy'.format(config.SYMBOL))
    log_event('=' * 50)
    try:
        while True:
            reset_day()
            now = datetime.now(timezone.utc)
            # Weekend check — markets closed Saturday & Sunday
            if now.weekday() >= 5:
                time.sleep(60)
                continue
            if now.hour < config.SESSION_OPEN_HOUR or now.hour >= config.SESSION_CLOSE_HOUR:
                time.sleep(30)
                continue
            update_position_tracking()
            session_close_guard()

            try_box_opening_range()
            try:
                open('heartbeat.txt', 'w').write(str(__import__('time').time()))
            except Exception:
                pass
            if today_box is None:
                log_event('[{}] Waiting for opening range candle...'.format(config.SYMBOL))
                time.sleep(config.CHECK_INTERVAL)
                continue
            if today_box == 'invalid':
                time.sleep(config.CHECK_INTERVAL)
                continue
            # Sync today_traded with MT5 on every cycle — prevents double-entry on restart
            if not today_traded:
                open_pos = mt5.positions_get(symbol=config.SYMBOL) or []
                if any(p.magic == config.MAGIC_NUMBER for p in open_pos):
                    log_event('[{}] Existing position detected on startup — marking today as traded'.format(config.SYMBOL))
                    today_traded = True

            if today_traded:
                log_event('[{}] Already traded today -- waiting for next session'.format(config.SYMBOL))
                time.sleep(60)
                continue
            if not risk_manager.can_trade():
                log_event('[{}] Risk manager blocked -- daily limit reached'.format(config.SYMBOL))
                time.sleep(60)
                continue
            try:
                box_high, box_low, open_time, daily_atr = today_box
                df_5m  = get_data(config.SYMBOL, config.TF_5M, bars=50)
                ct = df_5m.iloc[-1]['time']
                if ct == last_scan_candle:
                    time.sleep(config.CHECK_INTERVAL)
                    continue
                last_scan_candle = ct
                signal = scan_for_signal(df_5m, box_high, box_low, open_time,
                                         config.WINDOW_MINUTES, config.RR)
                if signal:
                    log_event('[{}] SIGNAL -- {} {} | Entry={:.1f} SL={:.1f} TP={:.1f}'.format(
                        config.SYMBOL, signal['pattern'].upper(), signal['type'],
                        signal['entry'], signal['sl'], signal['tp']))
                    sl_dist   = abs(signal['entry'] - signal['sl'])
                    lot       = calculate_lot_size(config.SYMBOL, sl_dist, config.RISK_PERCENT,
                                                   config.MAX_ACTUAL_RISK_PCT, config.RISK_CAP_MODE)
                    if not lot:
                        print(f'[{config.SYMBOL}] Trade skipped — account too small for this SL distance')
                        time.sleep(config.CHECK_INTERVAL)
                        continue
                    direction = signal['type']
                    price     = signal['entry']
                    # Smart order: if price already past signal entry use market order,
                    # otherwise place a pending stop so we only fill on confirmation.
                    tick = mt5.symbol_info_tick(config.SYMBOL)
                    at_market = False
                    if tick:
                        at_market = (tick.ask >= price) if direction == 'BUY' else (tick.bid <= price)
                    if at_market and tick:
                        market_px = tick.ask if direction == 'BUY' else tick.bid
                        req = {
                            'action':       mt5.TRADE_ACTION_DEAL,
                            'symbol':       config.SYMBOL,
                            'volume':       lot,
                            'type':         mt5.ORDER_TYPE_BUY if direction == 'BUY' else mt5.ORDER_TYPE_SELL,
                            'price':        round(market_px, 2),
                            'sl':           round(signal['sl'], 2),
                            'tp':           round(signal['tp'], 2),
                            'magic':        config.MAGIC_NUMBER,
                            'comment':      'QFS GER40',
                            'type_time':    mt5.ORDER_TIME_GTC,
                            'type_filling': mt5.ORDER_FILLING_IOC,
                        }
                        log_event('[{}] Price past entry -- market order @ {:.2f}'.format(config.SYMBOL, market_px))
                    else:
                        req = {
                            'action':       mt5.TRADE_ACTION_PENDING,
                            'symbol':       config.SYMBOL,
                            'volume':       lot,
                            'type':         mt5.ORDER_TYPE_BUY_STOP if direction == 'BUY' else mt5.ORDER_TYPE_SELL_STOP,
                            'price':        round(price, 2),
                            'sl':           round(signal['sl'], 2),
                            'tp':           round(signal['tp'], 2),
                            'magic':        config.MAGIC_NUMBER,
                            'comment':      'QFS GER40',
                            'type_time':    mt5.ORDER_TIME_DAY,
                            'type_filling': mt5.ORDER_FILLING_IOC,
                        }
                    result = mt5.order_send(req)
                    if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                        log_event('[{}] Order placed -- ticket={} lot={}'.format(
                            config.SYMBOL, result.order, lot))
                        risk_manager.record_entry()
                        today_traded = True
                        send_signal(config.SYMBOL, direction, price,
                                    signal['sl'], signal['tp'], STRATEGY_NAME, config.RR)
                    else:
                        log_event('[{}] Order FAILED -- retcode={} comment={}'.format(
                            config.SYMBOL,
                            getattr(result, 'retcode', 'None'),
                            getattr(result, 'comment', 'None')))
                else:
                    log_event('[{}] Scan -- no signal this bar'.format(config.SYMBOL))
            except Exception as e:
                log_event('[{}] Scan error: {}'.format(config.SYMBOL, e))
            time.sleep(config.CHECK_INTERVAL)
    except KeyboardInterrupt:
        log_event('[{}] Bot stopped by user'.format(config.SYMBOL))
    finally:
        send_status(STRATEGY_NAME, 'STOPPED')
        mt5.shutdown()


if __name__ == '__main__':
    run()
