import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Mock @supabase/supabase-js so we can control the client factory and the
// chainable queries used by adminClient() and resolveOAuthIdentity().
const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient
}));

import {
  _resetAdminClientForTests,
  adminClient,
  badRequest,
  hashToken,
  parseBearerToken,
  rejectIfWrongMethod,
  resolveOAuthIdentity,
  scopeAllows,
  SUPPORTED_SCOPES,
  unauthorized
} from '../../server/oauthAuth.js';

function buildChain(terminal) {
  // Returns a Proxy that is chainable for any method, and resolves to `terminal`
  // at the end (supports `.single()` and `.maybeSingle()` explicit terminators).
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

const ORIGINAL_ENV = { ...process.env };

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

function futureIso(secondsAhead = 3600) {
  return new Date(Date.now() + secondsAhead * 1000).toISOString();
}

function pastIso(secondsAgo = 60) {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

beforeEach(() => {
  _resetAdminClientForTests();
  mockCreateClient.mockReset();
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('hashToken', () => {
  it('returns a 64-character lowercase hex SHA-256 digest', () => {
    const token = 'abc123token';
    const expected = createHash('sha256').update(token).digest('hex');
    expect(hashToken(token)).toBe(expected);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(hashToken('hello')).toBe(hashToken('hello'));
  });

  it('produces different digests for different inputs', () => {
    expect(hashToken('hello')).not.toBe(hashToken('hellp'));
  });
});

describe('parseBearerToken', () => {
  it('extracts the token from a standard Authorization header', () => {
    expect(parseBearerToken({ headers: { authorization: 'Bearer abc123' } })).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseBearerToken({ headers: { authorization: 'bearer abc123' } })).toBe('abc123');
    expect(parseBearerToken({ headers: { authorization: 'BEARER abc123' } })).toBe('abc123');
  });

  it('returns null when the header is missing', () => {
    expect(parseBearerToken({ headers: {} })).toBeNull();
    expect(parseBearerToken({})).toBeNull();
    expect(parseBearerToken(null)).toBeNull();
  });

  it('returns null when the scheme is wrong', () => {
    expect(parseBearerToken({ headers: { authorization: 'Basic abc123' } })).toBeNull();
    expect(parseBearerToken({ headers: { authorization: 'Token abc123' } })).toBeNull();
  });

  it('returns null when the token is empty or whitespace only', () => {
    expect(parseBearerToken({ headers: { authorization: 'Bearer ' } })).toBeNull();
    expect(parseBearerToken({ headers: { authorization: 'Bearer\t' } })).toBeNull();
  });

  it('accepts a capitalized Authorization header (Node convention)', () => {
    expect(parseBearerToken({ headers: { Authorization: 'Bearer xyz' } })).toBe('xyz');
  });

  it('tolerates extra whitespace between the scheme and the token', () => {
    expect(parseBearerToken({ headers: { authorization: 'Bearer   multi-token' } })).toBe(
      'multi-token'
    );
  });
});

describe('rejectIfWrongMethod', () => {
  it('returns false and does not respond when the method is allowed', () => {
    const res = makeRes();
    const sent = rejectIfWrongMethod({ method: 'POST' }, res, ['POST']);
    expect(sent).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
  });

  it('responds 405 with the Allow header when the method is not allowed', () => {
    const res = makeRes();
    const sent = rejectIfWrongMethod({ method: 'GET' }, res, ['POST']);
    expect(sent).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expect(res.body).toEqual({ error: 'method_not_allowed' });
  });

  it('accepts the method case-insensitively', () => {
    const res = makeRes();
    const sent = rejectIfWrongMethod({ method: 'post' }, res, ['POST']);
    expect(sent).toBe(false);
  });

  it('lists every allowed method in the Allow header', () => {
    const res = makeRes();
    rejectIfWrongMethod({ method: 'PATCH' }, res, ['GET', 'POST']);
    expect(res.headers.Allow).toBe('GET, POST');
  });
});

describe('unauthorized', () => {
  it('responds 401 with the default error code', () => {
    const res = makeRes();
    unauthorized(res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_api_key' });
  });

  it('honours a custom error message', () => {
    const res = makeRes();
    unauthorized(res, 'missing_api_key');
    expect(res.body).toEqual({ error: 'missing_api_key' });
  });
});

describe('badRequest', () => {
  it('responds 400 with the canonical invalid_request shape', () => {
    const res = makeRes();
    badRequest(res, 'title is required');
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request', message: 'title is required' });
  });
});

describe('adminClient', () => {
  it('throws a clear deploy-time error if VITE_SUPABASE_URL is missing', () => {
    delete process.env.VITE_SUPABASE_URL;
    expect(() => adminClient()).toThrow(/VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('throws a clear deploy-time error if SUPABASE_SERVICE_ROLE_KEY is missing', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => adminClient()).toThrow(/VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('memoizes the client so createClient is only called once across calls', () => {
    mockCreateClient.mockReturnValue({ from: vi.fn() });
    const a = adminClient();
    const b = adminClient();
    expect(a).toBe(b);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it('recreates the client after _resetAdminClientForTests', () => {
    // mockImplementation (not mockReturnValue) so each createClient call returns
    // a fresh client object — mockReturnValue would return the same reference
    // every call and break the `a !== b` identity assertion below.
    mockCreateClient.mockImplementation(() => ({ from: vi.fn() }));
    const a = adminClient();
    _resetAdminClientForTests();
    const b = adminClient();
    expect(a).not.toBe(b);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it('uses auth: { persistSession: false, autoRefreshToken: false }', () => {
    mockCreateClient.mockReturnValue({ from: vi.fn() });
    adminClient();
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'service-role-key',
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  });
});

describe('SUPPORTED_SCOPES + scopeAllows', () => {
  it('lists the canonical three scopes', () => {
    expect(SUPPORTED_SCOPES).toEqual([
      'workouts:write',
      'history:read',
      'progression:read'
    ]);
  });

  it('returns true for an exact scope match', () => {
    expect(scopeAllows('history:read', 'history:read')).toBe(true);
  });

  it('returns true when the required scope is one of several granted', () => {
    expect(scopeAllows('workouts:write history:read progression:read', 'history:read')).toBe(true);
  });

  it('returns false when the required scope is not granted', () => {
    expect(scopeAllows('history:read', 'workouts:write')).toBe(false);
  });

  it('returns false for empty or missing scope strings', () => {
    expect(scopeAllows('', 'history:read')).toBe(false);
    expect(scopeAllows(null, 'history:read')).toBe(false);
    expect(scopeAllows(undefined, 'history:read')).toBe(false);
  });
});

describe('resolveOAuthIdentity', () => {
  it('returns null when the Authorization header is missing without hitting the DB', async () => {
    mockCreateClient.mockReturnValue({ from: vi.fn() });
    const result = await resolveOAuthIdentity({ headers: {} });
    expect(result).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns null when the bearer scheme is missing', async () => {
    mockCreateClient.mockReturnValue({ from: vi.fn() });
    const result = await resolveOAuthIdentity({ headers: { authorization: 'Basic abc' } });
    expect(result).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns the resolved identity on success and includes consent_id + scope', async () => {
    const tokenHash = hashToken('good-token');
    const tokenRow = {
      id: 'token-1',
      consent_id: 'consent-1',
      user_id: 'user-1',
      client_id: 'claude-desktop',
      scope: 'history:read workouts:write progression:read',
      access_token_expires_at: futureIso(),
      revoked_at: null
    };
    const consentRow = {
      id: 'consent-1',
      user_id: 'user-1',
      client_id: 'claude-desktop',
      scope: 'history:read workouts:write progression:read',
      revoked_at: null
    };

    const tokenClient = { from: vi.fn() };
    tokenClient.from
      .mockReturnValueOnce(buildChain({ data: tokenRow, error: null }))
      .mockReturnValueOnce(buildChain({ data: consentRow, error: null }));
    mockCreateClient.mockReturnValue(tokenClient);

    const result = await resolveOAuthIdentity(
      { headers: { authorization: 'Bearer good-token' } },
      { requireScope: 'history:read' }
    );

    expect(result).toEqual({
      user_id: 'user-1',
      consent_id: 'consent-1',
      client_id: 'claude-desktop',
      scope: 'history:read workouts:write progression:read'
    });
    expect(tokenClient.from.mock.calls[0][0]).toBe('gymtrack_oauth_tokens');
    expect(tokenClient.from.mock.calls[1][0]).toBe('gymtrack_oauth_consents');
  });

  it('returns null when the token hash does not match a row', async () => {
    const client = { from: vi.fn().mockReturnValueOnce(buildChain({ data: null, error: null })) };
    mockCreateClient.mockReturnValue(client);

    const result = await resolveOAuthIdentity({ headers: { authorization: 'Bearer wrong' } });
    expect(result).toBeNull();
    // No consent lookup should happen when the token row is missing.
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it('returns null when the token has been revoked', async () => {
    const client = {
      from: vi.fn().mockReturnValueOnce(
        buildChain({
          data: {
            id: 'token-1',
            consent_id: 'consent-1',
            user_id: 'user-1',
            client_id: 'claude-desktop',
            scope: 'history:read',
            access_token_expires_at: futureIso(),
            revoked_at: pastIso()
          },
          error: null
        })
      )
    };
    mockCreateClient.mockReturnValue(client);

    const result = await resolveOAuthIdentity({ headers: { authorization: 'Bearer t' } });
    expect(result).toBeNull();
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it('returns null when the access token is expired', async () => {
    const client = {
      from: vi.fn().mockReturnValueOnce(
        buildChain({
          data: {
            id: 'token-1',
            consent_id: 'consent-1',
            user_id: 'user-1',
            client_id: 'claude-desktop',
            scope: 'history:read',
            access_token_expires_at: pastIso(),
            revoked_at: null
          },
          error: null
        })
      )
    };
    mockCreateClient.mockReturnValue(client);

    const result = await resolveOAuthIdentity({ headers: { authorization: 'Bearer t' } });
    expect(result).toBeNull();
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it('returns null when the consent has been revoked (Connected Agents revocation)', async () => {
    const client = {
      from: vi
        .fn()
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'token-1',
              consent_id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'history:read',
              access_token_expires_at: futureIso(),
              revoked_at: null
            },
            error: null
          })
        )
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'history:read',
              revoked_at: pastIso()
            },
            error: null
          })
        )
    };
    mockCreateClient.mockReturnValue(client);

    const result = await resolveOAuthIdentity({ headers: { authorization: 'Bearer t' } });
    expect(result).toBeNull();
    expect(client.from).toHaveBeenCalledTimes(2);
  });

  it('returns null when the consent row is missing', async () => {
    const client = {
      from: vi
        .fn()
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'token-1',
              consent_id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'history:read',
              access_token_expires_at: futureIso(),
              revoked_at: null
            },
            error: null
          })
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
    };
    mockCreateClient.mockReturnValue(client);

    const result = await resolveOAuthIdentity({ headers: { authorization: 'Bearer t' } });
    expect(result).toBeNull();
    expect(client.from).toHaveBeenCalledTimes(2);
  });

  it('returns null when the consent belongs to a different user than the token (mismatch defence)', async () => {
    const client = {
      from: vi
        .fn()
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'token-1',
              consent_id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'history:read',
              access_token_expires_at: futureIso(),
              revoked_at: null
            },
            error: null
          })
        )
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'consent-1',
              user_id: 'user-2',
              client_id: 'claude-desktop',
              scope: 'history:read',
              revoked_at: null
            },
            error: null
          })
        )
    };
    mockCreateClient.mockReturnValue(client);

    const result = await resolveOAuthIdentity({ headers: { authorization: 'Bearer t' } });
    expect(result).toBeNull();
  });

  it('returns null when requireScope is set and the consent does not grant it', async () => {
    const client = {
      from: vi
        .fn()
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'token-1',
              consent_id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'workouts:write',
              access_token_expires_at: futureIso(),
              revoked_at: null
            },
            error: null
          })
        )
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'workouts:write',
              revoked_at: null
            },
            error: null
          })
        )
    };
    mockCreateClient.mockReturnValue(client);

    const result = await resolveOAuthIdentity(
      { headers: { authorization: 'Bearer t' } },
      { requireScope: 'history:read' }
    );
    expect(result).toBeNull();
  });

  it('throws when the token lookup fails so callers can return 500', async () => {
    const client = {
      from: vi.fn().mockReturnValueOnce(
        buildChain({ data: null, error: new Error('connection refused') })
      )
    };
    mockCreateClient.mockReturnValue(client);

    await expect(
      resolveOAuthIdentity({ headers: { authorization: 'Bearer t' } })
    ).rejects.toThrow(/connection refused/);
  });

  it('throws when the consent lookup fails (after a successful token lookup)', async () => {
    const client = {
      from: vi
        .fn()
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'token-1',
              consent_id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'history:read',
              access_token_expires_at: futureIso(),
              revoked_at: null
            },
            error: null
          })
        )
        .mockReturnValueOnce(
          buildChain({ data: null, error: new Error('consent table missing') })
        )
    };
    mockCreateClient.mockReturnValue(client);

    await expect(
      resolveOAuthIdentity({ headers: { authorization: 'Bearer t' } })
    ).rejects.toThrow(/consent table missing/);
  });

  it('does not write last_used_at on every read (OAuth rotation path owns it)', async () => {
    const updateMock = vi.fn().mockReturnValue(buildChain({ error: null }));
    const client = {
      from: vi.fn((table) => {
        if (table === 'gymtrack_oauth_tokens') {
          return buildChain({
            data: {
              id: 'token-1',
              consent_id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'history:read',
              access_token_expires_at: futureIso(),
              revoked_at: null
            },
            error: null
          });
        }
        if (table === 'gymtrack_oauth_consents') {
          return buildChain({
            data: {
              id: 'consent-1',
              user_id: 'user-1',
              client_id: 'claude-desktop',
              scope: 'history:read',
              revoked_at: null
            },
            error: null
          });
        }
        return { update: updateMock };
      })
    };
    mockCreateClient.mockReturnValue(client);

    await resolveOAuthIdentity({ headers: { authorization: 'Bearer t' } });

    expect(updateMock).not.toHaveBeenCalled();
  });
});
