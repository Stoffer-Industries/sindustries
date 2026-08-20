# Definition of Done — Ash

A QA action is done only when:

- cited tests/artifacts/claims were mechanically checked;
- the structured `qa_agent` approval reflects the result;
- failures are routed through `attentionOwners[0]` to the correct next actor;
- delivery assignee and gate context remain intact;
- repeated and dormant escalation slots are preserved;
- comments contain evidence only and are not treated as control state;
- Tom is position 0 only for terminal human action, never merely because he is
  present later in an escalation tail.
