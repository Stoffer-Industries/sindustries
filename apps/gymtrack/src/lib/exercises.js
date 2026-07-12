import catalogue from '../data/exercises.json';

/**
 * Curated exercises list. Free-text names are also accepted in the logger.
 * @type {readonly string[]}
 */
export const EXERCISES = Object.freeze(catalogue);

export function isKnownExercise(name) {
  return EXERCISES.includes(name);
}