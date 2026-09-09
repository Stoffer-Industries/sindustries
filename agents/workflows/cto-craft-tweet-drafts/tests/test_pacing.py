from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from cto_craft_workflow.pacing import stagger_scheduled_for


AUCKLAND = ZoneInfo("Pacific/Auckland")


def test_stagger_scheduled_for_one_item_uses_next_morning() -> None:
    items = [{"body": "one"}]
    result = stagger_scheduled_for(
        items,
        now=datetime(2026, 8, 10, 21, 0, tzinfo=timezone.utc),  # 09:00 NZST on Aug 11
    )

    assert result is items
    assert result[0]["scheduledFor"] == "2026-08-12T09:00:00+12:00"


def test_stagger_scheduled_for_spaces_batches_one_day_apart() -> None:
    items = [{"body": str(index)} for index in range(5)]

    result = stagger_scheduled_for(
        items,
        now=datetime(2026, 8, 10, 21, 0, tzinfo=timezone.utc),
    )

    assert [item["scheduledFor"] for item in result] == [
        "2026-08-12T09:00:00+12:00",
        "2026-08-13T09:00:00+12:00",
        "2026-08-14T09:00:00+12:00",
        "2026-08-15T09:00:00+12:00",
        "2026-08-16T09:00:00+12:00",
    ]


def test_stagger_scheduled_for_handles_nz_dst_transition() -> None:
    items = [{"body": "one"}, {"body": "two"}]

    result = stagger_scheduled_for(
        items,
        now=datetime(2026, 9, 26, 21, 0, tzinfo=timezone.utc),
    )

    assert result[0]["scheduledFor"] == "2026-09-28T09:00:00+13:00"
    assert result[1]["scheduledFor"] == "2026-09-29T09:00:00+13:00"


def test_stagger_scheduled_for_is_idempotent() -> None:
    items = [{"body": "one"}, {"body": "two"}]
    now = datetime(2026, 8, 10, 21, 0, tzinfo=timezone.utc)

    first = stagger_scheduled_for(items, now=now)
    first_values = [item["scheduledFor"] for item in first]
    second_values = [item["scheduledFor"] for item in stagger_scheduled_for(first, now=now)]

    assert second_values == first_values


def test_stagger_scheduled_for_uses_custom_anchor_hour() -> None:
    items = [{"body": "one"}]

    result = stagger_scheduled_for(
        items,
        now=datetime(2026, 8, 10, 21, 0, tzinfo=timezone.utc),
        anchor_hour=14,
    )

    assert result[0]["scheduledFor"] == "2026-08-12T14:00:00+12:00"
