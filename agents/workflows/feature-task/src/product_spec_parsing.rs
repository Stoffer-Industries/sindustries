//! Product-spec, acceptance-criteria, and implementer-PR parsing for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3). This module owns
//! product-spec/reference parsing, structured resync records, deterministic
//! acceptance-criteria checksums, workstream parsing, tech-design signals,
//! and implementer-PR URL/review inspection. The CLI dispatch and shared task
//! envelope types remain in `main.rs`; no public CLI or API surface changes.

use anyhow::{Context, Result, anyhow};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use super::{ProductSpecRef, StageArgs, Task, Workstream, comment_text, gh_command};
use crate::{pr_gates, task_approvals};

pub(crate) fn product_spec(task: &Task) -> Option<ProductSpecRef> {
    parse_product_spec_ref(&task.description.clone().unwrap_or_default())
}

/// Parse the `**Spec:**` line from a task description. Tolerates inline
/// annotations in parens (`(...)`), brackets (`[...]`), backticks (`` `...` ``),
/// and trailing punctuation that isn't part of the path. Returns `None` only
/// when the line is genuinely missing or unparseable.
///
/// Used both for spec drift detection (where the strict form matters) and for
/// archival (where we want to survive legacy inline notes). The lenient form
/// here is intentionally bounded — exotic multi-line / malformed Spec values
/// still return `None` and surface via the existing `MissingSpecRef` path.
pub(crate) fn parse_product_spec_ref(text: &str) -> Option<ProductSpecRef> {
    let line_re = Regex::new(r"(?im)^\s*\*\*Spec:\*\*\s+(.+?)\s*$").unwrap();
    let cap = line_re.captures(text)?;
    let raw = cap.get(1)?.as_str();
    extract_spec_path_from_line(raw)
}

/// Extract a spec path from the raw text after `**Spec:**`. Strips:
///   - backtick-wrapped paths (`` `<path>` ``)
///   - trailing punctuation (`,`, `.`, `;`)
///   - one trailing inline annotation in `(...)`, `[...]`, or `` `...` `` form
///
/// Returns `None` when the residue is not a parseable spec path.
pub(crate) fn extract_spec_path_from_line(raw: &str) -> Option<ProductSpecRef> {
    let mut s = raw.trim();
    // Strip a single trailing inline annotation: "(...)", "[...]", or "`...`".
    if let Some(stripped) = strip_trailing_annotation(s) {
        s = stripped;
    }
    // Trim trailing punctuation first (so a trailing `,` doesn't fool the
    // backtick-wrap detector into seeing a backtick + comma residue).
    s = s.trim_end_matches([',', '.', ';']);
    // Strip optional backtick wrapping.
    if s.starts_with('`') && s.ends_with('`') && s.len() >= 2 {
        s = &s[1..s.len() - 1];
    }
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Reject obviously malformed (whitespace, control chars, multi-token) values.
    if s.chars().any(char::is_whitespace) {
        return None;
    }
    // Reject shell-quoted or otherwise bracketed residue we didn't strip.
    if matches!(s.chars().next(), Some('(') | Some('[') | Some('{'))
        || matches!(s.chars().last(), Some(')') | Some(']') | Some('}'))
    {
        return None;
    }
    // Accept .md or .spec.ts / _spec.ts paths only (matches the existing
    // strict regex's contract: `[._]spec\.ts` allows either `.` or `_`).
    let valid_suffix = s.ends_with(".md") || s.ends_with(".spec.ts") || s.ends_with("_spec.ts");
    if !valid_suffix {
        return None;
    }
    Some(ProductSpecRef {
        path: s.to_string(),
    })
}

pub(crate) fn strip_trailing_annotation(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    if bytes.last().copied() != Some(b')')
        && bytes.last().copied() != Some(b']')
        && bytes.last().copied() != Some(b'`')
    {
        return None;
    }
    let opener = match bytes.last().copied() {
        Some(b')') => b'(',
        Some(b']') => b'[',
        Some(b'`') => b'`',
        _ => return None,
    };
    // Find the matching opener at the same depth from the start. We don't
    // handle nested parens here; that's exactly the slippery-slope surface
    // the tech design calls out and we want to leave for human review.
    if let Some(open_idx) = s.find(opener as char) {
        return Some(s[..open_idx].trim_end());
    }
    None
}

pub(crate) fn brain_spec_approved_by_tom(text: &str) -> bool {
    Regex::new(r"(?m)^\s*-\s*\[[xX]\]\s+\*\*Approved by Tom\*\*\s*$")
        .unwrap()
        .is_match(text)
}

/// True if any task comment starts with `[spec-resynced]`.
///
/// Note: this check is deliberately permissive on presence — Quinn (or any
/// external writer) can post the comment at any time. The fluid drift gate
/// additionally verifies the comment carries a drift fingerprint that
/// matches the current drift episode (see
/// [`latest_resync_record_matches_drift`]). Without that secondary check
/// a stale `[spec-resynced]` from a previous episode could clear drift for
/// a brand new drift episode.
#[allow(
    dead_code,
    reason = "test-only helper reached from #[cfg(test)] modules; clippy's bin target cannot see those calls"
)]
pub(crate) fn spec_resync_signal_present(task: &Task) -> bool {
    !tagged_values(task, "[spec-resynced]").is_empty()
}

/// One parsed `[spec-resynced]` comment, including its bound checksum and
/// drift fingerprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResyncRecord {
    /// sha256 hex digest of the spec checksum that was set after this resync.
    pub(crate) checksum: String,
    /// sha256 hex digest of the failure list that defined the resynced drift
    /// episode. A new drift episode with different failures produces a
    /// different fingerprint and the previous record becomes stale.
    pub(crate) fingerprint: String,
    /// Pretty short summary line from the comment, used for diagnostics.
    pub(crate) summary: String,
}

/// Parse a single comment's body for `[spec-resynced]` + bound fields.
///
/// Recognised format (Lobster-authored):
/// ```text
/// [spec-resynced] <optional prose>
/// checksum=<64 hex>
/// driftFingerprint=<64 hex>
/// ```
/// The two key=value lines may appear in any order, before or after the
/// `[spec-resynced]` line. Returns `None` if the comment does not start with
/// `[spec-resynced]` or does not carry both fields (older or hand-written
/// comments are intentionally rejected so the stale-drift guard holds).
pub(crate) fn parse_resync_record(text: &str) -> Option<ResyncRecord> {
    let trimmed = text.trim();
    if !trimmed.starts_with("[spec-resynced]") {
        return None;
    }
    let mut checksum: Option<String> = None;
    let mut fingerprint: Option<String> = None;
    let mut summary = String::new();
    let summary_capture = Regex::new(r"(?m)^\[spec-resynced\]\s*(.*)$").unwrap();
    if let Some(cap) = summary_capture.captures(trimmed) {
        summary = cap[1].trim().to_string();
    }
    let kv = Regex::new(r"(?m)^\s*(checksum|driftFingerprint)\s*=\s*([a-fA-F0-9]+)\s*$").unwrap();
    for cap in kv.captures_iter(trimmed) {
        match &cap[1] {
            "checksum" => checksum = Some(cap[2].to_lowercase()),
            "driftFingerprint" => fingerprint = Some(cap[2].to_lowercase()),
            _ => {}
        }
    }
    let checksum = checksum?;
    if !ResyncRecord::is_sha256_hex(&checksum) {
        return None;
    }
    let fingerprint = fingerprint?;
    if !ResyncRecord::is_sha256_hex(&fingerprint) {
        return None;
    }
    Some(ResyncRecord {
        checksum,
        fingerprint,
        summary,
    })
}

impl ResyncRecord {
    fn is_sha256_hex(value: &str) -> bool {
        value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
    }
}

/// Walk comments newest-to-oldest and return the most recent
/// `[spec-resynced]` record parsed successfully.
pub(crate) fn latest_resync_record(task: &Task) -> Option<ResyncRecord> {
    for comment in task.comments.iter().rev() {
        let text = comment_text(comment);
        if let Some(record) = parse_resync_record(text) {
            return Some(record);
        }
    }
    None
}

/// True iff the most recent `[spec-resynced]` comment carries a
/// `driftFingerprint` that matches the current drift episode fingerprint
/// and a checksum whose stored value on the task still matches. Both legs
/// must hold — a fingerprint match alone is not enough because the spec
/// checksum can drift again after a resync without a fresh `[spec-resynced]`.
pub(crate) fn latest_resync_record_matches_drift(
    task: &Task,
    drift_fingerprint: &str,
    stored_checksum: Option<&str>,
) -> bool {
    let Some(record) = latest_resync_record(task) else {
        return false;
    };
    record.fingerprint == drift_fingerprint && stored_checksum == Some(&record.checksum)
}

/// Hash the failure list that defined the current drift episode. Returns a
/// lowercase sha256 hex digest. Stable across runs (failure order is
/// preserved verbatim), so it can be embedded in `[spec-resynced]` comments
/// to bind them to the episode.
pub(crate) fn drift_episode_fingerprint(failures: &[String]) -> String {
    let joined = failures.join("\n");
    let digest = Sha256::digest(joined.as_bytes());
    format!("{digest:x}")
}

/// True if the task is in the `open` status (uses brain spec as source of truth).
pub(crate) fn task_is_open(task: &Task) -> bool {
    task.status == "open"
}

pub(crate) fn resolve_product_spec_path(path: &str, repo: &Path, workspace_root: &Path) -> PathBuf {
    let spec = Path::new(path);
    if spec.is_absolute() {
        return spec.to_path_buf();
    }
    if path.starts_with("brain/") {
        if workspace_root.file_name().and_then(|name| name.to_str()) == Some("brain") {
            return workspace_root.join(path.trim_start_matches("brain/"));
        }
        return workspace_root.join(spec);
    }
    repo.join(spec)
}

pub(crate) fn workspace_root(args: &StageArgs) -> &Path {
    args.workspace_root
        .as_deref()
        .unwrap_or_else(|| Path::new("/Users/quinnstoffer/.openclaw/workspace"))
}

pub(crate) fn acceptance_criteria_text(text: &str) -> Vec<String> {
    let re = Regex::new(r"(?m)^\s*-\s*\[[ xX]\]\s+(.+)$").unwrap();
    re.captures_iter(text)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|criterion| criterion != "**Approved by Tom**")
        .collect()
}

pub(crate) fn spec_checksum(task: &Task) -> String {
    let acs = acceptance_criteria_text(&task.description.clone().unwrap_or_default());
    acceptance_criteria_checksum(&acs)
}

pub(crate) fn acceptance_criteria_checksum(acceptance_criteria: &[String]) -> String {
    let value = json!({ "acceptanceCriteria": acceptance_criteria });
    let canonical = canonical_json_bytes(&value);
    let digest = Sha256::digest(canonical);
    format!("{digest:x}")
}

pub(crate) fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(&canonical_json_value(value)).expect("serialize canonical JSON")
}

pub(crate) fn canonical_json_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json_value(value)))
                .collect();
            Value::Object(Map::from_iter(sorted))
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json_value).collect()),
        _ => value.clone(),
    }
}

pub(crate) fn spec_checksum_failures(task: &Task) -> Vec<String> {
    let Some(stored) = task.spec_checksum.as_deref() else {
        return vec![];
    };
    let current = spec_checksum(task);
    if current == stored {
        vec![]
    } else {
        vec![format!(
            "Spec drift detected — AC checksum changed since last approval. Task {} stored specChecksum `{stored}` but current AC checksum is `{current}`.",
            task.id
        )]
    }
}

pub(crate) fn workstreams(task: &Task) -> Vec<Workstream> {
    parse_workstreams(&task.description.clone().unwrap_or_default())
}

pub(crate) fn parse_workstreams(text: &str) -> Vec<Workstream> {
    let owner_section = parse_owner_workstreams(text);
    if !owner_section.is_empty() {
        return owner_section;
    }

    let heading = Regex::new(r"(?im)^\s{0,3}#{2,6}\s+(.+?)\s*$").unwrap();
    let mut matches: Vec<_> = heading.find_iter(text).collect();
    matches.retain(|m| m.as_str().to_lowercase().contains("workstream"));
    let strip_workstream_word = Regex::new(r"(?i)workstreams?").unwrap();
    matches
        .iter()
        .enumerate()
        .flat_map(|(idx, m)| {
            let start = m.end();
            let end = matches
                .get(idx + 1)
                .map(|n| n.start())
                .unwrap_or(text.len());
            let title = heading
                .captures(m.as_str())
                .and_then(|cap| cap.get(1))
                .map(|m| m.as_str().trim())
                .unwrap_or("Implementer");
            let owner = strip_workstream_word
                .replace_all(title, "")
                .trim_matches(|c: char| c.is_whitespace() || c == ':' || c == '-' || c == '/')
                .trim()
                .to_string();
            let body_text = text[start..end].trim();
            // A titled heading ("## Workstream: Rowan") names one workstream
            // directly. A bare plural heading ("## Workstreams") introduces a
            // bulleted list underneath, one workstream per top-level bullet —
            // same shape as the bold `**Workstreams**` section below.
            if owner.is_empty() {
                parse_bulleted_workstream_items(body_text)
            } else {
                vec![Workstream {
                    owner,
                    body: body_text.to_string(),
                }]
            }
        })
        .collect()
}

pub(crate) fn parse_owner_workstreams(text: &str) -> Vec<Workstream> {
    let section_re = Regex::new(r"(?im)^\s*\*\*Workstreams\*\*\s*$").unwrap();
    let Some(section_match) = section_re.find(text) else {
        return Vec::new();
    };
    let start = section_match.end();
    let after = &text[start..];
    let end_re = Regex::new(r"(?m)^\s*(?:#{1,6}\s+|\*\*[^*\n]+\*\*\s*$)").unwrap();
    let end = end_re
        .find(after)
        .map(|m| start + m.start())
        .unwrap_or(text.len());
    let section = &text[start..end];
    parse_bulleted_workstream_items(section)
}

/// Parse a workstreams section body into one `Workstream` per top-level
/// bullet (`- ...`). Handles both the legacy `- Owner: <name>` shape (owner
/// at the start of the bullet, often followed by indented `key: value`
/// continuation lines) and the `- **WS<N> — <title>** ... Owner: <name>; ...`
/// shape (owner anywhere in the bullet, or omitted entirely). Bullets with no
/// `Owner:` tag default to "Implementer".
pub(crate) fn parse_bulleted_workstream_items(section: &str) -> Vec<Workstream> {
    let item_re = Regex::new(r"(?m)^-\s+.*$").unwrap();
    let items: Vec<_> = item_re.find_iter(section).collect();
    if items.is_empty() {
        return Vec::new();
    }
    let owner_re = Regex::new(r"(?i)Owner:\s*([^;\n]+)").unwrap();
    items
        .iter()
        .enumerate()
        .map(|(idx, item_match)| {
            let body_start = item_match.start();
            let body_end = items
                .get(idx + 1)
                .map(|next| next.start())
                .unwrap_or(section.len());
            let body = section[body_start..body_end].trim().to_string();
            let owner = owner_re
                .captures(&body)
                .and_then(|cap| cap.get(1))
                .map(|m| {
                    m.as_str()
                        .trim()
                        .trim_end_matches(['.', ','])
                        .trim()
                        .to_string()
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Implementer".to_string());
            Workstream { owner, body }
        })
        .collect()
}

pub(crate) fn tagged_values(task: &Task, tag: &str) -> Vec<String> {
    task.comments
        .iter()
        .filter_map(|comment| {
            let text = comment_text(comment).trim();
            text.strip_prefix(tag).map(|rest| rest.trim().to_string())
        })
        .collect()
}

pub(crate) fn tech_design_url(task: &Task) -> Option<String> {
    tagged_values(task, "[tech-design]")
        .into_iter()
        .find(|v| !v.is_empty())
}

/// Structured TaskApproval rows are the sole source of tech-design approval.
pub(crate) fn tech_design_approved_structured(task: &Task) -> bool {
    task_approvals::task_approval_granted(task, "tech_design")
}

/// True if any task comment starts with `[tech-design-not-required]` followed
/// by a non-empty rationale. Used by the code-task lobster to allow code
/// tasks to skip the tech design gate when they are small enough not to
/// warrant one.
pub(crate) fn tech_design_waived(task: &Task) -> bool {
    tagged_values(task, "[tech-design-not-required]")
        .into_iter()
        .any(|v| !v.trim().is_empty())
}

pub(crate) fn implementer_pr_urls(task: &Task) -> Vec<String> {
    let re = Regex::new(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+").unwrap();
    let mut urls = Vec::new();
    // `[implementer-prs]` is the role-based tag. Keep `[rowan-prs]` as a
    // compatibility alias for existing tasks while they drain.
    for tag in ["[implementer-prs]", "[rowan-prs]"] {
        for value in tagged_values(task, tag) {
            for m in re.find_iter(&value) {
                let url = m.as_str().to_string();
                if !urls.contains(&url) {
                    urls.push(url);
                }
            }
        }
    }
    urls
}

/// The PR URL(s) named in the most recent `[implementer-prs]` (or legacy
/// `[rowan-prs]`) comment that names at least one parseable PR URL. This is
/// the authoritative "currently gating" PR set — unlike `implementer_pr_urls`
/// (the full historical union) or the old "highest PR number" heuristic,
/// which both broke on task 30251df0: PR #455 was opened right after #454
/// from the same branch as an accidental duplicate, then closed unmerged,
/// while #454 (lower number, opened first) was the one that actually merged.
/// Numeric-max treated #455 as "latest" and blocked `acceptance -> done`
/// forever even after Rowan and Quinn each posted a correcting
/// `[implementer-prs]` comment naming only #454 — a later correction comment
/// is the real signal of intent, not PR number magnitude.
pub(crate) fn latest_implementer_pr_urls(task: &Task) -> Vec<String> {
    let re = Regex::new(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+").unwrap();
    for comment in task.comments.iter().rev() {
        let text = comment_text(comment).trim();
        let rest = text
            .strip_prefix("[implementer-prs]")
            .or_else(|| text.strip_prefix("[rowan-prs]"));
        if let Some(rest) = rest {
            let urls: Vec<String> = re.find_iter(rest).map(|m| m.as_str().to_string()).collect();
            if !urls.is_empty() {
                return urls;
            }
        }
    }
    Vec::new()
}

#[allow(
    dead_code,
    reason = "test-only helper reached from #[cfg(test)] modules; clippy's bin target cannot see those calls"
)]
pub(crate) fn implementer_active_pr_urls_with<F>(task: &Task, inspect: F) -> Vec<String>
where
    F: Fn(&str) -> Result<pr_gates::ReviewState>,
{
    implementer_pr_urls(task)
        .into_iter()
        .filter(|url| !matches!(inspect(url), Ok(pr_gates::ReviewState::Merged)))
        .collect()
}

pub(crate) fn inspect_pr(url: &str) -> Result<pr_gates::ReviewState> {
    let output = gh_command()
        .args([
            "pr",
            "view",
            url,
            "--json",
            "reviewDecision,state,mergedAt,comments,reviews",
        ])
        .output()
        .context("run gh pr view")?;
    if !output.status.success() {
        return Err(anyhow!(
            String::from_utf8_lossy(&output.stderr).trim().to_string()
        ));
    }
    pr_gates::parse_github_review_state(&String::from_utf8(output.stdout)?)
}
