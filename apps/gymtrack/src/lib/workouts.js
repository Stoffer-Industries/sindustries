import { supabase } from './supabase.js';
import { requireAuthenticatedUser } from './workouts-auth.js';

/**
 * @typedef {Object} Workout
 * @property {string} id
 * @property {string} user_id
 * @property {string} performed_at  ISO timestamp
 * @property {string|null} notes
 * @property {string|null} planned_workout_id  Optional FK to public.planned_workouts.
 *
 * @typedef {Object} WorkoutSet
 * @property {string} id
 * @property {string} workout_id
 * @property {string} exercise_name
 * @property {number} set_index
 * @property {number} reps
 * @property {number} weight
 * @property {'kg'|'lb'} unit
 * @property {string|null} planned_set_id  Optional FK to public.planned_workout_sets.
 */

/**
 * Create a workout (without sets).
 * @param {{ performed_at?: string, notes?: string|null, planned_workout_id?: string|null }} input
 * @returns {Promise<{ data: Workout|null, error: Error|null }>}
 */
export async function createWorkout(input = {}) {
  const { user, error: authError } = await requireAuthenticatedUser();
  if (authError) return { data: null, error: authError };
  const performed_at = input.performed_at ?? new Date().toISOString();
  const row = {
    user_id: user.id,
    performed_at,
    notes: input.notes ?? null
  };
  if (input.planned_workout_id) row.planned_workout_id = input.planned_workout_id;
  const { data, error } = await supabase
    .from('workouts')
    .insert(row)
    .select()
    .single();
  return { data, error };
}

/**
 * Attach a single set to a workout.
 * @param {{ workout_id: string, exercise_name: string, set_index: number, reps: number, weight: number, unit?: 'kg'|'lb', planned_set_id?: string|null }} input
 * @returns {Promise<{ data: WorkoutSet|null, error: Error|null }>}
 */
export async function addSet(input) {
  const row = {
    workout_id: input.workout_id,
    exercise_name: input.exercise_name,
    set_index: input.set_index,
    reps: input.reps,
    weight: input.weight,
    unit: input.unit ?? 'kg'
  };
  if (input.planned_set_id) row.planned_set_id = input.planned_set_id;
  const { data, error } = await supabase
    .from('workout_sets')
    .insert(row)
    .select()
    .single();
  return { data, error };
}

/**
 * Add a batch of sets to a workout in one request.
 * @param {{ workout_id: string, sets: Array<Omit<WorkoutSet,'id'|'workout_id'|'created_at'>> }} input
 * @returns {Promise<{ data: WorkoutSet[]|null, error: Error|null }>}
 */
export async function addSets({ workout_id, sets }) {
  if (!sets || sets.length === 0) return { data: [], error: null };
  const rows = sets.map((s) => {
    const row = {
      workout_id,
      exercise_name: s.exercise_name,
      set_index: s.set_index,
      reps: s.reps,
      weight: s.weight,
      unit: s.unit ?? 'kg'
    };
    if (s.planned_set_id) row.planned_set_id = s.planned_set_id;
    return row;
  });
  const { data, error } = await supabase
    .from('workout_sets')
    .insert(rows)
    .select();
  return { data, error };
}

/**
 * List workouts for the current user within a window (default last 30 days).
 * @param {{ since?: string }} input  ISO timestamp; defaults to now - 30 days
 * @returns {Promise<{ data: Workout[]|null, error: Error|null }>}
 */
export async function listWorkouts({ since } = {}) {
  const cutoff = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('workouts')
    .select('*')
    .gte('performed_at', cutoff)
    .order('performed_at', { ascending: false });
  return { data, error };
}

/**
 * List sets for a batch of workout ids.
 * @param {{ workout_ids: string[] }} input
 * @returns {Promise<{ data: WorkoutSet[]|null, error: Error|null }>}
 */
export async function listSetsForWorkouts({ workout_ids }) {
  if (!workout_ids || workout_ids.length === 0) return { data: [], error: null };
  const { data, error } = await supabase
    .from('workout_sets')
    .select('*')
    .in('workout_id', workout_ids)
    .order('set_index', { ascending: true });
  return { data, error };
}

/**
 * Delete a workout and its sets (CASCADE in DB).
 * @param {string} id
 * @returns {Promise<{ error: Error|null }>}
 */
export async function deleteWorkout(id) {
  const { error } = await supabase.from('workouts').delete().eq('id', id);
  return { error };
}