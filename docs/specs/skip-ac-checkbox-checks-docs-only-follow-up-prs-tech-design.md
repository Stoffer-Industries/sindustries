---
status: draft
task_id: d1ea4812-156d-436d-ab5f-838fbedfbf89
product_spec: n/a (internal tooling — lobster workflow routing bug)
shipped_pr: null
shipped_date: null
---

# Skip AC-checkbox checks in lobster `verify_delivery` for docs-only follow-up PRs — Tech Design

## Links

- Task: `d1ea4812-156d-436d-ab5f-838fbedfbf89` (`Skip AC-checkbox checks in lobster verify_delivery for docs-only follow-up PRs (or filter prUrls to delivery-only)`)
- Task API: `http://localhost:4001/api/v1/tasks/d1ea4812-156d-436d-ab5f-838fbedfbf89`
- Originating incident: task `dd232b99` ("Deploy Mission Control to cloud-hosted staging runtime") — `[feature-task-progress-checklist]` comment at `2026-09-03T22:34:44Z` showing the false-positive on PR #566 (docs-only follow-up after the merged delivery PR #565)
- Originating PR / commit: `agents/workflows/feature-task/src/main.rs` @ `093f1b2` (current `origin/main` HEAD)

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `d1ea4812-lobster-verify-delivery-docs-only` (from `origin/main`)
- Worktree: `~/workspace/worktrees/d1ea4812-lobster-verify-delivery-docs-only`
- Primary code surfaces:
  - `agents/workflows/feature-task/src/pr_gates.rs` — new `pr_labels` helper, new `docs_only_label()` constant, new unit tests
  - `agents/workflows/feature-task/src/main.rs` — `verify_delivery` body (loop at lines 813–853), skip AC-checkbox checks for any URL whose labels include `docs-only`
- No API, schema, or `.openclaw` boundary changes. The `Task` and `TaskApproval` shapes are unchanged.

## Product intent (one-paragraph)

The lobster's `verify_delivery` step is the `doing → acceptance` gate. It currently loops through every URL in `implementer_pr_urls(task)` and, for the latest one (highest PR number), runs `body_has_checked_acceptance` plus the `task_ac_vs_open_pr_failures` AC-text match. When a task ships its implementation across a **delivery PR** (which carries the AC checkbox evidence) and then a **docs-only follow-up PR** lands on top (an ADR correction, a system-spec note, a runbook update), the follow-up PR becomes "latest" and the AC-checkbox check fires against it — even though it intentionally carries no `- [x] AC<N>` lines. The result is a structural false-positive that blocks every sweep with `PR https://…/pull/<N> does not show checked acceptance criteria in its body`, leaving the task unable to auto-advance even after the work is verified and Ash's `qa_agent` approval has landed. The fix is to recognise an explicit `docs-only` label on the PR and skip the AC-checkbox + AC-text checks for any URL carrying that label — making the marker opt-in (no silent behaviour change for existing PRs), aligned with the other "skip lobster check X" patterns in the codebase, and self-documenting via the label itself.

## Ownership boundary check

The natural source of truth for "this PR is a docs-only follow-up" is the **GitHub PR label** — it is a per-PR artefact the lobster already needs to read for any future exemption pattern, it is auditable in the PR UI, and it does not require any new task-comment tag, structured-approval row, or schema change. The lobster reading the label is the only new wiring needed.

Rowan's incremental-delivery posture: the durable fix is about as easy as any interim shim (one new helper in `pr_gates.rs`, two skip-conditions in `verify_delivery`, and a structural test). No interim shim is needed; design the final shape directly. The three options listed in the task description (label-based filter, `prUrls` split into `deliveryPrUrls` + `followupPrUrls`, AC-checkbox exemption by title prefix) were weighed: the label approach is explicit, doesn't bake a title-prefix convention into the lobster, and aligns with how other "skip lobster check X" patterns work — recommended. The `prUrls` split is cleaner in principle but more invasive (state-shape change, all callers update) and reserved for a later round if the label proves insufficient. The title-prefix option encodes a docs-only convention in the lobster that we do not want to commit to.

## Implementation plan

### Change 1 — new `pr_labels` helper in `pr_gates.rs`

Add a new public-to-crate helper alongside the existing `pr_changed_files` and `parse_github_review_state` helpers. Use the same fail-closed discipline (caller treats `Err(_)` as a real error, not as "no labels"):

```rust
/// Return the list of label names for a PR via `gh pr view --json labels`.
/// Returns `Ok(Vec)` of label names on a successful read (the Vec is empty
/// when the PR legitimately has no labels), or `Err` with a
/// caller-actionable message when the `gh` invocation fails or its output
/// cannot be decoded. The fail-closed contract matches `pr_changed_files`:
/// callers that treat an empty label list as "not docs-only" preserve
/// that behaviour by matching on `Ok(labels)`; `Err(_)` is reserved for
/// the gate-fail path so a transient `gh` blip cannot silently bypass
/// the docs-only skip.
pub(crate) fn pr_labels(url: &str) -> Result<Vec<String>, String> {
    let output = Command::new("gh")
        .args([
            "pr",
            "view",
            url,
            "--json",
            "labels",
            "--jq",
            ".labels[].name",
        ])
        .output();
    let output = match output {
        Ok(out) if out.status.success() => out,
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            return Err(format!(
                "gh pr view {url} --json labels --jq .labels\\[\\].name exited {}: {stderr}",
                out.status
            ));
        }
        Err(err) => {
            return Err(format!(
                "failed to spawn `gh pr view` for {url}: {err}"
            ));
        }
    };
    let raw = String::from_utf8(output.stdout).unwrap_or_default();
    Ok(raw
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

/// The canonical label name that marks a PR as a docs-only follow-up
/// (system-spec ADR, ADR correction, runbook update, audit-ledger PR)
/// and exempts it from the AC-checkbox and AC-text-match checks in
/// `verify_delivery`. Documented in `docs/systems/tasks.md` (see
/// "PR convention — docs-only follow-up PRs" section added in Change 4).
pub(crate) const DOCS_ONLY_LABEL: &str = "docs-only";
```

The `--jq .labels[].name` projection gives one label per line, matching the `pr_changed_files` style. No new JSON parsing code needed — the helper returns `Vec<String>` directly.

### Change 2 — skip AC checks for docs-only PRs in `verify_delivery`

Inside `verify_delivery`'s `for url in &pr_urls` loop (currently at `agents/workflows/feature-task/src/main.rs` lines 813–853), gate the body and AC-text checks on the URL not being a docs-only follow-up. Concretely, after the `is_latest_pr_url` early-continue and the `inspect_pr` call, change the body branch to:

```rust
let docs_only = match pr_gates::pr_labels(url) {
    Ok(labels) => labels.iter().any(|name| name == pr_gates::DOCS_ONLY_LABEL),
    Err(err) => {
        failures.push(format!(
            "Could not read PR labels for {url}: {err}. Cannot exempt docs-only check."
        ));
        false
    }
};
if !docs_only {
    if let Ok(body) = pr_body(url) {
        if !pr_gates::body_has_checked_acceptance(&body) {
            failures.push(format!(
                "PR {url} does not show checked acceptance criteria in its body."
            ));
        }
        for ac_failure in ac_parsing::verify_pr_acs_failures(&body) {
            failures.push(format!("PR {url} — {ac_failure}"));
        }
    }
}
```

And, for symmetry, skip the `task_ac_vs_open_pr_failures` block on the same gate (the second `if let Some(url) = &latest_pr_url { ... }` block at the bottom of `verify_delivery`) so docs-only follow-ups do not trigger `task_ac_vs_open_pr_failures` either:

```rust
if let Some(url) = &latest_pr_url {
    let docs_only = match pr_gates::pr_labels(url) {
        Ok(labels) => labels.iter().any(|name| name == pr_gates::DOCS_ONLY_LABEL),
        Err(err) => {
            failures.push(format!(
                "Could not read PR labels for {url}: {err}. Cannot exempt docs-only check."
            ));
            false
        }
    };
    if !docs_only {
        match pr_body(url) {
            Ok(body) => {
                for ac_failure in
                    ac_parsing::task_ac_vs_open_pr_failures(&env.task.id, &task_acs, &body, url)
                {
                    failures.push(format!("PR {url} — {ac_failure}"));
                }
            }
            Err(err) => {
                failures.push(format!(
                    "Could not read PR body for {url}: {err}. Cannot validate AC text."
                ));
            }
        }
    }
}
```

Why this is correct and complete:

- **Opt-in**: only PRs explicitly labelled `docs-only` get the exemption. No silent behaviour change for existing PRs — the fix only affects PRs the implementer labels at open time. The `dd232b99` incident PR (#566) needs its label added retroactively as part of the migration in Change 5.
- **Fail-closed on `gh` errors**: a transient `gh` blip during `pr_labels` does NOT silently bypass the AC check — it pushes a failure and the sweep blocks, matching the existing `pr_changed_files` discipline (W36 A2). This is the correct posture: the lobster should not advance to `acceptance` without confirming the docs-only marker.
- **Review-state check still runs**: `inspect_pr` runs on every PR regardless of label. A closed-without-merge docs-only PR is still surfaced, which is what we want — a superseded PR should still be visible to the sweep. The label only exempts the body/AC-text checks.
- **Latest-only semantics preserved**: the `is_latest_pr_url` early-continue is unchanged. The exemption is layered on top of the existing latest-only filter, so a docs-only PR that is *not* the latest (e.g. a v1 → v2 stack where v1 was docs-only and v2 is the delivery) is still skipped by the existing filter, then the docs-only gate is moot.
- **Idempotent**: re-running the sweep on the same PR set produces the same failures as today, minus the AC-checkbox false-positive on docs-only PRs.

### Change 3 — structural tests

Add three new tests in `agents/workflows/feature-task/src/pr_gates.rs` (the module that already houses `body_has_checked_acceptance` and the `pr_changed_files` tests) covering AC2 of the task:

```rust
#[test]
fn body_has_checked_acceptance_returns_true_for_typical_pr_body() {
    let body = "- [x] AC1: implemented\n- [x] AC2: tested\n";
    assert!(body_has_checked_acceptance(body));
}

#[test]
fn body_has_checked_acceptance_returns_false_for_docs_only_body() {
    // No `- [x]` lines — the case that produced the dd232b99 false-positive.
    let body = "## Mission Control staging deployment shape\n\nADR correction …\n";
    assert!(!body_has_checked_acceptance(body));
}
```

And add an integration-style unit test in `agents/workflows/feature-task/src/main.rs` (alongside the existing `verify_delivery_review_gate_allows_pending_review`) that asserts the verify_delivery failure list is empty when only a docs-only PR is in the URL list — this is the load-bearing test for AC2's "delivery + docs-only → ✅" and "docs-only alone → ❌" combos:

```rust
#[test]
fn verify_delivery_skips_ac_checks_for_docs_only_pr() {
    // AC2: a docs-only follow-up PR alongside a delivery PR must NOT
    // produce the AC-checkbox false-positive. The docs-only label is
    // honoured; the AC checks are skipped; the sweep advances.
    let mut env = sample_doing_env();
    env.task.attention_owners = vec!["Quinn".to_string()];
    env.lobster_state.pr_urls = vec![
        "https://github.com/Stoffer-Industries/sindustries/pull/565".to_string(),
        "https://github.com/Stoffer-Industries/sindustries/pull/566".to_string(),
    ];
    // PR #566 carries the docs-only label; PR #565 does not. The test
    // exercises the verify_delivery failure-collection path with both
    // PR bodies stubbed via gh shim helpers.
    let failures = collect_verify_delivery_failures(&env);
    assert!(
        failures.is_empty(),
        "expected no failures for delivery+docs-only, got: {failures:?}"
    );
}
```

(The exact shim setup mirrors the existing `with_failing_gh_shim` pattern in `pr_gates.rs`; the test will be wired to return `["docs-only"]` for PR #566 and `[]` for PR #565 via a `gh` shim that inspects the URL argument. This is the same fixture pattern the lobster already uses for `pr_changed_files` and `parse_github_review_state` tests.)

### Change 4 — document the `docs-only` convention

Add a short section to `docs/systems/tasks.md` ("PR convention — docs-only follow-up PRs") explaining when to apply the `docs-only` label:

- Apply the `docs-only` label at PR open time when the PR is a follow-up to a task's delivery PR and intentionally carries no `- [x] AC<N>` lines (system-spec ADRs, ADR corrections, runbook updates, audit-ledger PRs).
- The label exempts the PR from the lobster's `verify_delivery` AC-checkbox and AC-text-match checks; review-state and merge-status checks still apply.
- Apply **only** to follow-up PRs. Do **not** apply to a delivery PR — a delivery PR must carry its own AC checkboxes.

Add the same one-liner to the PR template (`.github/PULL_REQUEST_TEMPLATE.md` if it exists, otherwise `docs/development/pull-requests.md`) so implementers see the convention at PR-open time.

### Change 5 — backfill the label on PR #566 and confirm `dd232b99` auto-advances

Apply the `docs-only` label to PR #566 (the dd232b99 follow-up) via `gh pr edit --add-label docs-only <url>` from the same worktree branch as a docs-only commit (no code change — just the label application + the doc updates in Change 4 in the same commit, so the PR body explains the convention). After merge:

1. Run the lobster cron manually (or wait for the next tick) and confirm `dd232b99` advances from `doing` to `acceptance` without Tom's manual `accepted` approval.
2. Confirm the existing `routing_*` tests (5 of them) still pass — they are unrelated to `verify_delivery`'s body checks but live in the same module and exercise the same lobster gate path.

## Data model / API contract changes

None. The fix is a logic change inside the lobster's `verify_delivery` step plus a new label-reading helper. The wire shape (`Task`, `TaskApproval`, the `[implementer-prs]` tag, the PR `body` field) is unchanged. The new `docs-only` label is a GitHub-side artefact, not a task-side field.

## Workflow / cron / skill changes

None for cron or workflow gates. One skill-side doc update:

- `agents/skills/dev/pr-open/SKILL.md` and `agents/skills/dev/pr-process/SKILL.md` — add a one-line note that a follow-up PR opened after the delivery PR for the same task should carry the `docs-only` label if it intentionally has no AC checkboxes. This is the only new workflow-facing documentation.

No new task-comment tags, no new structured-approval types, no new workflow gates.

## Test plan

| AC | Layer | Coverage | Rationale |
| --- | --- | --- | --- |
| AC1 | Unit (Rust) | `body_has_checked_acceptance_returns_false_for_docs_only_body` + the `verify_delivery_skips_ac_checks_for_docs_only_pr` integration test with `gh` shim returning `["docs-only"]` for PR #566. | The bug is logic-only; the test exercises the exact production code path. |
| AC2 | Unit (Rust) | Three combos — delivery alone (control), delivery + docs-only (target ✅), docs-only alone (target ❌ with clear "no delivery PR" error). | The structural test layer is the durable coverage for this surface. |
| AC3 | Integration (live) | After merge, run the lobster cron (or wait for next tick) and confirm `dd232b99` advances from `doing` to `acceptance`. | The end-to-end signal is "the previously-blocked task auto-advances." A live lobster tick is the only test that captures this. |
| AC4 | Doc | New "PR convention — docs-only follow-up PRs" section in `docs/systems/tasks.md`; one-line note in the PR template. | The convention is documented at the surfaces implementers see at PR-open time. |
| AC5 | Unit (Rust) | Existing `body_has_checked_acceptance` tests + the control arm of the AC2 test (delivery PR alone still produces the AC-checkbox check on the PR body). | The existing behaviour is preserved for delivery-only PRs. |

E2E is captured by AC3. The unit tests in `agents/workflows/feature-task/src/pr_gates.rs` and `src/main.rs` are the durable test layer for the body-check path; the live lobster tick is the test for the auto-advance behaviour.

## Open questions and risks

1. **Will the label survive GitHub's label-name normalisation?** GitHub label names are case-insensitive at the API level but case-preserving on display. `pr_labels` reads whatever `gh` returns (the API returns the canonical-cased name). The helper compares with `==` to the `DOCS_ONLY_LABEL` constant `"docs-only"`; if a PR is created with the label as `Docs-Only` it will not match. **Mitigation:** the doc / PR-template instruction is explicit about case; the lobster's `verify_delivery` does a case-insensitive comparison (`eq_ignore_ascii_case`) to be safe. Update Change 1's `any(|name| name == pr_gates::DOCS_ONLY_LABEL)` to `any(|name| name.eq_ignore_ascii_case(pr_gates::DOCS_ONLY_LABEL))`.
2. **What about future label conventions?** The `pr_labels` helper is intentionally generic — it returns `Vec<String>`, not a typed enum. Adding `audit-ledger-only` or `runbook-only` later is a one-line addition (a new constant + a new skip gate). No design change needed.
3. **Is there a risk of over-exemption?** The label is opt-in and the doc explicitly says "follow-up PRs only." A delivery PR cannot carry `docs-only` and still satisfy the AC checkbox check on the other (delivery) PRs in `pr_urls` — the gate only fires per-URL, not globally.
4. **Does this interact with the `qa_agent` gate?** No — `qa_agent_verified(task)` is a separate check (`agents/workflows/feature-task/src/main.rs` near the `verify_delivery` exit conditions). The label only exempts the body/AC-text checks; `qa_agent` approval still has to land before the task advances to `acceptance`. The two gates are orthogonal.
5. **What about PR #565 vs PR #566 ordering?** Both URLs are merged before the sweep runs (`dd232b99` evidence: merge SHAs `59a5a77` and `093f1b2`). The label applies to #566 only; the AC checkbox check runs against #565 (the latest-by-PR-number with no `docs-only` label would be #566, but #566 is exempt). After the fix lands and #566 has the label, the AC checkbox check runs against #565 (which carries the AC checkboxes) — passing.
6. **Will `gh pr view --json labels` work in CI?** Yes — `gh` is already invoked for `--json body`, `--json files`, `--json reviewDecision`, etc. in the same module. No new auth or capability is required.

## Definition of done

- [ ] `pr_gates::pr_labels` helper added with the same fail-closed `Result<Vec<String>, String>` discipline as `pr_changed_files`.
- [ ] `pr_gates::DOCS_ONLY_LABEL` constant set to `"docs-only"`; case-insensitive comparison used at the call site.
- [ ] `verify_delivery`'s body and `task_ac_vs_open_pr_failures` blocks gated on the docs-only label per Change 2.
- [ ] Three new tests added per Change 3 covering AC1 + AC2 combos; existing `body_has_checked_acceptance` and `routing_*` tests still pass (`cargo test -p feature-task`).
- [ ] `docs/systems/tasks.md` updated with the "PR convention — docs-only follow-up PRs" section.
- [ ] PR template (`.github/PULL_REQUEST_TEMPLATE.md` or `docs/development/pull-requests.md`) updated with the one-line note.
- [ ] PR opened from `d1ea4812-lobster-verify-delivery-docs-only` with this tech design linked in the PR body.
- [ ] PR body does **not** include a `- [x] AC<N>: ...` checklist for any AC — the lobster would treat it as implementation coverage and create a false signal (per `agents/skills/dev/tech-design/SKILL.md` warning). AC verification lives only in this doc and in `cargo test` output.
- [ ] On merge, frontmatter is updated to `status: shipped`, `shipped_pr: <N>`, `shipped_date: <YYYY-MM-DD>`.
- [ ] After merge, `gh pr edit --add-label docs-only https://github.com/Stoffer-Industries/sindustries/pull/566` is run (or the label is added in the docs-only PR that ships this design — preferred, single commit) and the next lobster tick advances `dd232b99` from `doing` to `acceptance` without Tom's manual `accepted` approval.
