import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AkahuCancelledError,
  AkahuTimeoutError,
  akahuGetAccounts,
  akahuGetPendingTransactions,
  akahuGetTransactions,
  akahuRefreshAllAccounts,
  createAkahuBudget,
  exchangeAuthorizationCode,
  paginateAkahuTransactions
} from '../src/services/akahuClient';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body)),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }
  };
}

/** A fetch mock whose promise never settles, to drive stalled-header timeouts. */
function neverResolves() {
  return vi.fn(() => new Promise(() => {}));
}

/** A fetch mock that resolves headers but whose body `.text()` never settles. */
function stalledBody() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: vi.fn(() => new Promise(() => {})),
    headers: { get: () => null }
  }));
}

describe('akahuClient', () => {
  beforeEach(() => {
    process.env.AKAHU_CLIENT_ID = 'app_token_test';
    vi.restoreAllMocks();
  });

  it('requests an on-demand Akahu refresh with app and user tokens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await akahuRefreshAllAccounts({ accessToken: 'user_token_test' });

    expect(res).toEqual({ requested: true, rateLimited: false, message: null });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.akahu.io/v1/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer user_token_test',
          'X-Akahu-Id': 'app_token_test'
        }
      })
    );
  });

  it('treats Akahu refresh rate limits as non-fatal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(429, { success: false, message: 'Refresh initiated within last 5 minutes' })
      )
    );

    const res = await akahuRefreshAllAccounts({ accessToken: 'user_token_test' });

    expect(res).toEqual({
      requested: false,
      rateLimited: true,
      message: 'Refresh initiated within last 5 minutes'
    });
  });

  it('fetches pending transactions separately from settled transactions', async () => {
    const pending = [
      {
        _account: 'acc_123',
        date: '2026-05-12T00:00:00.000Z',
        description: 'PENDING CARD PURCHASE',
        amount: -12.34,
        type: 'EFTPOS'
      }
    ];
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, items: pending }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await akahuGetPendingTransactions({ accessToken: 'user_token_test' });

    expect(res).toEqual(pending);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.akahu.io/v1/transactions/pending',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer user_token_test',
          'X-Akahu-Id': 'app_token_test'
        }
      })
    );
  });

  describe('paginated transactions', () => {
    it('returns every page and repeats start/end with the cursor param', async () => {
      const pageOne = {
        success: true,
        items: [{ _id: 't1', _account: 'acc_1', date: '2026-05-01T00:00:00.000Z', description: 'a', amount: -1 }],
        cursor: { next: 'page-two' }
      };
      const pageTwo = {
        success: true,
        items: [{ _id: 't2', _account: 'acc_1', date: '2026-05-02T00:00:00.000Z', description: 'b', amount: -2 }],
        cursor: { next: null }
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, pageOne))
        .mockResolvedValueOnce(jsonResponse(200, pageTwo));
      vi.stubGlobal('fetch', fetchMock);

      const startMs = new Date('2026-05-01T00:00:00.000Z').getTime();
      const endMs = new Date('2026-05-03T00:00:00.000Z').getTime();

      const first = await akahuGetTransactions({ accessToken: 't', startMs, endMs });
      expect(first.items).toEqual(pageOne.items);
      expect(first.nextCursor).toBe('page-two');

      const second = await akahuGetTransactions({
        accessToken: 't',
        startMs,
        endMs,
        cursor: first.nextCursor!
      });
      expect(second.items).toEqual(pageTwo.items);
      expect(second.nextCursor).toBeNull();

      expect([...first.items, ...second.items]).toHaveLength(2);

      const [firstUrl] = fetchMock.mock.calls[0];
      const [secondUrl] = fetchMock.mock.calls[1];
      expect(new URL(firstUrl.toString()).searchParams.get('cursor')).toBeNull();
      expect(new URL(secondUrl.toString()).searchParams.get('cursor')).toBe('page-two');
      expect(new URL(secondUrl.toString()).searchParams.get('start')).toBe(
        new URL(firstUrl.toString()).searchParams.get('start')
      );
      expect(new URL(secondUrl.toString()).searchParams.get('end')).toBe(
        new URL(firstUrl.toString()).searchParams.get('end')
      );
    });

    it('stops traversal on a repeated cursor and reports incomplete', async () => {
      const page = {
        success: true,
        items: [{ _id: 't1', _account: 'acc_1', date: '2026-05-01T00:00:00.000Z', description: 'a', amount: -1 }],
        cursor: { next: 'same' }
      };
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, page)));

      const result = await paginateAkahuTransactions({ accessToken: 't' });

      expect(result.complete).toBe(false);
      // first page (cursor undefined) + the page fetched with cursor=same before the repeat is detected
      expect(result.pagesFetched).toBe(2);
    });

    it('treats an empty final page as complete traversal', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(200, { success: true, items: [], cursor: { next: null } }))
      );

      const result = await paginateAkahuTransactions({ accessToken: 't' });

      expect(result).toEqual({ items: [], complete: true, pagesFetched: 1 });
    });

    it('stops at the page cap and reports incomplete rather than success', async () => {
      let call = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          call += 1;
          return jsonResponse(200, {
            success: true,
            items: [{ _id: `t${call}`, _account: 'acc_1', date: '2026-05-01T00:00:00.000Z', description: 'a', amount: -1 }],
            cursor: { next: `cursor-${call}` }
          });
        })
      );

      const result = await paginateAkahuTransactions({ accessToken: 't', pageCap: 3 });

      expect(result.complete).toBe(false);
      expect(result.pagesFetched).toBe(3);
    });
  });

  describe('request deadlines', () => {
    beforeEach(() => {
      process.env.AKAHU_PER_CALL_TIMEOUT_MS = '30';
    });

    it('rejects with AKAHU_TIMEOUT when the provider never responds (stalled header)', async () => {
      vi.stubGlobal('fetch', neverResolves());

      await expect(akahuGetAccounts({ accessToken: 't' })).rejects.toThrow(AkahuTimeoutError);
    });

    it('rejects with AKAHU_TIMEOUT when the response body stalls', async () => {
      vi.stubGlobal('fetch', stalledBody());

      await expect(akahuGetAccounts({ accessToken: 't' })).rejects.toThrow(AkahuTimeoutError);
    });

    it('reports a caller cancellation as AKAHU_CANCELLED rather than a timeout', async () => {
      vi.stubGlobal('fetch', neverResolves());
      const controller = new AbortController();
      controller.abort();

      const err = await akahuGetAccounts({
        accessToken: 't',
        signal: controller.signal
      }).catch((e) => e);

      expect(err).toBeInstanceOf(AkahuCancelledError);
      expect(err).not.toBeInstanceOf(AkahuTimeoutError);
      expect(err.code).toBe('AKAHU_CANCELLED');
    });

    it('reports a mid-flight cancellation as AKAHU_CANCELLED rather than a timeout', async () => {
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          controller.abort();
          return new Promise(() => {});
        })
      );

      const err = await akahuGetAccounts({
        accessToken: 't',
        signal: controller.signal
      }).catch((e) => e);

      expect(err).toBeInstanceOf(AkahuCancelledError);
      expect(err.code).toBe('AKAHU_CANCELLED');
    });
  });

  describe('retry policy', () => {
    beforeEach(() => {
      process.env.AKAHU_PER_CALL_TIMEOUT_MS = '5000';
    });

    it('never retries the token exchange', async () => {
      process.env.AKAHU_CLIENT_SECRET = 'secret_test';
      process.env.AKAHU_REDIRECT_URI = 'https://example.test/callback';
      const fetchMock = vi.fn(async () => jsonResponse(500, { error: 'server_error' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(exchangeAuthorizationCode({ code: 'auth-code' })).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never retries /v1/refresh', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(429, { success: false, message: 'slow down' }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await akahuRefreshAllAccounts({ accessToken: 't' });

      expect(res.rateLimited).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 429 read a bounded number of times and then succeeds', async () => {
      let call = 0;
      const fetchMock = vi.fn(async () => {
        call += 1;
        if (call < 3) return jsonResponse(429, { success: false, message: 'rate limited' });
        return jsonResponse(200, { success: true, items: [{ _id: 'acc_1' }] });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await akahuGetAccounts({ accessToken: 't' });

      expect(res).toEqual([{ _id: 'acc_1' }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('bounds read retries by the whole-sync budget, not just the attempt count', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(429, { success: false, message: 'rate limited' }));
      vi.stubGlobal('fetch', fetchMock);
      const budget = createAkahuBudget(5);
      // Let the budget expire before the retry's pre-attempt budget check runs,
      // so the first attempt still happens but the retry is skipped.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The budget overrun is a deadline failure, not the provider's 429:
      // the two must be distinguishable at the route boundary.
      const err = await akahuGetAccounts({ accessToken: 't', budget }).catch((e) => e);

      expect(err).toBeInstanceOf(AkahuTimeoutError);
      expect(err.code).toBe('AKAHU_TIMEOUT');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
