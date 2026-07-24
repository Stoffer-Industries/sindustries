// apps/gymtrack/api/agent/history.js
//
// Vercel serverless handler for GET /api/agent/history.
//
// Authenticated agents retrieve the calling user's recent workout history,
// including each set's actual reps/weight and (when linked via planned_set_id)
// the planned target so the agent can reason about performance vs plan.
//
// Query parameters:
//   limit - integer 1..50, defaults to 10
//
// Response:
//   200 {
//     "workouts": [
//       {
//         "id": "<uuid>",
//         "performedAt": "2026-07-23T...",
//         "notes": "...",
//         "plannedWorkoutId": "<uuid>" | null,
//         "sets": [
//           {
//             "id": "<uuid>",
//             "exerciseName": "Bench Press",
//             "setIndex": 1,
//             "reps": 8,
//             "weight": 80,
//             "unit": "kg",
//             "plannedSetId": "<uuid>" | null,
//             "plannedReps": 8 | null,
//             "plannedWeight": 80 | null
//           }
//         ]
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
} from '../../server/agentAuth.js';

export const DEFAULT_LIMIT = 10;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 50;

/**
 * Parse and validate the `limit` query param. Returns the parsed integer, or a
 * human-readable error string describing the first violation.
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
 * Format a database workout row + nested sets into the agent API response shape.
 * Exported so tests can verify the mapping without re-implementing it.
 */
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

export default async function handler(req, res) {
  if (rejectIfWrongMethod(req, res, ['GET'])) return;

  let identity;
  try {
    identity = await resolveAgentIdentity(req);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err?.message ?? 'Auth lookup failed.' });
  }
  if (!identity) return unauthorized(res);

  const limit = parseLimit(req.query?.limit);
  if (typeof limit === 'string') return badRequest(res, limit);

  const client = adminClient();
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
    .eq('user_id', identity.user_id)
    .order('performed_at', { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(500).json({ error: 'server_error', message: error.message });
  }

  return res.status(200).json(formatHistoryResponse(data ?? []));
}
