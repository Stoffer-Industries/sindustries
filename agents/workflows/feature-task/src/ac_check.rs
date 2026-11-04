//! `ac-check` — grade a candidate PR body against a task description.
//!
//! This is the offline twin of the lobster's `verify-delivery` AC gate. It
//! runs the *same* two checks the gate runs — `task_acs_vs_delivery_pr_failures`
//! (AC coverage, verbatim text, recognised evidence) and
//! `mechanical_evidence_failures` (structural evidence) — against a task
//! description read from disk and a candidate PR body read from disk.
//!
//! Two reasons it exists:
//!
//! 1. A PR author can check a body *before* opening the PR, instead of
//!    discovering the mismatch when the lobster bounces the task back.
//! 2. The model-eval harness grades a candidate body with production code
//!    rather than a reimplementation of the parser. A reimplementation drifts
//!    from the parser and reports failures the gate would not — which is how
//!    a grader starts lying about the thing it grades.
//!
//! Exits `0` when the body satisfies every AC, `1` when it does not, and
//! prints a JSON report either way.

use crate::ac_parsing::{
    mechanical_evidence_failures, parse_ac_entries_filtered, parse_evidence,
    strip_trailing_evidence, task_acs_vs_delivery_pr_failures, task_description_acs,
    DeliveryPrEvidence, Evidence,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcCheckRow {
    pub(crate) label: String,
    pub(crate) task_text: String,
    pub(crate) pr_text: Option<String>,
    pub(crate) evidence: Option<String>,
    /// True when the PR body carries this AC as a *checked* `- [x]` line.
    pub(crate) checked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcCheckReport {
    pub(crate) ok: bool,
    pub(crate) failures: Vec<String>,
    pub(crate) acs: Vec<AcCheckRow>,
}

/// Describe a recognised evidence annotation in a form a human can read back.
fn describe_evidence(raw: &str) -> Option<String> {
    match parse_evidence(raw) {
        Some(Evidence::TestId(id)) => Some(format!("testID: {id}")),
        Some(Evidence::NotTested { reason }) => Some(format!("not tested: {reason}")),
        Some(Evidence::NotCode { reason }) => Some(format!("not code: {reason}")),
        Some(Evidence::Pr { reference }) => Some(format!("pr: {reference}")),
        Some(Evidence::Signoff { approver }) => Some(format!("sign-off: {approver}")),
        None => None,
    }
}

pub(crate) fn ac_check(args: &crate::AcCheckArgs) -> anyhow::Result<String> {
    let task_description =
        std::fs::read_to_string(&args.task_description).map_err(|e| {
            anyhow::anyhow!(
                "cannot read task description {}: {e}",
                args.task_description.display()
            )
        })?;
    let pr_body = std::fs::read_to_string(&args.pr_body)
        .map_err(|e| anyhow::anyhow!("cannot read PR body {}: {e}", args.pr_body.display()))?;

    let pr_files: Vec<String> = if args.pr_files.as_os_str().is_empty() {
        Vec::new()
    } else {
        std::fs::read_to_string(&args.pr_files)
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    };

    // The task side, parsed exactly as `verify_delivery.rs` parses it.
    let task_acs = task_description_acs(&task_description);

    let delivery = DeliveryPrEvidence {
        url: args.pr_url.clone(),
        body: pr_body.clone(),
        files: pr_files.clone(),
    };

    let mut failures = task_acs_vs_delivery_pr_failures(
        &args.task_id,
        &task_acs,
        std::slice::from_ref(&delivery),
    );
    failures.extend(mechanical_evidence_failures(
        &args.task_id,
        &task_acs,
        &pr_body,
        &pr_files,
    ));

    // Per-AC detail, so a near miss is distinguishable from a total miss.
    let section = crate::ac_parsing::extract_ac_section(&pr_body);
    // `parse_ac_entries_filtered(.., true)` yields only the ACs the PR body
    // carries as *checked* `- [x]` lines, which is the only form the gate
    // counts as covered.
    let checked_labels: std::collections::HashSet<String> =
        parse_ac_entries_filtered(section, true)
            .into_iter()
            .map(|(label, _)| label)
            .collect();
    let pr_entries = crate::ac_parsing::parse_ac_entries(section);
    let mut rows = Vec::new();
    for (label, task_text) in &task_acs {
        let found = pr_entries.iter().find(|(l, _)| l == label);
        let (pr_text, evidence, checked) = match found {
            Some((_, raw)) => (
                Some(strip_trailing_evidence(raw)),
                describe_evidence(raw),
                checked_labels.contains(label),
            ),
            None => (None, None, false),
        };
        rows.push(AcCheckRow {
            label: label.clone(),
            task_text: task_text.clone(),
            pr_text,
            evidence,
            checked,
        });
    }

    let report = AcCheckReport {
        ok: failures.is_empty(),
        failures,
        acs: rows,
    };
    Ok(serde_json::to_string_pretty(&report)?)
}
