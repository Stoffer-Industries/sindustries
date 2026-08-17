import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createItem,
  updateItem,
  approveItem,
  unapproveItem,
  publishItem,
  removeItem,
  reorderItems
} from './contentSchedulerApi.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockResponse = (data, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue({ data })
});

// Regression: services/tasks-api/src/app.ts mounts requireAuthenticatedUser
// on POST/PATCH/DELETE /api/v1/content-scheduler (task 0719a8e3), and the
// Tasks API runs on a different port than mission-control — a cross-origin
// request. Without credentials: 'include' the session cookie set by the
// Tasks app's login() is never sent, so every mutation (including the
// drag-to-reschedule "move tweet" flow) 401s.
describe('contentSchedulerApi mutations send the browser session cookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
