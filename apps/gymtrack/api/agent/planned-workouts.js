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
import {
  buildInsertRows,
  createPlannedWorkout,
  validatePlannedWorkoutBody
} from '../../server/agentData.js';

export { buildInsertRows, validatePlannedWorkoutBody };

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

  try {
    const result = await createPlannedWorkout(client, {
      userId: identity.user_id,
      legacyAgentKeyId: identity.key_id,
      body
    });
    return res.status(201).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err?.message ?? 'Insert failed.' });
  }
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
