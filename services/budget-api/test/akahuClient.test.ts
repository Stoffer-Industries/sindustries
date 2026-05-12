import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  akahuGetPendingTransactions,
  akahuRefreshAllAccounts
} from '../src/services/akahuClient.ts';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body))
  };
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
    expect(fetchMock).toHaveBeenCalledWith('https://api.akahu.io/v1/refresh', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user_token_test',
        'X-Akahu-Id': 'app_token_test'
      }
    });
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
    expect(fetchMock).toHaveBeenCalledWith('https://api.akahu.io/v1/transactions/pending', {
      headers: {
        Authorization: 'Bearer user_token_test',
        'X-Akahu-Id': 'app_token_test'
      }
    });
  });
});
