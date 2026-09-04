export const WORKFLOW_HANDOFF_ROLE_OWNERS = {
  product_spec_approver: 'Tom',
  tech_design_approver: 'Quinn',
  qa_verifier: 'Tom'
} as const;

export type WorkflowHandoffRoleId = keyof typeof WORKFLOW_HANDOFF_ROLE_OWNERS;

export const APPROVAL_WORKFLOW_HANDOFFS = {
  spec: {
    roleId: 'product_spec_approver',
    reason: 'Product spec approval is required'
  },
  tech_design: {
    roleId: 'tech_design_approver',
    reason: 'Tech design approval is required'
  },
  qa: {
    roleId: 'qa_verifier',
    reason: 'QA approval is required'
  }
} as const satisfies Record<string, { roleId: WorkflowHandoffRoleId; reason: string }>;

export function workflowHandoffForApproval(type: string) {
  return APPROVAL_WORKFLOW_HANDOFFS[type as keyof typeof APPROVAL_WORKFLOW_HANDOFFS] ?? null;
}

/**
 * Map a structured approval type to the attention-owner role that the
 * lobster (and the heartbeat queue, MC UI, etc.) treat as the head when
 * this approval is the active gate. The lobster already encodes the same
 * mapping in `workflow_attention_owner` (Rust) keyed on TaskApproval rows;
 * keeping a small TS mirror here is preferable to a cross-language helper
 * because the mapping is one entry per approval type and easy to audit.
 *
 * Distinct from `APPROVAL_WORKFLOW_HANDOFFS`, which clears the single-slot
 * `task.workflowHandoffRoleId/Gate/Reason` on approval; this map drives the
 * ordered `attentionOwners[]` head-slot routing on the same write. Both
 * writers stay in the same `$transaction` so a single approval lands
 * atomically across both fields.
 */
export const APPROVAL_ATTENTION_OWNERS = {
  spec: 'Tom',          // product_spec_approver — Tom
  tech_design: 'Quinn', // tech_design_approver — Quinn
  qa_agent: 'Ash',      // Ash's mechanical verification gate
  accepted: 'Tom'       // Tom's final human sign-off
} as const satisfies Record<string, string>;

export type ApprovalAttentionType = keyof typeof APPROVAL_ATTENTION_OWNERS;

export function attentionOwnerForApproval(type: string): string | null {
  return APPROVAL_ATTENTION_OWNERS[type as ApprovalAttentionType] ?? null;
}

export const WORKFLOW_HANDOFF_ROLE_IDS = new Set<string>(
  Object.keys(WORKFLOW_HANDOFF_ROLE_OWNERS)
);

export function workflowHandoffOwnerFor(roleId: string | null | undefined): string | null {
  if (!roleId) return null;
  return WORKFLOW_HANDOFF_ROLE_OWNERS[roleId as WorkflowHandoffRoleId] ?? null;
}

export function workflowHandoffRolesForOwner(owner: string): WorkflowHandoffRoleId[] {
  const normalized = owner.trim().toLowerCase();
  return (Object.entries(WORKFLOW_HANDOFF_ROLE_OWNERS) as Array<[WorkflowHandoffRoleId, string]>)
    .filter(([, configuredOwner]) => configuredOwner.toLowerCase() === normalized)
    .map(([roleId]) => roleId);
}
