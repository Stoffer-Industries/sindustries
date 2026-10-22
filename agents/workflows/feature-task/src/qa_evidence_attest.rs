//! Live AC-evidence attestation for Ash's `qa_agent` approval.
//!
//! Task `ad8346ee` ("Gate Ash's `qa_agent` approval on live AC-evidence +
//! SHA-pinned invalidation") closes the incident from task `39667e62`, where
//! PR #803's AC-evidence section was blanked to `"test body update"` *after*
//! Ash's `qa_agent` approval had already been granted. Nothing re-checked the
//! approval against the PR's current state, so the task sat silently parked
//! in `doing` for ~10 days.
//!
//! The root cause is a *missing coupling*: Ash's structured `qa_agent`
//! approval and the lobster's mechanical AC-evidence check each pass or fail
//! independently, and neither invalidates a stale grant.
//!
//! This module is the **compute** half of the fix (design decision D1). It
//! invokes the *same* [`crate::ac_parsing::mechanical_evidence_failures`] the
//! lobster's `verify_delivery` already runs — deliberately not a second
//! implementation — and emits a JSON attestation recording what was actually
//! verified:
//!
//! ```json
//! {
//!   "prNumber": 836,
//!   "headSha": "deb991e0...",
//!   "acSectionDigest": "9f2c...",
//!   "failures": [],
//!   "verifiedAt": "2026-10-22T16:27:00Z"
//! }
//! ```
//!
//! The **enforce** half lives in the Tasks API route
//! (`POST /tasks/:id/approvals`): it refuses a `qa_agent` approval that has no
//! attestation matching the current PR head. Keeping enforcement at the API
//! choke point is what makes the gate structural — a future writer cannot
//! bypass it by forgetting to call something.
//!
//! ## Why two pinned values, not one
//!
//! A PR head SHA pins the *code*. The `39667e62` incident was a **body edit**,
//! which need not move the head SHA at all. Pinning only the SHA would leave
//! AC3 unable to fire for the exact failure mode that created this task. So
//! the attestation carries two structured fields:
//!
//! - `headSha` — pins the code. Catches "code moved under the approval".
//! - `acSectionDigest` — SHA-256 over the normalised AC-evidence section.
//!   Catches "evidence was rewritten under the approval".
//!
//! Together they close the incident class.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::api_client;
use crate::cli_utils;
use crate::pr_gates;
use crate::Task;

/// Structured attestation describing what a `qa_agent` approval verified.
///
/// Serialised camelCase to match the Tasks API's approval contract.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvidenceAttestation {
    /// The PR number the attestation was computed against.
    pr_number: u64,
    /// Head SHA of the PR at verification time — pins the *code* (AC2).
    head_sha: String,
    /// SHA-256 over the normalised AC-evidence section of the PR body.
    /// Pins the *evidence* and makes AC3 detectable for body-only edits.
    ac_section_digest: String,
    /// Mechanical evidence failures. Empty means the live check passed.
    /// A non-empty list must block the approval, not merely warn.
    failures: Vec<String>,
    /// RFC-3339 UTC timestamp the attestation was minted. Carried so the
    /// Tasks API can enforce its replay-guard TTL without trusting a
    /// caller-supplied clock.
    verified_at: String,
}

/// Compute the SHA-256 digest of a PR body's AC-evidence section.
///
/// Normalisation is deliberately narrow: CRLF is folded to LF and trailing
/// whitespace is stripped per line, so a re-wrap or a Windows-authored edit
/// does not trip AC3. Everything else — AC text, checkboxes, evidence
/// annotations, subsection headings — is preserved verbatim, because those
/// are exactly the bytes whose mutation the incident turned on.
///
/// Pinned to the *section*, not the whole body: editing a changelog line
/// above `## Acceptance Criteria` must not invalidate a QA approval, while
/// blanking the AC section to `"test body update"` must.
pub(crate) fn ac_section_digest(body: &str) -> String {
    let section = crate::ac_parsing::extract_ac_section(body);
    let mut normalized = String::with_capacity(section.len());
    for line in section.lines() {
        normalized.push_str(line.trim_end());
        normalized.push('\n');
    }
    // Trailing blank lines are formatting noise, not an evidence change.
    while normalized.ends_with("\n\n") {
        normalized.pop();
    }
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Fetch the PR number and current head SHA via `gh pr view`.
///
/// One call for both fields so the two can never be read from different
/// points in time — a torn read would let an approval pin a number from one
/// commit against a SHA from another.
fn pr_identity(url: &str) -> Result<(u64, String)> {
    let output = cli_utils::gh_command()
        .args(["pr", "view", url, "--json", "number,headRefOid"])
        .output()?;
    if !output.status.success() {
        return Err(anyhow!(
            "Could not read PR identity for {url}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let raw = String::from_utf8(output.stdout)?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|err| anyhow!("Unexpected `gh pr view` output for {url}: {err} ({raw:?})"))?;
    let pr_number = parsed
        .get("number")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| anyhow!("`gh pr view` returned no PR number for {url}: {raw:?}"))?;
    let head_sha = parsed
        .get("headRefOid")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("`gh pr view` returned no headRefOid for {url}: {raw:?}"))?
        .to_string();
    Ok((pr_number, head_sha))
}

/// Read the PR's current head SHA.
///
/// Split out from `build_attestation` because AC3's invalidation pass needs
/// the SHA alone — it re-hashes a body it has already fetched for the
/// mechanical gate, so paying for a second `pr_body` call per delivery PR
/// would buy nothing.
pub(crate) fn pr_head_sha(pr_url: &str) -> Result<(u64, String)> {
    pr_identity(pr_url)
}

/// Current UTC time as an RFC-3339 string.
///
/// Hand-rolled from `SystemTime` rather than adding `chrono`/`time` for a
/// single field; the civil-from-days conversion below is the standard
/// Howard Hinnant algorithm and is unit-tested below against known epochs.
pub(crate) fn utc_now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_utc_rfc3339(secs)
}

fn format_utc_rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // days since 1970-01-01 -> civil date (Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Build a live attestation for `pr_url` against the task's ACs.
///
/// Invokes `mechanical_evidence_failures` — the *same* function
/// `verify_delivery` runs — so the approval gate and the delivery gate can
/// never disagree about what "evidence" means (design §Ownership boundary).
pub(crate) fn build_attestation(task: &Task, pr_url: &str) -> Result<EvidenceAttestation> {
    let (pr_number, head_sha) = pr_identity(pr_url)?;
    let body = cli_utils::pr_body(pr_url)?;
    let pr_files = pr_gates::pr_changed_files(pr_url).map_err(|err| {
        anyhow!("Could not read changed files for PR {pr_url} ({pr_number}): {err}")
    })?;
    let task_acs =
        crate::ac_parsing::task_description_acs(&task.description.clone().unwrap_or_default());
    let failures = crate::ac_parsing::mechanical_evidence_failures(
        &task.id,
        &task_acs,
        &body,
        &pr_files,
    );

    Ok(EvidenceAttestation {
        pr_number,
        head_sha,
        ac_section_digest: ac_section_digest(&body),
        failures,
        verified_at: utc_now_rfc3339(),
    })
}

/// Resolve which PR the attestation should be computed against.
///
/// `explicit` wins when given. Otherwise the PR is derived from the task's
/// most recent `[implementer-prs]`/`[rowan-prs]` comment via the same
/// `latest_implementer_pr_urls` the delivery gate already uses, so "which PR
/// is this task's delivery PR" has exactly one implementation.
fn resolve_pr_url(task: &Task, explicit: Option<&str>) -> Result<String> {
    if let Some(url) = explicit.map(str::trim).filter(|url| !url.is_empty()) {
        return Ok(url.to_string());
    }
    let derived = crate::product_spec_parsing::latest_implementer_pr_urls(task);
    match derived.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(anyhow!(
            "Could not derive a PR to attest for task {}: no `[implementer-prs]` comment \
             names one. Pass --pr-url explicitly.",
            task.id
        )),
        many => Err(anyhow!(
            "Task {} names {} PRs in its latest `[implementer-prs]` comment ({}). \
             Refusing to guess which one to attest — pass --pr-url explicitly.",
            task.id,
            many.len(),
            many.join(", ")
        )),
    }
}

/// Dispatch handler for the `mechanical-evidence-check` subcommand.
///
/// Note for callers: `main()` returns `Ok(())` regardless of `failures`, so
/// the subcommand's *exit code* does not carry the verdict. A caller must
/// branch on the parsed `failures` array. Checking `$?` alone would approve
/// against a failing attestation and reproduce the exact incident this task
/// exists to close.
pub(crate) fn mechanical_evidence_check(
    base_url: &str,
    task_id: &str,
    pr_url: Option<&str>,
) -> Result<EvidenceAttestation> {
    let task: Task = api_client::api_get(base_url, &format!("/tasks/{task_id}"))?;
    let pr_url = resolve_pr_url(&task, pr_url)?;
    build_attestation(&task, &pr_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attestation_with(failures: Vec<String>) -> EvidenceAttestation {
        EvidenceAttestation {
            pr_number: 1,
            head_sha: "abc".to_string(),
            ac_section_digest: "def".to_string(),
            failures,
            verified_at: "2026-10-22T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn an_attestation_is_spendable_only_when_failures_is_empty() {
        // The Tasks API refuses any `qa_agent` approval whose attestation
        // carries a non-empty `failures` list, so an empty list is the only
        // shape that may be written against. This test states that contract
        // on the producing side rather than leaving it implicit.
        assert!(attestation_with(vec![]).failures.is_empty());
        assert!(!attestation_with(vec![
            "AC1 cites test file \"missing.rs\" but that file is not in the merged PR diff."
                .to_string()
        ])
        .failures
        .is_empty());
    }

    // ---- ac_section_digest ----

    #[test]
    fn ac_section_digest_is_stable_for_identical_bodies() {
        let body = "## Acceptance Criteria\n- [x] AC1: First (testID: 1)\n";
        assert_eq!(ac_section_digest(body), ac_section_digest(body));
    }

    #[test]
    fn ac_section_digest_changes_when_the_ac_section_is_rewritten() {
        // This is the `39667e62` incident in miniature: the AC evidence is
        // replaced. A SHA-of-head-only pin would miss this entirely.
        let before = "## Summary\nLead-in.\n\n## Acceptance Criteria\n- [x] AC1: First (testID: 1)\n";
        let after = "test body update";
        assert_ne!(ac_section_digest(before), ac_section_digest(after));
    }

    #[test]
    fn ac_section_digest_ignores_changes_above_the_ac_section() {
        // Editing a changelog line must not invalidate a QA approval — the
        // digest pins the evidence, not the whole body.
        let before = "## Summary\nOriginal lead-in.\n\n## Acceptance Criteria\n- [x] AC1: First (testID: 1)\n";
        let after = "## Summary\nRewritten lead-in.\n\n## Acceptance Criteria\n- [x] AC1: First (testID: 1)\n";
        assert_eq!(ac_section_digest(before), ac_section_digest(after));
    }

    #[test]
    fn ac_section_digest_tolerates_crlf_and_trailing_whitespace() {
        // Re-wrapping or a Windows-authored edit is formatting, not an
        // evidence regression; it must not trip AC3.
        let lf = "## Acceptance Criteria\n- [x] AC1: First (testID: 1)\n";
        let crlf = "## Acceptance Criteria\r\n- [x] AC1: First (testID: 1)   \r\n";
        assert_eq!(ac_section_digest(lf), ac_section_digest(crlf));
    }

    #[test]
    fn ac_section_digest_detects_an_evidence_annotation_swap() {
        // Same AC text, different evidence citation. This is precisely the
        // drift AC3 exists to catch.
        let before = "## Acceptance Criteria\n- [x] AC1: First (testID: real-test)\n";
        let after = "## Acceptance Criteria\n- [x] AC1: First (testID: fake-test)\n";
        assert_ne!(ac_section_digest(before), ac_section_digest(after));
    }

    #[test]
    fn ac_section_digest_detects_a_unchecked_to_checked_flip() {
        let before = "## Acceptance Criteria\n- [ ] AC1: First (testID: 1)\n";
        let after = "## Acceptance Criteria\n- [x] AC1: First (testID: 1)\n";
        assert_ne!(ac_section_digest(before), ac_section_digest(after));
    }

    // ---- timestamp formatting ----

    #[test]
    fn format_utc_rfc3339_renders_known_epochs() {
        assert_eq!(format_utc_rfc3339(0), "1970-01-01T00:00:00Z");
        // 2026-10-22T00:00:00Z
        assert_eq!(format_utc_rfc3339(1_792_627_200), "2026-10-22T00:00:00Z");
        // Leap day, to prove the civil-from-days conversion.
        assert_eq!(format_utc_rfc3339(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn utc_now_is_a_plausible_current_year() {
        // Guards against an obviously wrong clock (e.g. epoch zero default
        // from a failed `SystemTime` read), which would make every
        // attestation look stale to the Tasks API's TTL check.
        assert!(utc_now_rfc3339().starts_with("202"));
    }

    // ---- resolve_pr_url ----

    fn task_with_pr_comments(texts: &[&str]) -> Task {
        Task {
            comments: texts
                .iter()
                .map(|text| crate::TaskComment {
                    text: Some((*text).to_string()),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn an_explicit_pr_url_always_wins() {
        // An explicit PR is trusted as given: the caller is overriding the
        // derived value, which is the documented escape hatch for ambiguity.
        let task = task_with_pr_comments(&["[implementer-prs] https://github.com/o/r/pull/1"]);
        assert_eq!(
            resolve_pr_url(&task, Some("https://github.com/o/r/pull/999")).unwrap(),
            "https://github.com/o/r/pull/999"
        );
    }

    #[test]
    fn a_blank_explicit_pr_url_falls_back_to_the_derived_one() {
        // `--pr-url ""` must not silently attest against an empty string.
        let task = task_with_pr_comments(&["[implementer-prs] https://github.com/o/r/pull/1"]);
        assert_eq!(
            resolve_pr_url(&task, Some("   ")).unwrap(),
            "https://github.com/o/r/pull/1"
        );
    }

    #[test]
    fn a_single_implementer_pr_is_derived_when_no_pr_url_is_passed() {
        let task = task_with_pr_comments(&["[implementer-prs] https://github.com/o/r/pull/42"]);
        assert_eq!(
            resolve_pr_url(&task, None).unwrap(),
            "https://github.com/o/r/pull/42"
        );
    }

    #[test]
    fn the_most_recent_implementer_comment_wins_when_prs_were_replaced() {
        // The #803 -> replacement-PR shape: an older comment still names the
        // abandoned PR. Attesting against it would pin the wrong PR.
        let task = task_with_pr_comments(&[
            "[implementer-prs] https://github.com/o/r/pull/803",
            "[implementer-prs] https://github.com/o/r/pull/904",
        ]);
        assert_eq!(
            resolve_pr_url(&task, None).unwrap(),
            "https://github.com/o/r/pull/904"
        );
    }

    #[test]
    fn no_implementer_pr_is_an_error_rather_than_a_silent_pass() {
        let task = task_with_pr_comments(&["[openclaw-needed] nothing here"]);
        let err = resolve_pr_url(&task, None).unwrap_err().to_string();
        assert!(err.contains("no `[implementer-prs]` comment"), "got: {err}");
    }

    #[test]
    fn an_ambiguous_multi_pr_task_refuses_rather_than_guessing() {
        // Guessing here would mint an attestation against the wrong PR and
        // store a confidently-wrong pin — worse than refusing.
        let task = task_with_pr_comments(&[
            "[implementer-prs] https://github.com/o/r/pull/1 https://github.com/o/r/pull/2",
        ]);
        let err = resolve_pr_url(&task, None).unwrap_err().to_string();
        assert!(err.contains("Refusing to guess"), "got: {err}");
    }
}