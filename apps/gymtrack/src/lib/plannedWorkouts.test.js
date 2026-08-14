import { describe, expect, it } from 'vitest';
import {
  buildInsertRows,
  validatePlannedWorkoutBody
} from '../../api/agent/planned-workouts.js';

describe('validatePlannedWorkoutBody', () => {
  const validBody = () => ({
    scheduledFor: '2026-07-24',
    title: 'Upper Body Strength',
    notes: 'agent rationale',
    exercises: [
      {
        name: 'Bench Press',
        sets: [{ reps: 8, weight: 80, unit: 'kg', notes: 'RPE 7' }]
      }
    ]
  });

  it('accepts a well-formed body', () => {
    expect(validatePlannedWorkoutBody(validBody())).toBeNull();
  });

  it('rejects a non-object body', () => {
    expect(validatePlannedWorkoutBody(null)).toMatch(/JSON object/);
    expect(validatePlannedWorkoutBody(undefined)).toMatch(/JSON object/);
    expect(validatePlannedWorkoutBody('string')).toMatch(/JSON object/);
    expect(validatePlannedWorkoutBody([])).toMatch(/JSON object/);
  });

  it('requires a YYYY-MM-DD scheduledFor', () => {
    const body = validBody();
    body.scheduledFor = '07/24/2026';
    expect(validatePlannedWorkoutBody(body)).toMatch(/YYYY-MM-DD/);
  });

  it('rejects an empty-string scheduledFor', () => {
    const body = validBody();
    body.scheduledFor = '';
    expect(validatePlannedWorkoutBody(body)).toMatch(/YYYY-MM-DD/);
  });

  it('requires a non-empty title', () => {
    const body = validBody();
    body.title = '   ';
    expect(validatePlannedWorkoutBody(body)).toMatch(/title/);
  });

  it('rejects notes that are not a string when provided', () => {
    const body = validBody();
    body.notes = 42;
    expect(validatePlannedWorkoutBody(body)).toMatch(/notes must be a string/);
  });

  it('requires a non-empty exercises array', () => {
    const body = validBody();
    body.exercises = [];
    expect(validatePlannedWorkoutBody(body)).toMatch(/non-empty array/);
  });

  it('enforces the per-plan exercises cap (25)', () => {
    const body = validBody();
    body.exercises = Array.from({ length: 26 }, () => ({
      name: 'Bench',
      sets: [{ reps: 5, weight: 50 }]
    }));
    expect(validatePlannedWorkoutBody(body)).toMatch(/at most 25/);
  });

  it('requires each exercise name to be a non-empty string', () => {
    const body = validBody();
    body.exercises[0].name = '';
    expect(validatePlannedWorkoutBody(body)).toMatch(/name must be a non-empty string/);
  });

  it('requires each exercise to have a non-empty sets array', () => {
    const body = validBody();
    body.exercises[0].sets = [];
    expect(validatePlannedWorkoutBody(body)).toMatch(/sets must be a non-empty array/);
  });

  it('enforces the per-exercise sets cap (20)', () => {
    const body = validBody();
    body.exercises[0].sets = Array.from({ length: 21 }, () => ({ reps: 5, weight: 50 }));
    expect(validatePlannedWorkoutBody(body)).toMatch(/at most 20/);
  });

  it('enforces the total-sets cap (200)', () => {
    const body = validBody();
    body.exercises = Array.from({ length: 11 }, (_, i) => ({
      name: `Exercise ${i}`,
      sets: Array.from({ length: 20 }, () => ({ reps: 5, weight: 50 }))
    }));
    expect(validatePlannedWorkoutBody(body)).toMatch(/200/);
  });

  it('requires reps to be a positive integer', () => {
    const body = validBody();
    body.exercises[0].sets[0].reps = 0;
    expect(validatePlannedWorkoutBody(body)).toMatch(/reps must be a positive integer/);
    body.exercises[0].sets[0].reps = 1.5;
    expect(validatePlannedWorkoutBody(body)).toMatch(/reps must be a positive integer/);
    body.exercises[0].sets[0].reps = '5';
    expect(validatePlannedWorkoutBody(body)).toMatch(/reps must be a positive integer/);
  });

  it('requires weight to be a non-negative finite number', () => {
    const body = validBody();
    body.exercises[0].sets[0].weight = -1;
    expect(validatePlannedWorkoutBody(body)).toMatch(/weight must be a non-negative number/);
    body.exercises[0].sets[0].weight = '80';
    expect(validatePlannedWorkoutBody(body)).toMatch(/weight must be a non-negative number/);
    body.exercises[0].sets[0].weight = NaN;
    expect(validatePlannedWorkoutBody(body)).toMatch(/weight must be a non-negative number/);
  });

  it('accepts zero weight (bodyweight movements)', () => {
    const body = validBody();
    body.exercises[0].sets[0].weight = 0;
    expect(validatePlannedWorkoutBody(body)).toBeNull();
  });

  it('defaults the unit to kg when missing', () => {
    const body = validBody();
    delete body.exercises[0].sets[0].unit;
    expect(validatePlannedWorkoutBody(body)).toBeNull();
  });

  it('rejects an unknown unit', () => {
    const body = validBody();
    body.exercises[0].sets[0].unit = 'stones';
    expect(validatePlannedWorkoutBody(body)).toMatch(/unit must be 'kg' or 'lb'/);
  });

  it('rejects non-string set notes when provided', () => {
    const body = validBody();
    body.exercises[0].sets[0].notes = 5;
    expect(validatePlannedWorkoutBody(body)).toMatch(/notes must be a string/);
  });

  it('reports the offending exercise and set index for fast debugging', () => {
    const body = validBody();
    body.exercises[1] = { name: 'Squat', sets: [{ reps: 0, weight: 100 }] };
    expect(validatePlannedWorkoutBody(body)).toMatch(/exercises\[1\]\.sets\[0\]\.reps/);
  });
});

describe('buildInsertRows', () => {
  it('flattens parent and child rows with user_id and consent_id', () => {
    const { parentRow, setRows } = buildInsertRows({
      userId: 'user-1',
      consentId: 'consent-1',
      body: {
        scheduledFor: '2026-07-24',
        title: 'Upper Body',
        notes: 'workout rationale',
        exercises: [
          {
            name: 'Bench Press',
            sets: [
              { reps: 8, weight: 80, unit: 'kg', notes: 'RPE 7' },
              { reps: 8, weight: 82.5, unit: 'kg' }
            ]
          }
        ]
      }
    });

    expect(parentRow).toEqual({
      user_id: 'user-1',
      consent_id: 'consent-1',
      scheduled_for: '2026-07-24',
      title: 'Upper Body',
      notes: 'workout rationale',
      status: 'planned'
    });

    expect(setRows).toHaveLength(2);
    expect(setRows[0]).toMatchObject({
      planned_workout_id: undefined,
      exercise_name: 'Bench Press',
      set_index: 1,
      target_reps: 8,
      target_weight: 80,
      unit: 'kg',
      notes: 'RPE 7'
    });
    expect(setRows[1]).toMatchObject({
      set_index: 2,
      target_weight: 82.5,
      notes: null
    });
  });

  it('trims whitespace from string fields', () => {
    const { parentRow, setRows } = buildInsertRows({
      userId: 'user-1',
      consentId: 'consent-1',
      body: {
        scheduledFor: '2026-07-24',
        title: '  Upper Body  ',
        notes: '  rationale  ',
        exercises: [
          {
            name: '  Bench Press  ',
            sets: [{ reps: 5, weight: 50, notes: '  warmup  ' }]
          }
        ]
      }
    });

    expect(parentRow.title).toBe('Upper Body');
    expect(parentRow.notes).toBe('rationale');
    expect(setRows[0].exercise_name).toBe('Bench Press');
    expect(setRows[0].notes).toBe('warmup');
  });

  it('defaults unit to kg and notes to null when missing', () => {
    const { setRows } = buildInsertRows({
      userId: 'u',
      consentId: 'c',
      body: {
        scheduledFor: '2026-07-24',
        title: 'Plan',
        exercises: [{ name: 'Bench', sets: [{ reps: 5, weight: 50 }] }]
      }
    });
    expect(setRows[0].unit).toBe('kg');
    expect(setRows[0].notes).toBeNull();
  });

  it('numbers sets sequentially per exercise starting at 1', () => {
    const { setRows } = buildInsertRows({
      userId: 'u',
      consentId: 'c',
      body: {
        scheduledFor: '2026-07-24',
        title: 'Plan',
        exercises: [
          {
            name: 'A',
            sets: [{ reps: 5, weight: 50 }, { reps: 5, weight: 50 }, { reps: 5, weight: 50 }]
          },
          {
            name: 'B',
            sets: [{ reps: 5, weight: 50 }]
          }
        ]
      }
    });
    expect(setRows.map((r) => r.set_index)).toEqual([1, 2, 3, 1]);
    expect(setRows.slice(0, 3).map((r) => r.exercise_name)).toEqual(['A', 'A', 'A']);
    expect(setRows[3].exercise_name).toBe('B');
  });

  it('records consent_id: null when consentId is omitted', () => {
    const { parentRow } = buildInsertRows({
      userId: 'u',
      body: {
        scheduledFor: '2026-07-24',
        title: 'Plan',
        exercises: [{ name: 'Bench', sets: [{ reps: 5, weight: 50 }] }]
      }
    });
    expect(parentRow.consent_id).toBeNull();
  });
});