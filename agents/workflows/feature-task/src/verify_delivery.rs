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
use crate::qa_evidence_attest;
use crate::qa_evidence_drift::{detect_drift, EvidenceDrift, LiveEvidence, RecordedPins};
use crate::product_spec_parsing::{
    implementer_pr_urls, inspect_pr, latest_implementer_pr_urls, workstreams,
};
use crate::task_approvals;
use crate::{
    analytics,
    api_client,
    api_client::{add_comment, read_envelope},
    cli_utils,
    lobster_state::{is_past, write_state},
    spec_check_ready::{
        attention_stack_after_qa_revocation, reconcile_workflow_attention, transition_or_block,
    },
    Envelope, StageArgs, Task,
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

/// A PR that claims checked task ACs is an implementation delivery, not just
/// review evidence. It must be merged before the lobster asks Ash to run the
/// `qa_agent` gate. Superseded PRs are filtered before this helper is called;
/// merged PRs are always allowed.
pub(crate) fn unmerged_ac_delivery_failure(
    url: &str,
    review: pr_gates::ReviewState,
    ac_labels: &[String],
) -> Option<String> {
    if ac_labels.is_empty() || review == pr_gates::ReviewState::Merged {
        return None;
    }
    Some(format!(
        "PR {url} contains checked acceptance criteria ({}) but is not merged; merge it before the qa_agent gate.",
        ac_labels.join(", ")
    ))
}

/// The QA handoff is only eligible after every delivery/evidence check passes.
/// In particular, an open AC-bearing PR must not be exposed to Ash merely
/// because the mechanical evidence sub-gate happened to pass.
pub(crate) fn qa_agent_gate_eligible(
    mechanical_gate_failed: bool,
    delivery_failures: &[String],
) -> bool {
    !mechanical_gate_failed && delivery_failures.is_empty()
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

/// Current AC-evidence pins of the delivery PRs that matter right now.
///
/// `body` is carried alongside the head SHA because the two pins are read
/// from different sources: the digest comes from the body already fetched
/// for the mechanical gate, and only the SHA needs its own `gh` call.
/// Reusing the in-memory body keeps AC3's cost at one extra call per PR
/// rather than a second full re-fetch.
fn live_delivery_pins(
    latest_urls: &[String],
    delivery_evidence: &[ac_parsing::DeliveryPrEvidence],
) -> (Vec<(String, LiveEvidence)>, Vec<String>) {
    let mut live = Vec::new();
    let mut failures = Vec::new();
    for delivery in delivery_evidence {
        // Only the PRs the task is currently being delivered against. A
        // superseded historical PR that still merged keeps its evidence
        // role in the AC coverage check, but the live grant was pinned
        // against the current set.
        if !is_latest_pr_url(&delivery.url, latest_urls) {
            continue;
        }
        match qa_evidence_attest::pr_head_sha(&delivery.url) {
            Ok((number, head_sha)) => live.push((
                delivery.url.clone(),
                LiveEvidence {
                    pr_number: number as i64,
                    head_sha,
                    ac_section_digest: qa_evidence_attest::ac_section_digest(&delivery.body),
                },
            )),
            // Fail closed, never open. A grant cannot be re-checked against
            // a PR whose head cannot be read, so the pass blocks and says
            // so rather than waving the approval through unchecked.
            Err(err) => failures.push(format!(
                "Could not read the head SHA of delivery PR {} to re-check the structured `qa_agent` approval: {err}.",
                delivery.url
            )),
        }
    }
    (live, failures)
}

/// AC3 of task `ad8346ee`: re-check a granted `qa_agent` approval against the
/// PR's current state before the QA gate is consulted.
///
/// Task `39667e62` merged PR #803 with its AC-evidence section blanked to
/// `"test body update"` *after* Ash approved it, and the task then sat in
/// `doing` for ~10 days with QA still green. Nothing in the pipeline
/// compared a granted approval against what the PR looks like now. This
/// closes that: on any pin divergence the approval is revoked and the task
/// is routed to its assignee with a reason naming the regression.
///
/// Two ordering rules are load-bearing:
///
/// - **Route first, revoke second.** The reverse can strand the task: a
///   revoked grant whose reconcile failed leaves nothing for the next pass
///   to act on, because AC3 only fires against an *approved* row. That is
///   precisely the silent park AC4 exists to prevent. Routing first means a
///   routing failure aborts before anything is mutated and the next pass
///   retries from the same state.
/// - **Idempotent by construction.** After the revoke, the row is no longer
///   `approved`, so `RecordedPins::from_task` returns `None` and later
///   passes no-op. No fingerprint bookkeeping is needed to avoid
///   re-revoking on every heartbeat.
///
/// Outcome of matching a granted approval's pinned PR number against the
/// task's current live delivery set.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AttestedPr {
    /// The attested PR is still a current delivery PR. Carries its index into
    /// the live slice.
    Matched(usize),
    /// The attested PR is no longer a current delivery PR — the #803 →
    /// replacement-PR swap. Carries the current numbers for the reason.
    Swapped { current: Vec<i64> },
    /// No live PR could be read at all.
    NoLivePrs,
}

/// Match a grant's pinned PR number against the current live delivery set.
///
/// Pure, so the multi-PR false positive this fixes is provable without a live
/// PR or a GitHub token. A grant is pinned to *one* PR, so the lookup must be
/// by number rather than by position: a task with two current delivery PRs
/// legitimately mints its grant against the second, and comparing those pins
/// against `live.first()`'s head SHA always reads `Drifted(HeadSha)` — a
/// spurious revoke-and-route loop on exactly the multi-PR task class this gate
/// exists to protect.
fn match_attested_pr(pins: &RecordedPins, live: &[(String, LiveEvidence)]) -> AttestedPr {
    if live.is_empty() {
        return AttestedPr::NoLivePrs;
    }
    let current: Vec<i64> = live.iter().map(|(_, state)| state.pr_number).collect();
    match pins
        .pr_number
        .and_then(|attested| live.iter().position(|(_, state)| state.pr_number == attested))
    {
        Some(index) => AttestedPr::Matched(index),
        // The attested PR is not among the task's current delivery PRs, so the
        // pins have nothing to be compared against. That *is* the swap, and it
        // is reported as such rather than compared against an arbitrary sibling.
        None => AttestedPr::Swapped { current },
    }
}

/// What AC3 decided for a granted `qa_agent` approval, before any effectful
/// step runs.
///
/// Pure on purpose. Which verdict wins and which PR the recovery step names
/// are the two things that decide whether AC3 reports the truth, and both used
/// to be only arguable through an effectful function — the test asserted the
/// *intent* while the wiring did something else. Splitting the decision out
/// makes the shipped path provable without a live PR or a Tasks API.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QaInvalidationPlan {
    drift: EvidenceDrift,
    /// Index into `live` of the PR this grant was verified against. `None`
    /// when the attested PR is no longer one of the task's current delivery
    /// PRs, or when the row pinned nothing to begin with.
    matched: Option<usize>,
    /// Index into `live` of a *current* delivery PR to re-verify against when
    /// nothing matched. Never the attested PR — see `plan_qa_invalidation`.
    recovery: Option<usize>,
}

/// Decide whether a granted `qa_agent` approval is still trustworthy, and if
/// not, what to tell the assignee.
///
/// Two orderings here are load-bearing and both were review findings:
///
/// - **`Unpinned` outranks `PrSwapped`.** `match_attested_pr` matches by PR
///   number, so a row with a `None` number cannot match any live PR and falls
///   into its `Swapped` arm. Routing there named a replacement-PR swap for a
///   row that certified nothing, and skipped the `is_unpinned()` check that
///   exists to prevent exactly that misreading — a regression that never
///   happened, described in a note an operator will act on. A row missing any
///   pin is reported `Unpinned` instead; both invalidate the grant, and only
///   the explanation differs.
/// - **Recovery never names the attested PR.** When nothing matched, the next
///   action pointed at the PR that *left* the task. An assignee following it
///   re-mints against that PR, the row is pinned to it again, and the next
///   pass reads `PrSwapped` once more — the recovery note re-entering the
///   revoke-and-route loop it exists to end. The attested number is kept as
///   history in the reason; the instruction names a current delivery PR.
///
/// Returns `None` when the grant is still current, or when nothing could be
/// read at all: `live_delivery_pins` already fails closed on that path and
/// records a blocking failure, so revoking on an unreadable PR would revoke a
/// grant we could not *check* rather than one we know to be stale.
fn plan_qa_invalidation(
    pins: &RecordedPins,
    live: &[(String, LiveEvidence)],
) -> Option<QaInvalidationPlan> {
    match match_attested_pr(pins, live) {
        AttestedPr::NoLivePrs => None,
        AttestedPr::Matched(index) => {
            let drift = detect_drift(pins, &live[index].1);
            if !drift.is_stale() {
                return None;
            }
            Some(QaInvalidationPlan {
                drift,
                matched: Some(index),
                recovery: None,
            })
        }
        // `live` is non-empty here — `match_attested_pr` returns `NoLivePrs`
        // otherwise — so index 0 is always a usable current delivery PR.
        AttestedPr::Swapped { current } => {
            let drift = if pins.is_unpinned() {
                EvidenceDrift::Unpinned
            } else {
                EvidenceDrift::PrSwapped {
                    attested: pins.pr_number,
                    current,
                }
            };
            Some(QaInvalidationPlan {
                drift,
                matched: None,
                recovery: Some(0),
            })
        }
    }
}

fn invalidate_stale_qa_approval(
    args: &StageArgs,
    env: &mut Envelope,
    live: &[(String, LiveEvidence)],
) -> Result<bool> {
    let Some(pins) = RecordedPins::from_task(&env.task) else {
        return Ok(false);
    };
    let Some(plan) = plan_qa_invalidation(&pins, live) else {
        return Ok(false);
    };
    let matched = plan.matched.map(|index| &live[index]);
    // Always a URL the assignee can actually run: the matched PR when there
    // is one, otherwise a current delivery PR. There is no path here that
    // falls back to the attested number.
    let recovery_url = matched
        .map(|(url, _)| url.as_str())
        .or_else(|| plan.recovery.map(|index| live[index].0.as_str()));
    revoke_and_route_stale_qa_approval(args, env, &pins, matched, recovery_url, plan.drift)
}

/// Revoke a stale `qa_agent` grant and route the task to its assignee, citing
/// the regression in the reconcile note (AC3).
fn revoke_and_route_stale_qa_approval(
    args: &StageArgs,
    env: &mut Envelope,
    pins: &RecordedPins,
    matched: Option<&(String, LiveEvidence)>,
    recovery_pr_url: Option<&str>,
    drift: EvidenceDrift,
) -> Result<bool> {
    let assignee = env.task.assignee.clone();
    let attested_label = pins
        .pr_number
        .map(|n| format!("PR #{n}"))
        .unwrap_or_else(|| "an unrecorded PR".to_string());
    let state = matched.map(|(_, state)| state);
    let live_label = match state {
        Some(state) => format!("the live PR now reports head {} with digest {}", state.head_sha, state.ac_section_digest),
        // Nothing matched the pin, so there is no live PR to quote. Saying
        // "the live PR now reports ..." would name a divergence that was never
        // measured.
        None => "no current delivery PR matches it".to_string(),
    };
    // The instruction is the part an assignee runs verbatim, so it must be
    // runnable and must not name the PR that left the task. Passing
    // `attested_label` here was both — `"PR #803"` is neither a PR number nor
    // a URL, so `--pr-url` could not parse it, and re-minting against the
    // departed PR re-pins the row to it and reads `PrSwapped` again.
    let assignee_label = assignee.as_deref().unwrap_or("the assignee");
    let next_action = match recovery_pr_url {
        Some(url) => format!(
            "{assignee_label} re-runs `feature-task mechanical-evidence-check --pr-url {url}` and re-approves with the fresh attestation"
        ),
        None => format!(
            "{assignee_label} re-runs `feature-task mechanical-evidence-check` against this task's current delivery PR and re-approves with the fresh attestation"
        ),
    };
    let note = format!(
        "Structured `qa_agent` approval revoked by the lobster: {}. The grant pinned {} at head {} with AC-section digest {}; {}. Next action: {} — POST /tasks/{}/approvals refuses an unattested `qa_agent` grant.",
        drift.reason(),
        attested_label,
        pins.head_sha.as_deref().unwrap_or("<none recorded>"),
        pins.ac_section_digest.as_deref().unwrap_or("<none recorded>"),
        live_label,
        next_action,
        env.task.id
    );
    if args.dry_run {
        return Ok(true);
    }
    if let Some(owner) = assignee {
        // The stack shape is not a local detail: the Tasks API rejects a
        // `doing` task whose stack puts Tom anywhere but sole position 0, so
        // building it inline here 409'd on every tick for any task already
        // escalated to Tom. The rule lives in `spec_check_ready` beside the
        // sibling terminal-stack helpers and is pinned against the server
        // expression by its unit test.
        let desired = attention_stack_after_qa_revocation(&env.task, &owner);
        api_client::api_reconcile_attention::<Task>(&args.base_url, &env.task.id, desired, &note)?;
    }
    api_client::api_delete(
        &args.base_url,
        &format!("/tasks/{}/approvals/qa_agent", env.task.id),
    )?;
    // Re-read so the QA gate below evaluates the revoked row rather than the
    // pre-revoke snapshot still held in `env.task`.
    env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
    add_comment(
        &args.base_url,
        &env.task.id,
        &format!("[qa-evidence-invalidated]\n{note}"),
    )?;
    Ok(true)
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
    if let Some(drift) = block_on_spec_drift_fluid(&args, env.clone(), "verify_delivery")? {
        if !drift.criteria_met {
            return Ok(drift);
        }
        env = drift;
    }
    // A deferred Ash verdict is an explicit OpenClaw handoff. Set this before
    // any later delivery/mechanical failure can return through the generic
    // blocker so the persisted lobster state and queue routing agree.
    let deferred = task_approvals::qa_agent_deferred(&env.task);
    let waiting_on_capability_extension =
        task_approvals::qa_agent_deferred_waiting_on_capability_extension(&env.task);
    let capability_extension_complete =
        task_approvals::qa_agent_deferred_capability_extension_complete(&env.task);
    if deferred && !waiting_on_capability_extension && !capability_extension_complete {
        env.lobster_state.openclaw_needed = true;
        env.lobster_state.openclaw_done = false;
    } else if waiting_on_capability_extension || capability_extension_complete {
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
        let pr_is_merged = matches!(&review, Ok(pr_gates::ReviewState::Merged));
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
        let contributes_evidence = is_latest || pr_is_merged;
        if !contributes_evidence {
            if let Err(err) = &review {
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
        let body = match cli_utils::pr_body(url) {
            Ok(body) => body,
            Err(err) => {
                failures.push(format!(
                    "Could not read PR body for {url}: {err}. Cannot use it as AC evidence."
                ));
                continue;
            }
        };
        if let Ok(review_state) = review {
            let ac_labels = ac_parsing::task_ac_labels_in_pr_body(&env.task.id, &body);
            if let Some(failure) = unmerged_ac_delivery_failure(url, review_state, &ac_labels) {
                failures.push(failure);
            }
        }
        if docs_only {
            continue;
        }
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
    // Only reconcile the QA handoff after the delivery-evidence checks below
    // have passed. Reconciliation used to happen at function entry, which
    // surfaced Ash before Lobster had established that the implementation
    // evidence was complete.
    if !mechanical_gate_failed && failures.is_empty() {
        reconcile_workflow_attention(&args, &mut env)?;
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
    // AC3 of task ad8346ee: re-check any granted `qa_agent` approval against
    // the PR's current state *before* the QA gate is consulted, so a grant
    // that no longer describes its PR can never satisfy the gate.
    let (live_pins, pin_failures) = live_delivery_pins(&latest_urls, &delivery_evidence);
    failures.extend(pin_failures);
    invalidate_stale_qa_approval(&args, &mut env, &live_pins)?;

    if qa_agent_gate_eligible(mechanical_gate_failed, &failures) {
        let qa_agent_failures = qa_agent_verified_failures(&env.task);
        if !qa_agent_failures.is_empty() {
            if !args.dry_run {
                let qa_fingerprint = qa_agent_failures.join("\n");
                let deferred = task_approvals::qa_agent_deferred(&env.task);
                let waiting_on_capability_extension =
                    task_approvals::qa_agent_deferred_waiting_on_capability_extension(&env.task);
                let capability_extension_complete =
                    task_approvals::qa_agent_deferred_capability_extension_complete(&env.task);
                let fingerprint_changed =
                    env.lobster_state.failure_fingerprint.as_deref() != Some(&qa_fingerprint);
                if deferred && !waiting_on_capability_extension && !capability_extension_complete {
                    env.lobster_state.openclaw_needed = true;
                    env.lobster_state.openclaw_done = false;
                }
                if fingerprint_changed {
                    env.lobster_state.failure_fingerprint = Some(qa_fingerprint.clone());
                }
                if fingerprint_changed
                    && !waiting_on_capability_extension
                    && !capability_extension_complete
                {
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
                } else if task_approvals::qa_agent_deferred_capability_extension_complete(&env.task)
                {
                    "verify_delivery_capability_extension_ready".to_string()
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
    let mut result = transition_or_block(
        &args,
        env,
        "acceptance",
        "verify_delivery",
        failures,
        None,
        "[feature-task-progress-checklist]",
        "Feature task workflow moved task to `acceptance`.",
    )?;
    if !result.criteria_met && !args.dry_run {
        // The blocker comment written by transition_or_block is the routing
        // evidence. Re-read before reconciling so a delivery checklist routes
        // back to the implementer instead of falling through to Ash.
        result.task = crate::api_client::api_get_task(&args.base_url, &result.task.id)?;
        reconcile_workflow_attention(&args, &mut result)?;
    }
    Ok(result)
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
    use crate::qa_evidence_drift::DriftField;

    fn live_pr(number: i64, head: &str, digest: &str) -> (String, LiveEvidence) {
        (
            format!("https://github.com/Stoffer-Industries/sindustries/pull/{number}"),
            LiveEvidence {
                pr_number: number,
                head_sha: head.to_string(),
                ac_section_digest: digest.to_string(),
            },
        )
    }

    fn pins_for(pr: i64, head: &str, digest: &str) -> RecordedPins {
        RecordedPins {
            pr_number: Some(pr),
            head_sha: Some(head.to_string()),
            ac_section_digest: Some(digest.to_string()),
        }
    }

    #[test]
    fn a_grant_minted_against_the_second_delivery_pr_is_matched_not_misread_as_drift() {
        // The multi-PR false positive. `live.first()` would compare this
        // grant against PR #803's head SHA, read `Drifted(HeadSha)`, and
        // revoke-and-route a perfectly valid grant — on exactly the task class
        // this gate exists to protect.
        let live = vec![live_pr(803, "head-of-803", "digest-of-803"), live_pr(904, "head-of-904", "digest-of-904")];
        let pins = pins_for(904, "head-of-904", "digest-of-904");

        let matched = &live[match match_attested_pr(&pins, &live) {
            AttestedPr::Matched(index) => index,
            other => panic!("expected the attested PR to match, got {other:?}"),
        }];
        let drift = detect_drift(&pins, &matched.1);
        assert_eq!(
            drift,
            EvidenceDrift::Current,
            "a valid grant on the second delivery PR must not be revoked"
        );
    }

    #[test]
    fn a_task_swapped_to_a_replacement_pr_reports_the_swap_rather_than_a_sibling_head_sha() {
        let live = vec![live_pr(904, "head-of-904", "digest-of-904")];
        let pins = pins_for(803, "head-of-803", "digest-of-803");

        assert_eq!(
            match_attested_pr(&pins, &live),
            AttestedPr::Swapped { current: vec![904] }
        );
    }

    #[test]
    fn an_unpinned_row_does_not_report_a_swap_from_a_null_pin() {
        // A pre-migration row has no attested PR number, so there is nothing
        // to have been swapped away from. `match_attested_pr` cannot express
        // that — a `None` number matches no live PR and falls into its
        // `Swapped` arm — so the matcher alone reports a swap, and the
        // shipped wiring is what has to keep the verdict honest.
        let live = vec![live_pr(904, "head", "digest")];
        let pins = RecordedPins {
            pr_number: None,
            head_sha: Some("head".to_string()),
            ac_section_digest: Some("digest".to_string()),
        };
        assert_eq!(
            match_attested_pr(&pins, &live),
            AttestedPr::Swapped { current: vec![904] }
        );
        // ...and the drift verdict itself is the honest one.
        assert_eq!(detect_drift(&pins, &live[0].1), EvidenceDrift::Unpinned);
    }

    #[test]
    fn an_unpinned_row_reports_unpinned_on_the_shipped_path_not_only_in_detect_drift() {
        // The review finding: `invalidate_stale_qa_approval` returned from the
        // `Swapped` arm, so `is_unpinned()` was never consulted on that path
        // and the reconcile note named a replacement-PR swap for a row that
        // certified nothing. This asserts the shipped decision, not the
        // intention behind it.
        let live = vec![live_pr(904, "head", "digest")];
        let pins = RecordedPins {
            pr_number: None,
            head_sha: Some("head".to_string()),
            ac_section_digest: Some("digest".to_string()),
        };
        let plan = plan_qa_invalidation(&pins, &live).expect("an unpinned grant is stale");
        assert_eq!(
            plan.drift,
            EvidenceDrift::Unpinned,
            "a row with a NULL pin must not be reported as a PR swap"
        );
        let reason = plan.drift.reason();
        assert!(
            !reason.contains("replacement PR"),
            "the reason must not name a regression that never happened"
        );
    }

    #[test]
    fn a_half_populated_row_that_never_matches_reports_unpinned_rather_than_a_swap() {
        // The number is recorded but the row is still unverifiable without a
        // head SHA. `is_unpinned()` covers all three pins precisely so a row
        // pinned only by number cannot be half-trusted.
        let live = vec![live_pr(904, "head", "digest")];
        let pins = RecordedPins {
            pr_number: Some(803),
            head_sha: None,
            ac_section_digest: Some("digest".to_string()),
        };
        let plan = plan_qa_invalidation(&pins, &live).expect("an unpinned grant is stale");
        assert_eq!(plan.drift, EvidenceDrift::Unpinned);
    }

    #[test]
    fn a_genuine_swap_still_reports_pr_swapped_on_the_shipped_path() {
        // The narrow-guard check on the guard above: `Unpinned` outranking
        // `PrSwapped` must not swallow the real swap.
        let live = vec![live_pr(904, "head-of-904", "digest-of-904")];
        let pins = pins_for(803, "head-of-803", "digest-of-803");
        let plan = plan_qa_invalidation(&pins, &live).expect("a fully-pinned swap is stale");
        assert_eq!(
            plan.drift,
            EvidenceDrift::PrSwapped {
                attested: Some(803),
                current: vec![904]
            }
        );
        let reason = plan.drift.reason();
        assert!(reason.contains("PR #803"));
        assert!(reason.contains("replacement PR"));
    }

    #[test]
    fn the_recovery_step_names_a_current_delivery_pr_never_the_departed_one() {
        // The second review finding: the next action pointed at the attested
        // PR, which had left the task. Following it re-mints against that PR,
        // re-pins the row to it, and reads `PrSwapped` again — the recovery
        // note re-entering the loop it exists to end. `plan.recovery` is the
        // index the note's `--pr-url` is built from.
        let live = vec![
            live_pr(904, "head-of-904", "digest-of-904"),
            live_pr(905, "head-of-905", "digest-of-905"),
        ];
        let pins = pins_for(803, "head-of-803", "digest-of-803");

        let plan = plan_qa_invalidation(&pins, &live).expect("a swap is stale");
        assert_eq!(
            plan.drift,
            EvidenceDrift::PrSwapped {
                attested: Some(803),
                current: vec![904, 905]
            }
        );
        let recovery = plan.recovery.expect("a swap must offer a recovery PR");
        assert_eq!(
            live[recovery].1.pr_number, 904,
            "recovery must name a current delivery PR"
        );
        assert_ne!(
            live[recovery].1.pr_number, 803,
            "recovery must never name the PR that left the task"
        );
    }

    #[test]
    fn an_unreadable_live_pr_produces_no_plan_rather_than_a_revoke() {
        // `live_delivery_pins` already fails closed. Planning a revoke on an
        // unreadable PR would revoke a grant we could not check rather than
        // one we know to be stale.
        let pins = pins_for(803, "head", "digest");
        assert_eq!(plan_qa_invalidation(&pins, &[]), None);
    }

    #[test]
    fn a_current_grant_produces_no_plan() {
        let live = vec![live_pr(803, "head", "digest")];
        let pins = pins_for(803, "head", "digest");
        assert_eq!(plan_qa_invalidation(&pins, &live), None);
    }

    #[test]
    fn a_matched_but_drifted_grant_recovery_names_the_matched_pr() {
        // The matched path keeps its precision: the recovery URL comes from
        // the matched entry, not from `live.first()`, so the multi-PR task
        // re-verifies against the PR it was actually verified against.
        let live = vec![
            live_pr(803, "old-head-803", "digest-of-803"),
            live_pr(904, "head-of-904", "digest-of-904"),
        ];
        let pins = pins_for(904, "old-head-904", "digest-of-904");

        let plan = plan_qa_invalidation(&pins, &live).expect("a moved head is stale");
        assert_eq!(
            plan.drift,
            EvidenceDrift::Drifted(vec![DriftField::HeadSha])
        );
        assert_eq!(plan.matched, Some(1));
        assert_eq!(plan.recovery, None);
        assert_eq!(
            live[plan.matched.unwrap()].1.pr_number,
            904,
            "the matched entry is the recovery PR when nothing was swapped"
        );
    }

    #[test]
    fn no_readable_live_pr_is_reported_separately_from_a_swap() {
        // `live_delivery_pins` already fails closed here. Reporting it as a
        // swap would revoke a grant we could not check, rather than one we
        // know to be stale.
        let pins = pins_for(803, "head", "digest");
        assert_eq!(match_attested_pr(&pins, &[]), AttestedPr::NoLivePrs);
    }

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
    fn unmerged_ac_delivery_blocks_qa_handoff() {
        let url = "https://github.com/Stoffer-Industries/sindustries/pull/812";
        let labels = vec!["AC1".to_string(), "AC4".to_string()];
        let failure = unmerged_ac_delivery_failure(url, pr_gates::ReviewState::Approved, &labels)
            .expect("an open AC-bearing PR must block QA");
        assert!(failure.contains("AC1, AC4"));
        assert!(failure.contains("not merged"));
        assert!(failure.contains("qa_agent"));
    }

    #[test]
    fn merged_ac_delivery_does_not_block_qa_handoff() {
        let labels = vec!["AC1".to_string()];
        assert!(unmerged_ac_delivery_failure(
            "https://github.com/Stoffer-Industries/sindustries/pull/812",
            pr_gates::ReviewState::Merged,
            &labels,
        )
        .is_none());
    }

    #[test]
    fn qa_agent_gate_requires_all_delivery_checks_to_pass() {
        assert!(qa_agent_gate_eligible(false, &[]));
        assert!(!qa_agent_gate_eligible(
            false,
            &["PR contains checked ACs but is not merged.".to_string()]
        ));
        assert!(!qa_agent_gate_eligible(true, &[]));
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
