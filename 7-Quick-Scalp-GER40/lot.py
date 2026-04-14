"""
lot.py — Dynamic Lot Sizing

Calculates lot size so that a full SL hit costs exactly RISK_PERCENT
of the current account balance.

The result is always clamped to the broker's volume_min / volume_max / volume_step.
"""

import MetaTrader5 as mt5


def calculate_lot_size(symbol: str, sl_distance: float, risk_percent: float = 1.0) -> float:
    """
    Returns the lot size for a trade where a full SL hit = risk_percent% of balance.

    Args:
        symbol      : e.g. "GER40.s"
        sl_distance : distance from entry to SL in price units (always positive)
        risk_percent: % of balance to risk (default 1.0)

    Returns:
        Lot size rounded to broker step, or 0.0 on any error.
    """
    if sl_distance <= 0:
        print(f"⚠️  lot.py: invalid SL distance ({sl_distance})")
        return 0.0

    account = mt5.account_info()
    if account is None:
        print(f"⚠️  lot.py: account info unavailable")
        return 0.0

    info = mt5.symbol_info(symbol)
    if info is None:
        print(f"⚠️  lot.py: symbol info unavailable for {symbol}")
        return 0.0

    balance     = account.balance
    risk_amount = balance * (risk_percent / 100.0)

    # pip_value = USD gained/lost per lot per 1-point move
    pip_value = info.trade_contract_size * info.point
    if pip_value <= 0:
        print(f"⚠️  lot.py: pip_value is zero for {symbol}")
        return 0.0

    # Convert SL distance (price units) to points, then to USD risk per lot
    sl_points    = sl_distance / info.point
    risk_per_lot = sl_points * pip_value

    lot = risk_amount / risk_per_lot

    # Clamp to broker limits
    lot = max(info.volume_min, min(lot, info.volume_max))
    lot = round(round(lot / info.volume_step) * info.volume_step, 2)

    print(f"📐 Lot calc: balance=${balance:.2f} | risk={risk_percent}% (${risk_amount:.2f}) "
          f"| sl_pts={sl_points:.0f} | lot={lot}")

    return lot
