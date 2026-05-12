"""
signal_bridge.py — Cross-bot signal confirmation layer
=======================================================
The 0-mt5-247-bot writes signal_bridge.json AFTER MT5 confirms each XAUUSD
order — meaning the sl/tp in the bridge are the ACTUAL EXECUTED parameters
(after SL_MULTIPLIER×1.5, ATR model, TP ladder, sanitize_market_stops).
These are the exact levels that achieve 83% WR, NOT the raw signal values.

This module reads that file so the Gold HA bot can:

  1. CONFIRM  — directions agree, signal < 2h old  → use executed SL/TP levels
  2. CONFLICT — directions oppose, signal < 1h old → skip the HA trade
  3. STALE    — signal older than window            → use own ATR levels
  4. ABSENT   — no bridge file or no XAUUSD entry  → use own ATR levels

The bridge file lives one level up from both bots so both can read/write it:
  C:\\CryptoNite-MT5-Bots\\signal_bridge.json
"""

import json
import os
from datetime import datetime, timezone

# Path: ../signal_bridge.json relative to this file's directory
BRIDGE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'signal_bridge.json'
)

# How long a bridge signal stays "active" for confirmation (minutes)
CONFIRM_WINDOW_MIN  = 120   # use analyst levels if signal < 2h old
CONFLICT_WINDOW_MIN = 60    # block trade if opposite signal < 1h old


def _read_bridge(symbol: str = 'XAUUSD') -> dict | None:
    """Load the bridge file and return the entry for symbol, or None."""
    base = symbol.upper().replace('.S', '').replace('.P', '').replace('.F', '').replace('.PRO', '')
    try:
        with open(BRIDGE_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get(base)
    except Exception:
        return None


def _age_minutes(bridge_sig: dict) -> float:
    """Return how many minutes ago the bridge signal was written."""
    try:
        ts = datetime.fromisoformat(bridge_sig['timestamp'])
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - ts).total_seconds() / 60
    except Exception:
        return 9999.0


def apply_signal_bridge(ha_signal: dict, symbol: str = 'XAUUSD') -> dict | None:
    """
    Cross-check a Gold HA signal against the latest Free Signals bridge entry.

    Returns:
      - Modified signal dict  (analyst SL/TP injected)  — directions confirmed
      - Original signal dict  (own ATR levels kept)     — bridge absent / stale
      - None                                             — fresh conflict, skip trade
    """
    ha_dir = ha_signal['type']   # 'BUY' or 'SELL'
    bridge = _read_bridge(symbol)

    # ── ABSENT ────────────────────────────────────────────────────────────────
    if bridge is None:
        print(f'[BRIDGE] No active Free Signal for {symbol} — using HA ATR levels')
        return ha_signal

    age    = _age_minutes(bridge)
    br_dir = bridge.get('direction', '').upper()
    br_sl  = bridge.get('sl')
    br_tp  = bridge.get('tp')
    br_ch  = bridge.get('channel_name', bridge.get('channel_id', '?'))

    # ── CONFIRMED ─────────────────────────────────────────────────────────────
    if br_dir == ha_dir:
        if age <= CONFIRM_WINDOW_MIN and br_sl and br_tp:
            confirmed = ha_signal.copy()
            confirmed['sl'] = float(br_sl)
            confirmed['tp'] = float(br_tp)
            confirmed['bridge_confirmed'] = True
            exec_tag = ' [EXECUTED]' if bridge.get('executed') else ' [RAW]'
            print(
                f'[BRIDGE] ✅ CONFIRMED by {br_ch} ({age:.0f}min ago, {br_dir}){exec_tag} '
                f'— using SL={br_sl:.2f} TP={br_tp:.2f} '
                f'(HA ATR was SL={ha_signal["sl"]:.2f} TP={ha_signal["tp"]:.2f})'
            )
            return confirmed
        else:
            # Same direction but stale — keep own levels
            print(
                f'[BRIDGE] Signal matches ({br_dir}) but stale ({age:.0f}min > {CONFIRM_WINDOW_MIN}min) '
                f'— using HA ATR levels'
            )
            return ha_signal

    # ── CONFLICT ──────────────────────────────────────────────────────────────
    else:
        if age <= CONFLICT_WINDOW_MIN:
            print(
                f'[BRIDGE] 🚫 CONFLICT — HA={ha_dir} but {br_ch} says {br_dir} '
                f'({age:.0f}min ago) — skipping trade to avoid opposing analyst signal'
            )
            return None   # caller should treat None as "no trade"
        else:
            # Old conflicting signal — expired, trust own HA pattern
            print(
                f'[BRIDGE] Old conflicting signal ({br_dir}, {age:.0f}min ago) — '
                f'expired, using HA ATR levels'
            )
            return ha_signal
