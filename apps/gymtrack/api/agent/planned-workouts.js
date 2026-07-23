// apps/gymtrack/api/agent/planned-workouts.js
//
// Vercel serverless handler for POST /api/agent/planned-workouts.
//
// Authenticated agents submit a planned workout for the user behind their
// bearer token. Validates payload bounds, inserts parent + child rows, and
// returns { plannedWorkoutId, setCount } on success.
//
// Request body:
//   {
//     "scheduledFor": "2026-07-24",          // YYYY-MM-DD
//     "title": "Upper Body Strength",        // non-empty
//     "notes": "optional agent rationale",   // optional
//     "exercises": [
//       {
//         "name": "Bench Press",
//         "sets": [
//           { "reps": 8, "weight": 80, "unit": "kg", "notes": "RPE 7" }
//         ]
//       }
//     ]
//   }
//
// Response:
//   201 { "plannedWorkoutId": "<uuid>", "setCount": <number> }
//   400 { "error": "invalid_request", "message": "<reason>" }
//   401 { "error": "invalid_api_key" }
//   405 { "error": "method_not_allowed" }
//   500 { "error": "server_error", "message": "<reason>" }

import {
  adminClient,
  badRequest,
  rejectIfWrongMethod,
  resolveAgentIdentity,
  unauthorized
} from '../../server/agentAuth.js';

const MAX_EXERCISES_PER_PLAN = 25;
const MAX_SETS_PER_EXERCISE = 20;
const MAX_TOTAL_SETS = 200;

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

function isNonNegativeNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Validate the POST body shape and bounds. Returns null on success or a
 * human-readable error message describing the first violation found.
 */
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

/**
 * Flatten the validated body into row arrays for parent + child inserts.
 */
export function buildInsertRows({ userId, keyId, body }) {
  const setRows = [];
  body.exercises.forEach((exercise) => {
    exercise.sets.forEach((set, idx) => {
      setRows.push({
        planned_workout_id: undefined, // filled in after parent insert
        exercise_name: exercise.name.trim(),
        set_index: idx + 1,
        target_reps: set.reps,
        target_weight: set.weight,
        unit: set.unit ?? 'kg',
        notes: set.notes?.trim() || null
      });
    });
  });
  const parentRow = {
    user_id: userId,
    agent_key_id: keyId,
    scheduled_for: body.scheduledFor,
    title: body.title.trim(),
    notes: body.notes?.trim() || null,
    status: 'planned'
  };
  return { parentRow, setRows };
}

export default async function handler(req, res) {
  if (rejectIfWrongMethod(req, res, ['POST'])) return;

  let identity;
  try {
    identity = await resolveAgentIdentity(req);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err?.message ?? 'Auth lookup failed.' });
  }
  if (!identity) return unauthorized(res);

  // Vercel does not always pre-parse JSON, depending on the runtime config;
  // accept either a parsed body or a JSON string.
  const body = typeof req.body === 'string'
    ? safeJsonParse(req.body)
    : req.body;

  const validationError = validatePlannedWorkoutBody(body);
  if (validationError) return badRequest(res, validationError);

  const client = adminClient();
  const { parentRow, setRows } = buildInsertRows({
    userId: identity.user_id,
    keyId: identity.key_id,
    body
  });

  const { data: parent, error: parentErr } = await client
    .from('planned_workouts')
    .insert(parentRow)
    .select()
    .single();

  if (parentErr || !parent) {
    return res
      .status(500)
      .json({ error: 'server_error', message: parentErr?.message ?? 'Insert failed.' });
  }

  if (setRows.length > 0) {
    const rowsWithFk = setRows.map((row) => ({ ...row, planned_workout_id: parent.id }));
    const { error: setsErr } = await client.from('planned_workout_sets').insert(rowsWithFk);
    if (setsErr) {
      // Roll back the parent so we never leave a plan with zero target sets.
      await client.from('planned_workouts').delete().eq('id', parent.id);
      return res
        .status(500)
        .json({ error: 'server_error', message: setsErr.message });
    }
  }

  return res.status(201).json({
    plannedWorkoutId: parent.id,
    setCount: setRows.length
  });
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
