import { Avatar } from '@sindustries/ui/react';
import { assigneeInitial } from '../utils/helpers.js';
import { assigneeDisplayName, findAssigneeUser } from '../users/assignees.js';

/** Normalise only the owner portion of a per-role-slot React key. */
function normalizeOwnerKeyPart(owner) {
  if (typeof owner !== 'string') return '';
  return owner.trim().toLowerCase();
}

/**
 * Build the ordered owner layers used by the stacked avatar group. The
 * returned shape is stable: delivery assignee first, then workflow-gate
 * owners (outstanding only, in policy-defined order), then attention
 * owners (in explicit escalation-slot order). Each entry carries the role so the
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
 * Every role slot is rendered, including repeated people. A repeated avatar
 * communicates that the same person owns more than one ordered responsibility;
 * collapsing it would destroy the escalation path.
 */
const ACTIONABLE_GATE_BY_STATUS = {
  open: 'spec',
  ready: 'tech_design',
  doing: 'qa_agent',
  acceptance: 'accepted'
};

export function buildStackedOwnerLayers(task) {
  const layers = [];

  // Layer 1: delivery assignee. The single source of truth for "who is
  // shipping this". Never duplicated elsewhere in the stack.
  const delivery = task?.assignee;
  if (delivery && typeof delivery === 'string' && delivery.trim()) {
    layers.push({
      role: 'delivery',
      owner: delivery,
      key: `delivery:${normalizeOwnerKeyPart(delivery)}`
    });
  }

  // Layer 2: the one exact status-actionable workflow gate. The mapper owns
  // this contract; the status check is defensive so stale/future payload rows
  // can never leak into the card stack.
  const gates = Array.isArray(task?.workflowGates) ? task.workflowGates : [];
  const actionableGate = ACTIONABLE_GATE_BY_STATUS[task?.status];
  for (const [gateIndex, gate] of gates.entries()) {
    const gateType = gate?.gate ?? gate?.type;
    if (!gate || gate.state !== 'outstanding') continue;
    if (!gate.owner || gateType !== actionableGate) continue;
    layers.push({
      role: 'workflow-gate',
      owner: gate.owner,
      gateType,
      key: `workflow-gate:${gateIndex}:${normalizeOwnerKeyPart(gate.owner)}`
    });
  }

  // Layer 3: attention owners in explicit escalation-slot order. Repeated
  // people stay as separate entries; position 0 is the current actor.
  const attention = Array.isArray(task?.attentionOwners) ? task.attentionOwners : [];
  for (const [slot, owner] of attention.entries()) {
    if (!owner || typeof owner !== 'string') continue;
    layers.push({
      role: 'attention',
      owner,
      slot,
      key: `attention:${slot}:${normalizeOwnerKeyPart(owner)}`
    });
  }

  return { entries: layers };
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
 * Repeated people retain one label per ordered role slot (AC5, AC6).
 */
export function buildAvatarAriaLabel(entry) {
  const displayName = assigneeDisplayName(entry.owner) || entry.owner;
  return `${roleLabel(entry.role)} ${displayName}`;
}

/**
 * Stacked avatar group for task cards. Renders the delivery assignee first,
 * then outstanding workflow-gate owners, then the ordered attention stack.
 * Repeated people remain visible as separate role slots (AC5, AC6).
 *
 * The component is read-only and consumes the mapper-derived task payload
 * directly. It does not own any focus or click behaviour — task cards
 * already route the click to the title; the avatar stack is informational.
 */
export function StackedAvatarGroup({ task, maxVisible = 4 }) {
  const { entries } = buildStackedOwnerLayers(task);
  if (entries.length === 0) return null;

  const visible = entries.slice(0, maxVisible);
  const overflow = entries.length - visible.length;

  return (
    <div
      className="task-owner-stack"
      role="group"
      aria-label={`Task ownership: ${entries.map((e) => `${roleLabel(e.role)} ${assigneeDisplayName(e.owner) || e.owner}`).join(', ')}`}
    >
      {visible.map((entry, index) => {
        const user = findAssigneeUser(entry.owner);
        const displayName = assigneeDisplayName(entry.owner) || entry.owner;
        const initial = assigneeInitial(entry.owner);
        const ariaLabel = buildAvatarAriaLabel(entry);
        const roleDepth = entry.role === 'attention' ? 300 : entry.role === 'workflow-gate' ? 200 : 100;
        // The `data-role` attribute lets the task-details surface and the
        // accessibility script read the role without re-parsing the label.
        return (
          <span
            key={entry.key}
            className={`task-owner-stack-item task-owner-stack-${entry.role}`}
            data-role={entry.role}
            data-owner-key={entry.key}
            aria-label={ariaLabel}
            style={{ zIndex: roleDepth - index }}
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
