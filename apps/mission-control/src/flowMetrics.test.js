import { describe, it, expect } from 'vitest';
import {
  parseTaskDate,
  daysBetween,
  cycleTimeDays,
  percentile,
  cycleTimeSummary,
  weeklyThroughput,
  wipByStatus,
  isoMonday,
  availableAssignees,
  availableTags,
  filterTasks,
  isCompleted,
  isArchived,
  completedInLastDays
} from './flowMetrics.js';

const NOW = new Date('2026-07-04T00:00:00.000Z');

function completedTask(daysAgo, extras = {}) {
  const createdAt = new Date(NOW.getTime() - (daysAgo + 5) * 86400000).toISOString();
  const completedAt = new Date(NOW.getTime() - daysAgo * 86400000).toISOString();
  return {
    status: 'done',
    createdAt,
    completedAt,
    archivedAt: null,
    ...extras
  };
}

describe('parseTaskDate', () => {
  it('returns a Date for ISO strings', () => {
    const d = parseTaskDate('2026-01-01T00:00:00Z');
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2026);
  });

  it('returns null for null/undefined/invalid', () => {
    expect(parseTaskDate(null)).toBeNull();
    expect(parseTaskDate(undefined)).toBeNull();
    expect(parseTaskDate('not-a-date')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('returns the difference in days', () => {
    const a = new Date('2026-01-01T00:00:00Z');
    const b = new Date('2026-01-04T00:00:00Z');
    expect(daysBetween(a, b)).toBeCloseTo(3, 5);
  });
});

describe('cycleTimeDays', () => {
  it('computes days from createdAt to completedAt', () => {
    const t = completedTask(1, {
      createdAt: new Date(NOW.getTime() - 6 * 86400000).toISOString(),
      completedAt: new Date(NOW.getTime() - 1 * 86400000).toISOString()
    });
    expect(cycleTimeDays(t)).toBeCloseTo(5, 5);
  });

  it('returns null when fields are missing', () => {
    expect(cycleTimeDays({})).toBeNull();
  });
});

describe('percentile', () => {
  it('returns null on empty input', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('returns the median for p=50 on an odd-length array', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('interpolates for p between data points', () => {
    expect(percentile([1, 2, 3, 4], 25)).toBeCloseTo(1.75, 5);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });
});

describe('cycleTimeSummary', () => {
  it('returns zeros when no completed tasks are within window', () => {
    const tasks = [completedTask(90)];
    const summary = cycleTimeSummary(tasks, NOW, 30);
    expect(summary.count).toBe(0);
    expect(summary.medianDays).toBeNull();
    expect(summary.p90Days).toBeNull();
  });

  it('computes median and p90 over a window of completed tasks', () => {
    const tasks = [
      completedTask(1, { createdAt: new Date(NOW.getTime() - 6 * 86400000).toISOString() }),
      completedTask(2, { createdAt: new Date(NOW.getTime() - 7 * 86400000).toISOString() }),
      completedTask(3, { createdAt: new Date(NOW.getTime() - 13 * 86400000).toISOString() })
    ];
    const summary = cycleTimeSummary(tasks, NOW, 30);
    expect(summary.count).toBe(3);
    expect(summary.medianDays).toBeGreaterThan(0);
    expect(summary.p90Days).toBeGreaterThanOrEqual(summary.medianDays);
  });
});

describe('weeklyThroughput', () => {
  it('returns 8 buckets in chronological order, oldest first', () => {
    const buckets = weeklyThroughput([], NOW, 8);
    expect(buckets).toHaveLength(8);
    for (let i = 1; i < buckets.length; i += 1) {
      expect(new Date(buckets[i].weekStart).getTime())
        .toBeGreaterThan(new Date(buckets[i - 1].weekStart).getTime());
    }
  });

  it('counts tasks whose completedAt falls in each bucket', () => {
    const thisMonday = isoMonday(NOW);
    const lastWeekStart = new Date(thisMonday);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    const tasks = [
      completedTask(0, {
        completedAt: new Date(NOW.getTime() - 1 * 3600000).toISOString()
      }),
      completedTask(0, {
        completedAt: new Date(NOW.getTime() - 2 * 3600000).toISOString()
      }),
      completedTask(0, {
        completedAt: new Date(lastWeekStart.getTime() + 1 * 86400000).toISOString()
      })
    ];
    const buckets = weeklyThroughput(tasks, NOW, 8);
    const last = buckets[buckets.length - 1];
    expect(last.doneCount).toBe(2);
    const penultimate = buckets[buckets.length - 2];
    expect(penultimate.doneCount).toBe(1);
  });
});

describe('wipByStatus', () => {
  it('counts only the open statuses and excludes done/archived', () => {
    const tasks = [
      { status: 'open' },
      { status: 'ready' },
      { status: 'doing' },
      { status: 'doing' },
      { status: 'acceptance' },
      { status: 'done' },
      { status: 'doing', archivedAt: '2026-01-01' }
    ];
    expect(wipByStatus(tasks)).toEqual({
      open: 1,
      ready: 1,
      doing: 2,
      acceptance: 1
    });
  });
});

describe('filter helpers', () => {
  const tasks = [
    { id: 1, status: 'done', assignee: 'Rowan', tags: ['pulse'] },
    { id: 2, status: 'done', assignee: 'Quinn', tags: ['pulse', 'obs'] },
    { id: 3, status: 'doing', assignee: 'Rowan', tags: ['task-flow'] }
  ];

  it('availableAssignees returns sorted assignees', () => {
    expect(availableAssignees(tasks)).toEqual(['Quinn', 'Rowan']);
  });

  it('availableTags returns sorted tags from string or {name} entries', () => {
    expect(availableTags([
      { tags: ['a'] },
      { tags: [{ name: 'b' }] },
      { tags: ['a', 'c'] }
    ])).toEqual(['a', 'b', 'c']);
  });

  it('filterTasks applies assignee + tag with "All" as no-filter', () => {
    expect(filterTasks(tasks, {}).length).toBe(3);
    expect(filterTasks(tasks, { assignee: 'Rowan' })).toEqual([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 3 })
    ]);
    expect(filterTasks(tasks, { assignee: 'All assignees', tag: 'pulse' })).toEqual([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 2 })
    ]);
  });
});

describe('predicates', () => {
  it('isCompleted requires done status and completedAt', () => {
    expect(isCompleted({ status: 'done', completedAt: '2026-01-01' })).toBe(true);
    expect(isCompleted({ status: 'doing', completedAt: '2026-01-01' })).toBe(false);
    expect(isCompleted({ status: 'done' })).toBe(false);
  });

  it('isArchived reflects archivedAt', () => {
    expect(isArchived({ archivedAt: null })).toBe(false);
    expect(isArchived({ archivedAt: '2026-01-01' })).toBe(true);
  });

  it('completedInLastDays windowing', () => {
    const tasks = [completedTask(1), completedTask(60), completedTask(5)];
    expect(completedInLastDays(tasks, NOW, 30)).toHaveLength(2);
  });
});
