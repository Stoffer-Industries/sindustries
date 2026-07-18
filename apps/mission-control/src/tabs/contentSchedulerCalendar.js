// Pure helpers for the Content Scheduler 10-day calendar view.
//
// Task: 95e65d06-e529-466e-a6b0-d8dfb1e2eb87
// Tech design: docs/specs/content-scheduler-calendar-view-2026-07-16-tech-design.md
//
// All functions here are deliberately framework-free so they can be
// unit-tested under Node directly. The Component layer imports these
// and renders them.

export const SCHEDULER_TIME_ZONE = 'Pacific/Auckland';

const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_FORMATTER_CACHE = new Map();

function dayFormatter(timeZone) {
  let fmt = DAY_FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-NZ', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      weekday: 'short'
    });
    DAY_FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

function timeFormatter(timeZone) {
  // One formatter per timeZone is sufficient — we only read hour/minute.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

/**
 * Build the 10 calendar day descriptors starting from today in `timeZone`.
 *
 * Returns an array of length 10 (today through today + 9). Each entry has:
 *   - key:    YYYY-MM-DD in `timeZone`
 *   - label:  e.g. "Wed 16 Jul" (weekday short, day, month short)
 *   - date:   the UTC instant of midnight in `timeZone` for that day (useful
 *             for sorting/visual ordering, but NOT for comparisons across
 *             DST boundaries — always compare `key` strings for equality)
 *
 * @param {Date} [now=new Date()]   anchor "now" instant
 * @param {string} [timeZone=SCHEDULER_TIME_ZONE]
 * @returns {Array<{key: string, label: string, date: Date}>}
 */
export function buildCalendarDays(now = new Date(), timeZone = SCHEDULER_TIME_ZONE) {
  const todayKey = getAucklandDayKey(now, timeZone);
  const fmt = dayFormatter(timeZone);
  const out = [];
  for (let i = 0; i < 10; i += 1) {
    // Parse todayKey to get year/month/day as numbers.
    const [yStr, mStr, dStr] = todayKey.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    // UTC midnight of today (in target tz) — we use UTC math as a stable
    // anchor; the date Key/label is the source of truth for grouping.
    const utcMidnight = new Date(Date.UTC(y, m - 1, d));
    const offsetMs = i * DAY_MS;
    const target = new Date(utcMidnight.getTime() + offsetMs);
    const targetKey = getAucklandDayKey(target, timeZone);
    // If the formatter shifted the key (DST edge cases where midnight in
    // Pacific/Auckland doesn't map to UTC midnight the same day), advance
    // until the formatter-produced key matches.
    let safe = target;
    while (getAucklandDayKey(safe, timeZone) !== targetKey && safe.getTime() < target.getTime() + DAY_MS * 2) {
      safe = new Date(safe.getTime() + 60 * 60 * 1000);
    }
    const parts = fmt.formatToParts(safe);
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const day = parts.find((p) => p.type === 'day')?.value ?? '';
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    const label = `${weekday} ${day} ${month}`;
    out.push({ key: targetKey, label, date: safe });
  }
  return out;
}

/**
 * Get the `YYYY-MM-DD` day key for an ISO timestamp / Date in `timeZone`.
 *
 * Used to bucket items into calendar day columns and to detect "today".
 * The key is timezone-stable: the same Pacific/Auckland instant always
 * produces the same key, regardless of the host system clock.
 *
 * @param {string|Date|null|undefined} value
 * @param {string} [timeZone=SCHEDULER_TIME_ZONE]
 * @returns {string|null} YYYY-MM-DD in the requested zone, or null if the
 *   input is missing/invalid.
 */
export function getAucklandDayKey(value, timeZone = SCHEDULER_TIME_ZONE) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.valueOf())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  // en-CA formats as YYYY-MM-DD by default.
  return fmt.format(d);
}

/**
 * Group scheduler items for the calendar view.
 *
 * Buckets non-removed items by their Pacific/Auckland day key. Items with
 * no `scheduledFor` or a day outside the calendar window land in the
 * `unscheduled` array. Day columns without any items still appear in
 * `byDayKey` (via the `days` argument) so the UI can render empty columns.
 *
 * @param {Array} items                scheduler items (any status)
 * @param {Array<{key: string}>} days  output of `buildCalendarDays()`
 * @param {string} [timeZone]
 * @returns {{ byDayKey: Record<string, Array>, unscheduled: Array, publishedByDayKey: Record<string, object> }}
 */
export function groupItemsForCalendar(items, days, timeZone = SCHEDULER_TIME_ZONE) {
  const dayKeys = new Set(days.map((d) => d.key));
  const byDayKey = Object.fromEntries(days.map((d) => [d.key, []]));
  const unscheduled = [];
  const publishedByDayKey = {};

  for (const item of items ?? []) {
    if (!item) continue;
    if (item.status === 'removed') continue;
    const dayKey = getAucklandDayKey(item.scheduledFor, timeZone);
    if (dayKey && dayKeys.has(dayKey)) {
      byDayKey[dayKey].push(item);
      if (item.status === 'published') {
        publishedByDayKey[dayKey] = item;
      }
    } else {
      unscheduled.push(item);
    }
  }

  // Stable order within each day column: queued first by position, then
  // approved by position, then published by publishedAt desc. Removed items
  // are filtered above. Card metadata surface area stays small in 10-day
  // windows so this is fine as a per-column sort.
  const statusRank = { queued: 0, approved: 1, published: 2 };
  for (const key of Object.keys(byDayKey)) {
    byDayKey[key].sort((a, b) => {
      const r = (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
      if (r !== 0) return r;
      const ap = a.position ?? 0;
      const bp = b.position ?? 0;
      if (ap !== bp) return ap - bp;
      return String(a.id).localeCompare(String(b.id));
    });
  }
  unscheduled.sort((a, b) => {
    const r = (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
    if (r !== 0) return r;
    return String(a.id).localeCompare(String(b.id));
  });

  return { byDayKey, unscheduled, publishedByDayKey };
}

/**
 * Extract HH:MM (24-hour) from an ISO timestamp in `timeZone`.
 *
 * Returns `null` if the input is missing/invalid. Hours/minutes are
 * returned as zero-padded strings (e.g. "09:00", "23:05").
 *
 * @param {string|Date|null|undefined} value
 * @param {string} [timeZone=SCHEDULER_TIME_ZONE]
 * @returns {string|null}
 */
export function getAucklandTimeOfDay(value, timeZone = SCHEDULER_TIME_ZONE) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.valueOf())) return null;
  const parts = timeFormatter(timeZone).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Compose a UTC ISO instant for the given dayKey + HH:MM in `timeZone`.
 *
 * Pacific/Auckland is UTC+12 standard / UTC+13 DST, so we cannot just
 * `new Date('YYYY-MM-DDTHH:mm')` and call it done — the browser's local
 * timezone would dominate the result. Instead we iterate the Intl-formatted
 * parts and adjust a UTC guess until it matches the requested local time.
 *
 * @param {string} dayKey      YYYY-MM-DD in `timeZone`
 * @param {string} hhmm        "HH:MM" (24h)
 * @param {string} [timeZone]
 * @returns {string|null} UTC ISO string, or null on bad input.
 */
export function zonedDateTimeToIso(dayKey, hhmm, timeZone = SCHEDULER_TIME_ZONE) {
  if (!dayKey || typeof dayKey !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!timeMatch) return null;
  const targetHour = Number(timeMatch[1]);
  const targetMinute = Number(timeMatch[2]);
  if (targetHour > 23 || targetMinute > 59) return null;

  // First guess: treat the requested local clock as if it were UTC, then
  // adjust by the zone offset we observe.
  let utcGuess = Date.UTC(year, month - 1, day, targetHour, targetMinute, 0, 0);

  // We allow up to 3 refinement passes. In practice 2 is always enough —
  // the first adjustment handles the standard offset, the second handles
  // a DST change within the loop.
  for (let i = 0; i < 3; i += 1) {
    const guess = new Date(utcGuess);
    const parts = timeFormatter(timeZone).formatToParts(guess);
    const hourPart = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minutePart = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const deltaMinutes = (targetHour - hourPart) * 60 + (targetMinute - minutePart);
    if (deltaMinutes === 0) {
      return guess.toISOString();
    }
    utcGuess += deltaMinutes * 60 * 1000;
  }
  // If we couldn't converge, give up rather than ship a wrong value.
  return null;
}

/**
 * Compute the new scheduledFor ISO for dropping `item` onto `targetDayKey`.
 *
 * Preserves the source item's Pacific/Auckland HH:MM where present,
 * defaulting to 09:00 when missing or invalid. Published items are not
 * reschedulable — the caller should guard this before calling.
 *
 * @param {object} item         source item (must be non-published)
 * @param {string} targetDayKey destination YYYY-MM-DD
 * @param {string} [timeZone]
 * @returns {string|null}       ISO string for updateItem, or null on bad input
 */
export function rescheduleIsoForDay(item, targetDayKey, timeZone = SCHEDULER_TIME_ZONE) {
  const hhmm = getAucklandTimeOfDay(item?.scheduledFor, timeZone) ?? '09:00';
  return zonedDateTimeToIso(targetDayKey, hhmm, timeZone);
}

/**
 * Is `targetDayKey` blocked by an existing published item other than `itemId`?
 *
 * AC6: dragging a non-published card onto a day with a published item must
 * be refused. The published item itself is not draggable (see `ItemRow`
 * draggable prop), so the only "exception" we need to model is "the user
 * somehow got the published card to be the dragged source", which we still
 * allow to no-op cleanly by returning true (the caller should also refuse
 * the drag on the published card up front).
 *
 * @param {Record<string, object>} publishedByDayKey
 * @param {string} targetDayKey
 * @param {string|null} itemId    dragged item id (so we don't self-block)
 * @returns {{ blocked: boolean, publishedItem: object|null }}
 */
export function dayDropBlocked(publishedByDayKey, targetDayKey, itemId) {
  const published = publishedByDayKey?.[targetDayKey] ?? null;
  if (!published) return { blocked: false, publishedItem: null };
  if (itemId && published.id === itemId) return { blocked: false, publishedItem: published };
  return { blocked: true, publishedItem: published };
}