import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the agent auth module so the handler is exercised against a stub
// adminClient + resolveAgentIdentity.
const mockAdminClient = { from: vi.fn() };

vi.mock('../../server/agentAuth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adminClient: () => mockAdminClient,
    resolveAgentIdentity: vi.fn()
  };
});

import handler from '../../api/agent/exercises/[exerciseName]/progression.js';
import { resolveAgentIdentity } from '../../server/agentAuth.js';
import {
  DEFAULT_LIMIT,
  EXERCISE_NAME_MAX_LENGTH,
  MAX_LIMIT,
  MIN_LIMIT,
  escapeIlikePattern,
  exerciseNameErrorMessage,
  normalizeExerciseName,
  parseLimit
} from '../../api/agent/exercises/[exerciseName]/progression.js';

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

describe('escapeIlikePattern', () => {
  it('escapes backslashes, percent, and underscore', () => {
    expect(escapeIlikePattern('100%')).toBe('100\\%');
    expect(escapeIlikePattern('leg_day')).toBe('leg\\_day');
    expect(escapeIlikePattern('a\\b')).toBe('a\\\\b');
  });

  it('leaves ordinary characters untouched', () => {
    expect(escapeIlikePattern('Bench Press')).toBe('Bench Press');
    expect(escapeIlikePattern('Café')).toBe('Café');
  });

  it('coerces non-string input to a string', () => {
    expect(escapeIlikePattern(123)).toBe('123');
  });
});

describe('normalizeExerciseName', () => {
  it('returns the trimmed name on success', () => {
    expect(normalizeExerciseName('Bench Press')).toBe('Bench Press');
    expect(normalizeExerciseName('  Squat  ')).toBe('Squat');
  });

  it('returns null for non-strings', () => {
    expect(normalizeExerciseName(undefined)).toBeNull();
    expect(normalizeExerciseName(null)).toBeNull();
    expect(normalizeExerciseName(123)).toBeNull();
    expect(normalizeExerciseName({})).toBeNull();
  });

  it('returns null for empty or whitespace-only strings', () => {
    expect(normalizeExerciseName('')).toBeNull();
    expect(normalizeExerciseName('   ')).toBeNull();
  });

  it('returns null when the name exceeds the max length', () => {
    expect(normalizeExerciseName('a'.repeat(EXERCISE_NAME_MAX_LENGTH + 1))).toBeNull();
  });

  it('accepts a name exactly at the max length', () => {
    expect(normalizeExerciseName('a'.repeat(EXERCISE_NAME_MAX_LENGTH))).toHaveLength(EXERCISE_NAME_MAX_LENGTH);
  });
});

describe('exerciseNameErrorMessage', () => {
  it('returns a string for every rejection reason', () => {
    expect(exerciseNameErrorMessage(undefined)).toMatch(/string/);
    expect(exerciseNameErrorMessage('')).toMatch(/non-empty/);
    expect(exerciseNameErrorMessage('   ')).toMatch(/non-empty/);
    expect(exerciseNameErrorMessage('a'.repeat(EXERCISE_NAME_MAX_LENGTH + 1))).toMatch(/at most/);
  });

  it('returns null for a valid name', () => {
    expect(exerciseNameErrorMessage('Bench Press')).toBeNull();
  });
});

describe('parseLimit (progression)', () => {
  it('returns the default when missing or empty', () => {
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('')).toBe(DEFAULT_LIMIT);
  });

  it('parses a valid integer in the allowed range', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('100')).toBe(100);
    expect(parseLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
  });

  it('rejects values below the minimum', () => {
    expect(parseLimit('0')).toMatch(/between/);
  });

  it('rejects values above the maximum', () => {
    expect(parseLimit(String(MAX_LIMIT + 1))).toMatch(/between/);
  });

  it('rejects non-integer values', () => {
    expect(parseLimit('1.5')).toMatch(/between/);
    expect(parseLimit('abc')).toMatch(/between/);
  });

  it('caps the accepted range to MIN_LIMIT..MAX_LIMIT', () => {
    expect(MIN_LIMIT).toBe(1);
    expect(MAX_LIMIT).toBe(200);
  });
});

describe('GET /api/agent/exercises/:exerciseName/progression', () => {
  it('returns 405 with the Allow header for non-GET methods', async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, query: { exerciseName: 'Bench Press' } }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET');
    expect(res.body).toEqual({ error: 'method_not_allowed' });
    expect(resolveAgentIdentity).not.toHaveBeenCalled();
  });

  it('returns 401 when no agent identity is resolved', async () => {
    resolveAgentIdentity.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { exerciseName: 'Bench Press' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_api_key' });
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('returns 500 when resolveAgentIdentity throws', async () => {
    resolveAgentIdentity.mockRejectedValueOnce(new Error('connection refused'));
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { exerciseName: 'Bench Press' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body.message).toMatch(/connection refused/);
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('returns 400 when the exercise name is missing', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.message).toMatch(/exerciseName/);
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('returns 400 when the exercise name is whitespace-only', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { exerciseName: '   ' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.message).toMatch(/non-empty/);
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('returns 400 when the limit is out of range', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { exerciseName: 'Bench Press', limit: '999' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.message).toMatch(/between/);
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });

  it('queries workout_sets scoped to user_id + exercise name and returns the formatted payload', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    const dbRows = [
      {
        set_index: 1,
        reps: 8,
        weight: 80,
        unit: 'kg',
        planned_set_id: null,
        planned_workout_sets: null,
        workouts: { id: 'w-1', performed_at: '2026-07-23T10:00:00Z', user_id: 'user-1' }
      },
      {
        set_index: 2,
        reps: 8,
        weight: 82.5,
        unit: 'kg',
        planned_set_id: 'ps-1',
        planned_workout_sets: { target_reps: 8, target_weight: 80 },
        workouts: { id: 'w-1', performed_at: '2026-07-23T10:00:00Z', user_id: 'user-1' }
      }
    ];
    mockAdminClient.from.mockReturnValueOnce(buildChain({ data: dbRows, error: null }));

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { exerciseName: 'Bench Press' } }, res);

    expect(res.statusCode).toBe(200);
    expect(mockAdminClient.from).toHaveBeenCalledWith('workout_sets');
    expect(res.body).toEqual({
      exerciseName: 'Bench Press',
      sets: [
        {
          performedAt: '2026-07-23T10:00:00Z',
          workoutId: 'w-1',
          setIndex: 1,
          reps: 8,
          weight: 80,
          unit: 'kg',
          plannedReps: null,
          plannedWeight: null
        },
        {
          performedAt: '2026-07-23T10:00:00Z',
          workoutId: 'w-1',
          setIndex: 2,
          reps: 8,
          weight: 82.5,
          unit: 'kg',
          plannedReps: 8,
          plannedWeight: 80
        }
      ]
    });
  });

  it('escapes ilike special characters in the exercise name', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    // Use a Proxy that records the final `.ilike` call to assert the pattern.
    let capturedPattern = null;
    const chain = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'ilike') return (col, pattern) => {
            capturedPattern = pattern;
            return chain;
          };
          if (prop === 'then') return (resolve) => resolve({ data: [], error: null });
          return () => chain;
        }
      }
    );
    mockAdminClient.from.mockReturnValueOnce(chain);

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { exerciseName: '100% leg_day' } }, res);

    expect(res.statusCode).toBe(200);
    expect(capturedPattern).toBe('100\\% leg\\_day');
  });

  it('returns an empty sets array when there are no results', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    mockAdminClient.from.mockReturnValueOnce(buildChain({ data: [], error: null }));

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { exerciseName: 'Bench Press' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ exerciseName: 'Bench Press', sets: [] });
  });

  it('returns 500 when the database query errors', async () => {
    resolveAgentIdentity.mockResolvedValueOnce({ user_id: 'user-1', key_id: 'key-1' });
    mockAdminClient.from.mockReturnValueOnce(
      buildChain({ data: null, error: new Error('relation workout_sets does not exist') })
    );

    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: { exerciseName: 'Bench Press' } }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body.message).toMatch(/workout_sets does not exist/);
  });
});
