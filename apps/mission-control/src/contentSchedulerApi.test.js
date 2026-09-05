import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createItem,
  updateItem,
  approveItem,
  unapproveItem,
  publishItem,
  removeItem,
  reorderItems,
  contentSchedulerApiBaseUrl
} from './contentSchedulerApi.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockResponse = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue({ data })
});

describe('contentSchedulerApiBaseUrl', () => {
  const originalPort = window.location.port;

  beforeEach(() => {
    delete import.meta.env.VITE_CONTENT_SCHEDULER_API_BASE_URL;
  });

  afterEach(() => {
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

  it('returns the build-time scheduler service override when set', () => {
    import.meta.env.VITE_CONTENT_SCHEDULER_API_BASE_URL = 'https://scheduler.example.com/api/v1';
    setPort('5175');
    expect(contentSchedulerApiBaseUrl()).toBe('https://scheduler.example.com/api/v1');
  });

  it('maps the Mission Control dev modes to the scheduler service ports', () => {
    setPort('5175');
    expect(contentSchedulerApiBaseUrl()).toBe('http://localhost:4004/api/v1');
    setPort('5176');
    expect(contentSchedulerApiBaseUrl()).toBe('http://localhost:4003/api/v1');
  });

  it('falls back to the scheduler service dev port on unknown ports', () => {
    setPort('9999');
    expect(contentSchedulerApiBaseUrl()).toBe('http://localhost:4003/api/v1');
  });
});

// The Content Scheduler API runs on a different port than Mission Control —
// a cross-origin request. Without credentials: 'include' the session cookie
// set by the Tasks app's login() is never sent, so every mutation (including
// the drag-to-reschedule "move tweet" flow) 401s.
describe('contentSchedulerApi mutations send the browser session cookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete import.meta.env.VITE_CONTENT_SCHEDULER_API_BASE_URL;
  });

  it('createItem', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 1 }));
    await createItem({ body: 'hi', source: 'manual', scheduledFor: '2026-08-20T00:00:00Z' });
    expect(mockFetch.mock.calls[0][1].credentials).toBe('include');
  });

  it('updateItem (drag-to-reschedule)', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 1 }));
    await updateItem(1, { scheduledFor: '2026-08-21T00:00:00Z' });
    expect(mockFetch.mock.calls[0][1].credentials).toBe('include');
  });

  it('approveItem', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 1 }));
    await approveItem(1, 'Tom');
    expect(mockFetch.mock.calls[0][1].credentials).toBe('include');
  });

  it('unapproveItem', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 1 }));
    await unapproveItem(1, 'Tom');
    expect(mockFetch.mock.calls[0][1].credentials).toBe('include');
  });

  it('publishItem', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 1 }));
    await publishItem(1, 'Tom');
    expect(mockFetch.mock.calls[0][1].credentials).toBe('include');
  });

  it('removeItem', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 1 }));
    await removeItem(1, 'Tom');
    expect(mockFetch.mock.calls[0][1].credentials).toBe('include');
  });

  it('reorderItems', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(null));
    await reorderItems([1, 2, 3], 'Tom');
    expect(mockFetch.mock.calls[0][1].credentials).toBe('include');
  });
});
