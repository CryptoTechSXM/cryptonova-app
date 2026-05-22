# =============================================================
# LOT SIZING
# =============================================================
# This module answers: "how many lots should I trade?"
#
# Two modes:
#   fixed  → always use the same lot size (e.g. 0.01)
#   risk   → calculate the right lot so that if the SL is hit,
#            you lose exactly risk_percent% of your balance
#
# For a $1,000 account at 1% risk:
#   Max loss per trade = $10
#   If SL distance = $3.00 on Gold (1 lot = $100/point):
#   Lot = $10 / ($3.00 × 100) = 0.03 lots
# =============================================================

import MetaTrader5 as mt5
from bot.logger import log


def calculate_lot_size(symbol: str, sl_distance: float, cfg: dict) -> float:

    # --- FIXED MODE ---
    if cfg.get("lot_mode", "fixed") == "fixed":
        return cfg.get("lot_size", 0.01)

    # --- RISK MODE ---
    risk_percent = cfg.get("risk_percent", 1.0)

    account = mt5.account_info()
    if account is None:
        log(f"{symbol}: account info unavailable ❌")
        return 0.0

    if sl_distance <= 0:
        log(f"{symbol}: invalid SL distance ({sl_distance}) ❌")
        return 0.0

    balance = account.balance
    risk_amount = balance * (risk_percent / 100)

    info = mt5.symbol_info(symbol)
    if info is None:
        log(f"{symbol}: symbol info unavailable ❌")
        return 0.0

    # pip_value = how much 1 lot moves in $ per 1 point move
    pip_value = info.trade_contract_size * info.point

    if pip_value <= 0:
        log(f"{symbol}: pip_value is zero ❌")
        return 0.0

    # sl_distance is in price units → convert to points
    sl_points = sl_distance / info.point

    # lot = risk_amount / (sl_points * pip_value)
    lot = risk_amount / (sl_points * pip_value)

    # Clamp to broker's min/max/step
    lot = max(info.volume_min, min(lot, info.volume_max))
    lot = round(round(lot / info.volume_step) * info.volume_step, 2)

    log(f"{symbol}: lot={lot} | balance={balance:.2f} | risk=${risk_amount:.2f} | sl_pts={sl_points:.1f}")

    return lot
