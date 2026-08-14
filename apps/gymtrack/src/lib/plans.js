import { supabase } from './supabase.js';

/**
 * @typedef {Object} PlannedSet
 * @property {string} id
 * @property {string} planned_workout_id
 * @property {string} exercise_name
 * @property {number} set_index
 * @property {number} target_reps
 * @property {number} target_weight
 * @property {'kg'|'lb'} unit
 * @property {string|null} notes
 *
 * @typedef {Object} PlannedWorkout
 * @property {string} id
 * @property {string} user_id
 * @property {string|null} consent_id
 * @property {string} scheduled_for  YYYY-MM-DD
 * @property {string} title
 * @property {string|null} notes
 * @property {'planned'|'started'|'completed'|'archived'} status
 * @property {PlannedSet[]} sets
 */

const PLAN_WITH_SETS_SELECT =
  'id,user_id,consent_id,scheduled_for,title,notes,status,planned_workout_sets(id,planned_workout_id,exercise_name,set_index,target_reps,target_weight,unit,notes)';

/**
 * Fetch the user's planned workout (if any) scheduled for `yyyyMmDd`. The
 * most-recent plan wins when more than one exists for the same date.
 *
 * @param {{ date: string }} input
 * @returns {Promise<{ data: PlannedWorkout|null, error: Error|null }>}
 */
export async function fetchPlannedWorkoutForDate({ date }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { data: null, error: new Error('date must be a YYYY-MM-DD string') };
  }
  const { data, error } = await supabase
    .from('planned_workouts')
    .select(PLAN_WITH_SETS_SELECT)
    .eq('scheduled_for', date)
    .in('status', ['planned', 'started'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { data: null, error };
  if (!data) return { data: null, error: null };
  return { data: shapePlannedWorkout(data), error: null };
}

/**
 * Mark a planned workout as completed. The user must own the row (RLS).
 * Returns the error if the update fails; resolves with null on success.
 *
 * @param {{ plannedWorkoutId: string }} input
 * @returns {Promise<{ error: Error|null }>}
 */
export async function markPlannedWorkoutCompleted({ plannedWorkoutId }) {
  const { error } = await supabase
    .from('planned_workouts')
    .update({ status: 'completed' })
    .eq('id', plannedWorkoutId)
    .in('status', ['planned', 'started']);
  return { error };
}

/**
 * Fetch the user's planned workout referenced by `workout.planned_workout_id`
 * (used by history display to enrich a logged workout with its target sets).
 *
 * @param {{ plannedWorkoutId: string }} input
 * @returns {Promise<{ data: PlannedWorkout|null, error: Error|null }>}
 */
export async function fetchPlannedWorkoutById({ plannedWorkoutId }) {
  if (!plannedWorkoutId) return { data: null, error: null };
  const { data, error } = await supabase
    .from('planned_workouts')
    .select(PLAN_WITH_SETS_SELECT)
    .eq('id', plannedWorkoutId)
    .maybeSingle();
  if (error) return { data: null, error };
  if (!data) return { data: null, error: null };
  return { data: shapePlannedWorkout(data), error: null };
}

/**
 * Fetch the user's pending planned workouts (status `planned` or `started`)
 * for the Workouts tab listing. Ordered by `scheduled_for` ascending so the
 * soonest workout is at the top, with the same embedded-sets shape used by
 * the single-date fetcher.
 *
 * @returns {Promise<{ data: PlannedWorkout[], error: Error|null }>}
 */
export async function listPendingPlannedWorkouts() {
  const { data, error } = await supabase
    .from('planned_workouts')
    .select(PLAN_WITH_SETS_SELECT)
    .in('status', ['planned', 'started'])
    .order('scheduled_for', { ascending: true });
  if (error) return { data: null, error };
  if (!data) return { data: [], error: null };
  return { data: data.map(shapePlannedWorkout), error: null };
}

/**
 * Normalize a Supabase row from `planned_workouts` (with embedded
 * `planned_workout_sets`) into the PlannedWorkout shape used by the UI.
 * Sets are sorted by set_index.
 */
export function shapePlannedWorkout(row) {
  const sets = (row.planned_workout_sets ?? [])
    .slice()
    .sort((a, b) => a.set_index - b.set_index);
  return {
    id: row.id,
    user_id: row.user_id,
    consent_id: row.consent_id ?? null,
    scheduled_for: row.scheduled_for,
    title: row.title,
    notes: row.notes ?? null,
    status: row.status,
    sets
  };
}
