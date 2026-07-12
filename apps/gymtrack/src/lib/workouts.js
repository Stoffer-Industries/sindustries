import { supabase } from './supabase.js';

/**
 * @typedef {Object} Workout
 * @property {string} id
 * @property {string} user_id
 * @property {string} performed_at  ISO timestamp
 * @property {string|null} notes
 *
 * @typedef {Object} WorkoutSet
 * @property {string} id
 * @property {string} workout_id
 * @property {string} exercise_name
 * @property {number} set_index
 * @property {number} reps
 * @property {number} weight
 * @property {'kg'|'lb'} unit
 */

/**
 * Create a workout (without sets).
 * @param {{ performed_at?: string, notes?: string|null }} input
 * @returns {Promise<{ data: Workout|null, error: Error|null }>}
 */
export async function createWorkout(input = {}) {
  const { data: { user } = {} } = await supabase.auth.getUser();
  if (!user) return { data: null, error: new Error('Not authenticated') };
  const performed_at = input.performed_at ?? new Date().toISOString();
  const { data, error } = await supabase
    .from('workouts')
    .insert({ user_id: user.id, performed_at, notes: input.notes ?? null })
    .select()
    .single();
  return { data, error };
}

/**
 * Attach a single set to a workout.
 * @param {{ workout_id: string, exercise_name: string, set_index: number, reps: number, weight: number, unit?: 'kg'|'lb' }} input
 * @returns {Promise<{ data: WorkoutSet|null, error: Error|null }>}
 */
export async function addSet(input) {
  const { data, error } = await supabase
    .from('workout_sets')
    .insert({
      workout_id: input.workout_id,
      exercise_name: input.exercise_name,
      set_index: input.set_index,
      reps: input.reps,
      weight: input.weight,
      unit: input.unit ?? 'kg'
    })
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
  const rows = sets.map((s) => ({
    workout_id,
    exercise_name: s.exercise_name,
    set_index: s.set_index,
    reps: s.reps,
    weight: s.weight,
    unit: s.unit ?? 'kg'
  }));
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