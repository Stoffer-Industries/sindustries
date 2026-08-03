import {
  createPlannedWorkout,
  exerciseNameErrorMessage,
  fetchExerciseProgression,
  fetchWorkoutHistory,
  normalizeExerciseName,
  parseHistoryLimit,
  parseProgressionLimit,
  validatePlannedWorkoutBody
} from '../../../apps/gymtrack/server/agentData.js';
import { scopeAllows } from './scopes.js';

export const MCP_TOOLS = [
  {
    name: 'plan_workout',
    description: 'Create a planned workout for the authenticated GymTrack user.',
    inputSchema: {
      type: 'object',
      required: ['scheduledFor', 'title', 'exercises'],
      properties: {
        scheduledFor: { type: 'string', description: 'Workout date in YYYY-MM-DD format.' },
        title: { type: 'string' },
        notes: { type: 'string' },
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'sets'],
            properties: {
              name: { type: 'string' },
              sets: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['reps', 'weight'],
                  properties: {
                    reps: { type: 'integer' },
                    weight: { type: 'number' },
                    unit: { type: 'string', enum: ['kg', 'lb'] },
                    notes: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  {
    name: 'read_history',
    description: 'Read the authenticated user\'s recent GymTrack workout history.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      }
    }
  },
  {
    name: 'read_exercise_progression',
    description: 'Read progression history for one exercise for the authenticated GymTrack user.',
    inputSchema: {
      type: 'object',
      required: ['exerciseName'],
      properties: {
        exerciseName: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      }
    }
  }
];

function mcpJson(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload)
      }
    ],
    structuredContent: payload
  };
}

export async function callMcpTool({ client, identity, name, args }) {
  if (name === 'plan_workout') {
    if (!scopeAllows(identity.scope, 'workouts:write')) {
      throw Object.assign(new Error('Missing required scope workouts:write.'), { status: 403 });
    }
    const validationError = validatePlannedWorkoutBody(args);
    if (validationError) {
      throw Object.assign(new Error(validationError), { status: 400 });
    }
    const result = await createPlannedWorkout(client, {
      userId: identity.userId,
      legacyAgentKeyId: null,
      body: args
    });
    return mcpJson(result);
  }

  if (name === 'read_history') {
    if (!scopeAllows(identity.scope, 'history:read')) {
      throw Object.assign(new Error('Missing required scope history:read.'), { status: 403 });
    }
    const limit = parseHistoryLimit(args?.limit);
    if (typeof limit === 'string') {
      throw Object.assign(new Error(limit), { status: 400 });
    }
    return mcpJson(
      await fetchWorkoutHistory(client, {
        userId: identity.userId,
        limit
      })
    );
  }

  if (name === 'read_exercise_progression') {
    if (!scopeAllows(identity.scope, 'progression:read')) {
      throw Object.assign(new Error('Missing required scope progression:read.'), { status: 403 });
    }
    const exerciseName = normalizeExerciseName(args?.exerciseName);
    if (exerciseName == null) {
      throw Object.assign(new Error(exerciseNameErrorMessage(args?.exerciseName) ?? 'exerciseName is required.'), {
        status: 400
      });
    }
    const limit = parseProgressionLimit(args?.limit);
    if (typeof limit === 'string') {
      throw Object.assign(new Error(limit), { status: 400 });
    }
    return mcpJson(
      await fetchExerciseProgression(client, {
        userId: identity.userId,
        exerciseName,
        limit
      })
    );
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 404 });
}
