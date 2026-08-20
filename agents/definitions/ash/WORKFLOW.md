# WORKFLOW.md — Ash

**Scope of this file:** how Ash verifies and routes task work. Polling cadence
belongs in `HEARTBEAT.md`.

## Ownership planes

Keep these ordered role slots separate:

- `assignee`: delivery owner;
- `workflowGates`: eligibility/context owner and, only when the attention stack
  is empty, fallback actor for the exact current lifecycle gate;
- `attentionOwners[0]`: authoritative current actor whenever the stack exists;
- later `attentionOwners`: dormant escalation targets.

Ash owning `qa_agent` never creates or replaces an attention-owner row. It does
make Ash actionable as the gate-owner fallback when `attentionOwners` is empty,
the gate is outstanding, and the task is in `doing`. The Tasks API mapper is
stage-aware: `open → spec`, `ready → tech_design`, `doing → qa_agent`,
`acceptance → accepted`. Ignore stale, approved, and future gates. If any
attention owner exists, position 0 acts and Ash's gate fallback is dormant.
Repeated people across or within planes are meaningful and must remain visible.

## When Ash is actionable

1. Fetch the full task and current delivery PR.
2. For a `doing` task with the current `qa_agent` gate, run the verifier in
   `agents/ash/src/verify.ts` and inspect cited tests, artifacts, and diff claims.
3. If evidence passes, write the structured `qa_agent` approval with Ash's
   credential. A comment may record evidence, but the approval row is the gate
   source and the attention stack is the routing source.
4. If ordinary delivery evidence fails (missing/failing tests, missing artifact,
   fabricated or mismatched claim), route the task back to its delivery assignee
   at `attentionOwners[0]`. Preserve gate context and the escalation tail.
5. If the blocker is tooling/systemic, route by capability: infrastructure,
   host, or network work may go to Lox; OpenClaw/runtime work goes to Quinn;
   otherwise choose the capable agent indicated by the evidence.
6. When resolved, advance only the current top slot. Preserve later and repeated
   slots exactly; never clear or deduplicate the whole stack accidentally.

## Escalation ceiling

Quinn is the highest agent escalation. If no agent can resolve the issue, route
Quinn to position 0. If Quinn still cannot resolve it, Quinn advances the stack
to `attentionOwners=["Tom"]`. Tom at position 0 is the terminal human action
state: the queue must surface Tom as actionable, no later attention owner is
needed, and there is no escalation beyond him.
Tom merely appearing later in a tail remains dormant and is not a reason to
message or wait on him.
