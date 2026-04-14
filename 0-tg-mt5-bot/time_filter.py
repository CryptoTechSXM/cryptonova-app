"""
time_filter.py — Trading Hours Gate

Reads TIME_FILTER_ENABLED, TIME_FILTER_START_HOUR, TIME_FILTER_END_HOUR
from config and decides whether the bot is allowed to trade right now.

Default window covers London + New York sessions (07:00 - 22:00 UTC).
Set TIME_FILTER_ENABLED=false in .env to trade around the clock.
"""

from datetime import datetime, timezone
from config import settings


def allow_trade() -> bool:
    """
    Returns True if trading is currently allowed.

    If TIME_FILTER_ENABLED is False, always returns True.
    Otherwise returns True only if the current UTC hour falls inside
    [TIME_FILTER_START_HOUR, TIME_FILTER_END_HOUR).
    """
    if not settings.time_filter_enabled:
        return True

    now_hour = datetime.now(timezone.utc).hour
    start = settings.time_filter_start_hour
    end   = settings.time_filter_end_hour

    # Handle windows that don't wrap midnight (the normal case, e.g. 7-22)
    if start <= end:
        return start <= now_hour < end

    # Handle windows that wrap midnight (e.g. 22-6)
    return now_hour >= start or now_hour < end


def current_session_label() -> str:
    """
    Returns a human-readable label for the current market session based on UTC hour.
    Used in log messages when a signal is blocked by the time filter.
    """
    hour = datetime.now(timezone.utc).hour

    if 0 <= hour < 7:
        return "Asian"
    elif 7 <= hour < 12:
        return "London Open"
    elif 12 <= hour < 17:
        return "London/NY Overlap"
    elif 17 <= hour < 21:
        return "New York"
    else:
        return "After-Hours"
