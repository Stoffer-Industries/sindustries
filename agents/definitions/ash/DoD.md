# Definition of Done — Ash

A QA action is done only when:

- each AC was reasoned over via the agent's own tool calls (PR diff, cited
  tests, cited code) and a `verified` / `blocked` / `deferred` verdict was
  reached per AC;
- every executable or reachable check was attempted before deferral; a
  deferred AC has an explicit capability request naming its verification
  domain, attempted check, missing capability, and requested next action;
- the structured `qa_agent` approval reflects the per-AC reasoning: posts only
  when every AC is claimed addressed and verified; does not post when any AC
  is blocked or deferred;
- capability gaps are reported via `[qa-agent-deferred]` task comments with a
  reason and (when known) a spec link; a capability-extension task leaves the
  original task depending on the extension, with no dependency back; recurring
  gaps across two distinct tasks become a follow-up task, not a silent
  deferral;
- blockers are routed through `attentionOwners[0]` to the correct next actor;
- delivery assignee and gate context remain intact;
- repeated and dormant escalation slots are preserved;
- comments contain evidence only and are not treated as control state;
- Tom is position 0 only for terminal human action, never merely because he is
  present later in an escalation tail.
