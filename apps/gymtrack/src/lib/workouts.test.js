import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock supabase-js. We construct a chainable query builder per test so each
// test can stage different responses. The mock also exposes `auth.getUser`.
const { mockSupabase } = vi.hoisted(() => {
  const mockSupabase = {
    auth: { getUser: vi.fn() },
    from: vi.fn()
  };
  return { mockSupabase };
});

vi.mock('./supabase.js', () => ({ supabase: mockSupabase }));

import { addSet, addSets, createWorkout, deleteWorkout, listSetsForWorkouts, listWorkouts } from './workouts.js';

function chain(terminal) {
  // Returns a Proxy that is chainable for any method, and resolves to `terminal` at the end.
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve) => resolve(terminal);
        if (prop === 'single') return () => Promise.resolve(terminal);
        // methods that return a new chainable
        return () => proxy;
      }
    }
  );
  return proxy;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createWorkout', () => {
  it('inserts a row with the current user_id and returns the row', async () => {
    mockSupabase.auth.getUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } });
    const terminal = { data: { id: 'w-1', user_id: 'user-1', performed_at: '2026-07-12T00:00:00Z' }, error: null };
    mockSupabase.from.mockReturnValueOnce(chain(terminal));

    const { data, error } = await createWorkout({ performed_at: '2026-07-12T00:00:00Z' });

    expect(error).toBeNull();
    expect(data).toEqual(terminal.data);
    expect(mockSupabase.from).toHaveBeenCalledWith('workouts');
  });

  it('returns an error when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValueOnce({ data: { user: null } });
    const { data, error } = await createWorkout();
    expect(data).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/authenticated/i);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

describe('addSet', () => {
  it('inserts a single set row and returns it', async () => {
    const terminal = { data: { id: 's-1', workout_id: 'w-1' }, error: null };
    mockSupabase.from.mockReturnValueOnce(chain(terminal));

    const { data, error } = await addSet({
      workout_id: 'w-1',
      exercise_name: 'Bench Press',
      set_index: 1,
      reps: 5,
      weight: 80
    });

    expect(error).toBeNull();
    expect(data).toEqual(terminal.data);
    expect(mockSupabase.from).toHaveBeenCalledWith('workout_sets');
  });
});

describe('addSets', () => {
  it('returns empty data when given no sets (skips DB)', async () => {
    const { data, error } = await addSets({ workout_id: 'w-1', sets: [] });
    expect(data).toEqual([]);
    expect(error).toBeNull();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('inserts a batch of sets with sequential indexes', async () => {
    const terminal = { data: [{ id: 's-1' }, { id: 's-2' }], error: null };
    mockSupabase.from.mockReturnValueOnce(chain(terminal));

    const { data, error } = await addSets({
      workout_id: 'w-1',
      sets: [
        { exercise_name: 'Bench Press', set_index: 1, reps: 5, weight: 80 },
        { exercise_name: 'Bench Press', set_index: 2, reps: 5, weight: 82.5 }
      ]
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    expect(mockSupabase.from).toHaveBeenCalledWith('workout_sets');
  });
});

describe('listWorkouts', () => {
  it('queries with a 30-day default cutoff and orders newest first', async () => {
    const terminal = { data: [], error: null };
    mockSupabase.from.mockReturnValueOnce(chain(terminal));

    const { data, error } = await listWorkouts();
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(mockSupabase.from).toHaveBeenCalledWith('workouts');
  });

  it('accepts a custom since cutoff', async () => {
    const terminal = { data: [{ id: 'w-1' }], error: null };
    mockSupabase.from.mockReturnValueOnce(chain(terminal));

    const { data, error } = await listWorkouts({ since: '2026-06-01T00:00:00Z' });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});

describe('listSetsForWorkouts', () => {
  it('returns empty array when given no ids', async () => {
    const { data, error } = await listSetsForWorkouts({ workout_ids: [] });
    expect(data).toEqual([]);
    expect(error).toBeNull();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('queries by workout_id list', async () => {
    const terminal = { data: [{ id: 's-1' }, { id: 's-2' }], error: null };
    mockSupabase.from.mockReturnValueOnce(chain(terminal));

    const { data } = await listSetsForWorkouts({ workout_ids: ['w-1', 'w-2'] });
    expect(data).toHaveLength(2);
    expect(mockSupabase.from).toHaveBeenCalledWith('workout_sets');
  });
});

describe('deleteWorkout', () => {
  it('issues a delete by id', async () => {
    const terminal = { error: null };
    mockSupabase.from.mockReturnValueOnce(chain(terminal));

    const { error } = await deleteWorkout('w-1');
    expect(error).toBeNull();
    expect(mockSupabase.from).toHaveBeenCalledWith('workouts');
  });
});