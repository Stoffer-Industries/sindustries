// Thin client for the Content Scheduler API endpoints.
//
// The scheduler is a separate service from tasks-api after the extraction.
// Its base URL is build-time configurable and has a local port fallback for
// the two Mission Control dev modes. All methods throw on non-2xx with the
// parsed error body attached.
//
// Task: 115e8d89-be43-4b81-9e0e-9ab422810f5f
// Tech design: docs/specs/content-scheduler-tab-tech-design.md

const DEFAULT_API_BASE_BY_PORT = {
  '5173': 'http://localhost:4000/api/v1',
  '5174': 'http://localhost:4001/api/v1',
  '5175': 'http://localhost:4004/api/v1',
  '5176': 'http://localhost:4003/api/v1'
};

export function contentSchedulerApiBaseUrl() {
  return (
    import.meta.env.VITE_CONTENT_SCHEDULER_API_BASE_URL
    ?? DEFAULT_API_BASE_BY_PORT[window.location.port]
    ?? 'http://localhost:4003/api/v1'
  );
}

async function request(path, { method = 'GET', body, actor } = {}) {
  const res = await fetch(`${contentSchedulerApiBaseUrl()}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(actor ? { 'x-actor': actor } : {})
    },
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const error = new Error(parsed?.error?.message ?? `Content Scheduler API ${res.status}`);
    error.code = parsed?.error?.code ?? 'UNKNOWN';
    error.status = res.status;
    throw error;
  }
  return parsed?.data ?? null;
}

export async function listItems(status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return request(`/content-scheduler/items${qs}`);
}

export async function createItem({ body, source, sourceRef, scheduledFor, actor }) {
  return request('/content-scheduler/items', {
    method: 'POST',
    body: { body, source, sourceRef, scheduledFor },
    actor
  });
}

export async function updateItem(id, patch, { actor } = {}) {
  return request(`/content-scheduler/items/${id}`, {
    method: 'PATCH',
    body: patch,
    actor
  });
}

export async function approveItem(id, actor) {
  return request(`/content-scheduler/items/${id}/approve`, { method: 'POST', actor });
}

export async function unapproveItem(id, actor) {
  return request(`/content-scheduler/items/${id}/unapprove`, { method: 'POST', actor });
}

export async function publishItem(id, actor) {
  return request(`/content-scheduler/items/${id}/publish`, { method: 'POST', actor });
}

export async function removeItem(id, actor) {
  return request(`/content-scheduler/items/${id}/remove`, { method: 'POST', actor });
}

export async function reorderItems(ids, actor) {
  return request('/content-scheduler/reorder', { method: 'POST', body: { ids }, actor });
}

export async function getTodayStatus() {
  return request('/content-scheduler/today-status');
}
