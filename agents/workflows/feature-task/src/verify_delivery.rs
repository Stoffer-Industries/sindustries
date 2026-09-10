//! Verify-delivery stage handler + leaf helpers for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a 7,796-line / 160-item god file"). This module
//! hosts the `verify_delivery` and `code_task_verify_delivery` stage
//! handlers and the small, pure helpers they compose (also consumed by
//! `post_merge` in `main.rs` until that stage moves with PR-C).
//!
//! Public surface (all `pub(crate)` — only `main.rs` consumes these):
//! - `verify_delivery` — `doing → acceptance` stage handler for the
//!   feature-task and code-task workflows
//! - `code_task_verify_delivery` — backwards-compatible CLI alias for
//!   `verify_delivery`; the code-task pipeline shares the same delivery
//!   contract
//! - `pr_number` — extract the PR number from a GitHub PR URL
//! - `is_latest_pr_url` — membership test for the
//!   `latest_implementer_pr_urls(task)` set
//! - `verify_delivery_review_failure` — review-state → blocker-failure
//!   constructor for the `verify_delivery` gate
//! - `qa_agent_verified_failures` — failure strings for the `qa_agent`
//!   structured-approval gate; the gate predicate itself
//!   (`qa_agent_verified`) lives in `task_approvals.rs` from PR-D
//!   onward (W37 A3 main.rs carve). Imported here as
//!   `crate::task_approvals::qa_agent_verified`.
//!
//! The leaf helpers do no I/O, no network, and no state mutation. They
//! are exercised as focused units via the `#[cfg(test)] mod tests`
//! block at the bottom of this file; the stage handler's higher-level
//! integration coverage stays in `main.rs`.

use crate::brain_spec_lifecycle::{
    block_on_spec_drift_fluid, block_with_manual_block, manual_block_failures,
};
use crate::pr_gates;
use crate::product_spec_parsing::{
    implementer_pr_urls, inspect_pr, latest_implementer_pr_urls, workstreams,
};
use crate::task_approvals;
use crate::{ac_parsing, test_runners};
use crate::{
    analytics,
    api_client::{add_comment, read_envelope},
    lobster_state::{is_past, write_state},
    pr_body,
    spec_check_ready::{reconcile_workflow_attention, transition_or_block},
    Envelope, StageArgs,
};
use anyhow::Result;

/// Extract the PR number from a GitHub PR URL for ordering.
pub(crate) fn pr_number(url: &str) -> u64 {
    url.rsplit('/')
        .next()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0)
}

/// True when `candidate` is a member of `latest_pr_urls` — the pre-computed
/// result of `latest_implementer_pr_urls`, i.e. the PR(s) named in the most
/// recent `[implementer-prs]`/`[rowan-prs]` comment. Used by `verify_delivery`
/// and `post_merge` to skip review-state and body checks against superseded
/// PRs (e.g. a v1 branch that was closed-without-merge and replaced by a v2
/// branch, or an accidental duplicate PR that a later comment corrected
/// away from). Callers must pass `latest_implementer_pr_urls(task)`, not the
/// full historical `implementer_pr_urls(task)` — comparing by PR-number
/// magnitude instead of comment recency broke on task 30251df0, where the
/// abandoned duplicate PR happened to have the higher number.
pub(crate) fn is_latest_pr_url(candidate: &str, latest_pr_urls: &[String]) -> bool {
    latest_pr_urls.iter().any(|url| url == candidate)
}

/// Map a PR review state to the corresponding `verify_delivery` gate failure
/// string. `ChangesRequested` and `ClosedUnmerged` block; every other state
/// (including `Approved`, `Required`, and unknown) is a pass-through.
pub(crate) fn verify_delivery_review_failure(
    url: &str,
    review: pr_gates::ReviewState,
) -> Option<String> {
    match review {
        pr_gates::ReviewState::ChangesRequested => Some(format!("Changes requested on {url}.")),
        pr_gates::ReviewState::ClosedUnmerged => Some(format!("PR {url} is closed without merge.")),
        _ => None,
    }
}

/// Failure strings for the `qa_agent` gate. Empty when the gate is satisfied.
/// Used by `verify_delivery` to short-circuit the transition with a
/// `[qa-agent-blocked]` comment. Gate predicate (`task_approvals::qa_agent_verified`)
/// lives in `task_approvals.rs` from PR-D onward.
pub(crate) fn qa_agent_verified_failures(task: &crate::Task) -> Vec<String> {
    if task_approvals::qa_agent_verified(task) {
        vec![]
    } else {
        vec!["Structured `qa_agent` approval is missing or not approved; Ash must run mechanical verification (cited tests pass, cited files exist, evidence matches the diff) before this task reaches Tom's acceptance. See task `f6a4d56a` AC1.".to_string()]
    }
}

/// `doing → acceptance` stage handler. Verifies the latest implementer PR
/// has merged cleanly, the task description carries enough metadata to
/// gate on, the mechanical evidence gate is satisfied, and the
/// `qa_agent` approval is in place. Short-circuits with a
/// `[qa-agent-blocked]` comment when the structured qa_agent gate is
/// the only thing outstanding; otherwise accumulates failures and
/// routes through `transition_or_block` with the
/// `[feature-task-progress-checklist]` comment shape used by every other
/// lobster gate.
pub(crate) fn verify_delivery(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    reconcile_workflow_attention(&args, &mut env)?;
    if let Some(drift) = block_on_spec_drift_fluid(&args, env.clone(), "verify_delivery")? {
        if !drift.criteria_met {
            return Ok(drift);
        }
        env = drift;
    }
    let manual_failures = manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return block_with_manual_block(
            &args,
            env,
            "verify_delivery",
            manual_failures,
            "[feature-task-blocked]",
        );
    }
    if is_past(&env.task, "doing") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_doing".to_string();
        return Ok(env);
    }
    // AC1 of task f6a4d56a: the `qa_agent` TaskApproval row is now created
    // by `POST /tasks` as a `state: pending` row (task d9cd8a83), so no
    // bootstrap is needed here. The previous `ensure_qa_agent_gate`
    // POST-then-DELETE pattern was removed — see the d9cd8a83 tech design.
    let mut failures = Vec::new();
    let pr_urls = implementer_pr_urls(&env.task);
    if pr_urls.is_empty() {
        failures
            .push("Missing `[implementer-prs]` task comment with at least one PR URL.".to_string());
    }
    env.lobster_state.pr_urls = pr_urls.clone();
    let task_acs =
        ac_parsing::task_description_acs(&env.task.description.clone().unwrap_or_default());
    // The PR(s) named in the most recent `[implementer-prs]`/`[rowan-prs]`
    // comment — see `latest_implementer_pr_urls` for why this is comment
    // recency, not PR-number magnitude.
    let latest_urls = latest_implementer_pr_urls(&env.task);
    // AC text match only checks the *latest* PR. Earlier PRs may legitimately
    // have drifted from the current task description (e.g. trailing-period
    // fixes landed in a follow-up PR). The latest PR is the one that will be
    // merged at this gate, so it's the only one that needs to match.
    let latest_pr_url = latest_urls.iter().max_by_key(|url| pr_number(url)).cloned();
    for url in &pr_urls {
        // Only the latest PR is the one that will be merged at this gate.
        // Earlier PRs that were intentionally superseded (e.g. v1 → v2
        // branch replace, stacked predecessors, or an accidental duplicate
        // PR a later comment corrected away from) should not contribute
        // failures here — the AC text match below already targets the
        // latest PR explicitly, so we extend the same principle to the
        // review-state and body checks. Without this, a closed-without-merge
        // superseded PR leaves a persistent "PR X is closed without merge."
        // failure that blocks every sweep (fingerprint dedup), even after the
        // task has been re-delivered on a fresh branch.
        if !is_latest_pr_url(url, &latest_urls) {
            continue;
        }
        let review = inspect_pr(url);
        match review {
            Ok(r) => {
                if let Some(failure) = verify_delivery_review_failure(url, r) {
                    failures.push(failure);
                }
            }
            Err(err) => failures.push(format!("Could not inspect PR {url}: {err}.")),
        }
        // Docs-only follow-up PRs (system-spec ADRs, ADR corrections,
        // runbook updates, audit-ledger PRs) carry the `docs-only` label
        // and intentionally have no AC-checkbox evidence — the AC check
        // happens against the delivery PR instead. Fail closed on a `gh`
        // blip during label read so a transient error cannot silently
        // bypass the docs-only skip.
        let docs_only = match pr_gates::is_docs_only_pr(url) {
            Ok(value) => value,
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
    }
    if let Some(url) = &latest_pr_url {
        // Same docs-only exemption for the AC text match against the
        // task description — a docs-only follow-up PR does not need to
        // cover the AC text in its body; the delivery PR does.
        let docs_only = match pr_gates::is_docs_only_pr(url) {
            Ok(value) => value,
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
    // Clippy evidence gate (opt-in via CLIPPY_ENFORCE env). When the gate
    // is enabled, only the latest PR is checked (matches the
    // `latest_pr_url` principle used above for AC text). Non-Rust /
    // content-only PRs are skipped outright.
    if let Some(url) = &latest_pr_url {
        failures.extend(pr_gates::clippy_evidence_failures(url));
    }
    if workstreams(&env.task).is_empty() {
        failures.push("Task description must include at least one workstream.".to_string());
    }
    // AC1 of task 5e35dc25: mechanical evidence gate before `qa_agent`.
    // The lobster runs the deterministic file-existence + test-execution
    // checks first; only if those pass do we ask Ash for semantic judgment
    // (AC2 of the same task). `PnpmTestRunner` shells out to
    // `pnpm test --filter <name>` per AC3; `CargoTestRunner` shells out to
    // `cargo test --bin feature-task <name>` for PRs touching this crate
    // (task e67c8835 fix — pnpm has no manifest to filter against here, so
    // it misreported every passing Rust test as a failure). Unit tests in
    // `ac_parsing` substitute `AlwaysPassTestRunner` / `AlwaysFailTestRunner`.
    //
    // Failures surface as `[feature-task-progress-checklist]` (the same
    // pattern every other lobster gate uses) and short-circuit the qa_agent
    // check below so Ash's heartbeat is not asked to verify a delivery that
    // has not yet cleared the mechanical bar.
    let mut mechanical_gate_failed = false;
    if let Some(url) = &latest_pr_url {
        // Pull the changed file list once and let both the runner
        // disambiguator and the mechanical-evidence check consume it. On
        // `gh` errors we surface the failure to the gate AND default
        // `is_rust_pr: true` so citations are over-checked rather than
        // under-checked during a transient blip (W36 audit finding A2:
        // false positives — shell citation routed to cargo — are less
        // harmful than false negatives — Rust citation silently routed to
        // pnpm).
        let pr_files_result = pr_gates::pr_changed_files(url);
        let is_rust_pr = match &pr_files_result {
            Ok(files) => pr_gates::touches_rust_feature_workflow(files),
            Err(_) => true,
        };
        if let Err(err) = &pr_files_result {
            failures.push(format!(
                "Could not list changed files for mechanical evidence check ({url}): {err}; \
                 defaulting to Rust citation runner."
            ));
        }
        let pr_files = pr_files_result.unwrap_or_default();
        let npm_workspace =
            test_runners::resolve_npm_workspace(&test_runners::repo_root_dir(), &pr_files);
        let body = pr_body(url).unwrap_or_default();
        // A single PR can cite Rust, shell, and Python tests across
        // different ACs (tasks 5baf6809, 60971f78 — both blocked by the
        // same underlying bug: `PnpmTestRunner` was the only runner and
        // has no manifest to filter shell/pytest citations against
        // either). `DispatchingTestRunner` picks a runner per citation by
        // the test_id's own shape; `is_rust_pr` remains the disambiguator
        // for bare Rust test names only (same predicate the clippy
        // evidence gate above already uses — task e67c8835). When the
        // file list is unknown we keep `is_rust_pr: true` so bare-Rust
        // citations stay on the cargo runner.
        let test_runner: Box<dyn ac_parsing::TestRunner> =
            Box::new(test_runners::DispatchingTestRunner {
                is_rust_pr,
                npm_workspace,
            });
        let mechanical_failures = ac_parsing::mechanical_evidence_failures(
            &env.task.id,
            &task_acs,
            &body,
            &pr_files,
            test_runner.as_ref(),
        );
        if !mechanical_failures.is_empty() {
            mechanical_gate_failed = true;
            for failure in mechanical_failures {
                failures.push(format!("PR {url} — {failure}"));
            }
        }
    }
    // AC1 of task f6a4d56a: short-circuit on `qa_agent` outstanding with a
    // dedicated `[qa-agent-blocked]` comment so Ash's verification gap is
    // visibly distinct from the generic `[feature-task-progress-checklist]`
    // failures. The fingerprint dedup reuses the same pattern as
    // `transition_or_block` so the comment is only posted on the first
    // transition into "blocked" for a given failure string — re-runs of
    // verify_delivery while Ash is still outstanding do not spam comments.
    //
    // AC2 of task 5e35dc25: skip this branch entirely when the mechanical
    // gate has already failed — Ash's qa_agent is not requested until
    // mechanical checks pass.
    if !mechanical_gate_failed {
        let qa_agent_failures = qa_agent_verified_failures(&env.task);
        if !qa_agent_failures.is_empty() {
            if !args.dry_run {
                let qa_fingerprint = qa_agent_failures.join("\n");
                if env.lobster_state.failure_fingerprint.as_deref() != Some(&qa_fingerprint) {
                    env.lobster_state.failure_fingerprint = Some(qa_fingerprint.clone());
                    add_comment(
                        &args.base_url,
                        &env.task.id,
                        &format!("[qa-agent-blocked]\n{}", qa_agent_failures.join("\n")),
                    )?;
                    write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
                }
            }
            env.criteria_met = false;
            env.action_taken = "verify_delivery_qa_agent_blocked".to_string();
            env.failures = qa_agent_failures;
            analytics::emit_gate_failure_events(&args, &env.task, "verify_delivery", &env.failures);
            return Ok(env);
        }
    }
    transition_or_block(
        &args,
        env,
        "acceptance",
        "verify_delivery",
        failures,
        None,
        "[feature-task-progress-checklist]",
        "Feature task workflow moved task to `acceptance`.",
    )
}

/// Backwards-compatible CLI alias for the code-task pipeline. Both task
/// types share the same delivery contract now, so this delegates to
/// `verify_delivery` instead of carrying a separate handler body.
pub(crate) fn code_task_verify_delivery(args: StageArgs) -> Result<Envelope> {
    verify_delivery(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_delivery_review_gate_allows_pending_review() {
        let url = "https://github.com/Stoffer-Industries/sindustries/pull/117";
        assert!(verify_delivery_review_failure(url, pr_gates::ReviewState::Required).is_none());
        assert!(
            verify_delivery_review_failure(url, pr_gates::ReviewState::CommentsPresent).is_none()
        );
        assert!(verify_delivery_review_failure(url, pr_gates::ReviewState::Merged).is_none());
        assert_eq!(
            verify_delivery_review_failure(url, pr_gates::ReviewState::ChangesRequested),
            Some(format!("Changes requested on {url}."))
        );
        assert_eq!(
            verify_delivery_review_failure(url, pr_gates::ReviewState::ClosedUnmerged),
            Some(format!("PR {url} is closed without merge."))
        );
    }

    #[test]
    fn pr_number_extracts_from_url() {
        assert_eq!(
            pr_number("https://github.com/Stoffer-Industries/sindustries/pull/142"),
            142
        );
        assert_eq!(pr_number("not-a-url"), 0);
    }

    #[test]
    fn is_latest_pr_url_returns_true_only_for_members_of_latest_set() {
        // `latest_pr_urls` is a pre-resolved set (the most recent
        // [implementer-prs] comment's URLs), not "all PR URls ever seen" —
        // membership, not PR-number magnitude, decides "latest" now.
        let latest_urls =
            vec!["https://github.com/Stoffer-Industries/sindustries/pull/368".to_string()];
        assert!(!is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &latest_urls
        ));
        assert!(is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/368",
            &latest_urls
        ));
    }

    #[test]
    fn is_latest_pr_url_handles_single_url() {
        let urls = vec!["https://github.com/Stoffer-Industries/sindustries/pull/365".to_string()];
        assert!(is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &urls
        ));
    }

    #[test]
    fn is_latest_pr_url_returns_false_for_empty_list() {
        let urls: Vec<String> = vec![];
        assert!(!is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &urls
        ));
    }

    #[test]
    fn is_latest_pr_url_returns_false_for_candidate_not_in_latest_set() {
        let latest_urls =
            vec!["https://github.com/Stoffer-Industries/sindustries/pull/365".to_string()];
        assert!(!is_latest_pr_url("not-a-url", &latest_urls));
        assert!(is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &latest_urls
        ));
    }

    #[test]
    fn is_latest_pr_url_true_for_every_member_of_a_multi_workstream_latest_set() {
        // A single [implementer-prs] comment can legitimately name multiple
        // PRs for concurrent workstreams (see
        // implementer_pr_urls_preserve_merged_prs_for_delivery). All of them
        // are "latest" together — none should be treated as superseded just
        // because another has a higher PR number.
        let latest_urls = vec![
            "https://github.com/foo/bar/pull/10".to_string(),
            "https://github.com/baz/qux/pull/12".to_string(),
        ];
        assert!(is_latest_pr_url(
            "https://github.com/foo/bar/pull/10",
            &latest_urls
        ));
        assert!(is_latest_pr_url(
            "https://github.com/baz/qux/pull/12",
            &latest_urls
        ));
    }
}
