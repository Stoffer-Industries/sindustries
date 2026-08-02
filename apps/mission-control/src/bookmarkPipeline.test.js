import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CURATION_THRESHOLD,
  DEFAULT_TIME_WINDOWS,
  PIPELINE_ORDER,
  STATUS_COLOR_VAR,
  availableTopics,
  curationGroups,
  cutoffFromWindow,
  formatRelativeAge,
  formatTimeSeriesDate,
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
  sankeyNodesAndLinks,
  stateCountsTimeSeries,
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
    expect(inScopeItem(item, { topic: 'all', now: NOW })).toBe(true);
    expect(inScopeItem(item, { topic: 'infra', now: NOW })).toBe(true);
    expect(inScopeItem(item, { topic: 'brain', now: NOW })).toBe(false);
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
    expect(inScopeTransition({ key: 'a', at: isoDaysAgo(1) }, byKey, { topic: 'all', now: NOW })).toBe(true);
    expect(inScopeTransition({ key: 'a', at: isoDaysAgo(1) }, byKey, { topic: 'brain', now: NOW })).toBe(false);
    expect(inScopeTransition({ key: 'unknown', at: isoDaysAgo(1) }, byKey, { topic: 'brain', now: NOW })).toBe(false);
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

  it('exposes a STATUS_COLOR_VAR map covering pipeline + curated + legacy statuses', () => {
    // Pipeline statuses use design tokens (or hex fallbacks) so the
    // Sankey + line chart agree with the KPI grid.
    expect(STATUS_COLOR_VAR.pending).toMatch(/var\(--si-color-graphite-500/);
    expect(STATUS_COLOR_VAR.approved).toMatch(/var\(--si-color-success-500/);
    expect(STATUS_COLOR_VAR.declined).toMatch(/var\(--si-color-danger-500/);
    // Curation bucket labels (used in the Sankey + time-series chart).
    expect(STATUS_COLOR_VAR['Curated: Monitoring']).toBeDefined();
    expect(STATUS_COLOR_VAR['Curated: High Signal']).toBeDefined();
    // Legacy statuses get muted neutral colours.
    expect(STATUS_COLOR_VAR.reviewed).toMatch(/var\(--si-color-neutral-200/);
  });
});

describe('formatTimeSeriesDate', () => {
  it('renders Date as YYYY-MM-DD in UTC', () => {
    expect(formatTimeSeriesDate(new Date('2026-07-04T15:00:00.000Z'))).toBe('2026-07-04');
  });
  it('parses ISO strings', () => {
    expect(formatTimeSeriesDate('2026-01-01T00:00:00Z')).toBe('2026-01-01');
  });
  it('returns "" for invalid input', () => {
    expect(formatTimeSeriesDate(null)).toBe('');
    expect(formatTimeSeriesDate('not-a-date')).toBe('');
  });
});

describe('sankeyNodesAndLinks', () => {
  it('returns null when items is empty or missing', () => {
    expect(sankeyNodesAndLinks([])).toBeNull();
    expect(sankeyNodesAndLinks(null)).toBeNull();
    expect(sankeyNodesAndLinks(undefined)).toBeNull();
  });

  it('produces 10 nodes covering the full curation pipeline', () => {
    const { nodes } = sankeyNodesAndLinks([
      makeItem({ reviewStatus: 'pending' }),
      makeItem({ reviewStatus: 'summarized' })
    ]);
    expect(nodes).toHaveLength(10);
    expect(nodes.map((n) => n.name)).toContain('Ingested');
    expect(nodes.map((n) => n.name)).toContain('Summarized');
    expect(nodes.map((n) => n.name)).toContain('Approved');
    expect(nodes.map((n) => n.name)).toContain('Declined');
    // All nodes carry the colour used by the chart's gradient stops.
    for (const node of nodes) expect(typeof node.color).toBe('string');
  });

  it('routes items by status + curation verdict', () => {
    const items = [
      makeItem({ reviewStatus: 'pending' }), // ingested
      makeItem({ reviewStatus: 'summarized' }), // summarized
      makeItem({ reviewStatus: 'summarized', curation: { score: 9 } }), // curatedImplement
      makeItem({ reviewStatus: 'summarized', curation: { score: 2 } }), // monitoring
      makeItem({ reviewStatus: 'spec_created' }), // specCreated
      makeItem({ reviewStatus: 'approved' }), // approved
      makeItem({ reviewStatus: 'declined' }) // declined
    ];
    const { nodes, links } = sankeyNodesAndLinks(items);
    const count = (name) => nodes.find((n) => n.name === name).count;
    expect(count('Ingested')).toBe(1);
    expect(count('Summarized')).toBe(3); // summarized + monitoring + curated
    expect(count('Monitoring')).toBe(1);
    expect(count('Curated: High Signal')).toBe(1);
    expect(count('Spec created')).toBe(1);
    expect(count('Approved')).toBe(1);
    expect(count('Declined')).toBe(1);
    expect(links.length).toBeGreaterThan(0);
  });

  it('honours the threshold boundary for the High Signal bucket', () => {
    const items = [
      makeItem({ reviewStatus: 'summarized', curation: { score: 6 } }), // below threshold
      makeItem({ reviewStatus: 'summarized', curation: { score: 7 } }), // at threshold
      makeItem({ reviewStatus: 'summarized', curation: { score: 8 } })  // above threshold
    ];
    const { nodes } = sankeyNodesAndLinks(items, { threshold: 7 });
    const monitoring = nodes.find((n) => n.name === 'Monitoring').count;
    const highSignal = nodes.find((n) => n.name === 'Curated: High Signal').count;
    expect(monitoring).toBe(1);
    expect(highSignal).toBe(2);
  });

  it('uses cumulative pass-through link values so the chain stays connected', () => {
    // 1 item approved, 1 tasked, 1 awaiting approval. The link from
    // "Awaiting approval" → "Approved" should carry 1 item, but the
    // link from "Spec created" → "Awaiting approval" should carry all
    // three (so the visual chain is unbroken).
    const items = [
      makeItem({ reviewStatus: 'approval_pending' }),
      makeItem({ reviewStatus: 'tasked' }),
      makeItem({ reviewStatus: 'approved' })
    ];
    const { links } = sankeyNodesAndLinks(items);
    const linkValue = (from, to) =>
      links.find((l) => l.source.name === from && l.target.name === to)?.value ?? 0;
    expect(linkValue('Awaiting approval', 'Approved')).toBe(1);
    expect(linkValue('Awaiting approval', 'Tasked')).toBe(1);
    expect(linkValue('Spec created', 'Awaiting approval')).toBe(3);
  });

  it('drops zero-value links (d3-sankey would render them degenerate)', () => {
    const items = [makeItem({ reviewStatus: 'pending' })];
    const { links } = sankeyNodesAndLinks(items);
    for (const link of links) expect(link.value).toBeGreaterThan(0);
  });

  it('treats summarized and summarised as the same pipeline position', () => {
    const items = [
      makeItem({ reviewStatus: 'summarized' }),
      makeItem({ reviewStatus: 'summarised' })
    ];
    const { nodes } = sankeyNodesAndLinks(items);
    expect(nodes.find((n) => n.name === 'Summarized').count).toBe(2);
  });
});

describe('stateCountsTimeSeries', () => {
  it('returns an empty series when items are missing', () => {
    const { statuses, points } = stateCountsTimeSeries([], [], { now: NOW });
    expect(statuses).toEqual([]);
    expect(points).toHaveLength(1); // the today fallback
  });

  it('renders a single baseline point when no transitions exist', () => {
    const items = [makeItem({ reviewStatus: 'summarized' })];
    const { statuses, points } = stateCountsTimeSeries(items, [], {
      windowValue: '7',
      now: NOW
    });
    expect(points.length).toBeGreaterThanOrEqual(1);
    // Last point carries the current snapshot.
    const last = points[points.length - 1];
    expect(last.counts.summarized).toBe(1);
    expect(statuses).toContain('summarized');
  });

  it('dedupes consecutive same-direction transitions per item', () => {
    // Without dedup, two summarized→monitoring transitions would push
    // the backward reconstruction below zero. With dedup, only one is
    // kept so counts stay >= 0.
    const items = [makeItem({ reviewStatus: 'monitoring', lastUpdatedAt: isoDaysAgo(1) })];
    const transitions = [
      { key: 'a', at: isoDaysAgo(2), from: 'summarized', to: 'monitoring' },
      { key: 'a', at: isoDaysAgo(1), from: 'monitoring', to: 'monitoring' } // duplicate
    ];
    const { points } = stateCountsTimeSeries(items, transitions, {
      windowValue: '7',
      now: NOW
    });
    for (const point of points) {
      expect(point.counts.monitoring).toBeGreaterThanOrEqual(0);
      expect(point.counts.summarized).toBeGreaterThanOrEqual(0);
    }
  });

  it('inflates the target status and decrements the source for transitions', () => {
    // An item was pending 2 days ago and got summarized 2 days ago.
    // Current snapshot says it's summarized; the chart should show it
    // flip from pending (before the transition) to summarized (after).
    const items = [makeItem({ key: 'a', reviewStatus: 'summarized', lastUpdatedAt: isoDaysAgo(1) })];
    const transitions = [
      { key: 'a', at: isoDaysAgo(2), from: 'pending', to: 'summarized' }
    ];
    const { points } = stateCountsTimeSeries(items, transitions, {
      windowValue: '7',
      now: NOW
    });
    const today = formatTimeSeriesDate(NOW);
    const dayFor = (daysAgo) => formatTimeSeriesDate(new Date(NOW.getTime() - daysAgo * 86400000));
    const todayPoint = points.find((p) => p.date === today);
    // One day before the transition: status was pending.
    const beforeTransition = points.find((p) => p.date === dayFor(3));
    expect(todayPoint.counts.summarized).toBe(1);
    expect(beforeTransition.counts.pending).toBe(1);
  });

  it('honours the topic filter (excludes items with other topics)', () => {
    const items = [
      makeItem({ topic: 'brain', reviewStatus: 'summarized' }),
      makeItem({ topic: 'infra', reviewStatus: 'approved' })
    ];
    const { points } = stateCountsTimeSeries(items, [], {
      windowValue: '7',
      topic: 'brain',
      now: NOW
    });
    const last = points[points.length - 1];
    expect(last.counts.summarized).toBe(1);
    expect(last.counts.approved || 0).toBe(0);
  });

  it('injects current curation buckets (Monitoring + High Signal) into the series', () => {
    const items = [
      makeItem({ key: 'a', reviewStatus: 'summarized', curation: { score: 9 } }),
      makeItem({ key: 'b', reviewStatus: 'summarized', curation: { score: 2 } })
    ];
    const { statuses, points } = stateCountsTimeSeries(items, [], {
      windowValue: '7',
      now: NOW
    });
    expect(statuses).toContain('Curated: High Signal');
    expect(statuses).toContain('Curated: Monitoring');
    const last = points[points.length - 1];
    expect(last.counts['Curated: High Signal']).toBe(1);
    expect(last.counts['Curated: Monitoring']).toBe(1);
  });

  it('handles a 7-day synthetic dataset (backward walk reaches back to first transition)', () => {
    // Timeline (relative to NOW):
    //   -6d: pending
    //   -5d at 12:00 UTC: pending → summarized
    //   -4d at 12:00 UTC: still summarized
    //   -3d at 12:00 UTC: summarized → approved
    //    0d (now): approved
    // We verify the chart reconstructs this by walking events
    // backward from each day-end.
    const items = [makeItem({ key: 'a', reviewStatus: 'approved', lastUpdatedAt: isoDaysAgo(0) })];
    const transitions = [
      { key: 'a', at: isoDaysAgo(5), from: 'pending', to: 'summarized' },
      { key: 'a', at: isoDaysAgo(3), from: 'summarized', to: 'approved' }
    ];
    const { points } = stateCountsTimeSeries(items, transitions, {
      windowValue: '7',
      now: NOW
    });
    const dateFor = (daysAgo) =>
      formatTimeSeriesDate(new Date(NOW.getTime() - daysAgo * 86400000));
    // Today (day 0): both transitions have happened → approved.
    const today = points.find((p) => p.date === dateFor(0));
    // Day 4 (one day before the approved transition): summarized.
    const dayBeforeApproved = points.find((p) => p.date === dateFor(4));
    // Day 6 (one day before the summarized transition): pending.
    const dayBeforeSummarized = points.find((p) => p.date === dateFor(6));
    expect(today.counts.approved).toBe(1);
    expect(dayBeforeApproved.counts.summarized).toBe(1);
    expect(dayBeforeSummarized.counts.pending).toBe(1);
  });
});