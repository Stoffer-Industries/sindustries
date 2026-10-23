---
status: draft
task_id: 7ae48b33-ff2c-4689-8876-b9b83d7b8dcb
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# verify-delivery must not rebuild a Tom-sole escalation

## Intent

Task `7ae48b33` (code task, `taskType: code`, no product spec — this is a workflow-correctness fix, not a product capability).

The `verify-delivery` stale-`qa_agent`-revoke path builds an attention stack the Tasks API forbids, so three `doing` tasks fail every task-lobsters cron tick with an identical `409 TOM_NOT_ACTIONABLE` and never clear. The revoke is deterministic, so this repeats indefinitely rather than degrading.

The affected tasks are `de9d8594`, `5cb4a8fe`, and `0a803329` — all Rowan-assigned, all `doing`, all carrying `attentionOwners: ['Tom']`.

## Where the contract is broken

**Producer** — `agents/workflows/feature-task/src/verify_delivery.rs::revoke_and_route_stale_qa_approval`:

```rust
if let Some(owner) = assignee {
    let mut desired = vec![owner];
    for existing in &env.task.attention_owners {
        if !desired.iter().any(|slot| slot.eq_ignore_ascii_case(existing)) {
            desired.push(existing.clone());
        }
    }
    api_client::api_reconcile_attention::<Task>(&args.base_url, &env.task.id, desired, &note)?;
}
```

The rule is "prepend the assignee, keep every existing tail." On a task already escalated Tom-sole, that is `['Rowan', 'Tom']`.

**Enforcer** — `services/tasks-api/src/routes/taskAttentionOwners.ts::attentionOwnerPolicyFailure` (L108–138). It only engages when `task.status === 'doing'`, and it enforces **two** independent Tom rules, in this order:

```ts
if (tomPositions.length > 0 && (actor !== 'quinn' && actor !== 'tom')) {   // rule A
  return { code: 'TOM_NOT_ACTIONABLE', message: 'Tom may only be routed on a doing task by an authenticated Quinn escalation; acceptance is not yet the current gate' };
}
if (tomPositions.length > 0 && (tomPositions[0] !== 0 || owners.length !== 1)) {  // rule B
  return { code: 'TOM_NOT_ACTIONABLE', message: 'A doing-task escalation to Tom must make Tom the sole terminal attention owner' };
}
```

`['Rowan', 'Tom']` violates rule B (Tom at position 1, length 2). The write 409s, so the revoke never lands, so the next tick rebuilds the same illegal stack.

### Rule A is the constraint AC1 does not mention

Quinn's root-cause comment reads rule B off the observed error. Rule A is the one that actually decides the fix, and it is not visible in the failure:

`api_reconcile_attention` authenticates with `TASKS_API_APPROVAL_TOKEN` (`api_client::authenticated_api_post_request`), *not* with the lobster service token used by `api_delete`. The reconciling actor is therefore whatever that token maps to in `TASKS_API_APPROVAL_SERVICE_CREDENTIALS`. That store contains `Quinn`, `Rowan`, `Ivy`, `Lox`, `Ash`, `feature_task_lobster`, `bookmark_lobster`, `Lobster`, and `brain_spec_reconciler` — **there is no `Tom` credential**. Rule A therefore permits a Tom write only for a Quinn-scoped token.

The observed message is rule B's, not rule A's, which tells us the reconcile runs under a Quinn-scoped token today. That makes AC1's "collapse to Tom-sole" option technically viable — and that is precisely why it should be rejected. It would leave the fix depending on a credential-to-actor coupling that nothing in the repo documents or tests. Any rotation of that token to a non-Quinn credential reintroduces rule A's 409 with no code change and no failing test.

## The semantic problem with collapsing to Tom-sole

The terminal escalation on the affected tasks was written by Quinn against a stated premise. From the live row on `de9d8594`:

> "Quinn terminal escalation: agent-side gates all green (Quinn tech_design 2026-10-14, Ash qa_agent 2026-10-12); Tom@0: re-issue accepted... Server rejects Tom-on-doing (HTTP 409), so only Quinn can route this. Delivery (Rowan) and all approvals preserved."

The escalation is conditioned on *"agent-side gates all green"* — explicitly including `Ash qa_agent`. The revoke path exists precisely because the `qa_agent` grant no longer matches its PR's live head and AC-section digest. So the revoke **falsifies the premise the escalation was authorised under**. Preserving Tom across that revocation leaves Tom paged at position 0 for a gate whose supporting evidence has just been invalidated — and it leaves him there on every subsequent tick.

That is also what the revoke's own note says to do next: `{assignee_label} re-runs feature-task mechanical-evidence-check ... and re-approves with the fresh attestation`. The note already routes the work to the assignee. The stack builder is the only part that disagrees.

## Design

**Rule:** when the lobster revokes a `qa_agent` approval as stale, a terminal Tom escalation on a `doing` task is dropped, because the revocation invalidates the escalation's own stated premise. The stack collapses to the assignee.

This yields `['Rowan']`, which:
- satisfies rule A (no Tom in the stack — both Tom rules short-circuit on `tomPositions.length > 0`),
- satisfies rule B trivially,
- matches the recovery instruction the same function already writes,
- is independent of which credential the reconcile runs under.

It is also the durable shape: it is correct by construction rather than correct by coincidence. The alternative — collapse to `['Tom']` — is correct only while a Quinn-scoped token happens to be wired in.

### Why this is not `enforce_tom_acceptance_only`

`spec_check_ready.rs` already encodes the terminal-slot invariant in `enforce_tom_acceptance_only` / `has_structured_quinn_tom_escalation`. Reusing it directly would be wrong here, and the difference is worth stating explicitly because the two look interchangeable:

`has_structured_quinn_tom_escalation` returns **true** on all three affected tasks (Tom at position 0, `addedBy: Quinn`, non-empty note). `enforce_tom_acceptance_only` would therefore collapse them to `['Tom']` — server-valid, but semantically inverted: it keeps Tom paged for acceptance immediately after the lobster revoked the QA approval Tom's acceptance depends on. `enforce_tom_acceptance_only` is correct for a routine sweep reconciling a *valid* stack; it is wrong for a revocation that has just invalidated the gate.

So the revoke path gets its own rule, placed beside the existing ones so the invariant lives in one module. AC3 asks that the rule be written once rather than re-derived per call site; this satisfies that by putting all three terminal-stack rules in `spec_check_ready.rs` and having `verify_delivery.rs` call into them, without conflating the sweep rule with the revocation rule.

### Ownership boundary

Natural source of truth: **workflow/cron/skill/OpenClaw boundary**. The attention stack is workflow-owned routing state; the Tasks API is the enforcing authority and its guard stays untouched.

The fix is deliberately client-side. `attentionOwnerPolicyFailure` is correct — a terminal Tom handoff must be unambiguous — and relaxing it to admit `['Rowan', 'Tom']` would weaken a real safety property across every caller to fix one misbehaving caller. No API, no schema, no data-model change.

Blast radius is contained: `api_reconcile_attention` has exactly two call sites. `spec_check_ready.rs:795` (`reconcile_workflow_attention`) already routes through `reconciled_attention_owners` → `enforce_tom_acceptance_only` and is unaffected. Only `verify_delivery.rs:399` builds a stack without consulting the invariant.

## Implementation plan

| File | Change |
| --- | --- |
| `agents/workflows/feature-task/src/spec_check_ready.rs` | Add pure `pub(crate) fn attention_stack_after_qa_revocation(task: &Task, assignee: &str) -> Vec<String>`. No I/O, no API call, no env reads. Drops any `Tom` entry, then prepends the assignee with the existing case-insensitive dedupe. |
| `agents/workflows/feature-task/src/verify_delivery.rs` | Replace the inline stack build in `revoke_and_route_stale_qa_approval` with a call to the helper. |
| `agents/workflows/feature-task/src/spec_check_ready.rs` (tests) | Regression tests, including the `include_str!` pin (below). |

The helper takes `&Task` and `&str` so it is callable from both call sites and testable with a literal fixture — no envelope, no `StageArgs`.

The existing `if let Some(owner) = assignee` guard is retained: with no assignee there is no one to route to, and the revoke should proceed without a stack write rather than manufacture an owner.

## Test plan

Layer: Rust unit (`cargo test` in `agents/workflows/feature-task`). These are pure functions over a `Task` value; there is no user-visible surface, so E2E is not applicable — the externally observable behaviour is the lobster cron tick, covered by AC5/AC6 below.

Cases:
1. Tom-sole `['Tom']` + assignee `Rowan` on a `doing` task → `['Rowan']`. The regression this task exists for.
2. `['Rowan']` + assignee `Rowan` (no Tom row) → `['Rowan']`, unchanged. AC2.
3. Empty stack + assignee `Rowan` → `['Rowan']`.
4. Non-`doing` status with a Tom row → Tom preserved. AC2's non-`doing` half: the server guard only engages on `doing`, so the client must not start rewriting stacks the server does not police.
5. Case-insensitive dedupe: `['rowan']` + assignee `Rowan` → `['Rowan']`, no duplicate.
6. Mixed tail `['Ash', 'Tom']` + assignee `Rowan` → `['Rowan', 'Ash']` — Tom dropped, non-Tom tail preserved in order.

### AC4 — pinning the real server rule

AC4 requires the test to assert against the constraint *as the server enforces it*, not a local copy that can drift. A duplicated Rust constant would satisfy the letter of the test and none of its purpose.

Implementation: `include_str!` the enforcer into the test module and assert the enforcing expression is still present.

```rust
const ENFORCER: &str = include_str!(
    "../../../../services/tasks-api/src/routes/taskAttentionOwners.ts"
);

#[test]
fn the_revocation_rule_matches_the_servers_terminal_tom_constraint() {
    assert!(
        ENFORCER.contains("tomPositions[0] !== 0 || owners.length !== 1"),
        "the Tasks API terminal-Tom rule changed shape; re-derive \
         attention_stack_after_qa_revocation against the new rule"
    );
    assert!(
        ENFORCER.contains("task?.status !== 'doing'"),
        "the Tasks API guard may no longer be doing-only; re-check whether \
         attention_stack_after_qa_revocation should preserve Tom off `doing`"
    );
}
```

Path verified to resolve from `agents/workflows/feature-task/src/`. If the server rule is renamed or restructured, this fails at compile-or-test time with an instruction to re-derive, rather than silently letting the client and server disagree.

### AC verification matrix

| AC | Verification | Layer |
| --- | --- | --- |
| AC1 | Test 1 — Tom-sole `['Tom']` collapses to `['Rowan']`; never emits Tom at a non-zero position or length > 1 on `doing`. | unit |
| AC2 | Tests 2 and 4 — `['Rowan']` unchanged; non-`doing` preserves Tom. | unit |
| AC3 | `attention_stack_after_qa_revocation` is `pub(crate)`, pure, takes only `&Task`/`&str`, lives beside `enforce_tom_acceptance_only`/`has_structured_quinn_tom_escalation`; `verify_delivery.rs` no longer builds a stack inline. | unit + review |
| AC4 | `the_revocation_rule_matches_the_servers_terminal_tom_constraint` asserts against `include_str!`'d `taskAttentionOwners.ts`. | unit |
| AC5 | Next task-lobsters cron tick: all three tasks (`de9d8594`, `5cb4a8fe`, `0a803329`) show no `TOM_NOT_ACTIONABLE`; `qa_agent` approvals revoked; `[qa-evidence-invalidated]` notes present with recovery instructions. | live cron run |
| AC6 | AC5 read from the actual cron run output, pasted into the PR body — not inferred from unit tests. | live cron run |

AC5/AC6 are post-merge operational checks. They cannot be satisfied from the PR: the fix must reach the deployed lobster binary before the cron can exercise it. They are recorded as a runbook step below and the task stays open until observed.

## Runbook — AC5/AC6 after merge

```bash
# 1. Confirm the merged binary is what the cron runs, then wait for / trigger a tick.
# 2. For each affected task, confirm no TOM_NOT_ACTIONABLE in the run output:
gh run list --workflow=task-lobsters.yml --limit 5
# 3. Confirm the revocation landed:
curl -s localhost:4001/api/v1/tasks/<id> | jq '{status, attentionOwners,
  qa: (.approvals[] | select(.type=="qa_agent") | .state)}'
#    expect: qa_agent state != "approved"; no 409 in the tick output; recovery note posted.
```

If rule A's message appears instead of rule B's on a future tick, the reconcile token has been rotated to a non-Quinn credential. That is independent of this fix — dropping Tom removes the dependency on the actor entirely — but it would break `spec_check_ready.rs`'s Tom-sole writes, which do still require a Quinn-scoped token. Worth raising with Quinn separately if observed.

## `.openclaw` boundary

None. No change outside this repo. The Tasks API guard, the credential store, and the cron schedule are all left as they are.

## Open questions and risks

1. **Dropping Tom is a routing decision, not just a shape fix.** It means a Quinn escalation is retracted by an automated sweep. My reading is that this is correct — the escalation was conditioned on gates being green, and the revoke falsifies that — and the recovery note routes the work back to the assignee, which is the same person the escalation's note preserved ("Delivery (Rowan) ... preserved"). Flagging it because it changes who is paged, and Quinn should confirm that an automated revocation is permitted to retract a Quinn-authored escalation rather than merely reshape it.
2. **Alternative rejected:** collapsing to `['Tom']` (server-valid today). Rejected because it pages Tom for a gate whose evidence was just invalidated, and because it silently depends on the reconcile token being Quinn-scoped. If Quinn prefers preserving the escalation, the fallback is to collapse to Tom-sole *and* add a test pinning the actor, which makes the coupling explicit — but it leaves the semantic inversion in place.
3. **Rule A remains unguarded for other callers.** `spec_check_ready.rs:795` still needs a Quinn-scoped token to write Tom-sole stacks. This task does not address it; noted in the runbook so it is not mistaken for solved.
4. **Precedent drift.** The affected tasks were escalated under Quinn's belief that the server forces a particular shape ("Server rejects Tom-on-doing (HTTP 409)"). Once this lands, `['Tom']` is no longer required for the revoke path. If any other note or doc asserts that shape as required, it should be corrected in the same PR.