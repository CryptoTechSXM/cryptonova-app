"""
time_filter.py — Trading Hours Gate

Three-layer gate:
  1. Window check  — must be inside [START_HOUR, END_HOUR)
  2. Blocked hours — specific UTC hours always skipped (data-driven dead zones)
  3. News blackout — MT5 economic calendar events (high/medium impact)
"""

from datetime import datetime, timezone
from config import settings


def allow_trade() -> bool:
    # Weekend check — FX and most CFD markets closed Saturday & Sunday
    if datetime.now(timezone.utc).weekday() >= 5:
        return False

    if not settings.time_filter_enabled:
        return True

    now_hour = datetime.now(timezone.utc).hour
    start    = settings.time_filter_start_hour
    end      = settings.time_filter_end_hour

    if start <= end:
        in_window = start <= now_hour < end
    else:
        in_window = now_hour >= start or now_hour < end

    if not in_window:
        return False

    blocked = getattr(settings, "blocked_hours", [])
    if now_hour in blocked:
        return False

    if getattr(settings, 'news_filter_enabled', False):
        from news_filter import is_news_blackout
        blackout, _ = is_news_blackout(settings)
        if blackout:
            return False

    return True


def block_reason() -> str:
    if datetime.now(timezone.utc).weekday() >= 5:
        return "weekend — markets closed"

    if not settings.time_filter_enabled:
        return ""

    now_hour = datetime.now(timezone.utc).hour
    start    = settings.time_filter_start_hour
    end      = settings.time_filter_end_hour

    if start <= end:
        in_window = start <= now_hour < end
    else:
        in_window = now_hour >= start or now_hour < end

    if not in_window:
        return "outside session window ({:02d}:00-{:02d}:00 UTC)".format(start, end)

    blocked = getattr(settings, "blocked_hours", [])
    if now_hour in blocked:
        reason = "blocked hour {:02d}:00 UTC".format(now_hour)
        if now_hour == 16:
            reason += " (London close)"
        elif now_hour in (7, 10):
            reason += " (low-quality hour — data filter)"
        return reason

    if getattr(settings, 'news_filter_enabled', False):
        from news_filter import is_news_blackout
        blackout, reason = is_news_blackout(settings)
        if blackout:
            return reason

    return ""


def current_session_label() -> str:
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
