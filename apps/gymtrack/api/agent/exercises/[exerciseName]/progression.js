// apps/gymtrack/api/agent/exercises/[exerciseName]/progression.js
//
// Vercel serverless handler for GET /api/agent/exercises/:exerciseName/progression.
//
// Authenticated agents retrieve the calling user's chronologically-ordered set
// history for a single exercise name, with each set's planned target when
// linked via planned_set_id. Name matching is case-insensitive exact match
// (no wildcards, no aliases — defer for v1).
//
// Query parameters:
//   limit - integer 1..200, defaults to 20
//
// Response:
//   200 {
//     "exerciseName": "Bench Press",
//     "sets": [
//       {
//         "performedAt": "2026-07-23T...",
//         "setIndex": 1,
//         "reps": 8,
//         "weight": 80,
//         "unit": "kg",
//         "plannedReps": 8 | null,
//         "plannedWeight": 80 | null
//       }
//     ]
//   }
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
} from '../../../../server/agentAuth.js';

export const DEFAULT_LIMIT = 20;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 200;
export const EXERCISE_NAME_MAX_LENGTH = 120;

/**
 * Escape the few characters that have special meaning in a PostgREST `ilike`
 * pattern so the input name is matched literally (no wildcards, no escaping
 * surprises). The default escape character in Postgres is `\`.
 */
export function escapeIlikePattern(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

/**
 * Validate and normalize the exercise name from the dynamic route. Returns the
 * normalized name (trimmed) on success or `null` on error. The caller checks
 * `null` to distinguish error from the success string (which would otherwise be
 * indistinguishable when the name itself is a string).
 */
export function normalizeExerciseName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > EXERCISE_NAME_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Explain why `normalizeExerciseName` rejected a value. Separate from the
 * normalizer so the success path stays a clean string.
 */
export function exerciseNameErrorMessage(raw) {
  if (typeof raw !== 'string') return 'exerciseName must be a string.';
  if (raw.trim().length === 0) return 'exerciseName must be a non-empty string.';
  if (raw.trim().length > EXERCISE_NAME_MAX_LENGTH) {
    return `exerciseName must be at most ${EXERCISE_NAME_MAX_LENGTH} characters.`;
  }
  return null;
}

/**
 * Parse and validate the `limit` query param. Returns the parsed integer or an
 * error string.
 */
export function parseLimit(rawLimit) {
  if (rawLimit == null || rawLimit === '') return DEFAULT_LIMIT;
  if (typeof rawLimit === 'object') return `limit must be a string, not an object.`;
  const n = Number(rawLimit);
  if (!Number.isInteger(n) || n < MIN_LIMIT || n > MAX_LIMIT) {
    return `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}.`;
  }
  return n;
}

/**
 * Format the rows returned by the exercise-progression query into the agent API
 * response shape.
 */
export function formatProgressionResponse(exerciseName, rows) {
  return {
    exerciseName,
    sets: (rows ?? []).map((s) => {
      // Vercel's dynamic-route param ends up on req.query; Supabase embeds the
      // joined workout under the `workouts` key. We tolerate both shapes.
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

export default async function handler(req, res) {
  if (rejectIfWrongMethod(req, res, ['GET'])) return;

  let identity;
  try {
    identity = await resolveAgentIdentity(req);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err?.message ?? 'Auth lookup failed.' });
  }
  if (!identity) return unauthorized(res);

  const rawExerciseName = req.query?.exerciseName;
  const exerciseName = normalizeExerciseName(rawExerciseName);
  if (exerciseName == null) {
    return badRequest(res, exerciseNameErrorMessage(rawExerciseName) ?? 'exerciseName is required.');
  }

  const limit = parseLimit(req.query?.limit);
  if (typeof limit === 'string') return badRequest(res, limit);

  const pattern = escapeIlikePattern(exerciseName);

  const client = adminClient();
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
    .eq('workouts.user_id', identity.user_id)
    .ilike('exercise_name', pattern)
    .order('performed_at', { ascending: false, foreignTable: 'workouts' })
    .limit(limit);

  if (error) {
    return res.status(500).json({ error: 'server_error', message: error.message });
  }

  return res.status(200).json(formatProgressionResponse(exerciseName, data ?? []));
}
