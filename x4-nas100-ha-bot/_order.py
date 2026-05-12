import MetaTrader5 as mt5
from lot import calculate_lot_size


def order_with_risk(symbol, direction, sl, tp, risk_pct, magic, spread_lim):
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        print('Symbol info unavailable')
        return None
    spread_pts = (tick.ask - tick.bid) / info.point
    if spread_pts > spread_lim:
        print(f'Spread {spread_pts:.0f} pts > {spread_lim} limit - skipping')
        return None
    price   = tick.ask if direction == 'BUY' else tick.bid
    sl_dist = abs(price - sl)
    lot     = calculate_lot_size(symbol, sl_dist, risk_pct)
    if lot <= 0:
        print('Lot size zero - skipping')
        return None
    order_type = mt5.ORDER_TYPE_BUY if direction == 'BUY' else mt5.ORDER_TYPE_SELL
    req = {
        'action':       mt5.TRADE_ACTION_DEAL,
        'symbol':       symbol,
        'volume':       lot,
        'type':         order_type,
        'price':        price,
        'sl':           sl,
        'tp':           tp,
        'magic':        magic,
        'comment':      'NAS100 BOT V1',
        'type_time':    mt5.ORDER_TIME_GTC,
        'type_filling': mt5.ORDER_FILLING_IOC,
    }
    return mt5.order_send(req)
