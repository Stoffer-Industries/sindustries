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
    expect(result.compoundingSignal.status).toBe('missing');
    expect(result.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('classifies a valid compounding signal payload', async () => {
    const validSignal = {
      schemaVersion: 1,
      runId: '2026-08-17T20:15:00Z',
      generatedAt: '2026-08-17T20:15:00Z',
      asOf: '2026-08-17T20:15:00Z',
      headlinePercentage: 37.5,
      currentWindow: {
        start: '2026-08-10T20:15:00Z',
        end: '2026-08-17T20:15:00Z',
        eligibleCount: 8,
        referencedCount: 3,
        percentage: 37.5,
        dossierPromotionCount: 2
      },
      trend: [
        { offsetWeeks: 0, start: '2026-08-10T20:15:00Z', end: '2026-08-17T20:15:00Z', eligibleCount: 8, referencedCount: 3, percentage: 37.5 },
        { offsetWeeks: 1, start: '2026-08-03T20:15:00Z', end: '2026-08-10T20:15:00Z', eligibleCount: 6, referencedCount: 1, percentage: 16.7 },
        { offsetWeeks: 2, start: '2026-07-27T20:15:00Z', end: '2026-08-03T20:15:00Z', eligibleCount: 5, referencedCount: 1, percentage: 20.0 },
        { offsetWeeks: 3, start: '2026-07-20T20:15:00Z', end: '2026-07-27T20:15:00Z', eligibleCount: 4, referencedCount: 0, percentage: 0.0 }
      ],
      operatorNote: null,
      decisionPolicy: {
        lowPercentageBelow: 25.0,
        corpusEstablishedDocuments: 25,
        minimumFourWeekEligibleItemsForBrokenPath: 10
      },
      inputs: {
        bookmarkState: { path: 'x' },
        corpusIndex: { path: 'y' },
        dossierPromotions: { path: 'z' }
      }
    };
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
          ok: true,
          status: 200,
          json: () => Promise.resolve([])
        });
      }
      if (url.endsWith('/api/compounding-signal')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(validSignal))
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await loadBookmarkState();
    expect(result.compoundingSignal.status).toBe('valid');
    expect(result.compoundingSignal.signal.headlinePercentage).toBe(37.5);
  });

  it('reports a malformed compounding signal payload as malformed', async () => {
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
          ok: true,
          status: 200,
          json: () => Promise.resolve([])
        });
      }
      if (url.endsWith('/api/compounding-signal')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('')
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await loadBookmarkState();
    expect(result.compoundingSignal.status).toBe('malformed');
  });

  it('returns empty defaults when both endpoints 404', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
    );

    const result = await loadBookmarkState();
    expect(result.snapshot).toEqual({ version: 1, items: {} });
    expect(result.transitions).toEqual([]);
    expect(result.compoundingSignal.status).toBe('missing');
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
      if (url.endsWith('/api/compounding-signal')) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      }
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
      'http://localhost:4001/api/transitions',
      'http://localhost:4001/api/compounding-signal'
    ]);
  });

  it('bookmarkStateBaseUrl honours VITE_BOOKMARK_STATE_BASE_URL', () => {
    import.meta.env.VITE_BOOKMARK_STATE_BASE_URL = 'http://override:9000';
    expect(bookmarkStateBaseUrl()).toBe('http://override:9000');
    delete import.meta.env.VITE_BOOKMARK_STATE_BASE_URL;
  });
});