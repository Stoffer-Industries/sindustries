export const STATUSES = ['open', 'ready', 'doing', 'acceptance', 'done'];

export const STATUS_LABELS = {
  open: 'Open',
  ready: 'Ready',
  doing: 'Doing',
  acceptance: 'Acceptance',
  done: 'Done'
};

export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

export const PRIORITY_SCORE = { urgent: 0, high: 1, medium: 2, low: 3 };

// Re-exported from the apps/tasks user registry so existing import sites keep working.
// The source of truth lives in `../users/assignees.js`.
export { ASSIGNEE_OPTIONS } from '../users/assignees.js';

export const TASK_TYPES = ['content', 'code', 'research', 'feature'];

export const TASK_TYPE_LABELS = {
  content: 'Content',
  code: 'Code',
  research: 'Research',
  feature: 'Feature'
};

export const CONFETTI_COLORS = ['#ffc935', '#00d4ff', '#ff3e8a', '#31c76a', '#f3f1ec', '#7d5dff'];
