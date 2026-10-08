---
name: attention-owner-routing
description: Add, replace, escalate, or clear Tasks API attention owners with ordered, reason-bearing routing and verified read-back.
---

# Attention-owner routing

Use this skill whenever a task needs an attention-owner add, replacement,
escalation, handoff, repair, or self-resolve.

## Procedure

1. Fetch the full task from the Tasks API, including `assignee`, approvals,
   workflow gates, `attentionOwners`, and attention-owner detail rows. Confirm
   the proposed owner has a concrete action now; completion criterion: the
   current blocker and next action are explicit.
2. Keep the ownership planes separate. Preserve `assignee` as the delivery
   owner, treat the current gate owner as gate context, and change only the
   ordered attention stack needed for the handoff. Preserve genuine later
   slots and meaningful duplicate role slots; completion criterion: the
   intended complete ordered stack is written down before mutation.
3. Require a concise task-specific reason naming who acts, why now, and the
   next action. Add Tom only when a concrete action requires Tom immediately;
   do not page him merely because an agent's work or gate is complete.
4. Write through the reason-bearing Tasks API endpoint:
   `POST /tasks/<id>/attention-owners/reconcile` with the complete
   `attentionOwners` array and a non-empty `note`. Use the endpoint's
   single-owner or self-resolve operation when appropriate. **Never use the
   legacy `PATCH /tasks/:id` attention-owner fields, direct curl, or a CLI
   fallback for an automated handoff.** If the reason-bearing endpoint is
   unavailable, stop and report the blocker; completion criterion: the API
   accepts the authenticated write without a compatibility-path fallback.
5. Post a task comment only as supporting audit evidence after the state write.
   A bracketed comment never substitutes for the row's authenticated actor or
   reason; completion criterion: the routing row itself contains the reason.
6. Read the task back and verify the complete ordered stack, `assignee`, task
   status, and every changed detail row's `addedBy` and non-empty `note`.
   Confirm approvals, gates, and unrelated owners were preserved; completion
   criterion: the read-back matches the intended mutation.
7. When the current agent's blocker or delivery handoff is complete, resolve
   or advance only that agent's top slot through the same reason-bearing path.
   Keep the delivery assignee unchanged and name the next gate or actor in the
   reason; completion criterion: the resolved agent is no longer a passive
   position-0 owner.

## Routing rules

- `attentionOwners[0]` is the only actionable owner; later entries are dormant
  escalation slots.
- Quinn is an exceptional OpenClaw/runtime unblocker, not a normal delivery,
  QA, acceptance, or review owner.
- Use PR review requests for review work. Use structured workflow gates for
  normal QA and acceptance transitions.
- Stale checklist or comment evidence must be checked against merged PRs and
  structured approvals before creating a new blocker.

## Verification

Do not report a handoff as complete until the API read-back proves both the
ordered owners and the reason-bearing detail metadata.

