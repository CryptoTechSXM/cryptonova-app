"""
news_filter.py — Economic Calendar News Filter (ForexFactory XML)

is_news_blackout(settings) -> (bool, str)
get_positions_to_close_before_news(settings, positions, active_trades) -> list

Impact mapping: High=RED(3), Medium=ORANGE(2), Low=YELLOW(1)
Times on ForexFactory are US/Eastern — converted to UTC automatically.
"""

import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

try:
    from logger import log
except ImportError:
    def log(msg, level="INFO"):
        print(f"[news_filter][{level}] {msg}")

_cache_ts      = None
_cache_events  = []
_CACHE_TTL_SEC = 300

# ForexFactory currency codes mapped from settings country codes
_COUNTRY_TO_CCY = {
    "US": "USD", "EU": "EUR", "GB": "GBP", "JP": "JPY",
    "AU": "AUD", "CA": "CAD", "CH": "CHF", "NZ": "NZD",
    "CN": "CNY", "DE": "EUR", "FR": "EUR",
}

_IMPACT_MAP   = {"High": 3, "Medium": 2, "Low": 1}
_IMPACT_LABEL = {3: "RED", 2: "ORANGE", 1: "YELLOW"}

_FF_URLS = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.xml",
    "https://nfs.faireconomy.media/ff_calendar_nextweek.xml",
]


def _et_to_utc(dt_naive):
    """Convert naive US/Eastern datetime to UTC, handling DST correctly."""
    try:
        from zoneinfo import ZoneInfo
        return dt_naive.replace(tzinfo=ZoneInfo("America/New_York")).astimezone(timezone.utc)
    except Exception:
        # Fallback: compute DST manually (2nd Sun Mar → 1st Sun Nov)
        year = dt_naive.year
        dst_start = datetime(year, 3, 8)  + timedelta(days=(6 - datetime(year, 3, 8).weekday())  % 7)
        dst_end   = datetime(year, 11, 1) + timedelta(days=(6 - datetime(year, 11, 1).weekday()) % 7)
        offset = timedelta(hours=-4) if dst_start <= dt_naive < dst_end else timedelta(hours=-5)
        return (dt_naive - offset).replace(tzinfo=timezone.utc)


def _fetch_ff_events(settings):
    """Fetch and parse ForexFactory XML calendar for this week + next week."""
    importance_map  = {"RED": 3, "ORANGE": 2, "YELLOW": 1}
    allowed_impacts = {importance_map[k] for k in settings.news_filter_importance
                       if k in importance_map}

    allowed_ccy = set()
    for country in settings.news_filter_countries:
        allowed_ccy.add(_COUNTRY_TO_CCY.get(country.upper(), country.upper()))

    events = []
    now    = datetime.now(timezone.utc)

    for url in _FF_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
            root = ET.fromstring(data)

            for ev in root.findall("event"):
                country    = (ev.findtext("country") or "").strip().upper()
                impact_str = (ev.findtext("impact")  or "").strip()
                date_str   = (ev.findtext("date")    or "").strip()  # MM-DD-YYYY
                time_str   = (ev.findtext("time")    or "").strip()  # e.g. "8:30am"
                title      = (ev.findtext("title")   or "?").strip()

                if country not in allowed_ccy:
                    continue
                impact = _IMPACT_MAP.get(impact_str, 0)
                if impact not in allowed_impacts:
                    continue
                if not date_str or time_str.lower() in ("all day", "tentative", ""):
                    continue

                try:
                    dt_date  = datetime.strptime(date_str, "%m-%d-%Y")
                    dt_time  = datetime.strptime(time_str.upper(), "%I:%M%p")
                    dt_naive = dt_date.replace(hour=dt_time.hour, minute=dt_time.minute)
                    dt_utc   = _et_to_utc(dt_naive)
                except ValueError:
                    continue

                # Keep only events within a ±36h window to keep cache lean
                if abs((dt_utc - now).total_seconds()) > 129600:
                    continue

                events.append({
                    "time":    dt_utc,
                    "name":    title,
                    "country": country,
                    "impact":  impact,
                })

        except Exception as e:
            if isinstance(e, urllib.error.HTTPError) and e.code == 404:
                log(f"[NEWS] {url.split('/')[-1]} not yet published (404) — skipping", "DEBUG")
            else:
                log(f"[NEWS] FF calendar fetch failed ({url}): {e}", "WARNING")

    events.sort(key=lambda x: x["time"])
    return events


def _refresh_cache(settings):
    global _cache_ts, _cache_events
    _cache_events = _fetch_ff_events(settings)
    _cache_ts     = datetime.now(timezone.utc)
    log(f"[NEWS] Calendar refreshed — {len(_cache_events)} relevant events in next 36h", "DEBUG")
    return _cache_events


def _get_events(settings):
    global _cache_ts, _cache_events
    now = datetime.now(timezone.utc)
    if _cache_ts is None or (now - _cache_ts).total_seconds() > _CACHE_TTL_SEC:
        _refresh_cache(settings)
    return _cache_events


def is_news_blackout(settings):
    """Returns (True, reason) inside a blackout window, else (False, '')."""
    if not getattr(settings, 'news_filter_enabled', False):
        return False, ""
    now    = datetime.now(timezone.utc)
    before = timedelta(minutes=settings.news_filter_before_min)
    after  = timedelta(minutes=settings.news_filter_after_min)
    for ev in _get_events(settings):
        t = ev["time"]
        if (t - before) <= now <= (t + after):
            label   = _IMPACT_LABEL.get(ev["impact"], "?")
            mins_to = int((t - now).total_seconds() / 60)
            timing  = f"in {mins_to}m" if mins_to >= 0 else f"{abs(mins_to)}m ago"
            return True, f"NEWS BLACKOUT: {ev['country']} {label} — {ev['name']} ({timing})"
    return False, ""


def get_positions_to_close_before_news(settings, positions, active_trades):
    """Returns unprotected positions that should be closed before an imminent event."""
    if not getattr(settings, 'news_filter_enabled', False):
        return []
    now         = datetime.now(timezone.utc)
    close_delta = timedelta(minutes=settings.news_close_before_min)
    eps         = 0.0001
    imminent    = [ev for ev in _get_events(settings)
                   if timedelta(0) < (ev["time"] - now) <= close_delta]
    if not imminent:
        return []
    to_close = []
    for pos in (positions or []):
        if active_trades.get(pos.ticket, {}).get("sl_trailed", False):
            continue
        entry = pos.price_open
        sl    = pos.sl
        if pos.type == 0:   # BUY
            protected = sl > 0 and sl >= (entry - eps)
        else:               # SELL
            protected = sl > 0 and sl <= (entry + eps)
        if not protected:
            to_close.append(pos)
    if to_close:
        ev    = imminent[0]
        label = _IMPACT_LABEL.get(ev["impact"], "?")
        mins  = int((ev["time"] - now).total_seconds() / 60)
        log(f"[NEWS] Pre-close: {len(to_close)} unprotected pos — "
            f"{ev['country']} {label} '{ev['name']}' in {mins}m", "WARNING")
    return to_close
