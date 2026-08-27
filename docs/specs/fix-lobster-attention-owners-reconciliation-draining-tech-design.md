---
status: draft
task_id: e67c8835-2a45-411e-a371-887cdc63abbb
product_spec: n/a (internal tooling — lobster workflow routing bug)
shipped_pr: null
shipped_date: null
---

# Fix lobster `attentionOwners` reconciliation draining `doing`-status tasks to `[]` — Tech Design

## Links

- Task: `e67c8835-2a45-411e-a371-887cdc63abbb` (`Fix lobster attentionOwners reconciliation draining doing-status tasks to []`)
- Task API: `http://localhost:4001/api/v1/tasks/e67c8835-2a45-411e-a371-887cdc63abbb`
- Bug report / root cause: Ash (heartbeat 2026-08-27T08:11 NZST) + Quinn (code read, same day); documented in the task description
- First-observed incident: 2026-08-27T06:55 NZST — 3 tasks (`b2f62c36`, `5baf6809`, `5279b310`) had `attentionOwners` blanked to `[]` within a ~10s window during one lobster sweep
- Originating PR / commit: `agents/workflows/feature-task/src/main.rs` @ `f1e61e0` ("fix(workflow): let Lobster own gate attention routing", task `3620956f`)

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `fix/e67c8835-lobster-attention-owners-reconciliation` (from `origin/main`)
- Worktree: `~/workspace/worktrees/e67c8835-lobster-attention-owners-reconciliation`
- Primary code surfaces:
  - `agents/workflows/feature-task/src/main.rs` — `managed_owner_reason_satisfied` (line 1567), `reconciled_attention_owners` (line 1587), `reconcile_workflow_attention` (line 1615), and the `routing_*` test module (lines 4392–4451)
- No API or schema changes; the existing `TaskApproval` rows already encode the structured closeouts (`tech_design`, `qa_agent`, `accepted`) we need to check.
- No `.openclaw` boundary work — pure Rust workflow logic.

## Product intent (one-paragraph)

The lobster's `attentionOwners` array is the single surface routing surfaces (heartbeats, queue classifiers, Tom's `WAITING_EXTERNAL` filter, the heartbeat-pass progress checker) all read to decide who owns a task. The reconciliation logic added in commit `f1e61e0` (task `3620956f`) was meant to keep that array consistent with the task's current state, but it uses OR-clauses in `managed_owner_reason_satisfied` that return `true` on a `doing` task for Quinn, Ash, *and* Tom simultaneously — so any single sweep that hits the same task from multiple stage functions drains a 3-entry array to `[]` over a handful of internal calls, silently hiding tasks that are qa_agent-approved and waiting on Tom's acceptance decision. In the 2026-08-27 incident this likely contributed to task `1016cbff` staying parked because Tom was never flagged. The fix is to tighten the removal condition: a managed head entry is removed only when that *specific owner's* structured closeout has landed, not whenever their named gate clause happens to be inert given the current status. The durable test layer is the existing `routing_*` Rust unit tests in the same module, plus one new regression test covering the exact 3-entry repro from the incident.

## Ownership boundary check

The natural source of truth for `attentionOwners` is **workflow / cron / skill / OpenClaw boundary** — it is the lobster's routing output, not a UI-local state, not a database-backed domain field owned by a service. The fields on `Task` it depends on (`status`, `attentionOwners`, comments with `[implementer-prs]` tag, `TaskApproval` rows) are already authoritative, so the fix stays entirely inside the lobster's reconciliation function. No new source of truth, no shared-package change.

Rowan's incremental-delivery posture: the durable fix is about as easy as any interim shim (a single function's body plus one new test). No interim shim is needed; design the final shape directly.

## Implementation plan

### File / module scope

Single file: `agents/workflows/feature-task/src/main.rs`.

### Change 1 — tighten `managed_owner_reason_satisfied`

The current implementation (lines 1567–1585) uses OR-clauses that return `true` as soon as *any* per-owner condition is inert for the current status:

```rust
fn managed_owner_reason_satisfied(task: &Task, owner: &str) -> bool {
    match owner {
        "Quinn" => {
            task.status != "ready"
                || tech_design_approved_structured(task)
                || tech_design_waived(task)
        }
        "Ash" => {
            task.status != "doing"
                || implementer_pr_urls(task).is_empty()
                || qa_agent_verified(task)
        }
        "Tom" => task.status != "acceptance" || accepted_structured(task),
        _ => false,
    }
}
```

The `task.status != "<X>"` clauses are the source of the bug. For a `doing`-status task:

- Quinn's clause `task.status != "ready"` is `true` regardless of any tech-design state
- Ash's clause `task.status != "doing"` is `false` but `qa_agent_verified(task)` is `true` (the incident task) — so still `true`
- Tom's clause `task.status != "acceptance"` is `true` regardless of any `accepted` state

All three names independently look "removable." `reconciled_attention_owners`' else-branch pops the head each time it's invoked; `reconcile_workflow_attention` is called from the top of nearly every stage function (`spec_check`, `ready_checks`, `code_task_tech_design_check`, `code_task_ready_checks`, `verify_delivery`, `feedback_aggregate`, `post_merge`, plus inside `transition_or_block`). One sweep hitting a task from multiple of these drains a 3-entry array.

**Replacement body** (the surgical fix):

```rust
fn managed_owner_reason_satisfied(task: &Task, owner: &str) -> bool {
    match owner {
        "Quinn" => tech_design_approved_structured(task) || tech_design_waived(task),
        "Ash" => qa_agent_verified(task),
        "Tom" => accepted_structured(task),
        _ => false,
    }
}
```

Why this is correct and complete:

- **Quinn** is only relevant on a `ready` task waiting for tech-design sign-off. Once their specific closeout lands (approved or waived), they may be popped. The status-mismatch clause is no longer needed because Quinn is only ever *placed* at the head by `workflow_attention_owner` for a `ready` task — and the `Some(desired)` arm of `reconciled_attention_owners` already handles replacement of a stale Quinn head in any other state.
- **Ash** is only relevant on a `doing` task that has PR evidence but no qa_agent sign-off. Once `qa_agent_verified` is true, the lobster should pop their head and let the next sweep push the task toward `acceptance`. Other Ash-shaped states (no PR yet, etc.) leave Ash at the head, which is fine — the `Some(desired)` arm handles re-routing when state moves.
- **Tom** is only relevant on an `acceptance` task that has not been accepted. Once `accepted_structured` is true, Tom's head entry can be popped. The status-mismatch clause is redundant for the same reason Quinn's is.
- **Anything else** stays false, same as today. Unrelated heads (Rowan, Lox, an arbitrary assignor) are never auto-popped by `managed_owner_reason_satisfied`, so this change does not affect them.

This change does not touch `workflow_attention_owner`, `reconciled_attention_owners`, `reconcile_workflow_attention`, or any caller — only the single function whose body has the bug.

### Change 2 — new regression test

Add one test in the `routing_*` test module that captures the exact 3-entry repro from the 2026-08-27 incident:

```rust
#[test]
fn routing_does_not_drain_managed_owners_when_only_ash_gate_closed() {
    // Repro for task e67c8835: a "doing" task with qa_agent approved must
    // not have unrelated Quinn/Tom entries drained just because their gate
    // clauses happen to be inert for the current status. Only the head
    // entry whose own gate has actually closed may be removed.
    let mut task = routing_task("doing", &["Quinn", "Ash", "Tom"]);
    task.comments.push(TaskComment {
        text: Some(
            "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                .to_string(),
        ),
        body: None,
    });
    task.approvals.push(TaskApproval {
        approval_type: "qa_agent".to_string(),
        state: "approved".to_string(),
        ..TaskApproval::default()
    });
    // workflow_attention_owner returns None for this state, so the else
    // branch of reconciled_attention_owners fires. With the buggy OR-clause
    // implementation, this would drain the array across multiple sweeps.
    // After the fix, only Ash's head (whose specific gate closed) is removed.
    let once = reconciled_attention_owners(&task);
    assert_eq!(once, vec!["Quinn", "Tom"]);
}
```

Idempotency (the existing pattern in `routing_removes_satisfied_managed_owner_and_is_idempotent`):

```rust
let once = reconciled_attention_owners(&task);
assert_eq!(once, vec!["Quinn", "Tom"]);
task.attention_owners = once.clone();
assert_eq!(reconciled_attention_owners(&task), once);
```

And one more covering the other direction (only Quinn's gate closed — Tom stays put even though `task.status != "acceptance"`):

```rust
#[test]
fn routing_keeps_tom_head_until_accepted_even_when_status_is_doing() {
    // A `doing`-status task with Tom at head (e.g. handed off early) and
    // Quinn's tech_design closed must not pop Tom. Tom's closeout is the
    // `accepted` structured approval — anything weaker is not enough.
    let mut task = routing_task("doing", &["Tom", "Quinn", "Ash"]);
    task.approvals.push(TaskApproval {
        approval_type: "tech_design".to_string(),
        state: "approved".to_string(),
        ..TaskApproval::default()
    });
    let once = reconciled_attention_owners(&task);
    // Quinn's gate is closed (pop head? No — Tom is the head, and Tom's
    // gate hasn't closed). Array should be untouched.
    assert_eq!(once, vec!["Tom", "Quinn", "Ash"]);
}
```

### Change 3 — verify the existing `routing_*` tests still pass

Five existing tests in the `routing_*` module (lines 4392–4451) are expected to pass unchanged with the new body:

| Test | Status | First | Approvals | Expected | Reasoning under new body |
| --- | --- | --- | --- | --- | --- |
| `routing_does_not_surface_ash_before_delivery_evidence` | `doing` | `[Rowan, Tom]` | — | `[Rowan, Tom]` | `workflow_attention_owner` returns None; first entry is `Rowan`, not a managed name; nothing to pop. |
| `routing_replaces_implementer_with_ash_after_delivery` | `doing` | `[Rowan, Tom]` | `[implementer-prs]` comment | `[Ash, Tom]` | `workflow_attention_owner` returns Some("Ash"); `Some(desired)` arm replaces head. |
| `routing_advances_stale_implementer_to_tom_at_acceptance` | `acceptance` | `[Rowan, Ash, Rowan, Tom]` | — | `[Tom, Ash, Rowan, Tom]` | `workflow_attention_owner` returns Some("Tom"); `Some(desired)` arm replaces head. |
| `routing_removes_satisfied_managed_owner_and_is_idempotent` | `acceptance` | `[Tom, Rowan, Tom]` | `accepted` approved | `[Rowan, Tom]` | `workflow_attention_owner` returns None (accepted); else branch fires; first entry `Tom` is popped because `managed_owner_reason_satisfied(task, "Tom")` returns true via the new `accepted_structured(task)` clause. |
| `routing_preserves_unrelated_head_and_duplicate_tail_slots` | `acceptance` | `[Lox, Rowan, Tom, Tom]` | — | `[Tom, Lox, Rowan, Tom, Tom]` | `workflow_attention_owner` returns Some("Tom"); `Some(desired)` arm inserts at front because first entry isn't a managed name. |

The existing `routing_removes_satisfied_managed_owner_and_is_idempotent` test is the load-bearing one — it's the only existing test that exercises the `else` branch under the new logic, and it relies on `accepted_structured(task)` being the closeout signal. That maps directly onto the new body and still passes.

## Data model / API contract changes

None. The fix is a pure logic change inside the lobster's reconciliation function; the wire shape (`Task.attentionOwners`, `Task.status`, `TaskApproval` rows, the `[implementer-prs]` comment tag) is unchanged.

## Workflow / cron / skill changes

None. No new task comment tags, no new structured approval types, no new workflow gates. The lobster still drives `doing → acceptance` on `qa_agent_verified` and `acceptance → done` on `accepted_structured` — exactly as before. The only difference is that, when those gates fire, the *head entry* of `attentionOwners` is no longer being popped pre-emptively in the same sweep from unrelated names.

## Test plan

| AC | Layer | Coverage | Rationale |
| --- | --- | --- | --- |
| AC1 | Unit (Rust) | New body of `managed_owner_reason_satisfied` per Change 1 — verified manually against each existing `routing_*` test (table above) and against the two new regression tests. | The predicate is pure logic over `Task` data; a Rust unit test exercises the exact production code path with no I/O. |
| AC2 | Unit (Rust) | `routing_does_not_drain_managed_owners_when_only_ash_gate_closed` (Change 2) — exact 3-entry repro from the 2026-08-27 incident. | The bug is logic-only; the regression test reproduces the exact data shape (3-entry array, status `doing`, qa_agent approved) that triggered the drain. |
| AC3 | Unit (Rust) | All five existing `routing_*` tests + the two new ones, run via `cargo test -p feature-task routing`. | The fix is a body replacement inside an existing function; existing tests in the same module are the regression coverage for "didn't break anything." |

E2E is not appropriate here — this is a Rust workflow's internal routing logic, not a user-visible app flow. The unit tests in `agents/workflows/feature-task/src/main.rs` are the durable test layer for this surface (see `routing_*` module added in `f1e61e0`). A live integration test would require staging the lobster itself, which is disproportionate for a 6-line function change.

## Open questions and risks

1. **Are there other call sites that rely on the OR-clause behaviour?** I traced all callers of `managed_owner_reason_satisfied` and the only call site is the `else` branch of `reconciled_attention_owners` (line 1608). `workflow_attention_owner` (line 1556) does its own state-based assignment and is independent. No other gate, stage, or comment tag depends on `managed_owner_reason_satisfied`. Risk: none.
2. **Does `accepted_structured` exist on the `Task` shape?** Yes — same predicate already in use at the transition path (`doing → acceptance` blocked on `!accepted_structured` is implicitly the next step after `qa_agent_verified` lands; the existing `routing_removes_satisfied_managed_owner_and_is_idempotent` test reads it via `task.approvals.push(TaskApproval { approval_type: "accepted", ... })`).
3. **Is there a risk of leaving a stale head stuck if Ash's gate closes but the next sweep doesn't advance the task to `acceptance`?** No — the `Some(desired)` arm of `reconciled_attention_owners` (line 1589) already handles the state move when `workflow_attention_owner` returns a value for the new state. With Ash popped, the next head is the next array entry (Quinn or Tom in the repro), and once the task transitions to `acceptance` the head is replaced with Tom. This is exactly the desired routing behaviour.
4. **Will the fix interact badly with the separate `failureFingerprint`-not-cleared-after-`qa_agent`-approval bug (see `MEMORY.md` 2026-08-26)?** No — those bugs are about fingerprint state on the `[lobster-state]` comment tag, which is independent of `attentionOwners`. The tasks that incident affected (`5baf6809`, `b2f62c36`, `5279b310`) had `attentionOwners` drained by *this* bug; fixing it doesn't address the fingerprint bug, and the fingerprint bug doesn't affect whether Ash's head gets popped. The two fixes are orthogonal and should land independently.
5. **Manual mitigation that Quinn applied during the incident (restoring `attentionOwners` on `b2f62c36` → `[Tom, Quinn, Ash]` and `5279b310` → `[Tom]`) is no longer reachable** after the fix lands. That's expected — the fix makes the draining impossible, so the restoration step is obsolete. The fix does not need to undo or modify any restored state.

## Definition of done

- [ ] Body of `managed_owner_reason_satisfied` updated per Change 1.
- [ ] Two new regression tests added per Change 2.
- [ ] `cargo test -p feature-task routing` is green with the full `routing_*` suite (5 existing + 2 new = 7 tests).
- [ ] PR opened from `fix/e67c8835-lobster-attention-owners-reconciliation` with this tech design linked in the PR body.
- [ ] PR body does **not** include a `- [x] AC<N>: ...` checklist for any AC — the lobster would treat it as implementation coverage and create a false signal (per `agents/skills/dev/tech-design/SKILL.md` warning). AC verification lives only in this doc and in `cargo test` output.
- [ ] On merge, frontmatter is updated to `status: shipped`, `shipped_pr: <N>`, `shipped_date: <YYYY-MM-DD>`.