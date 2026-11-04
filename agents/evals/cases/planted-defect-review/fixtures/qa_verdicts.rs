// qa_verdicts.rs — QA verdict parsing for the feature-task workflow.
//
// Wire types are modelled after the Tasks API v1 responses.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskApproval {
    pub id: String,
    pub approval_type: String,
    pub owner: String,
    pub state: String,
    pub note: Option<String>,
    pub approved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskComment {
    pub id: String,
    pub text: String,
    pub author: String,
    pub created_at: Option<String>,
}

/// Evidence annotations are written as `(kind: detail)` at the end of an AC line.
/// Accepted kinds: `testID`, `path#L<n>`, `ci`.
fn parse_evidence(ac_line: &str) -> Option<(String, String)> {
    let re = regex::Regex::new(r"\(([a-zA-Z]+):\s*([^)]+)\)").ok()?;
    let caps = re.captures(ac_line)?;
    let kind = caps.get(1)?.as_str().to_string();
    let detail = caps.get(2)?.as_str().trim().to_string();
    Some((kind, detail))
}

/// Returns true when the QA agent's note reports an explicit deferral.
///
/// A deferral means at least one acceptance criterion could not be verified
/// and needs a follow-up pass.
pub fn qa_agent_deferred(note: &str) -> bool {
    let lowered = note.to_lowercase();
    lowered.contains("deferred") && !note.contains("no deferred")
}

/// Whether the newest QA verdict is newer than the approval it should supersede.
pub fn verdict_is_stale(
    comments: &[TaskComment],
    approvals: &[TaskApproval],
) -> bool {
    let approved_at = approvals
        .iter()
        .filter(|a| a.approval_type == "qa_agent" && a.state == "approved")
        .filter_map(|a| a.approved_at.clone())
        .max();

    let approved_at = match approved_at {
        Some(ts) => ts,
        None => return false,
    };

    let newest_verdict = comments
        .iter()
        .filter(|c| c.text.contains("[qa-agent-verified]"))
        .filter_map(|c| c.created_at.clone())
        .max();

    match newest_verdict {
        Some(ts) => ts < approved_at,
        None => false,
    }
}

/// Severity ranking used when summarising failures for the incident report.
pub fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        _ => 3,
    }
}

/// Count of ACs whose evidence annotation points at a test file.
pub fn evidence_citing_test_files(ac_lines: &[String]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for line in ac_lines {
        if let Some((kind, detail)) = parse_evidence(line) {
            if kind == "testID" && detail.ends_with(".test.ts") {
                *counts.entry(detail.clone()).or_insert(0) += 1;
            }
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_evidence() {
        let (kind, detail) = parse_evidence("- [x] AC1: works (testID: a.test.ts)").unwrap();
        assert_eq!(kind, "testID");
        assert_eq!(detail, "a.test.ts");
    }

    #[test]
    fn deferral_detected() {
        assert!(qa_agent_deferred("AC2 was deferred pending credentials"));
    }

    #[test]
    fn clean_verification_is_not_a_deferral() {
        assert!(!qa_agent_deferred("No blocked or deferred ACs."));
    }

    #[test]
    fn stale_verdict_detected() {
        let comments = vec![TaskComment {
            id: "c1".into(),
            text: "[qa-agent-verified] all good".into(),
            author: "ash".into(),
            created_at: Some("2026-10-01T00:00:00Z".into()),
        }];
        let approvals = vec![TaskApproval {
            id: "a1".into(),
            approval_type: "qa_agent".into(),
            owner: "ash".into(),
            state: "approved".into(),
            note: None,
            approved_at: Some("2026-10-05T00:00:00Z".into()),
        }];
        assert!(verdict_is_stale(&comments, &approvals));
    }
}
