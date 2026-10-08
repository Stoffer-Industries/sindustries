---
name: attention-owner-routing
description: Add, replace, escalate, or clear Tasks API attention owners with ordered, reason-bearing routing and verified read-back.
---

# Attention-owner routing

## RULES

- **Always keep ownership planes separate.** Preserve `assignee` as the
  delivery owner, treat workflow gates and approvals as gate context, and use
  `attentionOwners[0]` only for the current actionable owner.
- **Always write a complete ordered stack.** Preserve genuine later slots and
  meaningful duplicate role slots; remove or advance only the resolved top
  slot.
- **Always record a task-specific reason and authenticated actor.** The reason
  must state who acts, why now, and the next action. A task comment is audit
  evidence, not routing metadata.
- **Never use the legacy `PATCH /tasks/:id` attention-owner fields, direct
  curl, or a compatibility CLI fallback for an automated handoff.** Use the
  reason-bearing reconcile operation; if it is unavailable, stop and report
  the blocker.
- **Never perform implementation or delivery work on a `dependencyBlocked`
  task, even when you are the explicit `attentionOwners[0]` owner.** A
  position-0 slot overrides the *routing classification* (which actor is
  next), not the *dependency gate itself*. If the attention note asks you to
  "open the delivery PR" while a real dependency is incomplete, the only
  correct action is to resolve or escalate the blocking dependency task (or
  report that you cannot), and post that back as the evidence. Do not start
  or continue building the downstream deliverable while its dependency is
  unresolved; that produces unreviewable, potentially-wasted work and masks
  the real blocker.
- **Only add Tom when a concrete action requires Tom immediately.** Do not page
  him merely because an agent's work or gate is complete.
- **Do not route Quinn for normal delivery, QA, acceptance, or review work.**
  Quinn is an exceptional OpenClaw/runtime unblocker.
- **Verify stale evidence before creating a blocker.** Check merged PRs,
  structured approvals, and current task evidence before trusting an old
  checklist or comment.

## PROCESS

### Escalation lifecycle

Treat every position-0 slot as a short-lived action handoff, not a watchlist:

1. **Action:** read the full task, confirm the concrete next action, and
   investigate or execute it during the current pass.
2. **Evidence:** record the result in the task's audit trail and verify the
   source of truth. A stale checklist or comment is not a new blocker by
   itself.
3. **Resolve or advance:** when the action is complete, self-resolve or
   advance only the current agent's top slot through the reason-bearing
   endpoint. Preserve the delivery assignee and genuine later slots.
4. **Remain or escalate:** when a genuine blocker remains, keep the current
   owner at position 0 and escalate only to the next capable actor with a
   reason naming the blocker and immediate next action. Do not remove a live
   blocker just to make the queue quiet.
5. **Verify:** read the task back after the write. If the source of truth shows
   that a later checklist was stale, clear the stale slot again rather than
   creating a duplicate escalation.

Capability deferrals are a distinct branch: Ash routes a real verifier-capability
gap to Quinn, Quinn resolves the capability task, and the original task returns
to Ash for a fresh QA pass. A capability-resolved marker is not itself QA
approval. Normal delivery or evidence failures return to the delivery assignee;
they must not surface Ash until Lobster's delivery-evidence gate has passed.

### Execute the routing operation

1. Fetch the full task from the Tasks API, including `assignee`, approvals,
   workflow gates, `attentionOwners`, and attention-owner detail rows. Confirm
   the proposed owner has a concrete action now.
2. Separate the delivery owner, current gate owner, and attention owner. Write
   down the intended complete ordered attention stack before mutating it.
3. Choose the smallest valid operation: reconcile the complete stack for an
   add/replacement, use the single-owner operation for a one-owner add, or use
   self-resolve when the current agent has completed its action.
4. Send the authenticated reason-bearing request:
   `POST /tasks/<id>/attention-owners/reconcile` with the complete
   `attentionOwners` array and a non-empty `note`. Preserve genuine tail slots
   and do not use a fallback path.
5. Post a task comment after the state write when audit context is useful. Do
   not treat the comment as a substitute for the row reason.
6. Read the task back and verify the ordered stack, `assignee`, status,
   approvals, gates, and every changed detail row's `addedBy` and non-empty
   `note`. Confirm unrelated owners were preserved.
7. When the current agent's blocker or delivery handoff is complete, resolve
   or advance only that agent's top slot through the same reason-bearing path.
   Keep the delivery assignee unchanged and name the next gate or actor.

## OUTPUT FORMAT

For every completed routing operation, retain or report:

```text
Task: <full UUID>
Operation: <add | replace | escalate | repair | self-resolve>
Before: attentionOwners=[...]
After: attentionOwners=[...]
Reason: <who acts, why now, next action>
Read-back: <actor and note metadata verified; unrelated state preserved>
```

The API payload for a complete-stack reconciliation is:

```json
{
  "attentionOwners": ["Ash"],
  "note": "Ash must verify the delivered implementation before acceptance."
}
```

## KNOWLEDGE FILES

Read these in order before mutating a task:

1. `agents/skills/ops/tasks-api/SKILL.md` — Tasks API data model, endpoint
   semantics, and credential targeting.
2. The full task from the Tasks API — current ownership, approvals, gates, and
   comments are the source of truth.
3. The invoking agent's `AGENTS.md` and role `WORKFLOW.md` — authority and
   role-specific handoff rules.
4. Relevant task evidence, merged PR bodies, and structured approvals — use
   these to reject stale checklist claims.

## ONBOARDING

The caller must provide:

- the full task UUID;
- the requested operation and proposed complete ordered stack;
- the current blocker or completed handoff evidence;
- the concrete next action and named actor;
- the authenticated agent identity and any required role-specific constraints.

If the caller cannot provide a concrete next action or the reason-bearing API
operation is unavailable, return the blocker without changing task ownership.

## IDENTITY

> Read the invoking agent's `AGENTS.md` for role, authority, and voice. This
> skill supplies only the shared attention-owner routing contract.
