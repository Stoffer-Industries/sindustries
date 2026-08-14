import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAdminClient = {
  auth: { getUser: vi.fn() },
  from: vi.fn()
};

vi.mock('../../server/oauthAuth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adminClient: () => mockAdminClient
  };
});

import handler from '../../api/connected-agents/revoke.js';

function buildChain(terminal) {
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve) => resolve(terminal);
        if (prop === 'single') return () => Promise.resolve(terminal);
        if (prop === 'maybeSingle') return () => Promise.resolve(terminal);
        return () => proxy;
      }
    }
  );
  return proxy;
}

function makeRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/connected-agents/revoke', () => {
  it('returns 405 for non-POST methods', async () => {
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expect(res.body).toEqual({ error: 'method_not_allowed' });
  });

  it('returns 401 when the user session is missing', async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: { consentId: 'consent-1' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('invalid_session');
  });

  it('revokes the consent family for the signed-in user', async () => {
    mockAdminClient.auth.getUser.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null
    });
    mockAdminClient.from
      .mockReturnValueOnce(buildChain({ data: { id: 'consent-1', user_id: 'user-1' }, error: null }))
      .mockReturnValueOnce(buildChain({ error: null }))
      .mockReturnValueOnce(buildChain({ error: null }))
      .mockReturnValueOnce(buildChain({ error: null }));

    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: { authorization: 'Bearer supabase-user-token' },
        body: { consentId: 'consent-1' }
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockAdminClient.from.mock.calls.map(([table]) => table)).toEqual([
      'gymtrack_oauth_consents',
      'gymtrack_oauth_consents',
      'gymtrack_oauth_tokens',
      'gymtrack_oauth_authorization_codes'
    ]);
  });
});
