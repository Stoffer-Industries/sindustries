// Pure transition rules for task status writes.
//
// The Tasks API is the enforcement boundary for the workflow gate order.
// A task may not reach `acceptance` (Tom's sign-off gate) before Ash's
// structured `qa_agent` approval exists, and may not reach `done` before
// Tom's `accepted` approval exists. Today the API validates only that the
// requested status is a valid enum member, so any caller — the Lobster, a
// script, the Tasks UI, another agent holding an API token — can write an
// illegal transition. The Lobster's own gate is a second, independent
// defence; this module is the first.
//
// The rules live here as pure functions so they are unit-testable without a
// database, and so the PATCH handler only has to map a returned error onto
// an HTTP response. Which approvals gate which transition is NOT hardcoded
// here: the caller passes the task type's required-approval set, derived
// from the same config the `workflowGates` surface reads
// (`.openclaw/tasks-api/required-approvals.yaml`). Task types with an
// empty required set (`content`, `research`) are therefore unaffected, and
// the policy stays editable without a deploy.
//
// Task `fb5c4e40` AC1/AC2.

/** The approval fields the transition rules read. Mirrors the `TaskApproval`
 *  columns `type`, `state` and `revokedAt`.
 *
 *  `revokedAt` is a `Date` on the Prisma row and a string on the serialised
 *  payload, so both are accepted — the rule only asks whether a revocation
 *  timestamp is present, never what it says. */
export interface TransitionApprovalRow {
  type: string;
  state: string;
  revokedAt?: Date | string | null;
}

/** A rejected status transition. The `status` is always 409: the request is
 *  well-formed but conflicts with the task's current approval state. */
export interface StatusTransitionError {
  status: 409;
  code: string;
  message: string;
}

/** The `qa_agent` gate is open — no approval, or an approval still pending. */
export const QA_APPROVAL_REQUIRED = 'QA_APPROVAL_REQUIRED';
/** The `qa_agent` gate was granted and later revoked. */
export const QA_APPROVAL_REVOKED = 'QA_APPROVAL_REVOKED';
/** The `accepted` gate is open — Tom has not signed the task off. */
export const ACCEPTANCE_APPROVAL_REQUIRED = 'ACCEPTANCE_APPROVAL_REQUIRED';

/** Approval type that gates `doing → acceptance` (Ash's QA gate). */
const QA_APPROVAL_TYPE = 'qa_agent';
/** Approval type that gates `acceptance → done` (Tom's sign-off). */
const ACCEPTED_APPROVAL_TYPE = 'accepted';

export interface StatusTransitionCheck {
  /** The task's current status. */
  fromStatus: string;
  /** The status the caller asked for. */
  toStatus: string;
  /** The task type's required-approval set, from the required-approvals config. */
  requiredApprovals: string[];
  /** The task's current approval rows. */
  approvals: TransitionApprovalRow[];
  /** Resolved owner per approval type, for the error message. */
  gateOwners?: Record<string, string | null>;
}

function ownerFor(
  gateOwners: Record<string, string | null> | undefined,
  approvalType: string
): string | null {
  const owner = gateOwners?.[approvalType];
  return typeof owner === 'string' && owner.trim().length > 0 ? owner.trim() : null;
}

function findRow(
  approvals: TransitionApprovalRow[],
  approvalType: string
): TransitionApprovalRow | undefined {
  return approvals.find((approval) => approval.type === approvalType);
}

/**
 * True when an approval row counts as a granted gate.
 *
 * `state === 'approved'` is the grant. `revokedAt` is checked as well
 * because the API writes both together when it revokes a row — a row that
 * somehow carried an approval and a revocation timestamp is not a grant.
 */
function isGranted(row: TransitionApprovalRow | undefined): boolean {
  if (!row) return false;
  if (row.state !== 'approved') return false;
  return !row.revokedAt;
}

/**
 * Validate a requested status transition against the task's approval state.
 *
 * Returns `null` when the transition is allowed, or a `StatusTransitionError`
 * describing the blocked gate when it is not.
 *
 * Enforced rules:
 *
 * - `doing → acceptance` requires a granted `qa_agent` approval, when the
 *   task type's required-approval set includes `qa_agent`.
 * - `acceptance → done` requires a granted `accepted` approval, when the
 *   task type's required-approval set includes `accepted`.
 *
 * Every other transition is allowed, preserving current behaviour — including
 * the `acceptance → doing` rollback that the attention-owner handoff relies
 * on, and the `open → done` repair path.
 */
export function statusTransitionError(
  check: StatusTransitionCheck
): StatusTransitionError | null {
  const { fromStatus, toStatus, requiredApprovals, approvals } = check;
  const gateOwners = check.gateOwners;

  if (fromStatus === 'doing' && toStatus === 'acceptance') {
    if (!requiredApprovals.includes(QA_APPROVAL_TYPE)) return null;
    const row = findRow(approvals, QA_APPROVAL_TYPE);
    if (isGranted(row)) return null;
    const owner = ownerFor(gateOwners, QA_APPROVAL_TYPE);
    const who = owner ? `${owner} must approve` : 'the gate owner must approve';
    if (row && (row.state === 'revoked' || row.revokedAt)) {
      return {
        status: 409,
        code: QA_APPROVAL_REVOKED,
        message:
          `Cannot move a task from \`doing\` to \`acceptance\`: the structured \`${QA_APPROVAL_TYPE}\` approval was revoked. ` +
          `${who} the \`${QA_APPROVAL_TYPE}\` gate before this task reaches acceptance.`
      };
    }
    return {
      status: 409,
      code: QA_APPROVAL_REQUIRED,
      message:
        `Cannot move a task from \`doing\` to \`acceptance\`: the structured \`${QA_APPROVAL_TYPE}\` approval is ` +
        `${row ? `\`${row.state}\`` : 'missing'}. ${who} the \`${QA_APPROVAL_TYPE}\` gate before this task reaches acceptance.`
    };
  }

  if (fromStatus === 'acceptance' && toStatus === 'done') {
    if (!requiredApprovals.includes(ACCEPTED_APPROVAL_TYPE)) return null;
    const row = findRow(approvals, ACCEPTED_APPROVAL_TYPE);
    if (isGranted(row)) return null;
    const owner = ownerFor(gateOwners, ACCEPTED_APPROVAL_TYPE);
    const who = owner ? `${owner} must approve` : 'the gate owner must approve';
    return {
      status: 409,
      code: ACCEPTANCE_APPROVAL_REQUIRED,
      message:
        `Cannot move a task from \`acceptance\` to \`done\`: the structured \`${ACCEPTED_APPROVAL_TYPE}\` approval is ` +
        `${row ? `\`${row.state}\`` : 'missing'}. ${who} the \`${ACCEPTED_APPROVAL_TYPE}\` gate before this task is closed.`
    };
  }

  return null;
}
