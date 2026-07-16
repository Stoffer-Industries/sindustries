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

/**
 * Render a Date as `YYYY-MM-DD` in UTC. Used for the states-over-time
 * chart and the Sankey legend. Mirrors `fmtDate` in the standalone
 * dashboard (`tools/bookmark-dashboard/index.html`).
 */
export function formatTimeSeriesDate(date) {
  if (date == null) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0')
  ].join('-');
}

/**
 * Status color tokens. Mirrors the standalone dashboard's `colors` map.
 * The standalone dashboard uses raw hex values for some legacy statuses
 * that don't have a matching design-system token (Q6 in the prior
 * design). We centralise them here so the tab inherits the design
 * tokens where they exist and only deviates for legacy states.
 */
export const STATUS_COLOR_VAR = {
  pending: 'var(--si-color-graphite-500, #8aa0bd)',
  ingested: 'var(--si-color-graphite-500, #8aa0bd)',
  summarized: 'var(--si-color-graphite-700, #5a6b83)',
  monitoring: 'var(--si-color-brand-700, #b46a00)',
  curated_implement: 'var(--si-color-info-500, #2f75d6)',
  'Curated: Monitoring': 'var(--si-color-brand-700, #b46a00)',
  'Curated: High Signal': 'var(--si-color-info-500, #2f75d6)',
  spec_requested: 'var(--si-color-accent-500, #5e3f8a)',
  spec_created: 'var(--si-color-accent-500, #bd1e66)',
  revision_staged: '#7254bd',
  revision_requested: '#9a6fd8',
  approval_pending: 'var(--si-color-accent-500, #d9257a)',
  tasked: 'var(--si-color-success-500, #148f46)',
  approved: 'var(--si-color-success-500, #0f9b59)',
  declined: 'var(--si-color-danger-500, #a3312b)',
  reviewed: 'var(--si-color-neutral-200, #c8d0db)',
  summarised: 'var(--si-color-neutral-200, #c8d0db)',
  queued_for_spec: 'var(--si-color-neutral-200, #c8d0db)'
};

/**
 * Sankey diagram input for the curation pipeline. Mirrors
 * `computeSankeyData()` in the standalone dashboard. Returns
 * `{ nodes: [...], links: [...] }` ready for `d3-sankey` layout.
 *
 * Cumulative pass-through: each link's value = items currently AT or
 * PAST the target stage. This keeps every link visible even when items
 * have moved on, and matches the standalone dashboard's documented
 * behaviour.
 *
 * `threshold` controls the `Curated: High Signal` bucket boundary and
 * defaults to `DEFAULT_CURATION_THRESHOLD` so callers don't have to
 * remember the magic number.
 *
 * Returns `null` when the snapshot has no items (the caller should
 * render the empty state instead of an empty Sankey).
 */
export function sankeyNodesAndLinks(items, { threshold = DEFAULT_CURATION_THRESHOLD } = {}) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const buckets = {
    ingested: 0,
    summarized: 0,
    monitoring: 0,
    curatedImplement: 0,
    specRequested: 0,
    specCreated: 0,
    approvalPending: 0,
    tasked: 0,
    approved: 0,
    declined: 0
  };

  for (const item of items) {
    const status = item?.reviewStatus;
    const c = item?.curation;
    const hasCuration = !!c;
    const score = c ? Number(c.score || 0) : 0;
    const highScore = hasCuration && score >= threshold;
    const isSummarized = status === 'summarized' || status === 'summarised';

    if (status === 'spec_requested') buckets.specRequested += 1;
    else if (status === 'spec_created') buckets.specCreated += 1;
    else if (status === 'approval_pending' || status === 'revision_staged') buckets.approvalPending += 1;
    else if (status === 'tasked') buckets.tasked += 1;
    else if (status === 'approved') buckets.approved += 1;
    else if (status === 'declined') buckets.declined += 1;
    else if (highScore) buckets.curatedImplement += 1;
    else if (hasCuration) buckets.monitoring += 1; // low-score curation verdict
    else if (isSummarized) buckets.summarized += 1;
    else buckets.ingested += 1;
  }

  // `count` = items currently AT this bucket (matches funnel).
  // `value` = used by d3-sankey for visual sizing (kept 0 for transient
  // stages that should still render as connected nodes).
  const summarizedCurrent = buckets.summarized + buckets.monitoring + buckets.curatedImplement;
  const nodeDefs = [
    { name: 'Ingested', count: buckets.ingested, value: buckets.ingested, color: '#8aa0bd' },
    { name: 'Summarized', count: summarizedCurrent, value: buckets.summarized, color: '#5a6b83' },
    { name: 'Monitoring', count: buckets.monitoring, value: buckets.monitoring, color: '#b46a00' },
    { name: 'Curated: High Signal', count: buckets.curatedImplement, value: buckets.curatedImplement, color: '#2f75d6' },
    { name: 'Spec requested', count: buckets.specRequested, value: buckets.specRequested, color: '#5e3f8a' },
    { name: 'Spec created', count: buckets.specCreated, value: buckets.specCreated, color: '#bd1e66' },
    { name: 'Awaiting approval', count: buckets.approvalPending, value: buckets.approvalPending, color: '#d9257a' },
    { name: 'Tasked', count: buckets.tasked, value: buckets.tasked, color: '#148f46' },
    { name: 'Approved', count: buckets.approved, value: buckets.approved, color: '#0f9b59' },
    { name: 'Declined', count: buckets.declined, value: buckets.declined, color: '#a3312b' }
  ];
  const nodes = nodeDefs.map((d) => ({ ...d }));

  // Cumulative pass-through link values: items AT or PAST the target
  // stage. Keeps every link visible even when items have moved on.
  const approvalAndBeyond = buckets.approvalPending + buckets.tasked + buckets.approved + buckets.declined;
  const specCreatedAndBeyond = buckets.specCreated + approvalAndBeyond;
  const specRequestedAndBeyond = buckets.specRequested + specCreatedAndBeyond;
  const implementBoundTotal = buckets.curatedImplement + specRequestedAndBeyond;
  const summarizedTotal = buckets.summarized + buckets.monitoring + implementBoundTotal;

  const linkDefs = [
    { source: 'Ingested', target: 'Summarized', value: summarizedTotal },
    { source: 'Summarized', target: 'Monitoring', value: buckets.monitoring },
    { source: 'Summarized', target: 'Curated: High Signal', value: implementBoundTotal },
    { source: 'Curated: High Signal', target: 'Spec requested', value: specRequestedAndBeyond },
    { source: 'Spec requested', target: 'Spec created', value: specCreatedAndBeyond },
    { source: 'Spec created', target: 'Awaiting approval', value: approvalAndBeyond },
    { source: 'Awaiting approval', target: 'Tasked', value: buckets.tasked },
    { source: 'Awaiting approval', target: 'Approved', value: buckets.approved },
    { source: 'Awaiting approval', target: 'Declined', value: buckets.declined }
  ];
  const links = linkDefs
    .filter((l) => l.value > 0)
    .map((l) => ({
      source: nodes.find((n) => n.name === l.source),
      target: nodes.find((n) => n.name === l.target),
      value: l.value
    }));

  return { nodes, links };
}

/**
 * Time-series dataset for the states-over-time line chart. Mirrors
 * `seriesData()` in the standalone dashboard.
 *
 * The dataset reconstructs historical state counts by walking
 * transitions backward from each day-end and decrementing the target
 * status while incrementing the source status. This is the only
 * portable reconstruction we have without time-machine queries into
 * the snapshot.
 *
 * Consecutive same-direction transitions per item are deduped: the
 * lobster can re-apply the same status on every run without changing
 * actual state, and each duplicate would inflate the event count and
 * break the backward walk (push counts below zero).
 *
 * Curation buckets (`Curated: Monitoring`, `Curated: High Signal`) are
 * injected into the current snapshot before the backward walk so the
 * chart renders them from day 1.
 *
 * `topic` filters the items the time series is built from (without the
 * scope-of-state filter that `inScopeItem` applies). `windowValue`
 * controls how many days back we render. `'all'` walks from the
 * earliest transition.
 */
export function stateCountsTimeSeries(items, transitions, { windowValue = '30', topic = 'all', now = new Date(), threshold = DEFAULT_CURATION_THRESHOLD } = {}) {
  const scopedItems = (items || []).filter((item) => {
    if (!item) return false;
    if (topic !== 'all' && topicOf(item) !== topic) return false;
    return true;
  });

  // Empty short-circuit: no items + no transitions = nothing to render.
  // Caller can detect this and show the empty state instead of a flat
  // line at zero across 30 days.
  if (scopedItems.length === 0 && (!Array.isArray(transitions) || transitions.length === 0)) {
    const today = formatTimeSeriesDate(now);
    return { statuses: [], points: [{ date: today, counts: {} }] };
  }

  const relevantKeys = new Set(scopedItems.map((item) => item.key));

  // Sort + dedupe consecutive same-direction transitions.
  const rawEvents = (Array.isArray(transitions) ? transitions : [])
    .filter((event) => relevantKeys.has(event?.key))
    .filter((event) => !!parseBookmarkDate(event?.at))
    .slice()
    .sort((a, b) => parseBookmarkDate(a.at) - parseBookmarkDate(b.at));

  const lastStateSeen = new Map();
  const events = rawEvents.filter((event) => {
    if (!event.key || !event.to) return true;
    if (lastStateSeen.get(event.key) === event.to) return false;
    lastStateSeen.set(event.key, event.to);
    return true;
  });

  // Build the date axis: from cutoff (or earliest transition) to today.
  const dates = [];
  const cutoff = cutoffFromWindow(windowValue, now);
  const earliest = events.length ? parseBookmarkDate(events[0].at) : null;
  const startDate = cutoff || earliest || now;
  const today = new Date(now);
  today.setHours(23, 59, 59, 999);
  for (let d = new Date(startDate); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(formatTimeSeriesDate(new Date(d)));
  }
  if (!dates.length) dates.push(formatTimeSeriesDate(today));

  // Statuses we render = union of pipeline order, the two curation
  // bucket labels (so the chart shows them from day 1), current item
  // statuses, and any from/to seen in events.
  const statuses = [
    ...new Set([
      ...PIPELINE_ORDER,
      'Curated: Monitoring',
      'Curated: High Signal',
      ...scopedItems.map(statusOf),
      ...events.flatMap((e) => [e.from, e.to]).filter(Boolean)
    ])
  ];

  // Current snapshot counts (what's true right now).
  const current = {};
  for (const status of statuses) current[status] = 0;
  for (const item of scopedItems) {
    const status = statusOf(item);
    if (!(status in current)) current[status] = 0;
    current[status] += 1;
  }
  // Inject current curation bucket counts. The transitions log will
  // start emitting these as from/to events from the next heartbeat
  // onwards (validate_curate_output.py now logs "Curated: Monitoring"
  // and "Curated: High Signal" transitions), so historical buckets
  // build up over time.
  let curMonitoring = 0;
  let curHighSignal = 0;
  const pastSpecStages = new Set([
    'spec_requested',
    'spec_created',
    'approval_pending',
    'revision_staged',
    'revision_requested',
    'tasked',
    'approved',
    'declined'
  ]);
  for (const item of scopedItems) {
    const c = item.curation;
    if (!c) continue;
    const st = statusOf(item);
    if (pastSpecStages.has(st)) continue;
    if (Number(c.score || 0) >= threshold) curHighSignal += 1;
    else curMonitoring += 1;
  }
  current['Curated: Monitoring'] = curMonitoring;
  current['Curated: High Signal'] = curHighSignal;

  const points = dates.map((date) => {
    const counts = { ...current };
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    // Walk events backward: for any transition AFTER dayEnd, undo it
    // (decrement target, increment source). Stop when we cross dayEnd.
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      const eventAt = parseBookmarkDate(event.at);
      if (!eventAt || eventAt <= dayEnd) break;
      if (event.to) counts[event.to] = Math.max(0, (counts[event.to] || 0) - 1);
      if (event.from) counts[event.from] = (counts[event.from] || 0) + 1;
    }
    return { date, counts };
  });

  // Only return statuses that actually have at least one non-zero point.
  const visibleStatuses = statuses.filter((s) => points.some((p) => (p.counts[s] || 0) > 0));
  return { statuses: visibleStatuses, points };
}