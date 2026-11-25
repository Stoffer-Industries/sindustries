import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/http.ts';

export type ApprovalType = 'spec' | 'tech_design' | 'qa_agent' | 'accepted';
export type ApprovalPrincipal = {
  actor: string;
  /** Types this actor may GRANT. */
  approvalTypes: ReadonlySet<ApprovalType>;
  /** Types this actor may REVOKE. Superset of `approvalTypes` by construction. */
  revocationTypes: ReadonlySet<ApprovalType>;
  kind: 'clerk_session' | 'service';
};

declare global { namespace Express { interface Request { approvalPrincipal?: ApprovalPrincipal } } }

// AC3 of task `ad8346ee`: the lobster needs to REVOKE a `qa_agent` approval
// whose AC-evidence pins no longer match the PR, and it needs to do so without
// ever being able to GRANT one.
//
// Grant and revoke are deliberately separate dimensions. Granting a gate is
// an authority act; revoking one is a safety downgrade that a later grant can
// undo. Folding both into the single `approvalTypes` set would have forced
// one of two bad options: hand the lobster `qa_agent` grant rights (so it
// could self-approve the gate AC1 exists to police), or leave AC3's
// invalidation unimplemented.
//
// `feature_task_lobster` is added here and ONLY here. It still cannot write
// an approval row of any type via POST.
const REVOKE_ONLY_PERMISSIONS: Record<string, ReadonlySet<ApprovalType>> = {
  feature_task_lobster: new Set<ApprovalType>(['qa_agent'])
};

function revocationTypesFor(actor: string, grantable: ReadonlySet<ApprovalType>): ReadonlySet<ApprovalType> {
  const extra = REVOKE_ONLY_PERMISSIONS[actor];
  if (!extra) return grantable;
  return new Set<ApprovalType>([...grantable, ...extra]);
}

// `feature_task_lobster` is the automated feature-task workflow itself, not
// a human/agent identity. As of task d9cd8a83 it no longer writes approval
// rows — `POST /tasks` materialises pending rows directly, so the lobster
// no longer needs the `qa_agent` write grant that the now-removed
// `ensure_qa_agent_gate` bootstrap required. The lobster still uses its
// service credential for `add_comment` and other non-approval routes
// (which are gated by separate middleware).
//
// `brain_spec_reconciler` is a separate, narrowly-scoped identity used only by
// `reconcile-brain-spec-approvals` (`agents/workflows/feature-task/src/main.rs`).
// It never exercises judgment: it only mirrors a `- [x] **Approved by Tom**`
// marker Tom already wrote into a `brain/tasks/specs/**/*.md` file into a
// structured `spec` approval, and only when that spec has exactly one
// unambiguous `**Spec:**` link from an active feature task. The resulting
// approval's `owner` is `brain_spec_reconciler`, not `Tom` — the audit trail
// always shows this was a mechanical reconciliation, never a live Tom action.
const ACTOR_PERMISSIONS: Record<string, ReadonlySet<ApprovalType>> = {
  // Tom holds the routine gates (`spec`, `accepted`) and is also authorised
  // as an override actor for `tech_design` and `qa_agent`. The override is
  // additive — `APPROVAL_ATTENTION_OWNERS` and the Rust
  // `workflow_attention_owner` still key on approval type (Quinn for
  // tech_design, Ash for qa_agent), so a Tom-granted approval satisfies
  // the gate exactly as a Quinn/Ash grant would without making Tom the
  // routine routable attention owner. See docs/specs/tom-approve-tech-
  // design-qa-gates-tech-design.md for the full design and AC4 invariant.
  Tom: new Set(['spec', 'accepted', 'tech_design', 'qa_agent']),
  Quinn: new Set(['tech_design']),
  Ash: new Set(['qa_agent']),
  feature_task_lobster: new Set([]),
  brain_spec_reconciler: new Set(['spec'])
};

export function approvalTypesForActor(actor: string): ApprovalType[] {
  return [...(ACTOR_PERMISSIONS[actor] ?? [])];
}

function permissions(actor: string, requested?: ApprovalType[]) {
  const policy = ACTOR_PERMISSIONS[actor];
  return policy ? new Set((requested ?? [...policy]).filter((type) => policy.has(type))) : null;
}

export async function requireApprovalPrincipal(req: Request, res: Response, next: NextFunction) {
  try {
    const principal = req.user;
    if (!principal) return sendError(res, 401, 'APPROVAL_AUTH_REQUIRED', 'A valid bearer credential is required');
    const requested = principal.kind === 'service'
      ? principal.approvalTypes.filter((type): type is ApprovalType =>
          ['spec', 'tech_design', 'qa_agent', 'accepted'].includes(type)
        )
      : undefined;
    const allowed = permissions(principal.actor, requested);
    if (!allowed) return sendError(res, 403, 'APPROVAL_ACTOR_FORBIDDEN', 'Actor is not permitted to mutate approvals');
    req.approvalPrincipal = {
      actor: principal.actor,
      approvalTypes: allowed,
      revocationTypes: revocationTypesFor(principal.actor, allowed),
      kind: principal.kind
    };
    return next();
  } catch (error) { return next(error); }
}

/**
 * Authorize REVOKING an approval row.
 *
 * Wider than `authorizeApprovalType` on purpose — see
 * `REVOKE_ONLY_PERMISSIONS`. A revoked gate is recoverable (the owner
 * re-approves); a gate granted to the wrong actor is not.
 */
export function authorizeApprovalRevocation(req: Request, res: Response, type: ApprovalType): boolean {
  if (!req.approvalPrincipal?.revocationTypes.has(type)) {
    sendError(res, 403, 'APPROVAL_TYPE_FORBIDDEN', `${req.approvalPrincipal?.actor ?? 'Actor'} cannot revoke ${type} approval`);
    return false;
  }
  return true;
}

export function authorizeApprovalType(req: Request, res: Response, type: ApprovalType): boolean {
  if (!req.approvalPrincipal?.approvalTypes.has(type)) {
    sendError(res, 403, 'APPROVAL_TYPE_FORBIDDEN', `${req.approvalPrincipal?.actor ?? 'Actor'} cannot mutate ${type} approval`);
    return false;
  }
  return true;
}
