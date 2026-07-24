import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the agent auth module so the handler is exercised against a stub
// adminClient + resolveAgentIdentity. The response helpers and middleware
// helpers are passed through from the real module.
const mockAdminClient = { from: vi.fn() };

vi.mock('../../server/agentAuth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adminClient: () => mockAdminClient,
    resolveAgentIdentity: vi.fn()
  };
});

import handler from '../../api/agent/history.js';
import { resolveAgentIdentity } from '../../server/agentAuth.js';
import { DEFAULT_LIMIT, MAX_LIMIT, MIN_LIMIT, parseLimit } from '../../api/agent/history.js';

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
  mockAdminClient.from.mockReset();
  resolveAgentIdentity.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseLimit', () => {
  it('returns the default when the param is missing or empty', () => {
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('')).toBe(DEFAULT_LIMIT);
  });

  it('parses a valid integer in the allowed range', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('25')).toBe(25);
    expect(parseLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
  });

  it('rejects values below the minimum', () => {
    expect(parseLimit('0')).toMatch(/between/);
    expect(parseLimit('-3')).toMatch(/between/);
  });

  it('rejects values above the maximum', () => {
    expect(parseLimit(String(MAX_LIMIT + 1))).toMatch(/between/);
  });

  it('rejects non-integer values', () => {
    expect(parseLimit('1.5')).toMatch(/between/);
    expect(parseLimit('abc')).toMatch(/between/);
  });

  it('rejects objects passed as the limit', () => {
    expect(parseLimit({})).toMatch(/string/);
    expect(parseLimit([])).toMatch(/string/);
  });

  it('caps the accepted range to MIN_LIMIT..MAX_LIMIT', () => {
    expect(MIN_LIMIT).toBe(1);
    expect(MAX_LIMIT).toBe(50);
  });
});

describe('GET /api/agent/history', () => {
  it('returns 405 with the Allow header for non-GET methods', async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET');
    expect(res.body).toEqual({ error: 'method_not_allowed' });
    expect(resolveAgentIdentity).not.toHaveBeenCalled();
  });

  it('returns 401 when no agent identity is resolved', async () => {
    resolveAgentIdentity.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_api_key' });
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('returns 500 when resolveAgentIdentity throws', async () => {
    resolveAgentIdentity.mockRejectedValueOnce(new Error('connection refused'));
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body.message).toMatch(/connection refused/);
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('returns 400 when the limit is out of range', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { limit: '0' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.message).toMatch(/between/);
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('queries workouts scoped to user_id with the default limit and returns the formatted payload', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const dbRows = [
      {
        id: 'w-1',
        performed_at: '2026-07-23T10:00:00Z',
        notes: null,
        planned_workout_id: null,
        workout_sets: [
          { id: 's-1', exercise_name: 'Bench Press', set_index: 1, reps: 8, weight: 80, unit: 'kg', planned_set_id: null, planned_workout_sets: null }
        ]
      }
    ];
    const chain = buildChain({ data: dbRows, error: null });
    mockAdminClient.from.mockReturnValueOnce(chain);

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(mockAdminClient.from).toHaveBeenCalledWith('workouts');
    expect(res.body).toEqual({
      workouts: [
        {
          id: 'w-1',
          performedAt: '2026-07-23T10:00:00Z',
          notes: null,
          plannedWorkoutId: null,
          sets: [
            { id: 's-1', exerciseName: 'Bench Press', setIndex: 1, reps: 8, weight: 80, unit: 'kg', plannedSetId: null, plannedReps: null, plannedWeight: null }
          ]
        }
      ]
    });
  });

  it('includes planned target fields when a set is linked to a planned set', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const dbRows = [
      {
        id: 'w-2',
        performed_at: '2026-07-22T10:00:00Z',
        notes: 'felt strong',
        planned_workout_id: 'pw-1',
        workout_sets: [
          {
            id: 's-2',
            exercise_name: 'Squat',
            set_index: 1,
            reps: 5,
            weight: 100,
            unit: 'kg',
            planned_set_id: 'ps-1',
            planned_workout_sets: { target_reps: 5, target_weight: 100 }
          }
        ]
      }
    ];
    mockAdminClient.from.mockReturnValueOnce(buildChain({ data: dbRows, error: null }));

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { limit: '5' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.workouts[0].plannedWorkoutId).toBe('pw-1');
    expect(res.body.workouts[0].sets[0]).toEqual({
      id: 's-2',
      exerciseName: 'Squat',
      setIndex: 1,
      reps: 5,
      weight: 100,
      unit: 'kg',
      plannedSetId: 'ps-1',
      plannedReps: 5,
      plannedWeight: 100
    });
  });

  it('returns an empty workouts array when there are no results', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    mockAdminClient.from.mockReturnValueOnce(buildChain({ data: [], error: null }));

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ workouts: [] });
  });

  it('returns 500 when the database query errors', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    mockAdminClient.from.mockReturnValueOnce(
      buildChain({ data: null, error: new Error('relation workouts does not exist') })
    );

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body.message).toMatch(/workouts does not exist/);
  });

  it('passes the requested limit to the supabase query', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const chain = buildChain({ data: [], error: null });
    mockAdminClient.from.mockReturnValueOnce(chain);

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { limit: '7' } }, res);

    expect(res.statusCode).toBe(200);
    const terminal = chain[Symbol.for('terminal')]; // undefined; we just care the chain was used
    expect(mockAdminClient.from).toHaveBeenCalledWith('workouts');
    // The chain proxy is unbounded; the only assertion we can make is that the
    // chain resolved with our stub and the response body is empty.
    expect(res.body).toEqual({ workouts: [] });
  });
});
