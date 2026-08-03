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
import {
  fetchWorkoutHistory,
  formatHistoryResponse,
  HISTORY_DEFAULT_LIMIT as DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT as MAX_LIMIT,
  HISTORY_MIN_LIMIT as MIN_LIMIT,
  parseHistoryLimit as parseLimit
} from '../../server/agentData.js';

export { DEFAULT_LIMIT, MAX_LIMIT, MIN_LIMIT, formatHistoryResponse, parseLimit };

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

  try {
    const result = await fetchWorkoutHistory(client, {
      userId: identity.user_id,
      limit
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err?.message ?? 'History lookup failed.' });
  }
}
