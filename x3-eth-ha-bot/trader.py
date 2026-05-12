import MetaTrader5 as mt5
from config import *
from lot import calculate_lot_size


def get_positions(symbol):
    return mt5.positions_get(symbol=symbol)


def send_order(symbol, order_type, sl, tp=0.0, risk_pct=1.0):
    tick = mt5.symbol_info_tick(symbol)
    info = mt5.symbol_info(symbol)

    if info is not None and info.point > 0:
        spread_pts = (tick.ask - tick.bid) / info.point
        if spread_pts > MAX_SPREAD:
            print(f"Spread too high ({spread_pts:.0f} pts) - skipping")
            return None

    price   = tick.ask if order_type == "BUY" else tick.bid
    sl_dist = abs(price - sl)
    lot     = calculate_lot_size(symbol, sl_dist, risk_pct)

    if lot <= 0:
        print("Lot size zero - skipping")
        return None

    order_type_mt5 = mt5.ORDER_TYPE_BUY if order_type == "BUY" else mt5.ORDER_TYPE_SELL

    request = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       lot,
        "type":         order_type_mt5,
        "price":        price,
        "sl":           sl,
        "tp":           tp,
        "magic":        MAGIC_NUMBER,
        "comment":      "ETH BOT V1",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    print(f"ORDER SENT: {result}")
    return result


def close_position(position):
    symbol = position.symbol
    volume = position.volume
    tick   = mt5.symbol_info_tick(symbol)

    if position.type == 0:
        order_type = mt5.ORDER_TYPE_SELL
        price      = tick.bid
    else:
        order_type = mt5.ORDER_TYPE_BUY
        price      = tick.ask

    request = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       volume,
        "type":         order_type,
        "position":     position.ticket,
        "price":        price,
        "magic":        MAGIC_NUMBER,
        "comment":      "Close ETH BOT V1",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    print(f"CLOSE RESULT: {result}")

    if result.retcode == mt5.TRADE_RETCODE_DONE:
        pass
    else:
        print(f"Close failed: retcode {result.retcode}")

    return result


def modify_sl(position, new_sl):
    request = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "position": position.ticket,
        "sl":       new_sl,
        "tp":       position.tp,
    }
    result = mt5.order_send(request)
    print(f"MODIFY SL -> {new_sl:.2f} | result: {result.retcode}")
    return result
