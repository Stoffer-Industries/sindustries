import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CURATION_THRESHOLD,
  DEFAULT_TIME_WINDOWS,
  PIPELINE_ORDER,
  availableTopics,
  curationGroups,
  cutoffFromWindow,
  formatRelativeAge,
  funnelRows,
  inScopeItem,
  inScopeTransition,
  itemByKey,
  itemList,
  itemUpdatedAt,
  kpiCounts,
  parseBookmarkDate,
  pendingApprovals,
  recentTransitions,
  statusOf,
  topicCounts,
  topicOf
} from './bookmarkPipeline.js';

const NOW = new Date('2026-07-04T12:00:00.000Z');

function isoDaysAgo(days, base = NOW) {
  return new Date(base.getTime() - days * 86400000).toISOString();
}

function makeSnapshot(items, locks = {}) {
  return { version: 1, items, approvalLocks: locks };
}

function makeItem(overrides = {}) {
  return {
    title: 'Untitled',
    reviewStatus: 'pending',
    lastUpdatedAt: isoDaysAgo(2),
    ...overrides
  };
}

describe('parseBookmarkDate', () => {
  it('parses ISO strings', () => {
    const d = parseBookmarkDate('2026-01-01T00:00:00Z');
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2026);
  });
  it('returns null for null/undefined/invalid', () => {
    expect(parseBookmarkDate(null)).toBeNull();
    expect(parseBookmarkDate(undefined)).toBeNull();
    expect(parseBookmarkDate('not-a-date')).toBeNull();
  });
});

describe('itemList / itemByKey', () => {
  it('returns [] for empty or missing snapshot', () => {
    expect(itemList(null)).toEqual([]);
    expect(itemList(undefined)).toEqual([]);
    expect(itemList({})).toEqual([]);
  });

  it('flattens snapshot.items to an array of { key, ...item }', () => {
    const items = {
      'aaa': { title: 'A', reviewStatus: 'summarized' },
      'bbb': { title: 'B', reviewStatus: 'pending' }
    };
    const list = itemList({ items });
    expect(list).toHaveLength(2);
    expect(list.map((i) => i.key).sort()).toEqual(['aaa', 'bbb']);
  });

  it('itemByKey returns a Map keyed on item.key', () => {
    const items = { 'aaa': { title: 'A' }, 'bbb': { title: 'B' } };
    const map = itemByKey({ items });
    expect(map.get('aaa').title).toBe('A');
    expect(map.get('bbb').title).toBe('B');
    expect(map.get('ccc')).toBeUndefined();
  });
});

describe('statusOf / topicOf / itemUpdatedAt', () => {
  it('defaults status to "pending" when missing', () => {
    expect(statusOf({})).toBe('pending');
    expect(statusOf(null)).toBe('pending');
  });

  it('prefers curation.topic over item.topic, falls back to "general"', () => {
    expect(topicOf({})).toBe('general');
    expect(topicOf({ topic: 'infra' })).toBe('infra');
    expect(topicOf({ topic: 'infra', curation: { topic: 'brain' } })).toBe('brain');
  });

  it('itemUpdatedAt picks lastUpdatedAt → reviewedAt → firstSeenAt', () => {
    const a = itemUpdatedAt({ lastUpdatedAt: isoDaysAgo(1) });
    const b = itemUpdatedAt({ reviewedAt: isoDaysAgo(2) });
    const c = itemUpdatedAt({ firstSeenAt: isoDaysAgo(3) });
    expect(a.getTime()).toBeGreaterThan(b.getTime());
    expect(b.getTime()).toBeGreaterThan(c.getTime());
    expect(itemUpdatedAt({})).toBeNull();
  });
});

describe('cutoffFromWindow', () => {
  it('returns null for "all"', () => {
    expect(cutoffFromWindow('all', NOW)).toBeNull();
  });

  it('returns a Date midnight-aligned N days back', () => {
    const cutoff = cutoffFromWindow('7', NOW);
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getHours()).toBe(0);
    const diffDays = Math.round((NOW.getTime() - cutoff.getTime()) / 86400000);
    // Allow ±1 day depending on whether the cutoff date has passed midnight
    expect(diffDays).toBeGreaterThanOrEqual(6);
    expect(diffDays).toBeLessThanOrEqual(8);
  });
});

describe('inScopeItem / inScopeTransition', () => {
  it('respects the topic filter', () => {
    const item = makeItem({ topic: 'infra' });
    expect(inScopeItem(item, { topic: 'all' })).toBe(true);
    expect(inScopeItem(item, { topic: 'infra' })).toBe(true);
    expect(inScopeItem(item, { topic: 'brain' })).toBe(false);
  });

  it('respects the time window', () => {
    const fresh = makeItem({ lastUpdatedAt: isoDaysAgo(2) });
    const stale = makeItem({ lastUpdatedAt: isoDaysAgo(120) });
    expect(inScopeItem(fresh, { windowValue: '30', now: NOW })).toBe(true);
    expect(inScopeItem(stale, { windowValue: '30', now: NOW })).toBe(false);
    expect(inScopeItem(stale, { windowValue: 'all', now: NOW })).toBe(true);
  });

  it('inScopeTransition filters by topic of the referenced item', () => {
    const byKey = new Map([['a', makeItem({ topic: 'infra' })]]);
    expect(inScopeTransition({ key: 'a', at: isoDaysAgo(1) }, byKey, { topic: 'all' })).toBe(true);
    expect(inScopeTransition({ key: 'a', at: isoDaysAgo(1) }, byKey, { topic: 'brain' })).toBe(false);
    expect(inScopeTransition({ key: 'unknown', at: isoDaysAgo(1) }, byKey, { topic: 'brain' })).toBe(false);
  });
});

describe('kpiCounts', () => {
  it('counts items by reviewStatus including the canonical pipeline order', () => {
    const items = [
      makeItem({ reviewStatus: 'pending' }),
      makeItem({ reviewStatus: 'pending' }),
      makeItem({ reviewStatus: 'summarized' }),
      makeItem({ reviewStatus: 'approved' })
    ];
    const counts = kpiCounts(items);
    expect(counts.pending).toBe(2);
    expect(counts.summarized).toBe(1);
    expect(counts.approved).toBe(1);
    // Untouched statuses default to 0
    expect(counts.tasked).toBe(0);
    expect(counts.curated_implement).toBe(0);
    expect(counts.monitoring).toBe(0);
  });

  it('injects curated_implement and monitoring for items past spec stages', () => {
    const items = [
      makeItem({ curation: { score: 9, topic: 'brain' }, reviewStatus: 'summarized' }),
      makeItem({ curation: { score: 3, topic: 'brain' }, reviewStatus: 'summarized' }),
      // Past spec_requested — should NOT count toward curation buckets.
      makeItem({ curation: { score: 9, topic: 'brain' }, reviewStatus: 'spec_created' })
    ];
    const counts = kpiCounts(items);
    expect(counts.curated_implement).toBe(1);
    expect(counts.monitoring).toBe(1);
    expect(counts.summarized).toBe(2);
    expect(counts.spec_created).toBe(1);
  });
});

describe('curationGroups', () => {
  it('buckets items by curation verdict and threshold', () => {
    const items = [
      makeItem({ key: 'a', curation: { score: 9, topic: 'brain', createdAt: isoDaysAgo(1) } }),
      makeItem({ key: 'b', curation: { score: 3, topic: 'brain', createdAt: isoDaysAgo(3) } }),
      makeItem({ key: 'c' }),
      makeItem({ key: 'd', curation: { score: 7, topic: 'brain', createdAt: isoDaysAgo(2) } })
    ];
    const groups = curationGroups(items, { now: NOW });
    expect(groups.threshold).toBe(DEFAULT_CURATION_THRESHOLD);
    expect(groups.implementBound.map((i) => i.key).sort()).toEqual(['a', 'd']);
    expect(groups.curatedWaiting.map((i) => i.key)).toEqual(['b']);
    expect(groups.uncurated.map((i) => i.key)).toEqual(['c']);
  });

  it('sorts implementBound by score desc, curatedWaiting by recency', () => {
    const items = [
      makeItem({ key: 'a', curation: { score: 9, createdAt: isoDaysAgo(5) } }),
      makeItem({ key: 'b', curation: { score: 12, createdAt: isoDaysAgo(1) } }),
      makeItem({ key: 'c', curation: { score: 2, createdAt: isoDaysAgo(1) } }),
      makeItem({ key: 'd', curation: { score: 1, createdAt: isoDaysAgo(2) } })
    ];
    const groups = curationGroups(items, { now: NOW });
    expect(groups.implementBound.map((i) => i.key)).toEqual(['b', 'a']);
    expect(groups.curatedWaiting.map((i) => i.key)).toEqual(['c', 'd']);
  });

  it('honours the topic + window scope', () => {
    const items = [
      makeItem({ key: 'a', topic: 'infra', lastUpdatedAt: isoDaysAgo(1), curation: { score: 9, createdAt: isoDaysAgo(1) } }),
      makeItem({ key: 'b', topic: 'brain', lastUpdatedAt: isoDaysAgo(1), curation: { score: 9, createdAt: isoDaysAgo(1) } }),
      makeItem({ key: 'c', topic: 'infra', lastUpdatedAt: isoDaysAgo(120), curation: { score: 9, createdAt: isoDaysAgo(120) } })
    ];
    const groups = curationGroups(items, { topic: 'infra', windowValue: '30', now: NOW });
    expect(groups.implementBound.map((i) => i.key)).toEqual(['a']);
    expect(groups.uncurated).toEqual([]);
    expect(groups.curatedWaiting).toEqual([]);
  });
});

describe('funnelRows', () => {
  it('returns counts in pipeline order then alphabetical for unknown statuses', () => {
    const items = [
      makeItem({ reviewStatus: 'pending' }),
      makeItem({ reviewStatus: 'pending' }),
      makeItem({ reviewStatus: 'approved' }),
      makeItem({ reviewStatus: 'legacy_thing' })
    ];
    const rows = funnelRows(items);
    const statuses = rows.map((r) => r.status);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('approved');
    expect(statuses).toContain('legacy_thing');
    // pipeline order items come before unknowns
    const idxPending = statuses.indexOf('pending');
    const idxLegacy = statuses.indexOf('legacy_thing');
    expect(idxPending).toBeLessThan(idxLegacy);
  });

  it('skips zero-count statuses', () => {
    const items = [makeItem({ reviewStatus: 'pending' })];
    const rows = funnelRows(items);
    expect(rows.find((r) => r.status === 'approved')).toBeUndefined();
  });
});

describe('topicCounts', () => {
  it('counts items by topic in the time window, ignoring the topic filter', () => {
    const items = [
      makeItem({ topic: 'infra' }),
      makeItem({ topic: 'infra' }),
      makeItem({ topic: 'brain' }),
      makeItem({ topic: 'infra', lastUpdatedAt: isoDaysAgo(120) })
    ];
    const counts = topicCounts(items, { windowValue: '30', now: NOW });
    const byTopic = Object.fromEntries(counts.map((c) => [c.topic, c.count]));
    expect(byTopic.infra).toBe(2);
    expect(byTopic.brain).toBe(1);
  });

  it('sorts by count desc', () => {
    const items = [
      makeItem({ topic: 'a' }),
      makeItem({ topic: 'b' }),
      makeItem({ topic: 'b' }),
      makeItem({ topic: 'c' }),
      makeItem({ topic: 'c' }),
      makeItem({ topic: 'c' })
    ];
    const counts = topicCounts(items, { windowValue: '30', now: NOW });
    expect(counts.map((c) => c.topic)).toEqual(['c', 'b', 'a']);
  });
});

describe('recentTransitions', () => {
  it('returns the most recent N transitions in scope, newest first', () => {
    const byKey = new Map();
    const transitions = [
      { key: 'a', at: isoDaysAgo(5), from: 'pending', to: 'summarized' },
      { key: 'a', at: isoDaysAgo(1), from: 'summarized', to: 'curated' },
      { key: 'a', at: isoDaysAgo(2), from: 'summarized', to: 'monitoring' },
      { key: 'a', at: isoDaysAgo(120), from: 'pending', to: 'ingested' }
    ];
    const recent = recentTransitions(transitions, byKey, { windowValue: '30', now: NOW, limit: 3 });
    expect(recent).toHaveLength(3);
    expect(recent[0].at).toBe(isoDaysAgo(1));
    expect(recent[1].at).toBe(isoDaysAgo(2));
    expect(recent[2].at).toBe(isoDaysAgo(5));
  });

  it('returns [] when transitions is not an array', () => {
    expect(recentTransitions(null, new Map())).toEqual([]);
  });
});

describe('pendingApprovals', () => {
  it('returns one row per topic in approvalLocks', () => {
    const snapshot = makeSnapshot({}, {
      infra: { items: ['a', 'b'], requestedAt: isoDaysAgo(2) },
      brain: { items: ['c'], requestedAt: isoDaysAgo(1) }
    });
    const rows = pendingApprovals(snapshot);
    expect(rows).toHaveLength(2);
    const byTopic = Object.fromEntries(rows.map((r) => [r.topic, r]));
    expect(byTopic.infra.itemCount).toBe(2);
    expect(byTopic.brain.itemCount).toBe(1);
  });

  it('returns [] when there are no locks', () => {
    expect(pendingApprovals(makeSnapshot({}))).toEqual([]);
    expect(pendingApprovals(null)).toEqual([]);
  });
});

describe('availableTopics', () => {
  it('returns sorted unique topics, defaulting to "general"', () => {
    const items = [
      makeItem({ topic: 'brain' }),
      makeItem({}),
      makeItem({ topic: 'infra' }),
      makeItem({ topic: 'brain' })
    ];
    expect(availableTopics(items)).toEqual(['brain', 'general', 'infra']);
  });

  it('honours curation.topic when present', () => {
    const items = [
      makeItem({ topic: 'infra', curation: { topic: 'brain', score: 9 } })
    ];
    expect(availableTopics(items)).toEqual(['brain']);
  });
});

describe('formatRelativeAge', () => {
  it('returns "" for null/invalid input', () => {
    expect(formatRelativeAge(null)).toBe('');
    expect(formatRelativeAge('not-a-date')).toBe('');
  });
  it('returns "just now" for <1 minute', () => {
    const justNow = new Date(NOW.getTime() - 10 * 1000).toISOString();
    expect(formatRelativeAge(justNow, NOW)).toBe('just now');
  });
  it('returns "Xm", "Xh", "Xd", "Xmo" for increasing spans', () => {
    expect(formatRelativeAge(new Date(NOW.getTime() - 5 * 60000).toISOString(), NOW)).toBe('5m');
    expect(formatRelativeAge(new Date(NOW.getTime() - 3 * 3600000).toISOString(), NOW)).toBe('3h');
    expect(formatRelativeAge(new Date(NOW.getTime() - 2 * 86400000).toISOString(), NOW)).toBe('2d');
    expect(formatRelativeAge(new Date(NOW.getTime() - 60 * 86400000).toISOString(), NOW)).toBe('2mo');
  });
});

describe('module-level constants', () => {
  it('exposes the canonical pipeline order and time windows', () => {
    expect(PIPELINE_ORDER).toContain('pending');
    expect(PIPELINE_ORDER).toContain('approved');
    expect(DEFAULT_TIME_WINDOWS.map((w) => w.value)).toEqual(['7', '30', '90', 'all']);
  });
});