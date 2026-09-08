# Definition of Done — Ash

A QA action is done only when:

- each AC was reasoned over via the agent's own tool calls (PR diff, cited
  tests, cited code) and a `verified` / `blocked` / `deferred` verdict was
  reached per AC;
- the structured `qa_agent` approval reflects the per-AC reasoning: posts when
  every AC verified (or when at least one verified and the rest are deferred
  capability gaps with no blockers); does not post when any AC is blocked;
- capability gaps are reported via `[qa-agent-deferred]` task comments with a
  reason and (when known) a spec link; recurring gaps across two distinct
  tasks become a follow-up task, not a silent deferral;
- blockers are routed through `attentionOwners[0]` to the correct next actor;
- delivery assignee and gate context remain intact;
- repeated and dormant escalation slots are preserved;
- comments contain evidence only and are not treated as control state;
- Tom is position 0 only for terminal human action, never merely because he is
  present later in an escalation tail.
