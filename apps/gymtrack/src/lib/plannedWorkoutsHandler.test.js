import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the agent auth module so we can stub adminClient() and
// resolveAgentIdentity() independently of the real supabase client. The
// response helpers (badRequest, unauthorized, rejectIfWrongMethod) are passed
// through from the real module so the handler's bailing-on-truthy contract
// keeps working unchanged.
const mockAdminClient = { from: vi.fn() };

vi.mock('../../server/agentAuth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adminClient: () => mockAdminClient,
    resolveAgentIdentity: vi.fn()
  };
});

import handler from '../../api/agent/planned-workouts.js';
import { resolveAgentIdentity } from '../../server/agentAuth.js';

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

const validBody = {
  scheduledFor: '2026-07-24',
  title: 'Upper Body',
  notes: 'agent rationale',
  exercises: [
    {
      name: 'Bench Press',
      sets: [
        { reps: 8, weight: 80, unit: 'kg', notes: 'RPE 7' },
        { reps: 8, weight: 82.5, unit: 'kg' }
      ]
    },
    {
      name: 'Squat',
      sets: [{ reps: 5, weight: 100, unit: 'kg' }]
    }
  ]
};

beforeEach(() => {
  mockAdminClient.from.mockReset();
  resolveAgentIdentity.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/agent/planned-workouts', () => {
  it('returns 405 with the Allow header for non-POST methods', async () => {
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expect(res.body).toEqual({ error: 'method_not_allowed' });
    expect(resolveAgentIdentity).not.toHaveBeenCalled();
  });

  it('returns 401 when no agent identity is resolved', async () => {
    resolveAgentIdentity.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(
      { method: 'POST', headers: { authorization: 'Bearer unknown' }, body: validBody },
      res
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_api_key' });
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('returns 500 when resolveAgentIdentity throws', async () => {
    resolveAgentIdentity.mockRejectedValueOnce(new Error('connection refused'));
    const res = makeRes();
    await handler(
      { method: 'POST', headers: { authorization: 'Bearer whatever' }, body: validBody },
      res
    );
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body.message).toMatch(/connection refused/);
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('returns 400 with the validation message when the body is malformed', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const res = makeRes();
    await handler(
      { method: 'POST', headers: { authorization: 'Bearer good' }, body: { title: '' } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.message).toMatch(/scheduledFor/);
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('inserts the parent then the children and returns 201 with plannedWorkoutId + setCount', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    mockAdminClient.from
      .mockReturnValueOnce(buildChain({ data: { id: 'plan-uuid' }, error: null }))
      .mockReturnValueOnce(buildChain({ error: null }));

    const res = makeRes();
    await handler(
      { method: 'POST', headers: { authorization: 'Bearer good' }, body: validBody },
      res
    );

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ plannedWorkoutId: 'plan-uuid', setCount: 3 });
    expect(mockAdminClient.from.mock.calls[0][0]).toBe('planned_workouts');
    expect(mockAdminClient.from.mock.calls[1][0]).toBe('planned_workout_sets');
  });

  it('rolls back the parent insert when the child insert fails', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    mockAdminClient.from
      .mockReturnValueOnce(buildChain({ data: { id: 'plan-uuid' }, error: null }))
      .mockReturnValueOnce(buildChain({ error: new Error('FK violation') }))
      .mockReturnValueOnce(buildChain({ error: null }));

    const res = makeRes();
    await handler(
      { method: 'POST', headers: { authorization: 'Bearer good' }, body: validBody },
      res
    );

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body.message).toMatch(/FK violation/);
    expect(mockAdminClient.from.mock.calls[0][0]).toBe('planned_workouts');
    expect(mockAdminClient.from.mock.calls[1][0]).toBe('planned_workout_sets');
    expect(mockAdminClient.from.mock.calls[2][0]).toBe('planned_workouts');
  });

  it('returns 500 when the parent insert itself fails', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    mockAdminClient.from.mockReturnValueOnce(
      buildChain({ data: null, error: new Error('parent insert failed') })
    );

    const res = makeRes();
    await handler(
      { method: 'POST', headers: { authorization: 'Bearer good' }, body: validBody },
      res
    );

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body.message).toMatch(/parent insert failed/);
    expect(mockAdminClient.from.mock.calls[0][0]).toBe('planned_workouts');
    expect(mockAdminClient.from.mock.calls).toHaveLength(1);
  });

  it('parses a stringified JSON body for Vercel runtime variance', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    mockAdminClient.from
      .mockReturnValueOnce(buildChain({ data: { id: 'plan-uuid' }, error: null }))
      .mockReturnValueOnce(buildChain({ error: null }));

    const res = makeRes();
    await handler(
      {
        method: 'POST',
        headers: { authorization: 'Bearer good' },
        body: JSON.stringify(validBody)
      },
      res
    );

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ plannedWorkoutId: 'plan-uuid', setCount: 3 });
  });
});