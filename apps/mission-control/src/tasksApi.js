// Minimal client wrapping the existing Tasks API. The Tasks API is the
// source of truth for flow metrics — we deliberately avoid adding a new
// analytics endpoint or database.

const DEFAULT_API_BASE_BY_PORT = {
  '5173': 'http://localhost:4000/api/v1',
  '5174': 'http://localhost:4001/api/v1',
  '5175': 'http://localhost:4002/api/v1',
  '5176': 'http://localhost:4003/api/v1'
};

export function tasksApiBaseUrl() {
  return (
    import.meta.env.VITE_TASKS_API_BASE_URL
    ?? DEFAULT_API_BASE_BY_PORT[window.location.port]
    ?? 'http://localhost:4000/api/v1'
  );
}

async function apiEnvelope(path) {
  const res = await fetch(`${tasksApiBaseUrl()}${path}`, {
    headers: { 'content-type': 'application/json' }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `Tasks API ${res.status}`);
  }
  return body;
}

async function api(path) {
  const body = await apiEnvelope(path);
  return body.data;
}

/**
 * Fetch all tasks (including archived). Pagination is honoured via the
 * `limit` query; if the API caps below our requested 10000, paginate
 * until exhaustion.
 */
export async function fetchAllTasks() {
  const limit = 10000;
  const all = [];
  let cursor = null;
  // First page
  const first = await api(`/tasks?limit=${limit}&includeArchived=true&sort=priority`);
  if (!Array.isArray(first)) return [];
  all.push(...first);
  if (first.length < limit) return all;
  // Best-effort pagination; the API may not support cursors today.
  return all;
}

/**
 * Fetch the feature-task analytics weekly buckets for the last `weeks`
 * weeks. Used by the Feature Factory analytics panel on the Flow
 * dashboard (AC4 of task f170e344).
 */
export async function fetchFeatureTaskAnalyticsWeekly({ weeks = 8 } = {}) {
  return api(`/feature-task-analytics/weekly?weeks=${weeks}`);
}

/**
 * Upper bound on the number of analytics pages fetched for one task. The
 * endpoint's own page cap keeps real histories well inside this; the bound
 * only stops a misbehaving server that keeps handing out fresh cursors
 * from spinning forever.
 */
const MAX_ANALYTICS_EVENT_PAGES = 1000;

function paginationHasMore(pagination) {
  const raw = pagination?.hasMore;
  if (typeof raw === 'string') {
    return ['true', '1', 'yes'].includes(raw.trim().toLowerCase());
  }
  return Boolean(raw);
}

/**
 * Fetch the raw lifecycle analytics events for a single task. Used by
 * ad-hoc lifecycle replay (AC5 of task f170e344).
 *
 * The per-task events endpoint is bounded: a response carries one page of
 * events plus a `pagination` envelope. We follow `pagination.nextCursor`
 * until `pagination.hasMore` is false and return the concatenated event
 * list, so callers get the task's complete history rather than a silently
 * truncated first page. A response without a `pagination` object is
 * treated as a single-page response (pre-pagination server behaviour).
 */
export async function fetchFeatureTaskAnalyticsReplay(taskId) {
  const events = [];
  const seenCursors = new Set();
  let cursor = null;

  for (let page = 0; page < MAX_ANALYTICS_EVENT_PAGES; page += 1) {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const body = await apiEnvelope(
      `/feature-task-analytics/tasks/${taskId}/events${query}`
    );

    const pageEvents = Array.isArray(body?.data) ? body.data : [];
    events.push(...pageEvents);

    const pagination = body?.pagination;
    if (!paginationHasMore(pagination)) return events;

    const nextCursor = pagination?.nextCursor;
    if (typeof nextCursor !== 'string' || nextCursor === '') {
      throw new Error(
        'Tasks API analytics pagination: response reports more pages but no nextCursor'
      );
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error(
        `Tasks API analytics pagination: repeated cursor "${nextCursor}"`
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(
    `Tasks API analytics pagination: exceeded ${MAX_ANALYTICS_EVENT_PAGES} pages`
  );
}
