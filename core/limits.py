"""Simple limits so nobody can spam the app or run up the AI bill.

Daily limits count the customer's own activity log (the events table), so they
hold across every Vercel server. The short per-IP limits are kept in memory:
each server counts on its own, which is enough to slow down a script.
"""
import threading
import time
from datetime import datetime, timedelta, timezone

# What one customer can do in 24 hours.
DAILY = {
    "ritu": 40,           # questions to Ritu
    "cibil_report": 5,    # CIBIL report uploads (each one is read by Claude)
    "request": 10,        # requests sent to the team
}

MESSAGES = {
    "ritu": "You've asked Ritu a lot today. Try again tomorrow, or tap Call me and our executive will help.",
    "cibil_report": "You've uploaded your report several times today. Try again tomorrow.",
    "request": "You've sent a lot of requests today. Our executive will be in touch soon.",
}


def since(hours=24):
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")


def over_daily(store, user_id, kind):
    """True when the customer has used up today's limit. Never blocks on a database hiccup."""
    try:
        return store.count_events(user_id, kind, since()) >= DAILY[kind]
    except Exception:
        return False


_hits = {}
_lock = threading.Lock()


def too_fast(key, limit, seconds):
    """In-memory sliding window: True when `key` has been seen `limit` times in `seconds`."""
    now = time.monotonic()
    with _lock:
        recent = [t for t in _hits.get(key, ()) if now - t < seconds]
        if len(recent) >= limit:
            _hits[key] = recent
            return True
        recent.append(now)
        _hits[key] = recent
        if len(_hits) > 5000:  # keep memory small
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 3600]:
                _hits.pop(k, None)
        return False


def client_ip(request):
    fwd = request.headers.get("X-Forwarded-For", "")
    return (fwd.split(",")[0].strip() if fwd else request.remote_addr) or "unknown"
