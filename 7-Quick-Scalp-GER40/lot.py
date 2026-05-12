"""
lot.py - Dynamic Lot Sizing with Balance-Tier Scaling

Calculates lot size so that a full SL hit costs exactly RISK_PERCENT
of the current account balance.

Balance-tier scaling:
  Small accounts trade proportionally smaller positions so signals still
  fire and data is collected, rather than being blocked by broker minimum lots.
  Tiers (applied BEFORE broker-minimum clamping):
      $0    - $499  : 0.10x  (10x smaller than full size)
      $500  - $999  : 0.25x  (4x smaller)
      $1000 - $1999 : 0.50x  (2x smaller)
      $2000 - $4999 : 0.75x  (1.33x smaller)
      $5000+        : 1.00x  (full calculated size)

  After scaling the lot is rounded to broker volume_step.  The volume_min
  floor is intentionally NOT enforced — some brokers (confirmed for stock CFDs)
  accept sub-minimum volumes.  If the broker rejects the order the retcode is
  logged as normal.

Safety cap: when actual dollar risk at the final lot exceeds MAX_ACTUAL_RISK_PCT%
of balance, behaviour depends on RISK_CAP_MODE:
  "warn"  -- log a warning but still place the trade
  "block" -- skip the trade entirely (returns 0.0)
"""

import MetaTrader5 as mt5


def _balance_scale_factor(balance):
    """Return a lot-size multiplier based on account balance tier."""
    if balance < 500:
        return 0.10   # 10x smaller — micro accounts
    elif balance < 1000:
        return 0.25   # 4x smaller
    elif balance < 2000:
        return 0.50   # 2x smaller
    elif balance < 5000:
        return 0.75   # 1.33x smaller
    else:
        return 1.00   # full size


def calculate_lot_size(symbol, sl_distance, risk_percent=1.0,
                       max_actual_risk_pct=3.0, risk_cap_mode="warn"):
    """
    Returns the lot size for a trade where a full SL hit = risk_percent% of balance.
    Balance-tier scaling is applied automatically for small accounts.

    Args:
        symbol              : e.g. "XAUUSD"
        sl_distance         : distance from entry to SL in price units (always positive)
        risk_percent        : % of balance to risk (default 1.0)
        max_actual_risk_pct : threshold -- warn or block when actual risk exceeds this %
        risk_cap_mode       : "warn" = log but trade anyway | "block" = skip the trade

    Returns:
        Lot size rounded to broker step, or 0.0 if blocked / invalid.
    """
    if sl_distance <= 0:
        print("lot.py: invalid SL distance ({})".format(sl_distance))
        return 0.0

    account = mt5.account_info()
    if account is None:
        print("lot.py: account info unavailable")
        return 0.0

    info = mt5.symbol_info(symbol)
    if info is None:
        print("lot.py: symbol info unavailable for {}".format(symbol))
        return 0.0

    balance = account.balance
    risk_amount = balance * (risk_percent / 100.0)

    # pip_value = USD gained/lost per lot per 1-point move
    pip_value = info.trade_contract_size * info.point
    if pip_value <= 0:
        print("lot.py: pip_value is zero for {}".format(symbol))
        return 0.0

    # Convert SL distance (price units) to points, then to USD risk per lot
    sl_points = sl_distance / info.point
    risk_per_lot = sl_points * pip_value

    # Ideal lot (mathematically correct for risk_percent)
    ideal_lot = risk_amount / risk_per_lot

    # Apply balance-tier scaling — allows small accounts to take proportionally
    # smaller positions rather than being stuck at the broker minimum floor
    scale = _balance_scale_factor(balance)
    scaled_lot = ideal_lot * scale

    # Round to broker volume_step (do NOT enforce volume_min — some brokers
    # accept sub-minimum lots for stock CFDs, confirmed via live trades)
    step = info.volume_step if info.volume_step > 0 else 0.01
    lot = round(round(scaled_lot / step) * step, 10)

    # Guarantee at least one volume_step (avoids sending 0.0)
    if lot <= 0:
        lot = step

    # Cap at broker maximum
    lot = min(lot, info.volume_max)

    # Round to a sensible number of decimal places
    lot = round(lot, 8)

    # Actual dollar risk at the final lot
    actual_risk_usd = risk_per_lot * lot
    actual_risk_pct = (actual_risk_usd / balance) * 100.0

    tier_label = "x{:.0f}".format(1.0 / scale) if scale < 1.0 else "full"
    print("Lot calc: balance=${:.2f} [tier {}] | target={:.1f}% (${:.2f}) | "
          "ideal={:.4f} scaled={:.4f} | sl_pts={:.0f} | lot={} | actual_risk={:.1f}%".format(
          balance, tier_label, risk_percent, risk_amount,
          ideal_lot, scaled_lot, sl_points, lot, actual_risk_pct))

    if actual_risk_pct > max_actual_risk_pct:
        min_balance_needed = actual_risk_usd / (max_actual_risk_pct / 100.0)
        if risk_cap_mode == "block":
            print("TRADE SKIPPED: actual risk {:.1f}% > {:.1f}% cap "
                  "(${:.2f} at risk -- need ~${:.0f} balance for this SL)".format(
                  actual_risk_pct, max_actual_risk_pct, actual_risk_usd, min_balance_needed))
            return 0.0
        else:
            print("RISK WARNING: actual risk {:.1f}% > {:.1f}% cap "
                  "(${:.2f} at risk -- need ~${:.0f} for safe sizing) -- trading anyway".format(
                  actual_risk_pct, max_actual_risk_pct, actual_risk_usd, min_balance_needed))

    return lot
