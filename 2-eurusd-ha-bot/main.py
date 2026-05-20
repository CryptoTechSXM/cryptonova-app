import os
import time
import MetaTrader5 as mt5
import config
from data            import get_data, initialize
from strategy        import check_signal
from trader          import get_positions, close_position, modify_sl
from indicators      import atr, heikin_ashi
from logger          import log_trade, init_log, log_event
from risk            import DailyRiskManager, is_session_active
from _order          import order_with_risk
from telegram_sender import send_signal, send_close, send_adoption, send_status
from resolver          import resolve_symbol

STRATEGY_NAME = "EURUSD HA Bot"
SILENT        = os.getenv("SILENT_MODE", "false").lower() == "true"

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
_orig_sl         = {}
_adopted_tickets = set()  # tickets adopted from manual trades


def adopt_manual_trades(df_m5):
    """Detect manually opened positions, apply ATR-based SL if missing, hand off to manage_trade()."""
    positions = mt5.positions_get(symbol=config.SYMBOL)
    if not positions:
        return
    for pos in positions:
        # Only adopt genuine manual trades (magic == 0).
        # Non-zero magic = opened by another bot — leave it alone.
        if pos.magic != 0:
            continue
        if pos.ticket in _adopted_tickets:
            continue
        df5        = heikin_ashi(df_m5.copy())
        df5['atr'] = atr(df5, config.ATR_PERIOD)
        cur_atr    = df5['atr'].iloc[-1]
        if not (cur_atr > 0):
            print('[{}] ADOPTER: #{} ATR unavailable — skipped'.format(config.SYMBOL, pos.ticket))
            _adopted_tickets.add(pos.ticket)
            continue
        entry     = pos.price_open
        direction = 'BUY' if pos.type == 0 else 'SELL'
        sl_dist   = cur_atr * config.ATR_MULTIPLIER
        new_sl    = (entry - sl_dist) if direction == 'BUY' else (entry + sl_dist)
        existing  = pos.sl
        needs_sl  = (existing == 0
                     or (direction == 'BUY'  and existing < new_sl)
                     or (direction == 'SELL' and existing > new_sl))
        sl_to_set = new_sl if needs_sl else existing
        req = {
            "action":   mt5.TRADE_ACTION_SLTP,
            "position": pos.ticket,
            "sl":       sl_to_set,
            "tp":       pos.tp,
        }
        result = mt5.order_send(req)
        if result and result.retcode == mt5.TRADE_RETCODE_DONE:
            print('[{}] ADOPTED #{} {} @ {:.5f} SL={:.5f} ATR={:.5f}'.format(
                config.SYMBOL, pos.ticket, direction, entry, sl_to_set, cur_atr))
            send_adoption(config.SYMBOL, direction, entry, sl_to_set, STRATEGY_NAME)
        else:
            retcode = result.retcode if result else 'None'
            print('[{}] ADOPT FAILED #{} retcode={}'.format(config.SYMBOL, pos.ticket, retcode))
        _adopted_tickets.add(pos.ticket)


def _modify_sl_remove_tp(position, new_sl):
    """Trail the SL. Only remove the TP once the trail SL has crossed entry (true BE+).
    Before that, keep the TP so a fast move to target still banks the full profit."""
    entry = position.price_open
    sl_past_entry = (new_sl > entry) if position.type == 0 else (new_sl < entry and new_sl > 0)
    new_tp = 0.0 if sl_past_entry else position.tp  # keep TP until we're truly protected
    req = {"action": mt5.TRADE_ACTION_SLTP, "position": position.ticket, "sl": new_sl, "tp": new_tp}
    result = mt5.order_send(req)
    tp_label = 'TP_REMOVED' if sl_past_entry else f'TP_KEPT={new_tp:.5f}'
    print(f'TRAIL+{tp_label} → SL={new_sl:.5f} | retcode={result.retcode}')
    return result


def manage_trade(position, df_m1, df_m5):
    global closed_tickets, reversal_counter, _orig_sl
    if position.ticket in closed_tickets:
        return
    df5        = heikin_ashi(df_m5)
    df5['atr'] = atr(df5, config.ATR_PERIOD)
    cur_atr    = df5.iloc[-1]['atr']
    cur_price  = df_m1.iloc[-1]['close']
    entry      = position.price_open
    ticket     = position.ticket

    trig_mult    = getattr(config, 'TRAIL_ATR_TRIGGER', 0.30)
    buf_mult     = getattr(config, 'TRAIL_ATR_BUFFER',  0.25)
    be_buf       = getattr(config, 'BE_BUFFER_PTS',     0.0005)
    trigger_dist = cur_atr * trig_mult
    buffer_dist  = cur_atr * buf_mult
    profit = (cur_price - entry) if position.type == 0 else (entry - cur_price)

    if profit >= trigger_dist > 0:
        if position.type == 0:
            new_sl = max(entry + be_buf, cur_price - buffer_dist)
            if new_sl > position.sl:
                _modify_sl_remove_tp(position, new_sl)
        else:
            new_sl = min(entry - be_buf, cur_price + buffer_dist)
            if position.sl == 0 or new_sl < position.sl:
                _modify_sl_remove_tp(position, new_sl)
    # Reversal exit: only fire during active session hours.
    # Asia session noise (00:00-07:00 UTC) was tripping the counter and closing
    # valid London/NY trades before they could develop the next session.
    from risk import is_session_active
    if not is_session_active(config):
        reversal_counter[ticket] = 0   # reset counter — off-hours candles don't count
        return

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
    log_event(f'[{config.SYMBOL}] Closing {direction} -- reversal confirmed')
    close_position(position)
    log_trade(config.SYMBOL, direction, entry, position.sl, position.tp,
              cur_price, position.volume, profit_usd)
    risk_manager.record_trade(profit_usd)
    closed_tickets.add(position.ticket)
    reversal_counter.pop(position.ticket, None)
    diff     = (cur_price - entry) if direction == 'BUY' else (entry - cur_price)
    sl_dist  = abs(entry - position.sl)
    result_r = diff / sl_dist if sl_dist > 0 else 0
    send_close(config.SYMBOL, direction, entry, cur_price, result_r, STRATEGY_NAME)



_tracked_positions = {}   # ticket → {direction, entry, sl} for broker-close detection


def track_open_positions(positions):
    """Record current open positions so we can detect broker-side closes next loop."""
    global _tracked_positions
    current_tickets = {p.ticket for p in (positions or [])}
    # Detect tickets that were open last tick but are gone now (SL/TP/broker close)
    vanished = {t: info for t, info in _tracked_positions.items() if t not in current_tickets}
    for ticket, info in vanished.items():
        if ticket in closed_tickets:
            # Already handled by reversal logic — skip
            del _tracked_positions[ticket]
            continue
        # Pull the deal from MT5 history to find exit price and profit
        from datetime import datetime, timezone, timedelta
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        deals = mt5.history_deals_get(since, datetime.now(timezone.utc))
        exit_price = None
        profit_usd = 0.0
        if deals:
            closing = [d for d in deals if d.position_id == ticket and d.entry in (1, 3)]
            if closing:
                best = max(closing, key=lambda d: d.time)
                exit_price = best.price
                profit_usd = best.profit
        direction = info['direction']
        entry     = info['entry']
        sl        = info['sl']
        if exit_price is None:
            log_event(f'[{config.SYMBOL}] BROKER-CLOSE #{ticket} {direction} — no deal found in history')
        else:
            diff = (exit_price - entry) if direction == 'BUY' else (entry - exit_price)
            sl_dist = abs(entry - sl) if sl and sl != entry else 0
            result_r = diff / sl_dist if sl_dist > 0 else 0
            tag = 'TP' if profit_usd > 0.01 else ('SL' if profit_usd < -0.01 else 'BE')
            log_event(f'[{config.SYMBOL}] BROKER-CLOSE #{ticket} {direction} {tag} '
                  f'entry={entry:.5f} exit={exit_price:.5f} P&L={profit_usd:+.2f} ({result_r:+.2f}R)')
            log_trade(config.SYMBOL, direction, entry, sl, info.get('tp', 0),
                      exit_price, info.get('lot', 0), profit_usd,
                      info.get('open_time'))
            risk_manager.record_trade(profit_usd)
            send_close(config.SYMBOL, direction, entry, exit_price, result_r, STRATEGY_NAME)
        closed_tickets.add(ticket)
    # Update tracking: add new positions, remove gone ones
    _tracked_positions = {
        p.ticket: {
            'direction': 'BUY' if p.type == 0 else 'SELL',
            'entry':     p.price_open,
            'sl':        p.sl,
            'tp':        p.tp,
            'lot':       p.volume,
            'open_time': datetime.fromtimestamp(p.time) if p.time else None,
        }
        for p in (positions or [])
    }


_session_guard_fired = set()   # dates already acted on


def session_close_guard():
    """At SESSION_END_UTC close ALL open positions — EURUSD is a day-trading strategy.
    No overnight holds: Asia session noise was triggering false reversal exits at 03:00 UTC,
    closing positions that were opened during London/NY before they could develop.
    Closing at session end is cleaner than risking a 3am reversal-counter chop-out."""
    from datetime import datetime, timezone, date
    now = datetime.now(timezone.utc)
    if now.hour != config.SESSION_END_UTC:
        return
    today = date.today()
    if today in _session_guard_fired:
        return
    _session_guard_fired.add(today)
    positions = get_positions(config.SYMBOL)
    if not positions:
        return
    for pos in positions:
        entry = pos.price_open
        cur   = mt5.symbol_info_tick(config.SYMBOL)
        if not cur:
            continue
        cur_price = cur.bid if pos.type == 0 else cur.ask
        direction = 'BUY' if pos.type == 0 else 'SELL'
        print('[{}] SESSION CLOSE GUARD: closing {} #{} @ {:.5f} (no overnight holds)'.format(
            config.SYMBOL, direction, pos.ticket, cur_price))
        close_position(pos)
        risk_manager.record_trade(pos.profit)
        closed_tickets.add(pos.ticket)
        diff = (cur_price - entry) if direction == 'BUY' else (entry - cur_price)
        sl_dist = abs(entry - pos.sl) if pos.sl and pos.sl != entry else 0
        result_r = diff / sl_dist if sl_dist > 0 else 0
        send_close(config.SYMBOL, direction, entry, cur_price, result_r, STRATEGY_NAME)


def safe_initialize(max_retries=5, wait=10):
    for attempt in range(1, max_retries + 1):
        try:
            initialize()
            config.SYMBOL = resolve_symbol(config.BASE_SYMBOL)
            acc = mt5.account_info()
            max_atr    = getattr(config, 'MAX_ATR', 'n/a')
            buf        = getattr(config, 'SESSION_CLOSE_BUFFER', 30)
            cooldown   = getattr(config, 'TRADE_COOLDOWN', 300)
            max_trades = getattr(config, 'MAX_DAILY_TRADES', 3)
            print('=' * 55)
            print('  EURUSD HA Bot')
            print(f'  Asset       : {config.SYMBOL}')
            print('  Session     : {:02d}:00-{:02d}:00 UTC  ({} - {} local)'.format(
                config.SESSION_START_UTC, config.SESSION_END_UTC,
                _local(config.SESSION_START_UTC), _local(config.SESSION_END_UTC)))
            print(f'  Risk/trade  : {config.RISK_PERCENT}% | Max DD: {config.MAX_DAILY_LOSS_PCT}%')
            print(f'  Daily limit : {max_trades} trades | cooldown {cooldown}s')
            print(f'  Max spread  : {config.MAX_SPREAD} pts')
            print(f'  ATR filter  : {config.MIN_ATR} < ATR < {max_atr} pts')
            print(f'  Session buf : {buf}min before session close')
            print('  Trail       : {:.0%} ATR trigger | {:.0%} ATR buffer | TP kept until SL>entry'.format(
                config.TRAIL_ATR_TRIGGER, config.TRAIL_ATR_BUFFER))
            if acc:
                print(f'     Login   : {acc.login}')
                print(f'     Server  : {acc.server}')
                print(f'     Balance : ${acc.balance:,.2f}')
                print(f'     Equity  : ${acc.equity:,.2f}')
            print('=' * 55)
            send_status('EURUSD HA Bot', 'ONLINE')
            return True
        except Exception as e:
            print(f'MT5 attempt {attempt}/{max_retries}: {e}')
            time.sleep(wait)
    return False


def run():
    global last_candle_time, last_trade_time
    if not safe_initialize():
        return
    init_log()
    consecutive_errors = 0
    try:
        while True:
            try:
                # Weekend check — broker CFD markets closed Saturday & Sunday
                from datetime import datetime, timezone as _tz
                if datetime.now(_tz.utc).weekday() >= 5:
                    import time as _t; _t.sleep(60); continue
                df_m1 = get_data(config.SYMBOL, config.TIMEFRAMES['M1'])
                df_m5 = get_data(config.SYMBOL, config.TIMEFRAMES['M5'])
                df_h1 = get_data(config.SYMBOL, config.TIMEFRAMES['H1'])
                consecutive_errors = 0
                ct = df_m1.iloc[-1]['time']
                if last_candle_time == ct:
                    time.sleep(config.CHECK_INTERVAL)
                    continue
                last_candle_time = ct
                if not SILENT: log_event(f'[{config.SYMBOL}] New M1 candle: {ct}')

                signal = check_signal(df_m1, df_m5, df_h1, config)

                if signal:
                    entry_price = df_m1.iloc[-1]['close']
                    print(f"[{config.SYMBOL}] SIGNAL: {signal['type']} "
                          f"Entry~{entry_price:.5f} SL={signal['sl']:.5f} TP={signal['tp']:.5f}")

                adopt_manual_trades(df_m5)
                session_close_guard()
                try:
                    open('heartbeat.txt', 'w').write(str(__import__('time').time()))
                except Exception:
                    pass

                positions = get_positions(config.SYMBOL)
                track_open_positions(positions)   # detect broker-closed (SL/TP) and log them

                if positions:
                    for pos in positions:
                        manage_trade(pos, df_m1, df_m5)

                if not positions and signal:
                    if not is_session_active(config):
                        pass
                    elif not risk_manager.can_trade():
                        pass
                    else:
                        elapsed = time.time() - last_trade_time
                        if elapsed < config.TRADE_COOLDOWN:
                            if not SILENT:
                                log_event(f'[{config.SYMBOL}] Cooldown -- no execution')
                        else:
                            closed_tickets.clear()
                            reversal_counter.clear()
                            result = order_with_risk(
                                config.SYMBOL, signal['type'],
                                signal['sl'], signal['tp'],
                                config.RISK_PERCENT,
                                config.MAGIC_NUMBER, config.MAX_SPREAD
                            )
                            if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                                log_event(f'[{config.SYMBOL}] Order filled: {result.price}')
                                last_trade_time = time.time()
                                risk_manager.record_entry()
                                send_signal(config.SYMBOL, signal['type'], result.price,
                                            signal['sl'], signal['tp'], STRATEGY_NAME, 1.0)
                            else:
                                log_event(f'[{config.SYMBOL}] Not filled: {result}')
                elif not positions and not signal:
                    if not SILENT:
                        log_event(f'[{config.SYMBOL}] No signal this candle')

            except Exception as e:
                consecutive_errors += 1
                print('[{}] Error ({}): {}'.format(config.SYMBOL, consecutive_errors, e))
                if consecutive_errors >= 3:
                    if not safe_initialize():
                        break
                    consecutive_errors = 0
            time.sleep(config.CHECK_INTERVAL)
    except KeyboardInterrupt:
        print('Bot stopped')
    finally:
        send_status('EURUSD HA Bot', 'STOPPED')
        mt5.shutdown()


if __name__ == '__main__':
    import time as _time
    restart_count = 0
    while True:
        try:
            run()
            print('[RESTART] Bot exited cleanly — restarting in 30s...')
        except KeyboardInterrupt:
            print('[RESTART] Shutdown requested (Ctrl+C).')
            break
        except Exception as exc:
            print('[RESTART] Bot crashed: {} — restarting in 30s...'.format(exc))
        restart_count += 1
        print('[RESTART] Attempt #{} in 30 seconds...'.format(restart_count))
        try:
            _time.sleep(30)
        except KeyboardInterrupt:
            print('[RESTART] Shutdown during restart wait — stopping.')
            break
