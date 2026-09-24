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
 * returned shape is stable: attention owners first (in explicit escalation-slot
 * order), then workflow-gate owners (outstanding only, in policy-defined
 * order), then the delivery assignee. Each entry carries the role so the
 * accessibility label and the task-details surface can render the distinct
 * responsibilities without re-deriving them.
 *
 * Cross-role visual dedupe (AC4): a person who appears as both delivery
 * assignee AND attention owner renders ONE avatar, owned by the higher-tier
 * role (attention > workflow-gate > delivery). This closes the "Rowan is
 * shown three times for one task" defect without losing the escalation
 * semantics — within the attention tier, repeated names stay as separate
 * ordered slots because that IS the escalation shape.
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
 * in the accessibility label and the task-details surface.
 *
 * Every role slot is rendered, including repeated people. A repeated avatar
 * communicates that the same person owns more than one ordered responsibility;
 * collapsing it would destroy the escalation path. Position 0 is the current
 * attention owner and is therefore the strongest visual layer.
 */
const ACTIONABLE_GATE_BY_STATUS = {
  open: 'spec',
  ready: 'tech_design',
  doing: 'qa_agent',
  acceptance: 'accepted'
};

// Tier rank — higher wins on cross-role dedupe.
const ROLE_TIER = {
  delivery: 1,
  'workflow-gate': 2,
  attention: 3
};

/**
 * Find the attention-detail row matching this owner at the given
 * slot, falling back to the first case-insensitive match when the
 * slot lookup misses (older mapper responses without per-row positions).
 *
 * Quinn's PR #751 review (AC4 follow-up): the original implementation
 * matched by `owner` only, which silently collapsed the per-row note
 * for any intra-tier repeat (AC4 explicitly preserves two attention
 * slots for the same owner at different positions). The slot-aware
 * lookup surfaces each row's own note; the fallback to first-match
 * keeps older mapper payloads from rendering an empty reason.
 */
function findAttentionDetail(details, owner, slot) {
  if (!Array.isArray(details)) return null;
  const target = owner.trim().toLowerCase();
  if (typeof slot === 'number' && Number.isInteger(slot) && slot >= 0) {
    const slotRow = details[slot];
    if (slotRow && typeof slotRow?.owner === 'string' && slotRow.owner.trim().toLowerCase() === target) {
      return slotRow;
    }
  }
  for (const row of details) {
    if (typeof row?.owner !== 'string') continue;
    if (row.owner.trim().toLowerCase() === target) return row;
  }
  return null;
}

export function buildStackedOwnerLayers(task) {
  const layers = [];
  const attentionDetails = Array.isArray(task?.attentionOwnerDetails) ? task.attentionOwnerDetails : [];

  // Layer 1: attention owners in explicit escalation-slot order. Position 0
  // is the person currently exposed to the task and must be first in the
  // rendered ownership group. Each entry carries the per-row note so the
  // accessibility label and the task-details surface can surface the
  // reason without a second API round-trip.
  const attention = Array.isArray(task?.attentionOwners) ? task.attentionOwners : [];
  for (const [slot, owner] of attention.entries()) {
    if (!owner || typeof owner !== 'string') continue;
    const detail = findAttentionDetail(attentionDetails, owner, slot);
    layers.push({
      role: 'attention',
      owner,
      slot,
      note: detail?.note ?? null,
      addedBy: detail?.addedBy ?? null,
      rowId: detail?.id ?? null,
      key: `attention:${slot}:${normalizeOwnerKeyPart(owner)}`
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

  // Layer 3: delivery assignee. The single source of truth for "who is
  // shipping this". Never duplicated elsewhere in the stack. It is rendered
  // after attention and gate context so the current attention owner remains
  // visually primary.
  const delivery = task?.assignee;
  if (delivery && typeof delivery === 'string' && delivery.trim()) {
    layers.push({
      role: 'delivery',
      owner: delivery,
      key: `delivery:${normalizeOwnerKeyPart(delivery)}`
    });
  }

  // AC4 cross-role collapse: a name that appears in more than one role tier
  // renders one avatar, owned by the highest-tier role. Within a single
  // tier the repeat stays as separate slots because that IS the escalation
  // shape (e.g. [Rowan, Rowan, Tom] is a real escalation contract); only
  // cross-tier duplicates collapse.
  const collapsed = [];
  const seenAcrossTiers = new Map();
  for (const layer of layers) {
    const key = normalizeOwnerKeyPart(layer.owner);
    const existing = seenAcrossTiers.get(key);
    if (!existing) {
      seenAcrossTiers.set(key, { tier: ROLE_TIER[layer.role], layer });
      collapsed.push(layer);
      continue;
    }
    if (ROLE_TIER[layer.role] > existing.tier) {
      // The new layer outranks the prior; replace the prior with the new
      // entry but keep the original index so the avatar stack's relative
      // ordering stays stable for callers that read position-by-index.
      const idx = collapsed.indexOf(existing.layer);
      collapsed[idx] = layer;
      seenAcrossTiers.set(key, { tier: ROLE_TIER[layer.role], layer });
      continue;
    }
    if (ROLE_TIER[layer.role] === existing.tier) {
      // Same-tier repeat (intra-tier): keep as separate slot. The
      // escalation shape — e.g. Rowan listed twice intentionally at
      // different positions — is preserved by NOT replacing the prior and
      // NOT registering the new entry as the canonical representative.
      collapsed.push(layer);
      continue;
    }
    // Lower-tier: the higher-tier entry already represents this person;
    // skip the duplicate.
  }

  return { entries: collapsed };
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
 * Cross-role repeats render once with the higher-tier role label (AC4);
 * within-tier attention repeats stay as separate slots (AC5).
 *
 * AC4: when the row carries a `note`, append a 80-char truncated excerpt
 * so screen readers communicate why the attention request was raised
 * without a second interaction.
 */
export function buildAvatarAriaLabel(entry) {
  const displayName = assigneeDisplayName(entry.owner) || entry.owner;
  const baseLabel = `${roleLabel(entry.role)} ${displayName}`;
  if (entry.role !== 'attention' || !entry.note) return baseLabel;
  const trimmed = entry.note.length > 80 ? `${entry.note.slice(0, 80)}…` : entry.note;
  return `${baseLabel} — ${trimmed}`;
}

/**
 * Stacked avatar group for task cards. Renders the ordered attention stack
 * first, then outstanding workflow-gate owners, then the delivery assignee.
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
      aria-label={`Task ownership: ${entries.map((e) => buildAvatarAriaLabel(e)).join(', ')}`}
    >
      {visible.map((entry) => {
        const user = findAssigneeUser(entry.owner);
        const displayName = assigneeDisplayName(entry.owner) || entry.owner;
        const initial = assigneeInitial(entry.owner);
        const ariaLabel = buildAvatarAriaLabel(entry);
        const roleDepth = entry.role === 'attention' ? 300 : entry.role === 'workflow-gate' ? 200 : 100;
        const sameRoleEntries = visible.filter((candidate) => candidate.role === entry.role);
        const roleIndex = sameRoleEntries.indexOf(entry);
        // Position 0 is the current attention owner, so it must paint above
        // later escalation slots. The same rule keeps each role tier stable
        // if more than one gate or delivery context is ever introduced.
        const roleZIndex = roleDepth + sameRoleEntries.length - roleIndex - 1;
        // The `data-role` attribute lets the task-details surface and the
        // accessibility script read the role without re-parsing the label.
        // The `data-reason` attribute (AC4) carries the attention note into
        // the task-details surface so the per-row reason is rendered without
        // a second API round-trip.
        return (
          <span
            key={entry.key}
            className={`task-owner-stack-item task-owner-stack-${entry.role}`}
            data-role={entry.role}
            data-owner-key={entry.key}
            data-reason={entry.role === 'attention' && entry.note ? entry.note : undefined}
            aria-label={ariaLabel}
            style={{ zIndex: roleZIndex }}
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
