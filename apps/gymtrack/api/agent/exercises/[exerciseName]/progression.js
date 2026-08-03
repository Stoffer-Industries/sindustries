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
import {
  escapeIlikePattern,
  exerciseNameErrorMessage,
  EXERCISE_NAME_MAX_LENGTH,
  fetchExerciseProgression,
  formatProgressionResponse,
  normalizeExerciseName,
  parseProgressionLimit as parseLimit,
  PROGRESSION_DEFAULT_LIMIT as DEFAULT_LIMIT,
  PROGRESSION_MAX_LIMIT as MAX_LIMIT,
  PROGRESSION_MIN_LIMIT as MIN_LIMIT
} from '../../../../server/agentData.js';

export {
  DEFAULT_LIMIT,
  EXERCISE_NAME_MAX_LENGTH,
  MAX_LIMIT,
  MIN_LIMIT,
  escapeIlikePattern,
  exerciseNameErrorMessage,
  formatProgressionResponse,
  normalizeExerciseName,
  parseLimit
};

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

  const client = adminClient();

  try {
    const result = await fetchExerciseProgression(client, {
      userId: identity.user_id,
      exerciseName,
      limit
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err?.message ?? 'Progression lookup failed.' });
  }
}
