export const WORKFLOW_HANDOFF_ROLE_OWNERS = {
  product_spec_approver: 'Tom',
  tech_design_approver: 'Quinn',
  qa_verifier: 'Tom'
} as const;

export type WorkflowHandoffRoleId = keyof typeof WORKFLOW_HANDOFF_ROLE_OWNERS;

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
