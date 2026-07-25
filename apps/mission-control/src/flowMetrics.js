// Pure helpers for the Flow metrics tab. All functions are deterministic
// and exportable so they can be unit-tested without a React render.
//
// Definitions (see brain/tasks/specs/task-flow-metrics-dashboard-2026-07-04.md):
//   * Cycle time = (completedAt - createdAt) in days, for tasks where
//     status === 'done' and completedAt is within the last `days`.
//   * Weekly throughput = tasks moved to 'done' per ISO week, last N weeks.
//   * WIP by status = non-archived count for open/ready/doing/acceptance.

export const OPEN_STATUSES = ['open', 'ready', 'doing', 'acceptance'];
export const COMPLETED_STATUS = 'done';

export function parseTaskDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function daysBetween(start, end) {
  const ms = end.getTime() - start.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

export function isCompleted(task) {
  return task?.status === COMPLETED_STATUS && !!task.completedAt;
}

export function isArchived(task) {
  return !!task?.archivedAt;
}

/**
 * Tasks completed in the last `days` days relative to `now`.
 * Excludes tasks without a valid completedAt timestamp.
 */
export function completedInLastDays(tasks, now, days = 30) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return tasks.filter((t) => {
    if (!isCompleted(t)) return false;
    const completed = parseTaskDate(t.completedAt);
    return completed && completed >= cutoff && completed <= now;
  });
}

/**
 * Cycle time in days for a single task.
 * Returns null if either createdAt or completedAt is missing/invalid.
 */
export function cycleTimeDays(task) {
  const created = parseTaskDate(task?.createdAt);
  const completed = parseTaskDate(task?.completedAt);
  if (!created || !completed) return null;
  return daysBetween(created, completed);
}

/**
 * Compute the p-th percentile of an array of finite numbers using the
 * linear-interpolation method. Returns null on empty input.
 */
export function percentile(values, p) {
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const fraction = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

/**
 * Summary of cycle time across a set of tasks. Returns a count plus median
 * and p90 in days, rounded to one decimal place.
 */
export function cycleTimeSummary(tasks, now, windowDays = 30) {
  const completed = completedInLastDays(tasks, now, windowDays);
  const cycleTimes = completed
    .map(cycleTimeDays)
    .filter((v) => v != null && Number.isFinite(v) && v >= 0)
    .map((v) => Math.round(v * 10) / 10);

  const sorted = cycleTimes.slice().sort((a, b) => a - b);
  const median = sorted.length === 0 ? null : percentile(sorted, 50);
  const p90 = sorted.length === 0 ? null : percentile(sorted, 90);

  return {
    count: sorted.length,
    medianDays: median == null ? null : Math.round(median * 10) / 10,
    p90Days: p90 == null ? null : Math.round(p90 * 10) / 10
  };
}

/**
 * Compute the Monday for the ISO week containing `date`.
 * Local time; intentional and matches the spec note that NZ/ops treats
 * weeks as Monday-start.
 */
export function isoMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

/**
 * Weekly throughput for the last `weeks` calendar weeks, ending on the
 * Monday on or before `now`. Returns an array of 8 buckets in chronological
 * order, oldest first.
 */
export function weeklyThroughput(tasks, now, weeks = 8) {
  const buckets = [];
  const thisMonday = isoMonday(now);
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = new Date(thisMonday);
    start.setDate(start.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    buckets.push({ start, end });
  }

  const counts = buckets.map(() => 0);
  for (const t of tasks) {
    if (!isCompleted(t)) continue;
    const completed = parseTaskDate(t.completedAt);
    if (!completed) continue;
    for (let i = 0; i < buckets.length; i += 1) {
      if (completed >= buckets[i].start && completed < buckets[i].end) {
        counts[i] += 1;
        break;
      }
    }
  }

  return buckets.map((b, i) => ({
    weekStart: b.start.toISOString().slice(0, 10),
    doneCount: counts[i]
  }));
}

/**
 * Count non-archived tasks grouped by their current status in the open
 * statuses. Done and archived tasks are excluded.
 */
export function wipByStatus(tasks) {
  const counts = { open: 0, ready: 0, doing: 0, acceptance: 0 };
  for (const t of tasks) {
    if (isArchived(t)) continue;
    if (OPEN_STATUSES.includes(t.status)) {
      counts[t.status] += 1;
    }
  }
  return counts;
}

function taskAssignee(task) {
  return task?.assignee ?? null;
}

function taskTags(task) {
  if (!Array.isArray(task?.tags)) return [];
  return task.tags
    .map((tag) => (typeof tag === 'string' ? tag : tag?.name))
    .filter(Boolean);
}

export function availableAssignees(tasks) {
  const set = new Set();
  for (const t of tasks) {
    const a = taskAssignee(t);
    if (a) set.add(a);
  }
  return [...set].sort();
}

export function availableTags(tasks) {
  const set = new Set();
  for (const t of tasks) {
    for (const tag of taskTags(t)) set.add(tag);
  }
  return [...set].sort();
}

/**
 * Backlog size at the start of each week for the last `weeks` calendar weeks.
 * A task counts as "in backlog" at snapshot time T if:
 *   - createdAt <= T  (task existed at that point)
 *   - completedAt is null or completedAt >= T  (not yet done)
 *   - archivedAt  is null or archivedAt  >= T  (not yet archived)
 */
export function weeklyBacklogSize(tasks, now, weeks = 16) {
  const thisMonday = isoMonday(now);
  const points = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const snap = new Date(thisMonday);
    snap.setDate(snap.getDate() - i * 7);
    let count = 0;
    for (const t of tasks) {
      const created = parseTaskDate(t.createdAt);
      if (!created || created > snap) continue;
      const completed = parseTaskDate(t.completedAt);
      if (completed && completed < snap) continue;
      const archived = parseTaskDate(t.archivedAt);
      if (archived && archived < snap) continue;
      count += 1;
    }
    points.push({ weekStart: snap.toISOString().slice(0, 10), backlogCount: count });
  }
  return points;
}

/**
 * Rolling P90 cycle time (in days) at each week boundary for the last `weeks`
 * weeks. For each week W the P90 is computed over tasks completed in the
 * trailing `rollingWeeks` weeks ending at W. Returns null for weeks where
 * fewer than 3 completions fall in the window (too sparse for a meaningful
 * percentile).
 */
export function weeklyRollingP90(tasks, now, weeks = 16, rollingWeeks = 4) {
  const thisMonday = isoMonday(now);
  const points = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const weekEnd = new Date(thisMonday);
    weekEnd.setDate(weekEnd.getDate() - i * 7 + 7);
    const windowStart = new Date(weekEnd.getTime() - rollingWeeks * 7 * 24 * 60 * 60 * 1000);
    const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cycleTimes = [];
    for (const t of tasks) {
      if (!isCompleted(t)) continue;
      const completed = parseTaskDate(t.completedAt);
      if (!completed || completed < windowStart || completed >= weekEnd) continue;
      const ct = cycleTimeDays(t);
      if (ct != null && Number.isFinite(ct) && ct >= 0) cycleTimes.push(ct);
    }
    const p90 = cycleTimes.length >= 3 ? percentile(cycleTimes, 90) : null;
    points.push({
      weekStart: weekStart.toISOString().slice(0, 10),
      p90Days: p90 == null ? null : Math.round(p90 * 10) / 10
    });
  }
  return points;
}

/**
 * Apply assignee + tag filters to a task list.
 * Filter pass: a task is included if it matches the assignee filter AND
 * the tag filter. "All" is the sentinel string for "no filter".
 */
export function filterTasks(tasks, { assignee, tag } = {}) {
  return tasks.filter((t) => {
    if (assignee && assignee !== 'All assignees' && taskAssignee(t) !== assignee) {
      return false;
    }
    if (tag && tag !== 'All tags') {
      const tags = taskTags(t);
      if (!tags.includes(tag)) return false;
    }
    return true;
  });
}

// ---- Feature-task analytics helpers (task f170e344) ----
//
// Pure helpers for the Feature Factory analytics panel. The API returns
// weekly buckets with terminalTaskCount, capacityFailureCount,
// qualityFailureCount, gateFailureRate, evidenceTypeDistribution, etc.
// These helpers format and summarise that data for the dashboard.

/**
 * Format a gate failure rate (0..1) as a percentage string with one
 * decimal. Returns `—` for null so dashboards don't render `NaN%`.
 */
export function formatFailureRate(rate) {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Format an evidence distribution map as a sorted, abbreviated string.
 * Returns `—` for empty/missing data so the panel renders cleanly.
 */
export function formatEvidenceSummary(distribution) {
  if (!distribution || typeof distribution !== 'object') return '—';
  const entries = Object.entries(distribution)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '—';
  return entries
    .slice(0, 3)
    .map(([label, count]) => `${label} ${count}`)
    .join(' · ');
}

/**
 * Sum a numeric field across the weekly buckets. Returns 0 for empty input.
 */
export function sumWeeklyField(weeks, field) {
  return weeks.reduce((acc, w) => acc + (Number(w[field]) || 0), 0);
}

/**
 * Find the latest week with a non-zero terminalTaskCount. Useful for the
 * "current week" summary so the panel doesn't summarise an empty week.
 */
export function latestActiveWeek(weeks) {
  for (let i = weeks.length - 1; i >= 0; i -= 1) {
    if (weeks[i].terminalTaskCount > 0) return weeks[i];
  }
  return null;
}

/**
 * Stable sort by weekStart ISO date string.
 */
export function sortWeeklyBuckets(weeks) {
  return [...weeks].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
}

/**
 * Return the trend slope (delta between last and first non-zero weeks)
 * for a given numeric field. Positive = getting worse (more failures),
 * negative = getting better. Returns null if there are fewer than two
 * non-zero weeks.
 */
export function trendDelta(weeks, field) {
  const nonZero = weeks.filter((w) => Number(w[field]) > 0);
  if (nonZero.length < 2) return null;
  return nonZero[nonZero.length - 1][field] - nonZero[0][field];
}
