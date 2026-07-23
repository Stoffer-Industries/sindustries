import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Mock @supabase/supabase-js so we can control the client factory and the
// chainable queries used by adminClient() and resolveAgentIdentity().
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
  resolveAgentIdentity,
  unauthorized
} from '../../server/agentAuth.js';

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

  it('passes auth options that disable session persistence and token refresh', () => {
    mockCreateClient.mockReturnValue({ from: vi.fn() });
    adminClient();
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'service-role-key',
      expect.objectContaining({
        auth: { persistSession: false, autoRefreshToken: false }
      })
    );
  });
});

describe('resolveAgentIdentity', () => {
  it('returns null without hitting the database when no Authorization header is present', async () => {
    mockCreateClient.mockReturnValue({ from: vi.fn() });
    const result = await resolveAgentIdentity({ headers: {} });
    expect(result).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns the user_id and key_id when the hashed token matches an active row', async () => {
    const token = 'good-token';
    const lookup = buildChain({ data: { id: 'key-1', user_id: 'user-1' }, error: null });
    const update = buildChain({ error: null });
    const fromMock = vi
      .fn()
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(update);
    mockCreateClient.mockReturnValue({ from: fromMock });

    const result = await resolveAgentIdentity({ headers: { authorization: `Bearer ${token}` } });
    expect(result).toEqual({ user_id: 'user-1', key_id: 'key-1' });
    expect(fromMock).toHaveBeenCalledWith('gymtrack_agent_api_keys');
  });

  it('returns null when no row matches the hashed token', async () => {
    const lookup = buildChain({ data: null, error: null });
    mockCreateClient.mockReturnValue({ from: vi.fn().mockReturnValueOnce(lookup) });

    const result = await resolveAgentIdentity({ headers: { authorization: 'Bearer unknown' } });
    expect(result).toBeNull();
  });

  it('throws on database errors so the caller can distinguish server vs auth failure', async () => {
    const lookup = buildChain({ data: null, error: new Error('connection refused') });
    mockCreateClient.mockReturnValue({ from: vi.fn().mockReturnValueOnce(lookup) });

    await expect(
      resolveAgentIdentity({ headers: { authorization: 'Bearer whatever' } })
    ).rejects.toThrow(/connection refused/);
  });

  it('does not throw when the fire-and-forget last_used_at update rejects', async () => {
    const lookup = buildChain({ data: { id: 'key-1', user_id: 'user-1' }, error: null });
    const update = buildChain({ data: null, error: new Error('write conflict') });
    const fromMock = vi
      .fn()
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(update);
    mockCreateClient.mockReturnValue({ from: fromMock });

    await expect(
      resolveAgentIdentity({ headers: { authorization: 'Bearer whatever' } })
    ).resolves.toEqual({ user_id: 'user-1', key_id: 'key-1' });
  });
});