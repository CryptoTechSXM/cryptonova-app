# resolver.py — Dynamic broker symbol resolution
# ===============================================
# Brokers use different suffixes for the same instrument:
#   XAUUSD, XAUUSD.s, XAUUSD.p, XAUUSD.pro, XAUUSD.f, etc.
# This module finds the correct symbol for the connected broker
# automatically at startup — no manual config change needed when
# switching brokers or between demo and live accounts.

import MetaTrader5 as mt5

# Common broker suffixes tried in preference order.
# '' = try exact base name first, then suffixed variants.
_SUFFIXES = [
    '',
    '.s', '.p', '.pro', '.f',
    '.stp', '.ecn', '.raw',
    '.m', '.c', '.i', '.r', '.n',
    '.fx', '.x', '.tm',
]


def resolve_symbol(base):
    """
    Find the active broker symbol for a base instrument name.

    Priority:
      1. Exact base name            (e.g. 'XAUUSD')
      2. Suffixed variants          (e.g. 'XAUUSD.s', 'XAUUSD.p', ...)
      3. Symbols starting with base (broker-specific naming)
      4. Symbols containing base    (last resort)

    The symbol is selected in Market Watch if not already visible.
    Returns the resolved symbol string, or base if nothing matched.
    """
    base_upper = base.upper()

    # Step 1 & 2: try exact name then known suffixes
    for suffix in _SUFFIXES:
        candidate = base + suffix
        info = mt5.symbol_info(candidate)
        if info is not None:
            if not info.visible:
                mt5.symbol_select(candidate, True)
            print('[RESOLVER] {} -> {}'.format(base, candidate))
            return candidate

    # Step 3 & 4: search all broker symbols
    all_symbols = mt5.symbols_get()
    if all_symbols:
        starts   = [s.name for s in all_symbols
                    if s.name.upper().startswith(base_upper)]
        contains = [s.name for s in all_symbols
                    if base_upper in s.name.upper()]

        chosen = (starts or contains or [None])[0]
        if chosen:
            mt5.symbol_select(chosen, True)
            print('[RESOLVER] {} -> {} (search match)'.format(base, chosen))
            return chosen

    print('[RESOLVER] {} -> {} (no broker match — using as-is)'.format(base, base))
    return base
