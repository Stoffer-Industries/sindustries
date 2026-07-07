// Pure helpers for the Bookmarks pipeline tab. Mirrors the structure of
// flowMetrics.js: no React, no DOM, no I/O. All inputs are plain data.
//
// Definitions (see brain/tasks/specs/mc-bookmarks-tab-2026-07-07.md):
//   * `item` is a bookmark record from bookmark-review-state.json
//   * `transition` is a single JSONL event from bookmark-transitions.jsonl
//   * `reviewStatus` is the canonical pipeline state on each item
//   * `curation` (when present) is the curator's verdict: { score, topic, ... }
//
// The defaults below match the existing standalone dashboard
// (tools/bookmark-dashboard/index.html) so this module is a behavioural
// port, not a redesign.

export const DEFAULT_CURATION_THRESHOLD = 7;
export const DEFAULT_TOPIC = 'general';

export const DEFAULT_TIME_WINDOWS = [
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All', days: null }
];

// Canonical pipeline order. Items in the snapshot may also carry other
// reviewStatus values (legacy states, custom) — those are surfaced in
// KPIs but kept outside this ordered list.
export const PIPELINE_ORDER = [
  'pending',
  'ingested',
  'summarized',
  'monitoring',
  'curated_implement', // derived bucket: curation.score >= threshold and not yet past spec_requested
  'spec_requested',
  'spec_created',
  'revision_staged',
  'approval_pending',
  'tasked',
  'approved',
  'declined'
];

export function parseBookmarkDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function itemList(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const items = snapshot.items && typeof snapshot.items === 'object' ? snapshot.items : {};
  return Object.entries(items).map(([key, value]) => ({ key, ...(value || {}) }));
}

export function itemByKey(snapshot) {
  return new Map(itemList(snapshot).map((item) => [item.key, item]));
}

export function statusOf(item) {
  return item?.reviewStatus || 'pending';
}

export function topicOf(item) {
  if (!item) return DEFAULT_TOPIC;
  if (item.curation && item.curation.topic) return item.curation.topic;
  return item.topic || DEFAULT_TOPIC;
}

export function itemUpdatedAt(item) {
  if (!item) return null;
  return parseBookmarkDate(
    item.lastUpdatedAt || item.reviewedAt || item.firstSeenAt
  );
}

export function cutoffFromWindow(windowValue, now = new Date()) {
  const def = DEFAULT_TIME_WINDOWS.find((w) => w.value === windowValue) || DEFAULT_TIME_WINDOWS[1];
  if (!def || def.days == null) return null;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - def.days);
  cutoff.setHours(0, 0, 0, 0);
  return cutoff;
}

/**
 * Whether an item belongs in the current view scope (topic + time window).
 * `topic === 'all'` means no topic filter. `windowValue` is one of the
 * `DEFAULT_TIME_WINDOWS` values; `'all'` disables the time filter.
 */
export function inScopeItem(item, { topic = 'all', windowValue = '30', now = new Date() } = {}) {
  if (!item) return false;
  if (topic !== 'all' && topicOf(item) !== topic) return false;
  const cutoff = cutoffFromWindow(windowValue, now);
  if (!cutoff) return true;
  const updated = itemUpdatedAt(item);
  return !!updated && updated >= cutoff;
}

export function inScopeTransition(event, byKey, { topic = 'all', windowValue = '30', now = new Date(), useTime = true } = {}) {
  if (!event) return false;
  const item = byKey.get(event.key);
  if (topic !== 'all' && (!item || topicOf(item) !== topic)) return false;
  if (!useTime) return true;
  const cutoff = cutoffFromWindow(windowValue, now);
  if (!cutoff) return true;
  const at = parseBookmarkDate(event.at);
  return !!at && at >= cutoff;
}

/**
 * KPI counts for the snapshot, grouped by reviewStatus. Returns counts
 * for every status present in the snapshot plus the canonical pipeline
 * order so the KPI grid always renders the same labels.
 */
export function kpiCounts(items) {
  const counts = {};
  for (const status of PIPELINE_ORDER) counts[status] = 0;
  for (const item of items) {
    const status = statusOf(item);
    if (!(status in counts)) counts[status] = 0;
    counts[status] += 1;
  }
  // Inject the derived curation buckets so the dashboard reflects the
  // current curator verdict for items that haven't yet reached spec stages.
  const threshold = DEFAULT_CURATION_THRESHOLD;
  for (const item of items) {
    const c = item.curation;
    if (!c) continue;
    const status = statusOf(item);
    if (PIPELINE_ORDER.slice(5).includes(status)) continue; // past spec_requested
    const score = Number(c.score || 0);
    if (score >= threshold) counts.curated_implement += 1;
    else counts.monitoring += 1;
  }
  return counts;
}

/**
 * Bucket items into three curation groups:
 *   - implementBound: curated with score >= threshold (curator said yes)
 *   - curatedWaiting: curated with score <  threshold (curator said not now)
 *   - uncurated:      no curation verdict yet
 *
 * Filtered by `inScopeItem` first; sort keys match the standalone dashboard.
 */
export function curationGroups(items, { threshold = DEFAULT_CURATION_THRESHOLD, ...scope } = {}) {
  const implementBound = [];
  const curatedWaiting = [];
  const uncurated = [];

  for (const item of items) {
    if (!inScopeItem(item, scope)) continue;
    const c = item.curation;
    if (!c) {
      uncurated.push(item);
      continue;
    }
    const score = Number(c.score || 0);
    if (score >= threshold) implementBound.push(item);
    else curatedWaiting.push(item);
  }

  const sortByScoreDesc = (a, b) => (b.curation?.score || 0) - (a.curation?.score || 0);
  const sortByRecencyDesc = (a, b) => {
    const ta = a.curation?.createdAt ? new Date(a.curation.createdAt).getTime() : 0;
    const tb = b.curation?.createdAt ? new Date(b.curation.createdAt).getTime() : 0;
    return tb - ta;
  };
  const sortByUpdatedDesc = (a, b) =>
    (b.lastUpdatedAt || '').localeCompare(a.lastUpdatedAt || '');

  implementBound.sort(sortByScoreDesc);
  curatedWaiting.sort(sortByRecencyDesc);
  uncurated.sort(sortByUpdatedDesc);

  return { implementBound, curatedWaiting, uncurated, threshold };
}

/**
 * Funnel rows for the current scope. Returns `[{ status, count }]` in
 * pipeline order plus any extra statuses seen in the data, sorted by
 * pipeline order first then alphabetically for unknown statuses.
 */
export function funnelRows(items) {
  const counts = kpiCounts(items);
  const seen = new Set(Object.keys(counts));
  const ordered = [
    ...PIPELINE_ORDER.filter((s) => seen.has(s)),
    ...[...seen].filter((s) => !PIPELINE_ORDER.includes(s)).sort()
  ];
  return ordered
    .filter((s) => counts[s] > 0)
    .map((status) => ({ status, count: counts[status] }));
}

/**
 * Topic counts for the current time scope (topic filter does NOT apply
 * here — that would defeat the purpose of showing the topic breakdown).
 */
export function topicCounts(items, { windowValue = '30', now = new Date() } = {}) {
  const counts = {};
  for (const item of items) {
    if (!inScopeItem(item, { topic: 'all', windowValue, now })) continue;
    const topic = topicOf(item);
    counts[topic] = (counts[topic] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => ({ topic, count }));
}

/**
 * Recent transitions in scope, newest first, limited to `limit`.
 */
export function recentTransitions(transitions, byKey, { limit = 20, ...scope } = {}) {
  if (!Array.isArray(transitions)) return [];
  return transitions
    .filter((event) => inScopeTransition(event, byKey, scope))
    .slice()
    .sort((a, b) => {
      const ta = parseBookmarkDate(a.at)?.getTime() ?? 0;
      const tb = parseBookmarkDate(b.at)?.getTime() ?? 0;
      return tb - ta;
    })
    .slice(0, limit);
}

/**
 * Pending approvals banner rows: each topic in `approvalLocks` becomes a
 * row with item count and requestedAt age. Returns [] when there are no
 * pending locks.
 */
export function pendingApprovals(snapshot) {
  const locks = snapshot?.approvalLocks;
  if (!locks || typeof locks !== 'object') return [];
  return Object.entries(locks).map(([topic, lock]) => ({
    topic,
    itemCount: Array.isArray(lock?.items) ? lock.items.length : 0,
    requestedAt: lock?.requestedAt || null
  }));
}

export function availableTopics(items) {
  const set = new Set();
  for (const item of items) set.add(topicOf(item));
  return [...set].sort();
}

export function formatRelativeAge(iso, now = new Date()) {
  if (!iso) return '';
  const then = parseBookmarkDate(iso);
  if (!then) return '';
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}