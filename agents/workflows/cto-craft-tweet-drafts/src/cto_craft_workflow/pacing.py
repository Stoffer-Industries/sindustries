"""CTO Craft import scheduling policy.

Scheduling is intentionally workflow-local: the Content Scheduler API owns
persistence, while the workflow owns the editorial cadence and the timezone
boundary for that cadence.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


def _now_in_timezone(now: datetime, tz: ZoneInfo) -> datetime:
    """Return an injected clock value in the requested timezone.

    Treat a naive ``now`` as UTC so callers that construct a test clock without
    an offset still get a deterministic result. Production callers pass an
    aware UTC value from the workflow CLI.
    """

    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc).astimezone(tz)
    return now.astimezone(tz)


def _anchor_datetime(
    day,
    *,
    tz: ZoneInfo,
    anchor_hour: int,
) -> datetime:
    """Build the daily anchor, handling the rare DST gap/fold if needed."""

    candidate = datetime.combine(day, time(anchor_hour, tzinfo=tz))
    try:
        return candidate
    except ValueError:
        # A custom hour can land in a DST gap (the default 09:00 anchor does
        # not). The offset adjustment keeps the daily cadence moving forward.
        return candidate + timedelta(hours=1)


def stagger_scheduled_for(
    items: list[dict],
    *,
    now: datetime,
    tz: ZoneInfo = ZoneInfo("Pacific/Auckland"),
    anchor_hour: int = 9,
) -> list[dict]:
    """Set one staggered Pacific/Auckland schedule per import item.

    The first item is scheduled at 09:00 on the calendar day after ``now`` in
    ``tz``; each following item advances by one calendar day. Weekends are
    intentionally included and callers may reschedule drafts later in
    Mission Control.
    """

    if not items:
        return []
    if not 0 <= anchor_hour <= 23:
        raise ValueError("anchor_hour must be between 0 and 23")

    local_now = _now_in_timezone(now, tz)
    first_day = local_now.date() + timedelta(days=1)
    for index, item in enumerate(items):
        scheduled = _anchor_datetime(
            first_day + timedelta(days=index),
            tz=tz,
            anchor_hour=anchor_hour,
        )
        item["scheduledFor"] = scheduled.isoformat()
    return items


__all__ = ["stagger_scheduled_for"]
