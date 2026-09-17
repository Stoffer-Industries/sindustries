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

use crate::ac_parsing;
use crate::brain_spec_lifecycle::{
    block_on_spec_drift_fluid, block_with_manual_block, manual_block_failures,
};
use crate::pr_gates;
use crate::product_spec_parsing::{
    implementer_pr_urls, inspect_pr, latest_implementer_pr_urls, workstreams,
};
use crate::task_approvals;
use crate::{
    analytics,
    api_client::{add_comment, read_envelope},
    cli_utils,
    lobster_state::{is_past, write_state},
    spec_check_ready::{reconcile_workflow_attention, transition_or_block},
    Envelope, StageArgs,
};
use anyhow::Result;

/// Extract the PR number from a GitHub PR URL for ordering.
#[allow(
    dead_code,
    reason = "retained for compatibility with existing ordering tests and callers"
)]
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
    } else if task_approvals::qa_agent_deferred(task) {
        vec!["Ash reported deferred acceptance criteria; the structured `qa_agent` approval is invalid until every AC is claimed addressed and verified. OpenClaw must resolve the deferred items before QA can approve. See the latest `[qa-agent-deferred]` report.".to_string()]
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
    // A deferred Ash verdict is an explicit OpenClaw handoff. Set this before
    // any later delivery/mechanical failure can return through the generic
    // blocker so the persisted lobster state and queue routing agree.
    if task_approvals::qa_agent_deferred(&env.task)
        && !task_approvals::qa_agent_deferred_waiting_on_capability_extension(&env.task)
    {
        env.lobster_state.openclaw_needed = true;
        env.lobster_state.openclaw_done = false;
    } else if task_approvals::qa_agent_deferred_waiting_on_capability_extension(&env.task) {
        // The capability task is now the actionable work item. Clear any
        // stale OpenClaw handoff left by the pre-dependency deferral.
        env.lobster_state.openclaw_needed = false;
        env.lobster_state.openclaw_done = false;
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
    // The latest PR set controls review/lifecycle state. Evidence is broader:
    // merged historical delivery PRs remain valid proof when a task was
    // intentionally delivered over several PRs.
    let mut delivery_evidence = Vec::new();
    for url in &pr_urls {
        let review = inspect_pr(url);
        let is_latest = is_latest_pr_url(url, &latest_urls);
        match &review {
            Ok(r) if is_latest => {
                if let Some(failure) = verify_delivery_review_failure(url, *r) {
                    failures.push(failure);
                }
            }
            Err(err) if is_latest => failures.push(format!("Could not inspect PR {url}: {err}.")),
            _ => {}
        }
        // A historical PR contributes evidence only if it actually merged.
        // This preserves the superseded-PR fix: a closed replacement branch
        // cannot block delivery, but a merged predecessor can still prove an
        // AC whose implementation and test remain on main.
        let contributes_evidence = is_latest || matches!(review, Ok(pr_gates::ReviewState::Merged));
        if !contributes_evidence {
            if let Err(err) = review {
                failures.push(format!(
                    "Could not inspect historical delivery PR {url}: {err}; cannot use it as AC evidence."
                ));
            }
            continue;
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
        if docs_only {
            continue;
        }
        let body = match cli_utils::pr_body(url) {
            Ok(body) => body,
            Err(err) => {
                failures.push(format!(
                    "Could not read PR body for {url}: {err}. Cannot use it as AC evidence."
                ));
                continue;
            }
        };
        let files = match pr_gates::pr_changed_files(url) {
            Ok(files) => files,
            Err(err) => {
                failures.push(format!(
                    "Could not list changed files for delivery PR {url}: {err}."
                ));
                Vec::new()
            }
        };
        delivery_evidence.push(ac_parsing::DeliveryPrEvidence {
            url: url.clone(),
            body,
            files,
        });
    }
    if !task_acs.is_empty() {
        if delivery_evidence.is_empty() {
            failures.push(
                "No usable delivery PR evidence was found for the task acceptance criteria."
                    .to_string(),
            );
        } else {
            if !delivery_evidence
                .iter()
                .any(|delivery| pr_gates::body_has_checked_acceptance(&delivery.body))
            {
                failures.push(
                    "Delivery PRs do not show checked acceptance criteria in their bodies."
                        .to_string(),
                );
            }
            for ac_failure in ac_parsing::task_acs_vs_delivery_pr_failures(
                &env.task.id,
                &task_acs,
                &delivery_evidence,
            ) {
                failures.push(ac_failure);
            }
        }
    }
    // Clippy evidence gate (opt-in via CLIPPY_ENFORCE env). Check every
    // current delivery PR in a multi-workstream task; historical merged PRs
    // do not need to repeat the current clippy evidence.
    for url in &latest_urls {
        failures.extend(pr_gates::clippy_evidence_failures(url));
    }
    if workstreams(&env.task).is_empty() {
        failures.push("Task description must include at least one workstream.".to_string());
    }
    // AC1 of task 5e35dc25: mechanical evidence gate before `qa_agent`.
    // The lobster checks deterministic evidence structure first; test
    // execution belongs to GitHub CI and Ash's external-check verification.
    // In particular, the lobster must not run ordinary test-name citations
    // against whichever local checkout happens to be present.
    //
    // Failures surface as `[feature-task-progress-checklist]` (the same
    // pattern every other lobster gate uses) and short-circuit the qa_agent
    // check below so Ash's heartbeat is not asked to verify a delivery that
    // has not yet cleared the mechanical bar.
    let mut mechanical_gate_failed = false;
    // Mechanical evidence checks must key off the same winning source the
    // coverage/evidence check above selects for each AC — the first delivery
    // PR (in `pr_urls` order) whose AC text exactly matches the task
    // description and carries evidence. Checking every delivery PR that
    // merely *mentions* a label would re-fail a task on a now-stale citation
    // in an earlier, superseded PR even though a later PR already proves the
    // AC (task 2c3bf69b's AC6/AC review, Tom's 2026-09-12 05:44 NZST question).
    let winning_ac_sources =
        ac_parsing::winning_ac_evidence_sources(&env.task.id, &task_acs, &delivery_evidence);
    for (delivery_index, delivery) in delivery_evidence.iter().enumerate() {
        let url = &delivery.url;
        let acs_won_by_this_delivery: Vec<(String, String)> = task_acs
            .iter()
            .filter(|(label, _)| winning_ac_sources.get(label) == Some(&delivery_index))
            .cloned()
            .collect();
        if acs_won_by_this_delivery.is_empty() {
            // This PR isn't the authoritative evidence source for any AC —
            // either it doesn't cover any AC, or an earlier PR already won.
            // Its own (possibly stale) citations are not re-checked.
            continue;
        }
        // Mechanical checks run against each contributing PR's own files and
        // body. That prevents a multi-PR task from failing merely because its
        // final PR does not repeat a test file introduced by an earlier merge.
        let pr_files = &delivery.files;
        let mechanical_failures = ac_parsing::mechanical_evidence_failures(
            &env.task.id,
            &acs_won_by_this_delivery,
            &delivery.body,
            pr_files,
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
                let deferred = task_approvals::qa_agent_deferred(&env.task);
                let waiting_on_capability_extension =
                    task_approvals::qa_agent_deferred_waiting_on_capability_extension(&env.task);
                let fingerprint_changed =
                    env.lobster_state.failure_fingerprint.as_deref() != Some(&qa_fingerprint);
                if deferred && !waiting_on_capability_extension {
                    env.lobster_state.openclaw_needed = true;
                    env.lobster_state.openclaw_done = false;
                }
                if fingerprint_changed {
                    env.lobster_state.failure_fingerprint = Some(qa_fingerprint.clone());
                }
                if fingerprint_changed && !waiting_on_capability_extension {
                    add_comment(
                        &args.base_url,
                        &env.task.id,
                        &format!(
                            "{}\n{}",
                            if deferred {
                                "[openclaw-needed]"
                            } else {
                                "[qa-agent-blocked]"
                            },
                            qa_agent_failures.join("\n")
                        ),
                    )?;
                }
                if fingerprint_changed || deferred {
                    write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
                }
            }
            env.criteria_met = false;
            env.action_taken =
                if task_approvals::qa_agent_deferred_waiting_on_capability_extension(&env.task) {
                    "verify_delivery_capability_extension_pending".to_string()
                } else if task_approvals::qa_agent_deferred(&env.task) {
                    "verify_delivery_openclaw_needed".to_string()
                } else {
                    "verify_delivery_qa_agent_blocked".to_string()
                };
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
