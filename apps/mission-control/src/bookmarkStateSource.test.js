import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { loadBookmarkState, bookmarkStateBaseUrl } from './bookmarkStateSource.js';

describe('bookmarkStateSource', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete import.meta.env.VITE_BOOKMARK_STATE_BASE_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses /api/state and /api/transitions from the same origin', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.endsWith('/api/state')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ version: 1, items: { a: { title: 'A' } } })
        });
      }
      if (url.endsWith('/api/transitions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve([
              { key: 'a', at: '2026-07-01T00:00:00Z', from: 'pending', to: 'summarized' }
            ])
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await loadBookmarkState();
    expect(result.error).toBeNull();
    expect(result.snapshot.items.a.title).toBe('A');
    expect(result.transitions).toHaveLength(1);
    expect(result.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns empty defaults when both endpoints 404', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    );

    const result = await loadBookmarkState();
    expect(result.snapshot).toEqual({ version: 1, items: {} });
    expect(result.transitions).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('surfaces non-404 errors via the error field and still returns partial data', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.endsWith('/api/state')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ version: 1, items: {} })
        });
      }
      if (url.endsWith('/api/transitions')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({})
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await loadBookmarkState();
    expect(result.error).toMatch(/transitions failed: HTTP 500/);
    expect(result.snapshot).toEqual({ version: 1, items: {} });
  });

  it('uses the configured baseUrl', async () => {
    const seenUrls = [];
    globalThis.fetch = vi.fn((url) => {
      seenUrls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          url.endsWith('/api/transitions')
            ? Promise.resolve([])
            : Promise.resolve({ version: 1, items: {} })
      });
    });

    await loadBookmarkState({ baseUrl: 'http://localhost:4001' });
    expect(seenUrls).toEqual([
      'http://localhost:4001/api/state',
      'http://localhost:4001/api/transitions'
    ]);
  });

  it('bookmarkStateBaseUrl honours VITE_BOOKMARK_STATE_BASE_URL', () => {
    import.meta.env.VITE_BOOKMARK_STATE_BASE_URL = 'http://override:9000';
    expect(bookmarkStateBaseUrl()).toBe('http://override:9000');
    delete import.meta.env.VITE_BOOKMARK_STATE_BASE_URL;
  });
});