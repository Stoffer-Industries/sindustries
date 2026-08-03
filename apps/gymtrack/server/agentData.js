export const MAX_EXERCISES_PER_PLAN = 25;
export const MAX_SETS_PER_EXERCISE = 20;
export const MAX_TOTAL_SETS = 200;

export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MIN_LIMIT = 1;
export const HISTORY_MAX_LIMIT = 50;

export const PROGRESSION_DEFAULT_LIMIT = 20;
export const PROGRESSION_MIN_LIMIT = 1;
export const PROGRESSION_MAX_LIMIT = 200;
export const EXERCISE_NAME_MAX_LENGTH = 120;

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

function isNonNegativeNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function validatePlannedWorkoutBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Body must be a JSON object.';
  }
  const { scheduledFor, title, notes, exercises } = body;

  if (typeof scheduledFor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor)) {
    return 'scheduledFor must be a YYYY-MM-DD date string.';
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return 'title must be a non-empty string.';
  }
  if (notes != null && typeof notes !== 'string') {
    return 'notes must be a string when provided.';
  }
  if (!Array.isArray(exercises) || exercises.length === 0) {
    return 'exercises must be a non-empty array.';
  }
  if (exercises.length > MAX_EXERCISES_PER_PLAN) {
    return `exercises must have at most ${MAX_EXERCISES_PER_PLAN} entries.`;
  }

  let totalSets = 0;
  for (let ei = 0; ei < exercises.length; ei += 1) {
    const exercise = exercises[ei];
    if (!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) {
      return `exercises[${ei}] must be an object.`;
    }
    if (typeof exercise.name !== 'string' || exercise.name.trim().length === 0) {
      return `exercises[${ei}].name must be a non-empty string.`;
    }
    if (!Array.isArray(exercise.sets) || exercise.sets.length === 0) {
      return `exercises[${ei}].sets must be a non-empty array.`;
    }
    if (exercise.sets.length > MAX_SETS_PER_EXERCISE) {
      return `exercises[${ei}].sets must have at most ${MAX_SETS_PER_EXERCISE} entries.`;
    }
    totalSets += exercise.sets.length;
    if (totalSets > MAX_TOTAL_SETS) {
      return `Total set count across all exercises must not exceed ${MAX_TOTAL_SETS}.`;
    }
    for (let si = 0; si < exercise.sets.length; si += 1) {
      const set = exercise.sets[si];
      if (!set || typeof set !== 'object' || Array.isArray(set)) {
        return `exercises[${ei}].sets[${si}] must be an object.`;
      }
      if (!isPositiveInt(set.reps)) {
        return `exercises[${ei}].sets[${si}].reps must be a positive integer.`;
      }
      if (!isNonNegativeNumber(set.weight)) {
        return `exercises[${ei}].sets[${si}].weight must be a non-negative number.`;
      }
      const unit = set.unit ?? 'kg';
      if (unit !== 'kg' && unit !== 'lb') {
        return `exercises[${ei}].sets[${si}].unit must be 'kg' or 'lb'.`;
      }
      if (set.notes != null && typeof set.notes !== 'string') {
        return `exercises[${ei}].sets[${si}].notes must be a string when provided.`;
      }
    }
  }
  return null;
}

export function buildInsertRows({ userId, legacyAgentKeyId = null, keyId = null, body }) {
  const setRows = [];
  body.exercises.forEach((exercise) => {
    exercise.sets.forEach((set, idx) => {
      setRows.push({
        planned_workout_id: undefined,
        exercise_name: exercise.name.trim(),
        set_index: idx + 1,
        target_reps: set.reps,
        target_weight: set.weight,
        unit: set.unit ?? 'kg',
        notes: set.notes?.trim() || null
      });
    });
  });

  return {
    parentRow: {
      user_id: userId,
      agent_key_id: legacyAgentKeyId ?? keyId,
      scheduled_for: body.scheduledFor,
      title: body.title.trim(),
      notes: body.notes?.trim() || null,
      status: 'planned'
    },
    setRows
  };
}

export async function createPlannedWorkout(client, { userId, legacyAgentKeyId = null, keyId = null, body }) {
  const { parentRow, setRows } = buildInsertRows({ userId, legacyAgentKeyId, keyId, body });

  const { data: parent, error: parentErr } = await client
    .from('planned_workouts')
    .insert(parentRow)
    .select()
    .single();

  if (parentErr || !parent) {
    throw new Error(parentErr?.message ?? 'Insert failed.');
  }

  if (setRows.length > 0) {
    const rowsWithFk = setRows.map((row) => ({ ...row, planned_workout_id: parent.id }));
    const { error: setsErr } = await client.from('planned_workout_sets').insert(rowsWithFk);
    if (setsErr) {
      await client.from('planned_workouts').delete().eq('id', parent.id);
      throw new Error(setsErr.message);
    }
  }

  return {
    plannedWorkoutId: parent.id,
    setCount: setRows.length
  };
}

export function parseHistoryLimit(rawLimit) {
  if (rawLimit == null || rawLimit === '') return HISTORY_DEFAULT_LIMIT;
  if (typeof rawLimit === 'object') return `limit must be a string, not an object.`;
  const n = Number(rawLimit);
  if (!Number.isInteger(n) || n < HISTORY_MIN_LIMIT || n > HISTORY_MAX_LIMIT) {
    return `limit must be an integer between ${HISTORY_MIN_LIMIT} and ${HISTORY_MAX_LIMIT}.`;
  }
  return n;
}

export function formatHistoryResponse(workouts) {
  return {
    workouts: (workouts ?? []).map((w) => ({
      id: w.id,
      performedAt: w.performed_at,
      notes: w.notes ?? null,
      plannedWorkoutId: w.planned_workout_id ?? null,
      sets: (w.workout_sets ?? []).map((s) => ({
        id: s.id,
        exerciseName: s.exercise_name,
        setIndex: s.set_index,
        reps: s.reps,
        weight: s.weight,
        unit: s.unit,
        plannedSetId: s.planned_set_id ?? null,
        plannedReps: s.planned_workout_sets?.target_reps ?? null,
        plannedWeight: s.planned_workout_sets?.target_weight ?? null
      }))
    }))
  };
}

export async function fetchWorkoutHistory(client, { userId, limit }) {
  const { data, error } = await client
    .from('workouts')
    .select(`
      id,
      performed_at,
      notes,
      planned_workout_id,
      workout_sets(
        id,
        exercise_name,
        set_index,
        reps,
        weight,
        unit,
        planned_set_id,
        planned_workout_sets(target_reps, target_weight)
      )
    `)
    .eq('user_id', userId)
    .order('performed_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return formatHistoryResponse(data ?? []);
}

export function escapeIlikePattern(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

export function normalizeExerciseName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > EXERCISE_NAME_MAX_LENGTH) return null;
  return trimmed;
}

export function exerciseNameErrorMessage(raw) {
  if (typeof raw !== 'string') return 'exerciseName must be a string.';
  if (raw.trim().length === 0) return 'exerciseName must be a non-empty string.';
  if (raw.trim().length > EXERCISE_NAME_MAX_LENGTH) {
    return `exerciseName must be at most ${EXERCISE_NAME_MAX_LENGTH} characters.`;
  }
  return null;
}

export function parseProgressionLimit(rawLimit) {
  if (rawLimit == null || rawLimit === '') return PROGRESSION_DEFAULT_LIMIT;
  if (typeof rawLimit === 'object') return `limit must be a string, not an object.`;
  const n = Number(rawLimit);
  if (!Number.isInteger(n) || n < PROGRESSION_MIN_LIMIT || n > PROGRESSION_MAX_LIMIT) {
    return `limit must be an integer between ${PROGRESSION_MIN_LIMIT} and ${PROGRESSION_MAX_LIMIT}.`;
  }
  return n;
}

export function formatProgressionResponse(exerciseName, rows) {
  return {
    exerciseName,
    sets: (rows ?? []).map((s) => {
      const workout = s.workouts ?? {};
      return {
        performedAt: workout.performed_at ?? null,
        workoutId: workout.id ?? null,
        setIndex: s.set_index,
        reps: s.reps,
        weight: s.weight,
        unit: s.unit,
        plannedReps: s.planned_workout_sets?.target_reps ?? null,
        plannedWeight: s.planned_workout_sets?.target_weight ?? null
      };
    })
  };
}

export async function fetchExerciseProgression(client, { userId, exerciseName, limit }) {
  const pattern = escapeIlikePattern(exerciseName);
  const { data, error } = await client
    .from('workout_sets')
    .select(`
      set_index,
      reps,
      weight,
      unit,
      planned_set_id,
      planned_workout_sets(target_reps, target_weight),
      workouts!inner(id, performed_at, user_id)
    `)
    .eq('workouts.user_id', userId)
    .ilike('exercise_name', pattern)
    .order('performed_at', { ascending: false, foreignTable: 'workouts' })
    .limit(limit);

  if (error) throw new Error(error.message);
  return formatProgressionResponse(exerciseName, data ?? []);
}
