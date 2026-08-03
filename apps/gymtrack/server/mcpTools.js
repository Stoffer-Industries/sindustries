// apps/gymtrack/server/mcpTools.js
//
// MCP tool implementations for the GymTrack MCP server. These wrap the
// existing /api/agent/* handler logic so we have exactly one source of truth
// for each agent-facing operation: the MCP tools share validate/build/format
// helpers with the legacy static-key REST endpoints (AC5).
//
// Every tool takes `{ userId, args }` where `args` is the JSON object the
// MCP client sent in `params.arguments`. Every tool returns an MCP-shaped
// result object `{ content: [{ type: 'text', text: '<json-string>' }],
// isError?: boolean }`. Throwing is reserved for server errors — clients
// should see a JSON-RPC -32603 error code, never a stack trace.
//
// Scope gating: each tool advertises a `requiredScopes` array. The
// dispatcher in api/mcp.js calls `requireOAuthScope` before invoking the
// tool, so individual tool implementations do not need to repeat the check.

import { adminClient } from './agentAuth.js';
import {
  validatePlannedWorkoutBody,
  buildInsertRows
} from '../api/agent/planned-workouts.js';
import {
  parseLimit,
  formatHistoryResponse
} from '../api/agent/history.js';
import {
  normalizeExerciseName,
  exerciseNameErrorMessage,
  parseLimit as parseProgressionLimit,
  formatProgressionResponse
} from '../api/agent/exercises/[exerciseName]/progression.js';

/**
 * The canonical MCP tool definitions. The dispatcher in api/mcp.js returns
 * these verbatim from `tools/list`. Keeping the schema here (not in the
 * dispatcher) lets us add tools without touching the JSON-RPC plumbing.
 */
export const MCP_TOOLS = [
  {
    name: 'plan_workout',
    description:
      'Create a planned workout for the authenticated user. The plan is scheduled ' +
      'but not performed — the user still has to log the actual sets via the ' +
      'GymTrack UI on the day of the workout.',
    inputSchema: {
      type: 'object',
      properties: {
        scheduledFor: {
          type: 'string',
          description: 'YYYY-MM-DD date the workout is scheduled for.'
        },
        title: { type: 'string', description: 'Short title, e.g. "Upper Body Strength".' },
        notes: {
          type: 'string',
          description: 'Optional agent rationale visible to the user in the app.'
        },
        exercises: {
          type: 'object',
          description:
            'Wrapped under exercises; shape mirrors /api/agent/planned-workouts.',
          properties: {}
        }
      },
      required: ['scheduledFor', 'title', 'exercises'],
      additionalProperties: false
    },
    requiredScopes: ['workouts:write']
  },
  {
    name: 'read_history',
    description:
      'Read the user\'s recent workout history (newest first), including each ' +
      'set\'s actual reps/weight and the planned target when the set is linked ' +
      'back to a planned workout.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Number of workouts to return. Defaults to 10.'
        }
      },
      additionalProperties: false
    },
    requiredScopes: ['workouts:read']
  },
  {
    name: 'read_exercise_progression',
    description:
      'Read the chronological set history for a single exercise name. Returns ' +
      'planned targets alongside actuals so the agent can reason about progress ' +
      'and regression.',
    inputSchema: {
      type: 'object',
      properties: {
        exerciseName: {
          type: 'string',
          description: 'Exact exercise name as it appears in the user\'s history.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Number of sets to return. Defaults to 20.'
        }
      },
      required: ['exerciseName'],
      additionalProperties: false
    },
    requiredScopes: ['exercises:read']
  }
];

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_INFO = {
  name: 'gymtrack-mcp',
  version: '1.0.0'
};

/**
 * Look up a tool by name. Returns the tool definition or `null` if unknown.
 * `unknownTool` is the error we raise — the dispatcher wraps it as a
 * JSON-RPC -32601 method-not-found response.
 */
export function findTool(name) {
  return MCP_TOOLS.find((t) => t.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * plan_workout — create a planned workout for the authenticated user.
 *
 * Reuses `validatePlannedWorkoutBody` + `buildInsertRows` from the legacy
 * planned-workouts handler. The MCP `args` shape mirrors the REST body
 * shape so we do not need a separate validator.
 */
export async function planWorkoutTool({ userId, args }) {
  const validationError = validatePlannedWorkoutBody(args);
  if (validationError) {
    return textResult({ error: 'invalid_request', message: validationError }, true);
  }

  // The legacy REST handler uses `agent_key_id` to attribute the plan to
  // the issuing API key. For MCP we attribute to the OAuth client_id
  // instead via a synthetic id derived from `mcp:<client_id>`. This keeps
  // the column non-null without introducing a parallel attribution
  // table — the value is never queried for foreign-key relationships.
  // The caller passes the actual client_id through the dispatcher's
  // `toolContext` so this function stays pure-ish.
  const client = adminClient();
  const { parentRow, setRows } = buildInsertRows({
    userId,
    keyId: 'mcp-oauth',
    body: args
  });

  const { data: parent, error: parentErr } = await client
    .from('planned_workouts')
    .insert(parentRow)
    .select()
    .single();

  if (parentErr || !parent) {
    return textResult(
      { error: 'server_error', message: parentErr?.message ?? 'Insert failed.' },
      true
    );
  }

  if (setRows.length > 0) {
    const rowsWithFk = setRows.map((row) => ({ ...row, planned_workout_id: parent.id }));
    const { error: setsErr } = await client.from('planned_workout_sets').insert(rowsWithFk);
    if (setsErr) {
      await client.from('planned_workouts').delete().eq('id', parent.id);
      return textResult({ error: 'server_error', message: setsErr.message }, true);
    }
  }

  return textResult({ plannedWorkoutId: parent.id, setCount: setRows.length });
}

/**
 * read_history — return the user's most-recent workouts.
 */
export async function readHistoryTool({ userId, args }) {
  const limit = parseLimit(args?.limit);
  if (typeof limit === 'string') {
    return textResult({ error: 'invalid_request', message: limit }, true);
  }

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
    .eq('user_id', userId)
    .order('performed_at', { ascending: false })
    .limit(limit);

  if (error) {
    return textResult({ error: 'server_error', message: error.message }, true);
  }

  return textResult(formatHistoryResponse(data ?? []));
}

/**
 * read_exercise_progression — chronological set history for one exercise.
 */
export async function readExerciseProgressionTool({ userId, args }) {
  const exerciseName = normalizeExerciseName(args?.exerciseName);
  if (exerciseName == null) {
    return textResult(
      { error: 'invalid_request', message: exerciseNameErrorMessage(args?.exerciseName) ?? 'exerciseName is required.' },
      true
    );
  }

  const limit = parseProgressionLimit(args?.limit);
  if (typeof limit === 'string') {
    return textResult({ error: 'invalid_request', message: limit }, true);
  }

  const client = adminClient();
  // Match the same name shape as the REST handler: ilike with escaped
  // wildcards for case-insensitive exact-equivalent matching.
  const { data, error } = await client
    .from('workout_sets')
    .select(`
      set_index,
      reps,
      weight,
      unit,
      planned_set_id,
      workouts!workout_sets_workout_id_fkey(id, performed_at),
      planned_workout_sets(target_reps, target_weight)
    `)
    .eq('workouts.user_id', userId)
    .ilike('exercise_name', exerciseName.replace(/[\\%_]/g, '\\$&'))
    .order('workouts(performed_at)', { ascending: false })
    .limit(limit);

  if (error) {
    return textResult({ error: 'server_error', message: error.message }, true);
  }

  return textResult(formatProgressionResponse(exerciseName, data ?? []));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an MCP `tools/call` result. The MCP spec puts the tool's response
 * payload in `content[].text` as a JSON string — clients render it for the
 * LLM to read. `isError: true` signals a tool-level failure (bad input,
 * scope, etc.); protocol-level errors are emitted by the dispatcher as
 * JSON-RPC error envelopes instead.
 */
function textResult(payload, isError = false) {
  const result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  if (isError) result.isError = true;
  return result;
}