import time
from datetime import datetime
import MetaTrader5 as mt5
import config
from data            import initialize, get_data, get_daily_atr
from strategy        import get_opening_range, validate_liquidity_candle, scan_for_signal
from lot             import calculate_lot_size
from risk            import DailyRiskManager
from logger          import log_trade, init_log
from telegram_sender import send_signal

STRATEGY_NAME = "QFS XAUUSD"

risk_manager = DailyRiskManager(config)

def _local(utc_h, utc_m=0):
    from datetime import datetime
    off  = int((datetime.now() - datetime.utcnow()).total_seconds() / 60)
    mins = utc_h * 60 + utc_m + off
    tz   = datetime.now().astimezone().strftime('%Z')
    return f"{(mins // 60) % 24:02d}:{mins % 60:02d} {tz}"

# State for the current trading day
today_box      = None   # (box_high, box_low, open_time, daily_atr) or None
today_date     = None
today_traded   = False  # one trade per day max


def safe_initialize(max_retries=5, wait=10):
    for attempt in range(1, max_retries + 1):
        try:
            initialize()
            acc = mt5.account_info()
            print('=' * 55)
            print('  QUICK FLIP SCALPER - XAUUSD (Gold)')
            print(f'  Asset       : {config.SYMBOL}')
            print(f'  Strategy    : Engulfing reversal off opening range')
            print(f'  Session     : {config.SESSION_OPEN_HOUR:02d}:{config.SESSION_OPEN_MIN:02d}–{config.SESSION_CLOSE_HOUR:02d}:00 UTC  ({_local(config.SESSION_OPEN_HOUR, config.SESSION_OPEN_MIN)}–{_local(config.SESSION_CLOSE_HOUR)} local)')
            print(f'  Window      : {config.WINDOW_MINUTES} min from open')
            print(f'  RR          : {config.RR}:1')
            print(f'  Risk/trade  : {config.RISK_PERCENT}%')
            print(f'  Liq range   : {int(config.LIQ_PCT_MIN*100)}-{int(config.LIQ_PCT_MAX*100)}% of daily ATR')
            if acc:
                print(f'     Login   : {acc.login}')
                print(f'     Server  : {acc.server}')
                print(f'     Balance : ${acc.balance:,.2f}')
                print(f'     Equity  : ${acc.equity:,.2f}')
            print('=' * 55)
            return True
        except Exception as e:
            print(f'MT5 attempt {attempt}/{max_retries}: {e}')
            time.sleep(wait)
    return False


def reset_day():
    global today_box, today_date, today_traded
    now = datetime.utcnow().date()
    if today_date == now:
        return
    today_date   = now
    today_box    = None
    today_traded = False
    risk_manager._reset_if_new_day()
    print(f'[{config.SYMBOL}] New trading day: {now}')


def try_box_opening_range():
    global today_box
    if today_box is not None:
        return
    now = datetime.utcnow()
    if now.hour < config.SESSION_OPEN_HOUR:
        return
    if now.hour == config.SESSION_OPEN_HOUR and now.minute < config.SESSION_OPEN_MIN:
        return
    try:
        daily_atr = get_daily_atr(config.SYMBOL, config.ATR_PERIOD)
        df_15m    = get_data(config.SYMBOL, config.TF_15M, bars=20)
        result    = get_opening_range(df_15m, config.SESSION_OPEN_HOUR, config.SESSION_OPEN_MIN)
        if result is None:
            return
        box_high, box_low, open_time = result
        valid, pct = validate_liquidity_candle(box_high, box_low, daily_atr,
                                               config.LIQ_PCT_MIN, config.LIQ_PCT_MAX)
        if not valid:
            print(f'[{config.SYMBOL}] Box {pct:.0f}% of ATR - outside 22-38% range, no trade today')
            today_box = 'invalid'
            return
        today_box = (box_high, box_low, open_time, daily_atr)
        print(f'[{config.SYMBOL}] Opening box: {box_low:.2f} - {box_high:.2f} | ATR {daily_atr:.2f} | Range {pct:.0f}%')
    except Exception as e:
        print(f'[{config.SYMBOL}] Box error: {e}')


def run():
    global today_traded
    if not safe_initialize():
        return
    init_log()
    print(f'[{config.SYMBOL}] Bot running...')
    try:
        while True:
            reset_day()
            now = datetime.utcnow()
            # Outside session hours
            if now.hour < config.SESSION_OPEN_HOUR or now.hour >= config.SESSION_CLOSE_HOUR:
                time.sleep(30)
                continue
            # Box not yet set
            try_box_opening_range()
            if today_box is None or today_box == 'invalid':
                time.sleep(config.CHECK_INTERVAL)
                continue
            # Already traded today
            if today_traded or not risk_manager.can_trade():
                time.sleep(config.CHECK_INTERVAL)
                continue
            # Scan for signal
            try:
                box_high, box_low, open_time, daily_atr = today_box
                df_5m = get_data(config.SYMBOL, config.TF_5M, bars=50)
                signal = scan_for_signal(df_5m, box_high, box_low, open_time,
                                         config.WINDOW_MINUTES, config.RR)
                if signal:
                    print(f'[{config.SYMBOL}] {signal["pattern"].upper()} {signal["type"]} | '
                          f'Entry={signal["entry"]:.2f} SL={signal["sl"]:.2f} TP={signal["tp"]:.2f}')
                    sl_dist = abs(signal['entry'] - signal['sl'])
                    lot = calculate_lot_size(config.SYMBOL, sl_dist, config.RISK_PERCENT)
                    direction = signal['type']
                    price = signal['entry']
                    req = {
                        'action':       mt5.TRADE_ACTION_PENDING,
                        'symbol':       config.SYMBOL,
                        'volume':       lot,
                        'type':         mt5.ORDER_TYPE_BUY_STOP if direction == 'BUY' else mt5.ORDER_TYPE_SELL_STOP,
                        'price':        round(price, 2),
                        'sl':           round(signal['sl'], 2),
                        'tp':           round(signal['tp'], 2),
                        'magic':        config.MAGIC_NUMBER,
                        'comment':      'QFS XAUUSD',
                        'type_time':    mt5.ORDER_TIME_DAY,
                        'type_filling': mt5.ORDER_FILLING_IOC,
                    }
                    result = mt5.order_send(req)
                    if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                        print(f'[{config.SYMBOL}] Order placed: ticket={result.order}')
                        risk_manager.record_entry()
                        today_traded = True
                        send_signal(config.SYMBOL, direction, price,
                                    signal['sl'], signal['tp'], STRATEGY_NAME, config.RR)
                    else:
                        print(f'[{config.SYMBOL}] Order failed: {result}')
            except Exception as e:
                print(f'[{config.SYMBOL}] Scan error: {e}')
            time.sleep(config.CHECK_INTERVAL)
    except KeyboardInterrupt:
        print(f'[{config.SYMBOL}] Bot stopped')
    finally:
        mt5.shutdown()


if __name__ == '__main__':
    run()
