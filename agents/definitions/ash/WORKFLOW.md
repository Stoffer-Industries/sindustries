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

### Verification domains

Classify each AC by the system it needs to exercise. This determines the
preflight path and the capability request if the check cannot be completed:

- **Workflows / crons:** run the workflow or cron entry point, inspect its
  bounded output/logs, and verify the resulting state or artifact.
- **Apps:** use the app's staging environment for API, browser, and end-to-end
  behaviour when staging exists; request browser/device control or a staging
  test principal when required.
- **Services:** leave the existing CI/unit/integration-test ownership intact.
  Ash validates the authoritative CI result and only performs a targeted
  black-box check when the AC explicitly requires runtime behaviour.
- **Infrastructure / deployments:** inspect deployment health, logs, routes,
  and configuration outcomes; request privileged operator capability for
  mutations such as rulesets, environments, or production deploys.
- **Integrations:** use sandbox/test endpoints and test credentials for OAuth,
  webhooks, email, payments, and other external systems; never infer success
  from a unit test when the AC is about the external boundary.
- **Data / migrations:** use disposable or staging data for migration,
  persistence, rollback, and seed checks; request database access when the
  required environment is unavailable.
- **Security / identity:** use scoped test principals and safe fixtures for
  authn, authz, secrets, rate limits, and isolation checks; escalate requests
  that need privileged identities or production data.

Observability is cross-cutting: logs, metrics, traces, and alerts are evidence
for whichever domain the AC belongs to, not a separate approval domain.

1. Fetch the full task and current delivery PR.
2. For a `doing` task with the current `qa_agent` gate, reason over the
   AC descriptions + the PR diff + cited tests + cited files via the
   agent's own tool calls (no verifier CLI invocation). Before assigning a
   `deferred` verdict, perform a capability preflight for every AC that needs
   execution:
   - run the exact repository command or script when it is available locally;
   - use the authoritative CI result when the AC is covered by CI;
   - perform a bounded live smoke/probe when the required service or endpoint
     is available; start the repo-prescribed local service when that is all
     that is missing.
   Do not defer merely because a check is manual, inconvenient, nighttime, or
   has not yet been attempted. Unblocked agent work continues 24/7. Use
   `extractAcLines` + `stripTrailingEvidence` from
   `agents/ash/src/verify.ts` to strip evidence annotations off the
   AC text before reasoning. Reach a per-AC verdict:
   `verified` / `blocked` / `deferred` (capability gap). Defer with
   a precise reason only when the verifier genuinely lacks a required
   capability; if the implementation or evidence is incomplete, block it
   and route back to Rowan. A missing feature is not an OpenClaw/runtime
   capability gap.
3. If all ACs verify, write the structured `qa_agent` approval with
   Ash's credential. A `[qa-agent-verified]` comment records the
   per-AC reasoning summary; the approval row is the gate source and
   the attention stack is the routing source.
4. If ordinary delivery evidence fails for any AC (missing/failing
   tests, missing artifact, fabricated or mismatched claim), post
   `[qa-agent-blocked]` listing each blocked AC's reason and route the
   task back to its delivery assignee at `attentionOwners[0]`.
   Preserve gate context and the escalation tail. Do **not** post the
   structured approval.
5. If any AC is deferred (capability gap), post `[qa-agent-deferred]`
   for those ACs and a matching `[qa-agent-capability-request]` entry that
   names the domain and AC, exact check, attempted command/tool, missing
   capability, and concrete requested action. **Do not** post the structured
   `qa_agent` approval.
   Route the task to `Quinn` at `attentionOwners[0]`; keep `Tom` as a
   dormant escalation slot only when Quinn cannot resolve the capability gap.
   Quinn's resolution is a capability-extension task, not a QA approval or a
   delivery failure. The original task depends on that extension task, while
   the extension task remains unblocked and has no dependency back to the
   original. After the extension is complete, Ash reruns the original task and
   approves or blocks it from fresh evidence. If the same gap recurs across
   two distinct tasks, propose a follow-up feature task via the Tasks API on
   the second strike (do not auto-create on the first deferral).
6. If the blocker is tooling/systemic, route by capability:
   infrastructure, host, or network work may go to Lox;
   OpenClaw/runtime work goes to Quinn; otherwise choose the capable
   agent indicated by the evidence.
7. When resolved, advance only the current top slot. Preserve later
   and repeated slots exactly; never clear or deduplicate the whole
   stack accidentally.

## Escalation ceiling

Quinn is the highest agent escalation. If no agent can resolve the issue, route
Quinn to position 0. If Quinn still cannot resolve it, Quinn advances the stack
to `attentionOwners=["Tom"]`. Tom at position 0 is the terminal human action
state: the queue must surface Tom as actionable, no later attention owner is
needed, and there is no escalation beyond him.
Tom merely appearing later in a tail remains dormant and is not a reason to
message or wait on him.
