import { CONFETTI_COLORS } from './constants.js';

/**
 * Creates confetti pieces for the celebration effect
 * @param {number} [pieceCount=120]
 * @returns {Array<{id: number, color: string, startX: number, drift: number, rotation: number, size: number, duration: number, delay: number}>}
 */
export function createConfettiPieces(pieceCount = 120) {
  return Array.from({ length: pieceCount }, (_, index) => ({
    id: index,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    startX: 5 + Math.random() * 90,
    drift: -180 + Math.random() * 360,
    rotation: -520 + Math.random() * 1040,
    size: 6 + Math.random() * 8,
    duration: 1200 + Math.random() * 1300,
    delay: Math.random() * 220
  }));
}

/**
 * Normalize comments to array format
 * @param {unknown} comments
 * @returns {Array<{id?: string|number, author: string, text: string, createdAt?: string}>}
 */
export function normalizeComments(comments) {
  return Array.isArray(comments) ? comments : [];
}

/**
 * Format comment timestamp for display
 * @param {string|number|Date|null|undefined} value
 * @returns {string}
 */
export function formatCommentTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

/**
 * Normalize task data for the editor form
 * @param {Object} task
 * @returns {Object}
 */
export function normalizeTaskForEditor(task) {
  return {
    title: task.title ?? '',
    description: task.description ?? '',
    status: task.status ?? 'open',
    priority: task.priority ?? 'medium',
    assignee: task.assignee ?? '',
    dueAt: task.dueAt ? String(task.dueAt).slice(0, 10) : '',
    tagsText: Array.isArray(task.tags) ? task.tags.map((tag) => tag.name ?? tag).join(', ') : '',
    taskType: task.taskType ?? '',
    blocked: task.blocked ?? false
  };
}

/**
 * Get assignee initial for avatar
 * @param {string|null|undefined} assignee
 * @returns {string|null}
 */
export function assigneeInitial(assignee) {
  const trimmed = assignee?.trim();
  if (!trimmed) return null;
  const initial = trimmed.charAt(0);
  return initial ? initial.toUpperCase() : null;
}

/** Stable pulse-card tilt bucket (0–2) from a task id. */
export function taskCardTilt(taskId) {
  const id = String(taskId ?? '');
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum += id.charCodeAt(i);
  return sum % 3;
}
