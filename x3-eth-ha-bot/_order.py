import MetaTrader5 as mt5
from lot import calculate_lot_size


def order_with_risk(symbol, direction, sl, tp, risk_pct, magic, spread_lim):
    tick = mt5.symbol_info_tick(symbol)
    info = mt5.symbol_info(symbol)
    if info and info.point > 0:
        sp = (tick.ask - tick.bid) / info.point
        if sp > spread_lim:
            print(f'Spread {sp:.0f} pts > {spread_lim} -- skipping')
            return None
    price = tick.ask if direction == 'BUY' else tick.bid
    dist  = abs(price - sl)
    lot   = calculate_lot_size(symbol, dist, risk_pct)
    if lot <= 0:
        print('Lot zero -- skipping')
        return None
    ot  = mt5.ORDER_TYPE_BUY if direction == 'BUY' else mt5.ORDER_TYPE_SELL
    req = {
        'action':       mt5.TRADE_ACTION_DEAL,
        'symbol':       symbol,
        'volume':       lot,
        'type':         ot,
        'price':        price,
        'sl':           sl,
        'tp':           tp,
        'magic':        magic,
        'type_time':    mt5.ORDER_TIME_GTC,
        'type_filling': mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    print(f'ORDER: {result}')
    return result
