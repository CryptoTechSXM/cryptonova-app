import time
import MetaTrader5 as mt5
import config
from data            import get_data, initialize
from strategy        import check_signal
from trader          import get_positions, close_position, modify_sl
from indicators      import atr, heikin_ashi
from logger          import log_trade, init_log
from risk            import DailyRiskManager, is_session_active
from _order          import order_with_risk
from telegram_sender import send_signal, send_close

STRATEGY_NAME = "ETH HA Bot"

def _local(utc_h, utc_m=0):
    from datetime import datetime
    off  = int((datetime.now() - datetime.utcnow()).total_seconds() / 60)
    mins = utc_h * 60 + utc_m + off
    tz   = datetime.now().astimezone().strftime('%Z')
    return f"{(mins // 60) % 24:02d}:{mins % 60:02d} {tz}"

closed_tickets   = set()
last_candle_time = None
last_trade_time  = 0
reversal_counter = {}
risk_manager     = DailyRiskManager(config)


def manage_trade(position, df_m1, df_m5):
    global closed_tickets, reversal_counter
    if position.ticket in closed_tickets:
        return
    df5          = heikin_ashi(df_m5)
    df5['atr']   = atr(df5, config.ATR_PERIOD)
    cur_atr      = df5.iloc[-1]['atr']
    cur_price    = df_m1.iloc[-1]['close']
    entry        = position.price_open
    tick         = mt5.symbol_info_tick(config.SYMBOL)
    spread       = tick.ask - tick.bid
    ticket       = position.ticket
    if position.type == 0:
        be = entry + spread
        if (cur_price - entry) > cur_atr and position.sl < be:
            print(f'[{config.SYMBOL}] Break-even BUY {be:.2f}')
            modify_sl(position, be)
        new_sl = cur_price - cur_atr * config.TRAILING_ATR_MULTIPLIER
        if new_sl > position.sl:
            modify_sl(position, new_sl)
    if position.type == 1:
        be = entry - spread
        if (entry - cur_price) > cur_atr and position.sl > be:
            print(f'[{config.SYMBOL}] Break-even SELL {be:.2f}')
            modify_sl(position, be)
        new_sl = cur_price + cur_atr * config.TRAILING_ATR_MULTIPLIER
        if new_sl < position.sl:
            modify_sl(position, new_sl)
    last5 = df5.iloc[-1]
    if ticket not in reversal_counter:
        reversal_counter[ticket] = 0
    if position.type == 0:
        if last5['ha_close'] < last5['ha_open']:
            reversal_counter[ticket] += 1
        else:
            reversal_counter[ticket] = 0
        if reversal_counter[ticket] >= config.REVERSAL_CANDLES_REQUIRED:
            _close_and_log(position, 'BUY', entry, cur_price)
    if position.type == 1:
        if last5['ha_close'] > last5['ha_open']:
            reversal_counter[ticket] += 1
        else:
            reversal_counter[ticket] = 0
        if reversal_counter[ticket] >= config.REVERSAL_CANDLES_REQUIRED:
            _close_and_log(position, 'SELL', entry, cur_price)


def _close_and_log(position, direction, entry, cur_price):
    profit_usd = position.profit
    print(f'[{config.SYMBOL}] Closing {direction} -- reversal confirmed')
    close_position(position)
    diff = (cur_price - entry) if direction == 'BUY' else (entry - cur_price)
    log_trade(direction, entry, position.sl, cur_price, diff)
    risk_manager.record_trade(profit_usd)
    closed_tickets.add(position.ticket)
    reversal_counter.pop(position.ticket, None)
    sl_dist  = abs(entry - position.sl)
    result_r = diff / sl_dist if sl_dist > 0 else 0
    send_close(config.SYMBOL, direction, entry, cur_price, result_r, STRATEGY_NAME)


def safe_initialize(max_retries=5, wait=10):
    for attempt in range(1, max_retries + 1):
        try:
            initialize()
            acc = mt5.account_info()
            print('=' * 55)
            print('  MT5 connected')
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


def run():
    global last_candle_time, last_trade_time
    print('=' * 55)
    print('  ETH HA BOT V1')
    print(f'  Asset       : {config.SYMBOL}')
    print(f'  Session     : {config.SESSION_START_UTC:02d}:00–{config.SESSION_END_UTC:02d}:00 UTC  ({_local(config.SESSION_START_UTC)}–{_local(config.SESSION_END_UTC)} local)')
    print(f'  Risk/trade  : {config.RISK_PERCENT}% of balance')
    print(f'  Daily limit : {config.MAX_DAILY_TRADES} trades | -{config.MAX_DAILY_LOSS_PCT}% loss')
    print(f'  Max spread  : {config.MAX_SPREAD} pts')
    print(f'  Min ATR     : {config.MIN_ATR}')
    print(f'  SL / TP     : {config.ATR_MULTIPLIER}x / {config.TP_ATR_MULTIPLIER}x ATR')
    print('=' * 55)
    if not safe_initialize():
        return
    init_log()
    consecutive_errors = 0
    try:
        while True:
            try:
                df_m1 = get_data(config.SYMBOL, config.TIMEFRAMES['M1'])
                df_m5 = get_data(config.SYMBOL, config.TIMEFRAMES['M5'])
                df_h1 = get_data(config.SYMBOL, config.TIMEFRAMES['H1'])
                consecutive_errors = 0
                ct = df_m1.iloc[-1]['time']
                if last_candle_time == ct:
                    time.sleep(config.CHECK_INTERVAL)
                    continue
                last_candle_time = ct
                print(f'[{config.SYMBOL}] New M1 candle: {ct}')
                positions = get_positions(config.SYMBOL)
                if positions:
                    for pos in positions:
                        manage_trade(pos, df_m1, df_m5)
                else:
                    if not is_session_active(config):
                        time.sleep(config.CHECK_INTERVAL)
                        continue
                    if not risk_manager.can_trade():
                        time.sleep(config.CHECK_INTERVAL)
                        continue
                    elapsed = time.time() - last_trade_time
                    if elapsed < config.TRADE_COOLDOWN:
                        remaining = int(config.TRADE_COOLDOWN - elapsed)
                        print(f'[{config.SYMBOL}] Cooldown {remaining}s')
                        time.sleep(config.CHECK_INTERVAL)
                        continue
                    closed_tickets.clear()
                    reversal_counter.clear()
                    signal = check_signal(df_m1, df_m5, df_h1, config)
                    if signal:
                        print(f"[{config.SYMBOL}] SIGNAL: {signal['type']} SL={signal['sl']:.2f}")
                        result = order_with_risk(
                            config.SYMBOL, signal['type'],
                            signal['sl'], signal['tp'],
                            config.RISK_PERCENT,
                            config.MAGIC_NUMBER, config.MAX_SPREAD
                        )
                        if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                            print(f'[{config.SYMBOL}] Order filled: {result.price}')
                            last_trade_time = time.time()
                            risk_manager.record_entry()
                            rr = config.TP_ATR_MULTIPLIER / config.ATR_MULTIPLIER
                            send_signal(config.SYMBOL, signal['type'], result.price,
                                        signal['sl'], signal['tp'], STRATEGY_NAME, rr)
                        else:
                            print(f'[{config.SYMBOL}] Not filled: {result}')
                    else:
                        print(f'[{config.SYMBOL}] No signal this candle')
            except Exception as e:
                consecutive_errors += 1
                print(f'[{config.SYMBOL}] Error ({consecutive_errors}): {e}')
                if consecutive_errors >= 3:
                    if not safe_initialize():
                        break
                    consecutive_errors = 0
            time.sleep(config.CHECK_INTERVAL)
    except KeyboardInterrupt:
        print('Bot stopped')


if __name__ == '__main__':
    run()
