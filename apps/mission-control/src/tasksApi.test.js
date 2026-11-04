import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchFeatureTaskAnalyticsReplay, tasksApiBaseUrl } from './tasksApi.js';

describe('tasksApiBaseUrl', () => {
  const originalPort = window.location.port;

  beforeEach(() => {
    delete import.meta.env.VITE_TASKS_API_BASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      value: { port: originalPort },
      configurable: true
    });
  });

  function setPort(port) {
    Object.defineProperty(window, 'location', {
      value: { port },
      configurable: true
    });
  }

  it('returns the build-time env override when set', () => {
    import.meta.env.VITE_TASKS_API_BASE_URL = 'https://api.example.com/api/v1';
    setPort('5173');
    expect(tasksApiBaseUrl()).toBe('https://api.example.com/api/v1');
  });

  it('returns the port-mapped URL for known dev ports', () => {
    setPort('5173');
    expect(tasksApiBaseUrl()).toBe('http://localhost:4000/api/v1');
    setPort('5174');
    expect(tasksApiBaseUrl()).toBe('http://localhost:4001/api/v1');
  });

  it('falls back to the tasks-api default port (4000) on unknown ports', () => {
    setPort('9999');
    expect(tasksApiBaseUrl()).toBe('http://localhost:4000/api/v1');
  });
});

// Task 75032fad: the per-task analytics events endpoint is bounded, so the
// replay helper has to follow `pagination.nextCursor` instead of returning
// the first page and silently truncating the task's history.
describe('fetchFeatureTaskAnalyticsReplay', () => {
  function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
  }

  beforeEach(() => {
    delete import.meta.env.VITE_TASKS_API_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('follows pagination cursors and concatenates the pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'event-1' }],
          pagination: { limit: 500, returned: 1, hasMore: true, nextCursor: 'cursor-1' }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'event-2' }],
          pagination: { limit: 500, returned: 1, hasMore: false, nextCursor: null }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchFeatureTaskAnalyticsReplay('task-1');

    expect(events.map((event) => event.id)).toEqual(['event-1', 'event-2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain(
      '/feature-task-analytics/tasks/task-1/events'
    );
    expect(fetchMock.mock.calls[0][0]).not.toContain('cursor=');
    expect(fetchMock.mock.calls[1][0]).toContain(
      '/feature-task-analytics/tasks/task-1/events?cursor=cursor-1'
    );
  });

  it('returns a single page unchanged when the server sends no pagination', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'event-1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchFeatureTaskAnalyticsReplay('task-1');

    expect(events.map((event) => event.id)).toEqual(['event-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails instead of looping when the server repeats a cursor', async () => {
    const page = {
      data: [{ id: 'event-1' }],
      pagination: { limit: 500, returned: 1, hasMore: true, nextCursor: 'cursor-1' }
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFeatureTaskAnalyticsReplay('task-1')).rejects.toThrow(
      /repeated cursor/
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails when the server reports more pages without a cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'event-1' }],
        pagination: { limit: 500, returned: 1, hasMore: true, nextCursor: null }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFeatureTaskAnalyticsReplay('task-1')).rejects.toThrow(
      /nextCursor/
    );
  });
});
