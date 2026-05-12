"""
lot.py - Dynamic Lot Sizing with Balance-Tier Scaling
Same logic as all other CryptoNite bots.
"""
import MetaTrader5 as mt5


def _balance_scale_factor(balance):
    if balance < 500:   return 0.10
    elif balance < 1000: return 0.25
    elif balance < 2000: return 0.50
    elif balance < 5000: return 0.75
    else:                return 1.00


def calculate_lot_size(symbol, sl_distance, risk_percent=1.0,
                       max_actual_risk_pct=3.0, risk_cap_mode="warn"):
    if sl_distance <= 0:
        print("lot.py: invalid SL distance")
        return 0.0

    account = mt5.account_info()
    if account is None:
        print("lot.py: no account info")
        return 0.0

    info = mt5.symbol_info(symbol)
    if info is None:
        print("lot.py: no symbol info for {}".format(symbol))
        return 0.0

    balance    = account.balance
    risk_amount = balance * (risk_percent / 100.0)
    pip_value  = info.trade_contract_size * info.point
    if pip_value <= 0:
        return 0.0

    sl_points    = sl_distance / info.point
    risk_per_lot = sl_points * pip_value
    ideal_lot    = risk_amount / risk_per_lot

    scale      = _balance_scale_factor(balance)
    scaled_lot = ideal_lot * scale

    step = info.volume_step if info.volume_step > 0 else 0.01
    lot  = round(round(scaled_lot / step) * step, 10)
    if lot <= 0:
        lot = step
    lot = min(lot, info.volume_max)
    lot = round(lot, 8)

    actual_risk_usd = risk_per_lot * lot
    actual_risk_pct = (actual_risk_usd / balance) * 100.0
    tier = "x{:.0f}".format(1.0 / scale) if scale < 1.0 else "full"

    print("Lot: balance=${:.2f} [{}] ideal={:.4f} scaled={:.4f} lot={} actual_risk={:.1f}%".format(
        balance, tier, ideal_lot, scaled_lot, lot, actual_risk_pct))

    if actual_risk_pct > max_actual_risk_pct:
        if risk_cap_mode == "block":
            print("TRADE SKIPPED: actual risk {:.1f}% > cap".format(actual_risk_pct))
            return 0.0
        else:
            print("RISK WARNING: actual risk {:.1f}% > cap -- trading anyway".format(actual_risk_pct))

    return lot
