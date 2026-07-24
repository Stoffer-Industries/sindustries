/**
 * Apps/tasks-local assignee/user registry.
 *
 * Maps free-form assignee strings (case-insensitive) to a display name and an
 * optional avatar image. Source art lives under `apps/tasks/public/avatars/`.
 *
 * Keep this isolated behind helper functions so a future shared package,
 * API-backed user service, or agent profile system can replace the in-app
 * registry without changing `TaskCardSummary` or other call sites.
 */

export const ASSIGNEE_USERS = [
  { id: 'quinn', displayName: 'Quinn', avatarSrc: '/avatars/quinn.png' },
  { id: 'ivy', displayName: 'Ivy', avatarSrc: '/avatars/ivy.png' },
  { id: 'lox', displayName: 'Lox', avatarSrc: '/avatars/lox.png' },
  { id: 'rowan', displayName: 'Rowan', avatarSrc: '/avatars/rowan.png' },
  { id: 'tom', displayName: 'Tom', avatarSrc: '/avatars/tom.jpg' }
];

/**
 * Reserved assignee labels shown in dropdowns and filters.
 * Kept as the capitalized display names so existing filter values remain stable.
 */
export const ASSIGNEE_OPTIONS = ASSIGNEE_USERS.map((user) => user.displayName);

function normalizeAssigneeId(assignee) {
  if (typeof assignee !== 'string') return '';
  return assignee.trim().toLowerCase();
}

/**
 * Look up a registered assignee by id (case-insensitive, whitespace-trimmed).
 * Returns `null` for unknown / empty input — the task assignee is allowed to
 * be a free-form string outside the reserved set.
 */
export function findAssigneeUser(assignee) {
  const normalized = normalizeAssigneeId(assignee);
  if (!normalized) return null;
  return ASSIGNEE_USERS.find((user) => user.id === normalized) ?? null;
}

/**
 * Best-effort assignee display label.
 * - Returns the user's display name when the assignee is a known id.
 * - Returns the trimmed raw assignee when it is unknown / free-form.
 * - Returns an empty string when the assignee is missing or whitespace-only.
 */
export function assigneeDisplayName(assignee) {
  const user = findAssigneeUser(assignee);
  if (user) return user.displayName;
  if (typeof assignee === 'string') {
    const trimmed = assignee.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
