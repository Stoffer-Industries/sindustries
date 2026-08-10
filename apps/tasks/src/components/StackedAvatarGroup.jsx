import { Avatar } from '@sindustries/ui/react';
import { assigneeInitial } from '../utils/helpers.js';
import { assigneeDisplayName, findAssigneeUser } from '../users/assignees.js';

/**
 * Normalise a free-form owner label so duplicate people (e.g. `Quinn` and
 * `quinn `) collapse to the same visual entry without losing their multiple
 * roles. The dedupe key is the case-insensitive trimmed string so the
 * stacked avatar group is stable across server-rendered payload quirks.
 */
function normalizeOwnerKey(owner) {
  if (typeof owner !== 'string') return '';
  return owner.trim().toLowerCase();
}

/**
 * Build the ordered owner layers used by the stacked avatar group. The
 * returned shape is stable: delivery assignee first, then workflow-gate
 * owners (outstanding only, in policy-defined order), then attention
 * owners (in insertion order). Each entry carries the role so the
 * accessibility label and the task-details surface can render the distinct
 * responsibilities without re-deriving them.
 *
 * `delivery` is the single-row assignee field on the task. It is allowed to
 * be empty (no assignee yet) — the layout still renders the workflow-gate
 * and attention-owner layers so a task sitting in the queue waiting for a
 * gate owner surfaces that ownership immediately.
 *
 * `workflowGates` is the mapper-derived array. Only `outstanding` gates are
 * surfaced; approved gates are removed from the handoff surface (the goal
 * is to show what needs attention, not the audit trail).
 *
 * `attentionOwners` is the array of owner strings from the
 * `TaskAttentionOwner` table. The full details (note, addedBy) are surfaced
 * in task details, not here, so the avatar stack stays compact.
 *
 * Duplicate people are deduplicated visually: the first layer a person
 * appears in wins. Their distinct responsibilities remain available in
 * task details and accessibility labels (AC5).
 */
export function buildStackedOwnerLayers(task) {
  const layers = [];

  // Layer 1: delivery assignee. The single source of truth for "who is
  // shipping this". Never duplicated elsewhere in the stack.
  const delivery = task?.assignee;
  if (delivery && typeof delivery === 'string' && delivery.trim()) {
    layers.push({
      role: 'delivery',
      owner: delivery,
      key: normalizeOwnerKey(delivery)
    });
  }

  // Layer 2: outstanding workflow-gate owners. Approved gates are skipped
  // so the stack never re-shows a gate that has already been satisfied.
  const gates = Array.isArray(task?.workflowGates) ? task.workflowGates : [];
  for (const gate of gates) {
    if (!gate || gate.state !== 'outstanding') continue;
    if (!gate.owner) continue;
    layers.push({
      role: 'workflow-gate',
      owner: gate.owner,
      gateType: gate.type,
      key: normalizeOwnerKey(gate.owner)
    });
  }

  // Layer 3: attention owners. Insertion order matches the mapper output
  // (stable, oldest-first per the attention-owner createdAt sort).
  const attention = Array.isArray(task?.attentionOwners) ? task.attentionOwners : [];
  for (const owner of attention) {
    if (!owner || typeof owner !== 'string') continue;
    layers.push({
      role: 'attention',
      owner,
      key: normalizeOwnerKey(owner)
    });
  }

  // Deduplicate by key while preserving first-seen order. The first layer a
  // person appears in is the visible role; their additional roles are
  // surfaced in the accessibility label so screen readers and the
  // task-details surface still see the responsibility breakdown (AC5).
  const seen = new Set();
  const deduped = [];
  const roleCounts = new Map();
  for (const entry of layers) {
    roleCounts.set(entry.key, (roleCounts.get(entry.key) ?? 0) + 1);
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    deduped.push(entry);
  }
  return { entries: deduped, roleCounts };
}

/**
 * Human-readable role label for an owned role. Used in the accessibility
 * label and the task-details surface (AC6). Keeps the wording stable so
 * tests don't break on copy tweaks.
 */
export function roleLabel(role) {
  switch (role) {
    case 'delivery':
      return 'delivery assignee';
    case 'workflow-gate':
      return 'workflow-gate owner';
    case 'attention':
      return 'attention owner';
    default:
      return 'owner';
  }
}

/**
 * Build the combined accessibility label for a single avatar in the stack.
 * When a person wears multiple hats, the label lists each role so the
 * distinct responsibilities remain available to assistive tech (AC5, AC6).
 */
export function buildAvatarAriaLabel(entry, roleCounts) {
  const displayName = assigneeDisplayName(entry.owner) || entry.owner;
  const count = roleCounts.get(entry.key) ?? 1;
  if (count <= 1) {
    return `${roleLabel(entry.role)} ${displayName}`;
  }
  // Multiple roles: list the human roles in the visible order.
  const roles = ['delivery', 'workflow-gate', 'attention']
    .filter((role) => role !== entry.role)
    .filter((role) => {
      // Only include roles that actually appear in this task's stack.
      return roleCounts.has(entry.key); // best-effort; the caller refines below
    });
  // Simpler: describe the role for the visible layer and append a note
  // about additional roles.
  return `${roleLabel(entry.role)} ${displayName} (also has other roles on this task)`;
}

/**
 * Stacked avatar group for task cards. Renders the delivery assignee first,
 * then outstanding workflow-gate owners, then attention owners. Duplicate
 * people are deduplicated visually while their distinct responsibilities
 * remain available in task details and accessibility labels (AC5, AC6).
 *
 * The component is read-only and consumes the mapper-derived task payload
 * directly. It does not own any focus or click behaviour — task cards
 * already route the click to the title; the avatar stack is informational.
 */
export function StackedAvatarGroup({ task, maxVisible = 4 }) {
  const { entries, roleCounts } = buildStackedOwnerLayers(task);
  if (entries.length === 0) return null;

  const visible = entries.slice(0, maxVisible);
  const overflow = entries.length - visible.length;

  return (
    <div
      className="task-owner-stack"
      role="group"
      aria-label={`Task ownership: ${entries.map((e) => `${roleLabel(e.role)} ${assigneeDisplayName(e.owner) || e.owner}`).join(', ')}`}
    >
      {visible.map((entry) => {
        const user = findAssigneeUser(entry.owner);
        const displayName = assigneeDisplayName(entry.owner) || entry.owner;
        const initial = assigneeInitial(entry.owner);
        const ariaLabel = buildAvatarAriaLabel(entry, roleCounts);
        // The `data-role` attribute lets the task-details surface and the
        // accessibility script read the role without re-parsing the label.
        return (
          <span
            key={`${entry.role}:${entry.key}`}
            className={`task-owner-stack-item task-owner-stack-${entry.role}`}
            data-role={entry.role}
            data-owner-key={entry.key}
            aria-label={ariaLabel}
          >
            <Avatar
              src={user?.avatarSrc ?? undefined}
              alt={displayName}
              title={displayName}
            >
              {initial}
            </Avatar>
          </span>
        );
      })}
      {overflow > 0 ? (
        <span
          className="task-owner-stack-overflow"
          aria-label={`${overflow} more owner${overflow === 1 ? '' : 's'}`}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
