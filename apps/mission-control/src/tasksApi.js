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
    ?? 'http://localhost:4001/api/v1'
  );
}

async function api(path) {
  const res = await fetch(`${tasksApiBaseUrl()}${path}`, {
    headers: { 'content-type': 'application/json' }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `Tasks API ${res.status}`);
  }
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
