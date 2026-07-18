// Unit tests for the Content Scheduler 10-day calendar helpers.
// Task: 95e65d06-e529-466e-a6b0-d8dfb1e2eb87

import { describe, it, expect } from 'vitest';
import {
  SCHEDULER_TIME_ZONE,
  buildCalendarDays,
  getAucklandDayKey,
  getAucklandTimeOfDay,
  groupItemsForCalendar,
  zonedDateTimeToIso,
  rescheduleIsoForDay,
  dayDropBlocked
} from './contentSchedulerCalendar.js';

describe('buildCalendarDays', () => {
  it('returns 10 day entries starting from today in Pacific/Auckland', () => {
    // 2026-07-18 15:00 UTC = 2026-07-19 03:00 NZST (NZ is UTC+12 standard),
    // so the anchor day in NZ is Sun 19 Jul.
    const now = new Date('2026-07-18T15:00:00.000Z');
    const days = buildCalendarDays(now);
    expect(days).toHaveLength(10);
    expect(days[0].key).toBe('2026-07-19');
    expect(days[9].key).toBe('2026-07-28');
    // First label should start with "Sun" and include the day number.
    expect(days[0].label).toMatch(/^Sun 19 Jul$/);
    expect(days[9].label).toMatch(/^Tue 28 Jul$/);
    // en-NZ renders September as "Sept" (with t). Both forms should pass.
  });

  it('keeps keys sequential across the DST boundary (early-October NZ DST start)', () => {
    // 2026-09-27 is one day before NZ DST starts (last Sunday of September).
    // Daylight savings begins on 2026-09-27 in NZ, so this is the day the
    // hour moves forward at 02:00 → 03:00. The calendar must still produce
    // 10 sequential keys.
    const now = new Date('2026-09-26T15:00:00.000Z'); // Sun 27 Sep in NZ
    const days = buildCalendarDays(now);
    expect(days).toHaveLength(10);
    expect(days[0].key).toBe('2026-09-27');
    expect(days[9].key).toBe('2026-10-06');
    expect(days[0].label).toMatch(/^Sun 27 Sep(t)?$/);
  });

  it('uses the provided timezone instead of Pacific/Auckland when overridden', () => {
    const now = new Date('2026-07-18T15:00:00.000Z');
    const days = buildCalendarDays(now, 'UTC');
    expect(days[0].key).toBe('2026-07-18');
  });
});

describe('getAucklandDayKey', () => {
  it('returns the YYYY-MM-DD key in Pacific/Auckland for a UTC instant', () => {
    // 2026-07-18 23:30 UTC = 2026-07-19 11:30 NZST — next day in NZ.
    expect(getAucklandDayKey('2026-07-18T23:30:00.000Z')).toBe('2026-07-19');
    // 2026-07-18 13:00 UTC = 2026-07-19 01:00 NZST — next day in NZ.
    expect(getAucklandDayKey('2026-07-18T13:00:00.000Z')).toBe('2026-07-19');
    // 2026-07-18 11:00 UTC = 2026-07-18 23:00 NZST — same day in NZ.
    expect(getAucklandDayKey('2026-07-18T11:00:00.000Z')).toBe('2026-07-18');
  });

  it('returns null for missing/invalid input', () => {
    expect(getAucklandDayKey(null)).toBeNull();
    expect(getAucklandDayKey(undefined)).toBeNull();
    expect(getAucklandDayKey('not-a-date')).toBeNull();
    expect(getAucklandDayKey('')).toBeNull();
  });

  it('accepts Date instances', () => {
    expect(getAucklandDayKey(new Date('2026-07-18T11:00:00.000Z'))).toBe('2026-07-18');
  });
});

describe('getAucklandTimeOfDay', () => {
  it('extracts HH:MM in Pacific/Auckland', () => {
    // 2026-07-18 22:00 UTC = 2026-07-19 10:00 NZST.
    expect(getAucklandTimeOfDay('2026-07-18T22:00:00.000Z')).toBe('10:00');
    // 2026-07-18 19:30 UTC = 2026-07-19 07:30 NZST.
    expect(getAucklandTimeOfDay('2026-07-18T19:30:00.000Z')).toBe('07:30');
    // Just before midnight NZ.
    expect(getAucklandTimeOfDay('2026-07-18T11:55:00.000Z')).toBe('23:55');
  });

  it('returns null for invalid input', () => {
    expect(getAucklandTimeOfDay(null)).toBeNull();
    expect(getAucklandTimeOfDay('bad')).toBeNull();
  });
});

describe('zonedDateTimeToIso', () => {
  it('returns a UTC ISO for standard-time (NZST, UTC+12) target time', () => {
    // 2026-07-19 09:00 NZST = 2026-07-18 21:00 UTC.
    const iso = zonedDateTimeToIso('2026-07-19', '09:00');
    expect(iso).not.toBeNull();
    expect(new Date(iso).toISOString()).toBe('2026-07-18T21:00:00.000Z');
    // Round-trip back to local HH:MM should land on 09:00.
    expect(getAucklandTimeOfDay(iso)).toBe('09:00');
  });

  it('handles DST (NZDT, UTC+13) correctly', () => {
    // 2026-09-30 09:00 NZDT (DST starts 2026-09-27) = 2026-09-29 20:00 UTC.
    const iso = zonedDateTimeToIso('2026-09-30', '09:00');
    expect(iso).not.toBeNull();
    expect(new Date(iso).toISOString()).toBe('2026-09-29T20:00:00.000Z');
    expect(getAucklandTimeOfDay(iso)).toBe('09:00');
  });

  it('crosses midnight correctly when local time would shift days', () => {
    // 2026-07-19 00:30 NZST = 2026-07-18 12:30 UTC, but the day key must
    // remain 2026-07-19.
    const iso = zonedDateTimeToIso('2026-07-19', '00:30');
    expect(iso).not.toBeNull();
    expect(getAucklandDayKey(iso)).toBe('2026-07-19');
    expect(getAucklandTimeOfDay(iso)).toBe('00:30');
  });

  it('returns null on bad input', () => {
    expect(zonedDateTimeToIso('', '09:00')).toBeNull();
    expect(zonedDateTimeToIso('2026/07/19', '09:00')).toBeNull();
    expect(zonedDateTimeToIso('2026-07-19', '')).toBeNull();
    expect(zonedDateTimeToIso('2026-07-19', '25:00')).toBeNull();
    expect(zonedDateTimeToIso('2026-07-19', '9:99')).toBeNull();
  });
});

describe('rescheduleIsoForDay', () => {
  it('preserves the source item HH:MM when present', () => {
    const item = { scheduledFor: '2026-07-18T19:30:00.000Z' }; // 07:30 NZST
    const iso = rescheduleIsoForDay(item, '2026-07-22');
    expect(iso).not.toBeNull();
    expect(getAucklandTimeOfDay(iso)).toBe('07:30');
    expect(getAucklandDayKey(iso)).toBe('2026-07-22');
  });

  it('defaults to 09:00 when the source has no scheduledFor', () => {
    const item = { scheduledFor: null };
    const iso = rescheduleIsoForDay(item, '2026-07-22');
    expect(iso).not.toBeNull();
    expect(getAucklandTimeOfDay(iso)).toBe('09:00');
    expect(getAucklandDayKey(iso)).toBe('2026-07-22');
  });

  it('defaults to 09:00 when the source scheduledFor is invalid', () => {
    const item = { scheduledFor: 'not-a-date' };
    const iso = rescheduleIsoForDay(item, '2026-07-22');
    expect(iso).not.toBeNull();
    expect(getAucklandTimeOfDay(iso)).toBe('09:00');
  });
});

describe('groupItemsForCalendar', () => {
  const days = [
    { key: '2026-07-18', label: 'Sat 18 Jul', date: new Date('2026-07-18T00:00:00Z') },
    { key: '2026-07-19', label: 'Sun 19 Jul', date: new Date('2026-07-19T00:00:00Z') },
    { key: '2026-07-20', label: 'Mon 20 Jul', date: new Date('2026-07-20T00:00:00Z') }
  ];

  function makeItem(overrides) {
    return {
      id: 'i-1',
      body: 'b',
      source: 'manual',
      status: 'queued',
      scheduledFor: null,
      position: 0,
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      publishedUrl: null,
      publishError: null,
      removedAt: null,
      ...overrides
    };
  }

  it('places in-window items into their Pacific/Auckland day bucket', () => {
    const items = [
      makeItem({ id: 'queued-sun', status: 'queued', scheduledFor: '2026-07-18T19:00:00.000Z' }), // 07:00 Sun 19 NZ
      makeItem({ id: 'approved-mon', status: 'approved', scheduledFor: '2026-07-19T20:00:00.000Z' }), // 08:00 Mon 20 NZ
      makeItem({ id: 'published-sat', status: 'published', scheduledFor: '2026-07-17T20:00:00.000Z', publishedAt: '2026-07-18T02:00:00.000Z' }) // 08:00 Sat 18 NZ
    ];
    const { byDayKey, unscheduled, publishedByDayKey } = groupItemsForCalendar(items, days);
    expect(byDayKey['2026-07-19']).toHaveLength(1);
    expect(byDayKey['2026-07-19'][0].id).toBe('queued-sun');
    expect(byDayKey['2026-07-20']).toHaveLength(1);
    expect(byDayKey['2026-07-20'][0].id).toBe('approved-mon');
    expect(byDayKey['2026-07-18']).toHaveLength(1);
    expect(byDayKey['2026-07-18'][0].id).toBe('published-sat');
    expect(unscheduled).toEqual([]);
    expect(publishedByDayKey['2026-07-18'].id).toBe('published-sat');
  });

  it('routes items with no scheduledFor or out-of-window dates to Unscheduled', () => {
    const items = [
      makeItem({ id: 'no-sched', status: 'queued', scheduledFor: null }),
      makeItem({ id: 'far-past', status: 'queued', scheduledFor: '2026-06-01T00:00:00.000Z' }),
      makeItem({ id: 'far-future', status: 'queued', scheduledFor: '2027-01-01T00:00:00.000Z' })
    ];
    const { byDayKey, unscheduled } = groupItemsForCalendar(items, days);
    expect(unscheduled).toHaveLength(3);
    expect(unscheduled.map((i) => i.id).sort()).toEqual(['far-future', 'far-past', 'no-sched']);
    expect(Object.values(byDayKey).every((arr) => arr.length === 0)).toBe(true);
  });

  it('filters removed items from both buckets', () => {
    const items = [
      makeItem({ id: 'kept', status: 'queued', scheduledFor: '2026-07-18T19:00:00.000Z' }),
      makeItem({ id: 'gone', status: 'removed', removedAt: '2026-07-15T00:00:00.000Z', scheduledFor: '2026-07-18T19:00:00.000Z' }),
      makeItem({ id: 'gone-no-sched', status: 'removed', removedAt: '2026-07-15T00:00:00.000Z' })
    ];
    const { byDayKey, unscheduled } = groupItemsForCalendar(items, days);
    expect(byDayKey['2026-07-19']).toHaveLength(1);
    expect(byDayKey['2026-07-19'][0].id).toBe('kept');
    expect(unscheduled).toEqual([]);
  });
});

describe('dayDropBlocked', () => {
  const published = { id: 'pub', status: 'published', scheduledFor: '2026-07-18T20:00:00.000Z' };

  it('reports blocked when a different item is dragged onto a published day', () => {
    const result = dayDropBlocked({ '2026-07-19': published }, '2026-07-19', 'other-id');
    expect(result.blocked).toBe(true);
    expect(result.publishedItem).toBe(published);
  });

  it('does not block when the dragged item is the published one (no-op case)', () => {
    const result = dayDropBlocked({ '2026-07-19': published }, '2026-07-19', 'pub');
    expect(result.blocked).toBe(false);
    expect(result.publishedItem).toBe(published);
  });

  it('does not block when the target day has no published item', () => {
    const result = dayDropBlocked({}, '2026-07-19', 'other-id');
    expect(result.blocked).toBe(false);
    expect(result.publishedItem).toBeNull();
  });
});

describe('SCHEDULER_TIME_ZONE constant', () => {
  it('is locked to Pacific/Auckland', () => {
    expect(SCHEDULER_TIME_ZONE).toBe('Pacific/Auckland');
  });
});