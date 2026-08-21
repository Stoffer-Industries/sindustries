//! AC parsing and validation for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W32 audit, finding: "Feature-task workflow
//! remains a 7,120-line Rust entrypoint"). The cluster is pure text parsing
//! — no I/O, no network, no state — so it can be exercised as a focused unit
//! without spinning up the full workflow surface.
//!
//! Public surface (all `pub(crate)` — only `main.rs` consumes these):
//! - `Evidence` / `AcEvidence` — parsed AC shapes
//! - `extract_ac_section` / `parse_evidence` / `strip_trailing_evidence` / `parse_ac_line` — parsing helpers
//! - `task_description_acs` / `unchecked_task_ac_labels` / `ac_labels_in_pr_body` / `ac_labels_needing_new_pr` — task + PR AC extraction
//! - `task_ac_vs_open_pr_failures` / `verify_pr_acs_failures` — lobster gate checks

use regex::Regex;
use std::collections::HashMap;

/// A file entry in a PR's diff. Mirrors the shape of `gh pr view --json files`
/// entries that `main.rs` surfaces to the gate layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrFile {
    pub(crate) filename: String,
}

/// Evidence annotation recognised on a feature-task PR AC line.
///
/// Priority order: `TestId` (e2e/unit, always prefer this) → `NotTested`
/// (explicit opt-out with reason) → `NotCode` / `Pr` (non-code ACs).
///
/// `file:` was removed — it encouraged citing implementation files instead of
/// test files. Use `testID` for any automated test, or `not tested` with a
/// substantive reason when automation is genuinely impractical.
///
/// All variants accept an optional emoji prefix before the keyword so PRs are
/// visually scannable at a glance (e.g. `(🧪 testID: 4)` ≡ `(testID: 4)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Evidence {
    /// Playwright (e2e) or unit test reference — the default. Use this first.
    /// e.g. `(🧪 testID: cal-10-day-render)`
    TestId(String),
    /// Explicit opt-out with a reason. Use only when automated testing is
    /// genuinely impractical. e.g. `(⚠️ not tested: drag requires manual browser QA)`
    NotTested { reason: String },
    /// AC fulfilled outside the codebase (doc, spec, config).
    /// e.g. `(📄 not code: updated docs/systems/content-scheduler.md)`
    NotCode { reason: String },
    /// Covered by another merged PR. e.g. `(🔗 pr: #216)`
    Pr { reference: String },
}

/// One parsed AC line from a PR body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcEvidence {
    pub(crate) ac_label: String,
    pub(crate) description: String,
    pub(crate) evidence: Option<Evidence>,
}

/// Extract the Acceptance Criteria section from a PR body.
///
/// Recognises `## Acceptance Criteria` and `## ACs` / `## AC` headings. When
/// no header is found, the whole body is returned so PRs without a section
/// still get validated.
pub(crate) fn extract_ac_section(body: &str) -> &str {
    // Header regex captures the leading hash run so we know the section level.
    let header_re =
        Regex::new(r"(?im)^\s{0,3}(#{2,6})\s+(?:Acceptance Criteria|ACs?)\s*:?\s*$").unwrap();
    let Some(header_cap) = header_re.captures(body) else {
        return body;
    };
    let header_match = header_cap.get(0).unwrap();
    let header_level = header_cap.get(1).unwrap().as_str().len();
    let start = header_match.end();
    let tail = &body[start..];
    // Same-or-higher heading ends the section. Deeper headings (`### …`,
    // `#### …`, …) are subsections and stay inside the AC section — that's
    // how multi-task PR bodies (one `## Acceptance Criteria` containing
    // several `### Task …` subheadings) keep their ACs together.
    let closer_pattern = format!(r"(?m)^\s{{0,3}}#{{1,{header_level}}}\s+\S");
    let next_re = Regex::new(&closer_pattern)
        .unwrap_or_else(|e| panic!("closer pattern compiles for header level {header_level}: {e}"));
    match next_re.find(tail) {
        Some(next) => &tail[..next.start()],
        None => tail,
    }
}

/// Recognise an evidence annotation that anchors the end of a string.
///
/// Each pattern allows an optional emoji (or any non-ASCII / non-letter) prefix
/// inside the parentheses so `(🧪 testID: 4)` and `(testID: 4)` are both valid.
/// The prefix is matched by `[^a-zA-Z)]*` which accepts emojis, spaces, and
/// punctuation but not letters or `)`.
pub(crate) fn parse_evidence(text: &str) -> Option<Evidence> {
    // (not tested: <reason>) and (not code: <reason>) come first so the reason may contain colons.
    let not_tested = Regex::new(r"\([^a-zA-Z)]*not tested:\s*([^)]+)\)\s*$").unwrap();
    if let Some(cap) = not_tested.captures(text) {
        return Some(Evidence::NotTested {
            reason: cap[1].trim().to_string(),
        });
    }
    let not_code = Regex::new(r"\([^a-zA-Z)]*not code:\s*([^)]+)\)\s*$").unwrap();
    if let Some(cap) = not_code.captures(text) {
        return Some(Evidence::NotCode {
            reason: cap[1].trim().to_string(),
        });
    }
    // (testID: <value>) — preferred evidence type
    let test_id = Regex::new(r"\([^a-zA-Z)]*testID:\s*([^)]+)\)\s*$").unwrap();
    if let Some(cap) = test_id.captures(text) {
        return Some(Evidence::TestId(cap[1].trim().to_string()));
    }
    // (pr: #<n> or url)
    let pr_ref = Regex::new(r"\([^a-zA-Z)]*pr:\s*([^)]+)\)\s*$").unwrap();
    if let Some(cap) = pr_ref.captures(text) {
        return Some(Evidence::Pr {
            reference: cap[1].trim().to_string(),
        });
    }
    None
}

/// Strip a trailing evidence annotation from a description string.
/// Returns the description with the trailing `(...)` evidence removed.
pub(crate) fn strip_trailing_evidence(text: &str) -> String {
    let re = Regex::new(r"\s+\([^a-zA-Z)]*(?:testID|not tested|not code|pr):\s*[^)]+\)\s*$")
        .unwrap();
    match re.find(text) {
        Some(m) => text[..m.start()].trim_end().to_string(),
        None => text.to_string(),
    }
}

/// Parse a single AC line. Returns `None` if the line isn't a checked AC.
pub(crate) fn parse_ac_line(line: &str) -> Option<AcEvidence> {
    let ac_re = Regex::new(r"^\s*-\s*\[[xX]\]\s+(AC\d+):\s*(.+)$").unwrap();
    let cap = ac_re.captures(line.trim())?;
    let ac_label = cap[1].to_string();
    let rest = cap[2].to_string();
    if let Some(ev) = parse_evidence(&rest) {
        let description = strip_trailing_evidence(&rest);
        Some(AcEvidence {
            ac_label,
            description,
            evidence: Some(ev),
        })
    } else {
        Some(AcEvidence {
            ac_label,
            description: rest,
            evidence: None,
        })
    }
}

/// Build failure messages for ACs that lack evidence. Empty list = all ACs
/// in the section carry a valid evidence annotation: `(testID: ...)`,
/// `(not tested: reason)`, `(not code: reason)`, or `(pr: #<n>)`.
/// Emojis are optional before the keyword.
pub(crate) fn verify_pr_acs_failures(body: &str) -> Vec<String> {
    let section = extract_ac_section(body);
    let mut failures = Vec::new();
    for line in section.lines() {
        if let Some(ac) = parse_ac_line(line) {
            if ac.evidence.is_none() {
                failures.push(format!(
                    "AC {} — missing evidence. Use `(🧪 testID: <id>)` for e2e/unit tests (preferred), `(⚠️ not tested: <reason>)` when automation is impractical, `(📄 not code: <reason>)` for non-code ACs, or `(🔗 pr: #<n>)` if covered by another merged PR.",
                    ac.ac_label
                ));
            }
        }
    }
    failures
}

/// Extract all ACs from a task description (both checked and unchecked), returning (label, text) pairs.
pub(crate) fn task_description_acs(description: &str) -> Vec<(String, String)> {
    let re = Regex::new(r"(?m)^\s*-\s*\[[ xX]\]\s+(AC\d+):\s*(.+)$").unwrap();
    re.captures_iter(description)
        .map(|cap| (cap[1].to_string(), strip_trailing_evidence(cap[2].trim())))
        .collect()
}

/// Returns the labels of ACs in the task description that are still unchecked (`- [ ] ACN:`).
pub(crate) fn unchecked_task_ac_labels(description: &str) -> Vec<String> {
    let re = Regex::new(r"(?m)^\s*-\s*\[ \]\s+(AC\d+):").unwrap();
    re.captures_iter(description)
        .map(|cap| cap[1].to_string())
        .collect()
}

/// Returns the labels of AC lines referenced anywhere in `body` (checked or unchecked).
/// Used to determine which ACs a PR covers — if an AC label appears in the PR body it was
/// included in that delivery, even if Tom hasn't checked it off the task yet.
pub(crate) fn ac_labels_in_pr_body(body: &str) -> Vec<String> {
    let re = Regex::new(r"(?m)^\s*-\s*\[[ xX]\]\s+(AC\d+):").unwrap();
    re.captures_iter(body)
        .map(|cap| cap[1].to_string())
        .collect()
}

/// Returns unchecked task ACs that are not mentioned in any of the provided merged PR bodies.
/// These are ACs Tom added after the PRs merged — they require a new PR before QA can verify.
pub(crate) fn ac_labels_needing_new_pr(unchecked: &[String], pr_bodies: &[String]) -> Vec<String> {
    unchecked
        .iter()
        .filter(|label| {
            !pr_bodies
                .iter()
                .any(|body| ac_labels_in_pr_body(body).contains(label))
        })
        .cloned()
        .collect()
}

/// Compare task description ACs against an open PR body at the doing → acceptance gate.
///
/// Fails if any task AC is missing from the PR, has altered text, or lacks a valid evidence annotation.
///
/// When the PR body's AC section contains one or more `### Task <id>` subsections,
/// only ACs in the subsection matching `task_id` are considered for this task's check.
/// Sibling subsections (other tasks in the same combined delivery) are not consulted,
/// so AC labels (`AC1`, `AC2`, ...) from different tasks don't collide in the
/// underlying HashMap. PR bodies without any `### Task <id>` heading fall back to
/// consuming the whole AC section — preserving the pre-#183 single-task behavior.
pub(crate) fn task_ac_vs_open_pr_failures(
    task_id: &str,
    task_acs: &[(String, String)],
    body: &str,
    pr_url: &str,
) -> Vec<String> {
    if task_acs.is_empty() {
        return vec![];
    }
    let section = extract_ac_section(body);
    // H3-or-deeper `Task <id>` subheadings carve the AC section into per-task
    // subsections. The first whitespace-delimited token after `Task` is the id.
    // Production task ids are full UUIDs (e.g. `e2e647b1-16d5-4b93-a92a-ac944b8bb48d`)
    // but the convention documented in `agents/skills/dev/pr-open/SKILL.md` uses
    // the 8-char branch-name short prefix in `### Task <id>` headings. Match
    // either form so a single `### Task 513b3b02 — …` or `### Task 513b3b02-uuid — …`
    // heading can identify the subsection.
    let subsection_re = Regex::new(r"(?m)^\s*#{3,}\s+Task\s+(\S+)").unwrap();
    let ac_re = Regex::new(r"(?m)^\s*-\s*\[([xX ])\]\s+(AC\d+):\s*(.+)$").unwrap();
    let task_short_id = task_id.split('-').next().unwrap_or(task_id);
    let mut pr_ac_map: HashMap<String, (String, Option<Evidence>)> = HashMap::new();
    let mut matching_section = true; // assume single-section (no `### Task`) until proven otherwise
    let mut saw_any_subsection = false;
    for line in section.lines() {
        if let Some(cap) = subsection_re.captures(line) {
            let captured = &cap[1];
            matching_section = captured == task_id || captured == task_short_id;
            saw_any_subsection = true;
            continue;
        }
        if saw_any_subsection && !matching_section {
            // AC line in a sibling task's subsection — ignore for this caller's
            // HashMap. Without scoping, two tasks' ACs would collide on labels
            // and the second subsection's text would silently overwrite the first.
            continue;
        }
        if let Some(cap) = ac_re.captures(line) {
            let label = cap[2].to_string();
            let raw = cap[3].trim().to_string();
            let evidence = parse_evidence(&raw);
            let text = strip_trailing_evidence(&raw);
            pr_ac_map.insert(label, (text, evidence));
        }
    }
    let mut failures = Vec::new();
    for (label, task_text) in task_acs {
        match pr_ac_map.get(label) {
            None => failures.push(format!(
                "{label} missing from open PR {pr_url} — include all task ACs with evidence."
            )),
            Some((pr_text, evidence)) => {
                if task_text.to_lowercase() != pr_text.to_lowercase() {
                    failures.push(format!(
                        "{label} text altered — task: \"{task_text}\", PR: \"{pr_text}\". Copy the AC text verbatim from the task description."
                    ));
                }
                if evidence.is_none() {
                    failures.push(format!(
                        "{label} — missing evidence. Append `(🧪 testID: <id>)` for e2e/unit tests (preferred), `(⚠️ not tested: <reason>)` when automation is impractical, `(📄 not code: <reason>)` for non-code ACs, or `(🔗 pr: #<n>)` if covered by another merged PR. Emojis are optional but encouraged."
                    ));
                }
            }
        }
    }
    failures
}

// ---------------------------------------------------------------------------
// Mechanical evidence checks (task 5e35dc25 PR #1).
//
// These run the deterministic file-existence + test-execution checks against
// each per-task AC's parsed `Evidence`. Failures here surface as the
// `[feature-task-progress-checklist]` failures that the existing
// `verify_delivery` path already aggregates — Ash's `qa_agent` should not
// run until these pass. The mechanical checks are deliberately a strict
// superset of Ash's `verify.ts` behaviour so the lobster's gate is at
// least as strict as the agent's was.

// Test runner abstraction — injectable so unit tests can fake pass/fail
// outcomes without shelling out to `pnpm`. The production impl
// (`PnpmTestRunner` in `main.rs`) shells out to `pnpm test --filter <name>`.
pub(crate) trait TestRunner {
    fn run(&self, test_name: &str) -> Result<TestOutcome, String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TestOutcome {
    pub exit_code: i32,
    #[allow(dead_code)]
    pub stdout: String,
    #[allow(dead_code)]
    pub stderr: String,
}

/// Mechanical evidence check failures for the `doing -> acceptance` gate.
///
/// Returns one failure string per AC whose evidence is not mechanically
/// satisfied (cited file not in the PR diff, cited test fails), or an
/// empty Vec if every AC's evidence passes. Subsection scoping mirrors
/// `task_ac_vs_open_pr_failures`: when the PR body contains
/// `### Task <id>` subheadings, only the current task's subsection is
/// checked. Sibling subsections are skipped.
pub(crate) fn mechanical_evidence_failures(
    task_id: &str,
    task_acs: &[(String, String)],
    body: &str,
    pr_files: &[String],
    test_runner: &dyn TestRunner,
) -> Vec<String> {
    if task_acs.is_empty() {
        return vec![];
    }
    let section = extract_ac_section(body);
    let subsection_re = Regex::new(r"(?m)^\s*#{3,}\s+Task\s+(\S+)").unwrap();
    let ac_re = Regex::new(r"(?m)^\s*-\s*\[[xX]\]\s+(AC\d+):\s*(.+)$").unwrap();
    let task_short_id = task_id.split('-').next().unwrap_or(task_id);
    let mut pr_ac_evidence: HashMap<String, Option<Evidence>> = HashMap::new();
    let mut matching_section = true; // assume single-section until proven otherwise
    let mut saw_any_subsection = false;
    for line in section.lines() {
        if let Some(cap) = subsection_re.captures(line) {
            let captured = &cap[1];
            matching_section = captured == task_id || captured == task_short_id;
            saw_any_subsection = true;
            continue;
        }
        if saw_any_subsection && !matching_section {
            continue;
        }
        if let Some(cap) = ac_re.captures(line) {
            let label = cap[1].to_string();
            let raw = cap[2].trim().to_string();
            pr_ac_evidence.insert(label, parse_evidence(&raw));
        }
    }

    // File-path-shape detector for `TestId` values (matches Ash's
    // `verify.ts:checkTestId` at line 101 ported verbatim).
    let test_file_re = Regex::new(r"\.(test|spec)\.[mc]?[jt]sx?$").unwrap();
    let path_in_pr = |path: &str, files: &[String]| -> bool {
        files
            .iter()
            .any(|f| f == path || f.ends_with(&format!("/{path}")))
    };

    let mut failures = Vec::new();
    for (label, _task_text) in task_acs {
        let evidence = match pr_ac_evidence.get(label) {
            Some(ev) => ev,
            // AC missing from PR — handled by `task_ac_vs_open_pr_failures`.
            None => continue,
        };
        let evidence = match evidence {
            Some(e) => e,
            // AC lacks evidence — handled by `verify_pr_acs_failures`.
            None => continue,
        };
        match evidence {
            Evidence::TestId(test_id) => {
                if test_file_re.is_match(test_id) {
                    // File path: must be in the PR diff.
                    if !path_in_pr(test_id, pr_files) {
                        failures.push(format!(
                            "{label} cites test file \"{test_id}\" but that file is not in the merged PR diff."
                        ));
                    }
                } else {
                    // Test name: run it via the test runner.
                    match test_runner.run(test_id) {
                        Ok(outcome) => {
                            if outcome.exit_code != 0 {
                                failures.push(format!(
                                    "{label} cites test \"{test_id}\" but the test failed (exit {}) \u{2014} fix the test before shipping.",
                                    outcome.exit_code
                                ));
                            }
                        }
                        Err(e) => {
                            failures.push(format!(
                                "{label} cites test \"{test_id}\" but the test runner could not execute it: {e}"
                            ));
                        }
                    }
                }
            }
            Evidence::NotTested { reason } => {
                // The reason may be a file path or free text. If it looks
                // like a file path (contains a slash or has a test/spec
                // extension), check it's in the diff. Otherwise pass.
                if reason.contains('/') || test_file_re.is_match(reason) {
                    if !path_in_pr(reason, pr_files) {
                        failures.push(format!(
                            "{label} cites not-tested file \"{reason}\" but that file is not in the merged PR diff."
                        ));
                    }
                }
                // Free-text reasons pass — no mechanical surface.
            }
            Evidence::NotCode { reason: _ } => {
                // Non-code ACs always pass — no file or test surface.
            }
            Evidence::Pr { reference } => {
                // PR reference: `#<n>` or URL is a sibling cross-reference
                // and passes structurally. Anything else is treated as a
                // file path and must be in the diff.
                if reference.starts_with('#')
                    || reference.starts_with("http://")
                    || reference.starts_with("https://")
                {
                    // Sibling PR cross-reference — pass.
                } else if !path_in_pr(&reference, pr_files) {
                    failures.push(format!(
                        "{label} cites pr reference \"{reference}\" but that file is not in the merged PR diff."
                    ));
                }
            }
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_evidence ----

    #[test]
    fn parse_evidence_recognises_test_id() {
        assert_eq!(
            parse_evidence("foo (testID: 1234)"),
            Some(Evidence::TestId("1234".to_string()))
        );
    }

    #[test]
    fn parse_evidence_rejects_file_annotation() {
        // file: was removed — it must not be recognised as valid evidence.
        assert_eq!(parse_evidence("bar (file: apps/tasks/src/X.jsx:42)"), None);
        assert_eq!(
            parse_evidence("bar (file: src/main.rs: some_test_name)"),
            None
        );
    }

    #[test]
    fn parse_evidence_recognises_emoji_prefix_test_id() {
        assert_eq!(
            parse_evidence("foo (🧪 testID: cal-10-day-render)"),
            Some(Evidence::TestId("cal-10-day-render".to_string()))
        );
    }

    #[test]
    fn parse_evidence_recognises_emoji_prefix_not_tested() {
        assert_eq!(
            parse_evidence("foo (⚠️ not tested: drag requires manual browser QA)"),
            Some(Evidence::NotTested {
                reason: "drag requires manual browser QA".to_string()
            })
        );
    }

    #[test]
    fn parse_evidence_recognises_emoji_prefix_not_code() {
        assert_eq!(
            parse_evidence("foo (📄 not code: updated docs/systems/content-scheduler.md)"),
            Some(Evidence::NotCode {
                reason: "updated docs/systems/content-scheduler.md".to_string()
            })
        );
    }

    #[test]
    fn parse_evidence_recognises_emoji_prefix_pr() {
        assert_eq!(
            parse_evidence("foo (🔗 pr: #216)"),
            Some(Evidence::Pr {
                reference: "#216".to_string()
            })
        );
    }

    #[test]
    fn parse_evidence_recognises_not_tested_reason() {
        assert_eq!(
            parse_evidence("baz (not tested: requires manual click flow)"),
            Some(Evidence::NotTested {
                reason: "requires manual click flow".to_string()
            })
        );
    }

    #[test]
    fn parse_evidence_rejects_bare_not_tested() {
        assert_eq!(parse_evidence("qux (not tested)"), None);
        assert_eq!(parse_evidence("quux"), None);
    }

    #[test]
    fn parse_evidence_recognises_not_code() {
        assert_eq!(
            parse_evidence("foo (not code: updated brain/bookmarks/specs/foo.md)"),
            Some(Evidence::NotCode {
                reason: "updated brain/bookmarks/specs/foo.md".to_string()
            })
        );
    }

    #[test]
    fn strip_trailing_evidence_strips_not_code() {
        assert_eq!(
            strip_trailing_evidence("AC text (not code: updated brain/foo.md)"),
            "AC text"
        );
    }

    // ---- parse_ac_line ----

    #[test]
    fn parse_ac_line_extracts_label_description_evidence() {
        let ac = parse_ac_line("- [x] AC1: Build it (testID: 7)").unwrap();
        assert_eq!(ac.ac_label, "AC1");
        assert_eq!(ac.description, "Build it");
        assert_eq!(ac.evidence, Some(Evidence::TestId("7".to_string())));
    }

    #[test]
    fn parse_ac_line_ignores_unchecked_lines() {
        assert!(parse_ac_line("- [ ] AC2: Unchecked (testID: 1)").is_none());
    }

    #[test]
    fn parse_ac_line_ignores_non_ac_bullets() {
        assert!(parse_ac_line("- [x] `npm test`").is_none());
        assert!(parse_ac_line("- [x] Some other bullet").is_none());
    }

    #[test]
    fn parse_ac_line_handles_description_with_parens() {
        let ac = parse_ac_line("- [x] AC1: Allow (paren) text (testID: 1)").unwrap();
        assert_eq!(ac.ac_label, "AC1");
        assert_eq!(ac.description, "Allow (paren) text");
        assert_eq!(ac.evidence, Some(Evidence::TestId("1".to_string())));
    }

    // ---- extract_ac_section ----

    #[test]
    fn extract_ac_section_returns_section_when_header_present() {
        let body = "## Summary\nFoo.\n\n## Acceptance Criteria\n- [x] AC1: First\n- [x] AC2: Second (testID: 1)\n\n## Test plan\n- [x] run tests\n";
        let section = extract_ac_section(body);
        assert!(section.contains("AC1: First"));
        assert!(section.contains("AC2: Second"));
        assert!(!section.contains("Test plan"));
        assert!(!section.contains("run tests"));
    }

    #[test]
    fn extract_ac_section_falls_back_to_whole_body() {
        let body = "- [x] AC1: First (testID: 1)";
        let section = extract_ac_section(body);
        assert!(section.contains("AC1: First"));
    }

    #[test]
    fn extract_ac_section_handles_acs_header() {
        let body = "## ACs\n- [x] AC1: First (testID: 1)\n";
        let section = extract_ac_section(body);
        assert!(section.contains("AC1: First"));
    }

    #[test]
    fn extract_ac_section_preserves_h3_subheadings_inside_h2_section() {
        // Regression for the lobster bug: a `### Task …` heading inside
        // `## Acceptance Criteria` (e.g., PRs that ship multiple tasks at
        // once) used to close the AC section prematurely, dropping every AC
        // in the trailing subheading. Same-or-higher headings (h2/h1) must
        // still end the section.
        let body = "\
## Summary
Lead-in.

## Acceptance Criteria

### Task alpha — Pulse shell
- [x] AC1: First alpha AC (testID: 1)
- [x] AC2: Second alpha AC (testID: 2)

### Task beta — Flow metrics dashboard
- [x] AC1: First beta AC (testID: 3)
- [x] AC2: Second beta AC (testID: 4)

## Test plan
- [x] run tests
";
        let section = extract_ac_section(body);
        // All four ACs across both subheadings must survive.
        assert!(section.contains("First alpha AC"));
        assert!(section.contains("Second alpha AC"));
        assert!(section.contains("First beta AC"));
        assert!(section.contains("Second beta AC"));
        // The h3 subheadings themselves should also be preserved (they
        // belong to the AC section body).
        assert!(section.contains("### Task alpha"));
        assert!(section.contains("### Task beta"));
        // The next h2 closes the section as before.
        assert!(!section.contains("Test plan"));
        assert!(!section.contains("run tests"));
    }

    #[test]
    fn extract_ac_section_stops_at_h2_or_higher() {
        // h1 headings (like a stray top-level divider inside the body)
        // must also close the section.
        let body = "\
## Acceptance Criteria

### Subsection
- [x] AC1: kept (testID: 1)

# Conclusion

- [x] AC2: dropped (testID: 2)
";
        let section = extract_ac_section(body);
        assert!(section.contains("AC1: kept"));
        assert!(!section.contains("AC2: dropped"));
    }

    // ---- verify_pr_acs_failures ----

    #[test]
    fn verify_pr_acs_passes_with_not_code_evidence() {
        let body = "## Acceptance Criteria\n- [x] AC1: Spec updated (not code: updated brain/bookmarks/specs/foo.md)\n";
        assert!(verify_pr_acs_failures(body).is_empty());
    }

    #[test]
    fn verify_pr_acs_error_message_mentions_not_code() {
        let body = "## Acceptance Criteria\n- [x] AC1: No evidence here\n";
        let failures = verify_pr_acs_failures(body);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("not code"));
    }

    #[test]
    fn verify_pr_acs_passes_when_all_have_evidence() {
        let body = "## Acceptance Criteria\n- [x] AC1: Foo (🧪 testID: 1)\n- [x] AC2: Bar (not tested: design tokens)\n- [x] AC3: Baz (📄 not code: updated docs/systems/foo.md)\n";
        assert!(verify_pr_acs_failures(body).is_empty());
    }

    #[test]
    fn verify_pr_acs_blocks_one_missing_evidence() {
        let body = "## Acceptance Criteria\n- [x] AC1: Foo (testID: 1)\n- [x] AC2: Bar\n- [x] AC3: Baz (testID: 3)\n";
        let failures = verify_pr_acs_failures(body);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("AC2"));
        assert!(failures[0].contains("missing evidence"));
    }

    #[test]
    fn verify_pr_acs_blocks_all_missing_evidence() {
        let body = "## Acceptance Criteria\n- [x] AC1: Foo\n- [x] AC2: Bar\n";
        let failures = verify_pr_acs_failures(body);
        assert_eq!(failures.len(), 2);
        assert!(failures[0].contains("AC1"));
        assert!(failures[1].contains("AC2"));
    }

    #[test]
    fn verify_pr_acs_ignores_unchecked_lines() {
        let body = "## Acceptance Criteria\n- [ ] AC1: Pending\n- [x] AC2: Done (testID: 1)\n";
        assert!(verify_pr_acs_failures(body).is_empty());
    }

    #[test]
    fn verify_pr_acs_skips_other_sections() {
        let body = "## Test plan\n- [x] AC1: Not really an AC\n\n## Acceptance Criteria\n- [x] AC1: Real AC (testID: 1)\n";
        assert!(verify_pr_acs_failures(body).is_empty());
    }

    // ---- task_description_acs / unchecked_task_ac_labels / ac_labels_in_pr_body ----

    #[test]
    fn unchecked_task_ac_labels_returns_only_unchecked() {
        let desc = "## Acceptance Criteria\n- [x] AC1: Done\n- [ ] AC2: Pending\n- [X] AC3: Also done\n- [ ] AC4: Also pending\n";
        let labels = unchecked_task_ac_labels(desc);
        assert_eq!(labels, vec!["AC2".to_string(), "AC4".to_string()]);
    }

    #[test]
    fn unchecked_task_ac_labels_empty_when_all_checked() {
        let desc = "## Acceptance Criteria\n- [x] AC1: Done\n- [X] AC2: Also done\n";
        assert!(unchecked_task_ac_labels(desc).is_empty());
    }

    #[test]
    fn ac_labels_in_pr_body_finds_all_labels() {
        let body = "## Acceptance Criteria\n- [x] AC1: Done (testID: 1)\n- [ ] AC2: Not done\n- [X] AC5: Also done\n";
        let labels = ac_labels_in_pr_body(body);
        assert_eq!(
            labels,
            vec!["AC1".to_string(), "AC2".to_string(), "AC5".to_string()]
        );
    }

    #[test]
    fn ac_labels_needing_new_pr_returns_uncovered_acs() {
        // AC1 unchecked but in PR body (mid-QA) — no new PR needed
        // AC5 unchecked and NOT in any PR body — new PR needed
        let unchecked = vec!["AC1".to_string(), "AC5".to_string()];
        let pr_body1 =
            "## Acceptance Criteria\n- [x] AC1: Done (testID: 1)\n- [x] AC2: Done (testID: 2)\n"
                .to_string();
        let needs_pr = ac_labels_needing_new_pr(&unchecked, &[pr_body1]);
        assert_eq!(needs_pr, vec!["AC5".to_string()]);
    }

    #[test]
    fn ac_labels_needing_new_pr_empty_when_all_covered() {
        let unchecked = vec!["AC1".to_string(), "AC2".to_string()];
        let pr_body1 =
            "## Acceptance Criteria\n- [x] AC1: Done (testID: 1)\n- [x] AC2: Done (testID: 2)\n"
                .to_string();
        assert!(ac_labels_needing_new_pr(&unchecked, &[pr_body1]).is_empty());
    }

    #[test]
    fn task_description_acs_extracts_both_checked_and_unchecked() {
        let desc =
            "**AC:**\n- [x] AC1: First thing\n- [ ] AC2: Second thing\n- [X] AC3: Third thing\n";
        let acs = task_description_acs(desc);
        assert_eq!(acs.len(), 3);
        assert_eq!(acs[0], ("AC1".to_string(), "First thing".to_string()));
        assert_eq!(acs[1], ("AC2".to_string(), "Second thing".to_string()));
        assert_eq!(acs[2], ("AC3".to_string(), "Third thing".to_string()));
    }

    #[test]
    fn task_description_acs_empty_when_no_acs() {
        assert!(task_description_acs("No ACs here.").is_empty());
    }

    #[test]
    fn task_description_acs_strips_trailing_evidence() {
        let desc = "- [x] AC1: Do the thing (🧪 testID: my-test)\n- [ ] AC2: Other thing (⚠️ not tested: manual)\n";
        let acs = task_description_acs(desc);
        assert_eq!(acs[0], ("AC1".to_string(), "Do the thing".to_string()));
        assert_eq!(acs[1], ("AC2".to_string(), "Other thing".to_string()));
    }

    // ---- task_ac_vs_open_pr_failures ----

    #[test]
    fn task_ac_vs_open_pr_passes_when_all_acs_match_with_evidence() {
        let task_acs = vec![
            ("AC1".to_string(), "Do the thing".to_string()),
            ("AC2".to_string(), "Verify the result".to_string()),
        ];
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Do the thing (testID: test_do_thing)\n\
            - [x] AC2: Verify the result (not tested: manual verification)\n";
        let failures = task_ac_vs_open_pr_failures(
            "alpha",
            &task_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert!(
            failures.is_empty(),
            "expected no failures, got: {failures:?}"
        );
    }

    #[test]
    fn task_ac_vs_open_pr_blocks_on_text_mismatch() {
        let task_acs = vec![("AC1".to_string(), "Do the thing".to_string())];
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Do the other thing (testID: test_do_thing)\n";
        let failures = task_ac_vs_open_pr_failures(
            "alpha",
            &task_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("text altered"), "got: {}", failures[0]);
    }

    #[test]
    fn task_ac_vs_open_pr_blocks_on_missing_ac() {
        let task_acs = vec![
            ("AC1".to_string(), "Do the thing".to_string()),
            ("AC2".to_string(), "Extra requirement".to_string()),
        ];
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Do the thing (testID: test_do_thing)\n";
        let failures = task_ac_vs_open_pr_failures(
            "alpha",
            &task_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert_eq!(failures.len(), 1);
        assert!(
            failures[0].contains("AC2") && failures[0].contains("missing"),
            "got: {}",
            failures[0]
        );
    }

    #[test]
    fn task_ac_vs_open_pr_blocks_on_missing_evidence() {
        let task_acs = vec![("AC1".to_string(), "Do the thing".to_string())];
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Do the thing\n";
        let failures = task_ac_vs_open_pr_failures(
            "alpha",
            &task_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert_eq!(failures.len(), 1);
        assert!(
            failures[0].contains("missing evidence"),
            "got: {}",
            failures[0]
        );
    }

    #[test]
    fn task_ac_vs_open_pr_handles_multi_task_body() {
        // Regression for the lobster bug: when a PR body's AC section contains
        // two `### Task <id>` subsections, each task's HashMap should only see
        // its own subsection. Without scoping, AC labels collide and the
        // second subsection's text silently overwrites the first.
        let body = "## Acceptance Criteria\n\
            ### Task alpha — Pulse shell scaffold\n\
            - [x] AC1: Pulse loads at a single URL and renders a persistent tab bar (testID: pulse-shells-tab-bar)\n\
            - [x] AC2: Tab bar shows Tasks, Bookmarks, and Flow metrics tabs (testID: pulse-shells-tabs-render)\n\
            ### Task beta — Flow metrics dashboard\n\
            - [x] AC1: Dashboard shows cycle time (median and p90) for tasks completed (testID: flow-metrics-cycle-time)\n\
            - [x] AC2: Dashboard is reachable from the Flow metrics tab (testID: flow-metrics-reachable)\n";
        let alpha_acs = vec![
            (
                "AC1".to_string(),
                "Pulse loads at a single URL and renders a persistent tab bar".to_string(),
            ),
            (
                "AC2".to_string(),
                "Tab bar shows Tasks, Bookmarks, and Flow metrics tabs".to_string(),
            ),
        ];
        let beta_acs = vec![
            (
                "AC1".to_string(),
                "Dashboard shows cycle time (median and p90) for tasks completed".to_string(),
            ),
            (
                "AC2".to_string(),
                "Dashboard is reachable from the Flow metrics tab".to_string(),
            ),
        ];
        let alpha_failures = task_ac_vs_open_pr_failures(
            "alpha",
            &alpha_acs,
            body,
            "https://github.com/org/repo/pull/185",
        );
        assert!(
            alpha_failures.is_empty(),
            "expected alpha to pass, got: {alpha_failures:?}"
        );
        let beta_failures = task_ac_vs_open_pr_failures(
            "beta",
            &beta_acs,
            body,
            "https://github.com/org/repo/pull/185",
        );
        assert!(
            beta_failures.is_empty(),
            "expected beta to pass, got: {beta_failures:?}"
        );
    }

    #[test]
    fn task_ac_vs_open_pr_falls_back_when_no_subsection_heading() {
        // Single-task PR body — no `### Task <id>` headings anywhere. The whole
        // AC section is implicitly one subsection for this task, matching the
        // pre-#183 behavior that single-task deliveries relied on.
        let task_acs = vec![
            ("AC1".to_string(), "Do the thing".to_string()),
            ("AC2".to_string(), "Verify the result".to_string()),
        ];
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Do the thing (testID: test_do_thing)\n\
            - [x] AC2: Verify the result (not tested: manual verification)\n";
        let failures = task_ac_vs_open_pr_failures(
            "anything",
            &task_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert!(
            failures.is_empty(),
            "expected no failures, got: {failures:?}"
        );
    }

    #[test]
    fn task_ac_vs_open_pr_reports_missing_when_no_matching_subsection() {
        // PR body has a `### Task <other_id>` subsection but no subsection for
        // this task's id. The function should report every task AC as missing
        // rather than silently passing or borrowing from the sibling subsection.
        let task_acs = vec![
            ("AC1".to_string(), "Do the thing".to_string()),
            ("AC2".to_string(), "Do the other thing".to_string()),
        ];
        let body = "## Acceptance Criteria\n\
            ### Task other — something else\n\
            - [x] AC1: Other-task text (testID: test_other)\n\
            - [x] AC2: Other-task second thing (testID: test_other_two)\n";
        let failures = task_ac_vs_open_pr_failures(
            "alpha",
            &task_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert_eq!(failures.len(), 2, "got: {failures:?}");
        assert!(
            failures.iter().all(|f| f.contains("missing")),
            "expected missing-AC failures, got: {failures:?}"
        );
        assert!(
            failures.iter().any(|f| f.contains("AC1")),
            "expected AC1 in failures, got: {failures:?}"
        );
        assert!(
            failures.iter().any(|f| f.contains("AC2")),
            "expected AC2 in failures, got: {failures:?}"
        );
    }

    #[test]
    fn task_ac_vs_open_pr_isolates_text_per_subsection() {
        // Same `AC1` label appears in both subsections with intentionally
        // different texts. Calling for task `alpha` should match alpha's text,
        // calling for task `beta` should match beta's — proving there's no
        // collision leaking across subsections.
        let body = "## Acceptance Criteria\n\
            ### Task alpha\n\
            - [x] AC1: Alpha-specific AC1 text (testID: alpha_ac1)\n\
            ### Task beta\n\
            - [x] AC1: Beta-specific AC1 text (testID: beta_ac1)\n";
        let alpha_acs = vec![("AC1".to_string(), "Alpha-specific AC1 text".to_string())];
        let beta_acs = vec![("AC1".to_string(), "Beta-specific AC1 text".to_string())];

        let alpha_failures = task_ac_vs_open_pr_failures(
            "alpha",
            &alpha_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert!(
            alpha_failures.is_empty(),
            "expected alpha to match its own AC1, got: {alpha_failures:?}"
        );

        let beta_failures = task_ac_vs_open_pr_failures(
            "beta",
            &beta_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert!(
            beta_failures.is_empty(),
            "expected beta to match its own AC1, got: {beta_failures:?}"
        );

        // Cross-check: if a caller is keyed on `alpha` but the task description
        // contains beta's text, the function should report a text-mismatch
        // failure rather than borrowing alpha's text. This proves the HashMap
        // is correctly scoped.
        let cross_acs = vec![("AC1".to_string(), "Beta-specific AC1 text".to_string())];
        let cross_failures = task_ac_vs_open_pr_failures(
            "alpha",
            &cross_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert_eq!(
            cross_failures.len(),
            1,
            "expected one cross-subsection mismatch, got: {cross_failures:?}"
        );
        assert!(
            cross_failures[0].contains("text altered"),
            "got: {}",
            cross_failures[0]
        );
    }

    #[test]
    fn task_ac_vs_open_pr_matches_full_uuid_section_heading() {
        // Production task ids are full UUIDs (`e2e647b1-16d5-4b93-a92a-ac944b8bb48d`)
        // but the PR body convention in agents/skills/dev/pr-open/SKILL.md uses the
        // 8-char short prefix in `### Task <id>` headings. The function must match
        // either form, otherwise the lobster's `verify-delivery` gate falsely reports
        // "AC1 missing from open PR" for every AC when the PR body uses short prefixes
        // (which is the convention everywhere in our repo).
        let body = "## Acceptance Criteria\n\
            ### Task e2e647b1 — Flow metrics dashboard\n\
            - [x] AC1: Dashboard shows cycle time (median and p90) (testID: flow_metrics_cycle_time)\n\
            - [x] AC2: Dashboard shows weekly throughput (testID: flow_metrics_throughput)\n";
        let task_acs = vec![
            (
                "AC1".to_string(),
                "Dashboard shows cycle time (median and p90)".to_string(),
            ),
            (
                "AC2".to_string(),
                "Dashboard shows weekly throughput".to_string(),
            ),
        ];
        let failures = task_ac_vs_open_pr_failures(
            "e2e647b1-16d5-4b93-a92a-ac944b8bb48d",
            &task_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert!(
            failures.is_empty(),
            "expected full-UUID task id to match short-prefix heading, got: {failures:?}"
        );
    }

    #[test]
    fn task_ac_vs_open_pr_matches_full_uuid_section_heading_with_uuid_in_heading() {
        // Same regression as above but with a `### Task <full-uuid>` heading — proves
        // the equality check still works when the heading uses the same full UUID
        // the caller passes in.
        let body = "## Acceptance Criteria\n\
            ### Task e2e647b1-16d5-4b93-a92a-ac944b8bb48d — Flow metrics dashboard\n\
            - [x] AC1: Dashboard shows cycle time (median and p90) (testID: flow_metrics_cycle_time)\n";
        let task_acs = vec![(
            "AC1".to_string(),
            "Dashboard shows cycle time (median and p90)".to_string(),
        )];
        let failures = task_ac_vs_open_pr_failures(
            "e2e647b1-16d5-4b93-a92a-ac944b8bb48d",
            &task_acs,
            body,
            "https://github.com/org/repo/pull/1",
        );
        assert!(
            failures.is_empty(),
            "expected full-UUID heading to match full-UUID task id, got: {failures:?}"
        );
    }

    // ---- mechanical_evidence_failures (task 5e35dc25 PR #1) ----

    /// Test runner that reports every test as passing.
    struct AlwaysPassTestRunner;
    impl TestRunner for AlwaysPassTestRunner {
        fn run(&self, _test_name: &str) -> Result<TestOutcome, String> {
            Ok(TestOutcome {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            })
        }
    }

    /// Test runner that reports every test as failing, with a configurable
    /// error message so tests can assert error propagation.
    struct AlwaysFailTestRunner {
        msg: String,
    }
    impl TestRunner for AlwaysFailTestRunner {
        fn run(&self, _test_name: &str) -> Result<TestOutcome, String> {
            Ok(TestOutcome {
                exit_code: 1,
                stdout: String::new(),
                stderr: self.msg.clone(),
            })
        }
    }

    /// Test runner that records the names it was asked to run so tests can
    /// assert the cited test name was actually dispatched.
    struct RecordingTestRunner {
        log: std::cell::RefCell<Vec<String>>,
    }
    impl TestRunner for RecordingTestRunner {
        fn run(&self, test_name: &str) -> Result<TestOutcome, String> {
            self.log.borrow_mut().push(test_name.to_string());
            Ok(TestOutcome {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            })
        }
    }

    fn single_ac(label: &str, text: &str) -> Vec<(String, String)> {
        vec![(label.to_string(), text.to_string())]
    }

    #[test]
    fn mechanical_evidence_testid_file_path_in_diff_passes() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Cited test file lives in the PR diff (\u{1f9ea} testID: tests/foo.test.ts)\n";
        let files = vec!["tests/foo.test.ts".to_string()];
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Cited test file lives in the PR diff"),
            body,
            &files,
            &AlwaysPassTestRunner,
        );
        assert!(failures.is_empty(), "expected pass, got: {failures:?}");
    }

    #[test]
    fn mechanical_evidence_testid_file_path_not_in_diff_fails() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Cited test file lives in the PR diff (\u{1f9ea} testID: tests/foo.test.ts)\n";
        let files = vec!["tests/bar.test.ts".to_string()];
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Cited test file lives in the PR diff"),
            body,
            &files,
            &AlwaysPassTestRunner,
        );
        assert_eq!(failures.len(), 1, "got: {failures:?}");
        assert!(
            failures[0].contains("tests/foo.test.ts"),
            "failure must name the cited file: {failures:?}"
        );
        assert!(
            failures[0].contains("not in the merged PR diff"),
            "failure must reference the diff: {failures:?}"
        );
    }

    #[test]
    fn mechanical_evidence_testid_suffix_path_match_passes() {
        // PR file `apps/gymtrack/tests/foo.test.ts` should match the cited
        // suffix `foo.test.ts` (path-equality on basename).
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Cited test file lives in the PR diff (\u{1f9ea} testID: foo.test.ts)\n";
        let files = vec!["apps/gymtrack/tests/foo.test.ts".to_string()];
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Cited test file lives in the PR diff"),
            body,
            &files,
            &AlwaysPassTestRunner,
        );
        assert!(failures.is_empty(), "expected suffix match, got: {failures:?}");
    }

    #[test]
    fn mechanical_evidence_testid_test_name_runs_through_test_runner() {
        // Cited value is a test name (no `.test.` extension) — must be
        // dispatched to the test runner, not diff-checked.
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Cited test name runs (\u{1f9ea} testID: my_test_name)\n";
        let runner = RecordingTestRunner {
            log: std::cell::RefCell::new(Vec::new()),
        };
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Cited test name runs"),
            body,
            &[],
            &runner,
        );
        assert!(failures.is_empty(), "expected pass, got: {failures:?}");
        assert_eq!(
            runner.log.borrow().as_slice(),
            &["my_test_name".to_string()],
            "test runner must be invoked with the cited test name"
        );
    }

    #[test]
    fn mechanical_evidence_testid_test_name_failing_test_is_a_failure() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Cited test name runs (\u{1f9ea} testID: my_test_name)\n";
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Cited test name runs"),
            body,
            &[],
            &AlwaysFailTestRunner {
                msg: "boom".to_string(),
            },
        );
        assert_eq!(failures.len(), 1, "got: {failures:?}");
        assert!(
            failures[0].contains("my_test_name") && failures[0].contains("exit 1"),
            "failure must name the test and exit code: {failures:?}"
        );
    }

    #[test]
    fn mechanical_evidence_not_tested_file_path_in_diff_passes() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Manual-only test (\u{26a0}\u{fe0f} not tested: apps/ash/src/verify.ts)\n";
        let files = vec!["apps/ash/src/verify.ts".to_string()];
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Manual-only test"),
            body,
            &files,
            &AlwaysPassTestRunner,
        );
        assert!(failures.is_empty(), "expected pass, got: {failures:?}");
    }

    #[test]
    fn mechanical_evidence_not_tested_file_path_not_in_diff_fails() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Manual-only test (\u{26a0}\u{fe0f} not tested: apps/ash/src/verify.ts)\n";
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Manual-only test"),
            body,
            &[],
            &AlwaysPassTestRunner,
        );
        assert_eq!(failures.len(), 1, "got: {failures:?}");
        assert!(
            failures[0].contains("apps/ash/src/verify.ts"),
            "failure must name the cited file"
        );
    }

    #[test]
    fn mechanical_evidence_not_tested_free_text_reason_passes() {
        // Free-text reason (no slash, no test extension) — mechanical
        // surface treats it as a description, not a file path.
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Drag requires manual browser QA (\u{26a0}\u{fe0f} not tested: drag requires manual browser QA)\n";
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Drag requires manual browser QA"),
            body,
            &[],
            &AlwaysPassTestRunner,
        );
        assert!(failures.is_empty(), "expected pass, got: {failures:?}");
    }

    #[test]
    fn mechanical_evidence_not_code_always_passes() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Spec only (\u{1f4c4} not code: updated docs/systems/ash.md)\n";
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Spec only"),
            body,
            &[],
            &AlwaysPassTestRunner,
        );
        assert!(failures.is_empty(), "expected pass, got: {failures:?}");
    }

    #[test]
    fn mechanical_evidence_pr_reference_hash_passes() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Covered by sibling PR (\u{1f517} pr: #216)\n";
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Covered by sibling PR"),
            body,
            &[],
            &AlwaysPassTestRunner,
        );
        assert!(failures.is_empty(), "expected pass, got: {failures:?}");
    }

    #[test]
    fn mechanical_evidence_pr_reference_url_passes() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Covered by external doc (pr: https://example.com/docs/foo.md)\n";
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Covered by external doc"),
            body,
            &[],
            &AlwaysPassTestRunner,
        );
        assert!(failures.is_empty(), "expected pass, got: {failures:?}");
    }

    #[test]
    fn mechanical_evidence_pr_reference_file_path_not_in_diff_fails() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Covered by edited file (pr: apps/ash/src/verify.ts)\n";
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &single_ac("AC1", "Covered by edited file"),
            body,
            &[],
            &AlwaysPassTestRunner,
        );
        assert_eq!(failures.len(), 1, "got: {failures:?}");
        assert!(
            failures[0].contains("apps/ash/src/verify.ts"),
            "failure must name the cited file"
        );
    }

    #[test]
    fn mechanical_evidence_mixed_pass_fail_across_multiple_acs() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: Cited test file lives in the PR diff (\u{1f9ea} testID: tests/foo.test.ts)\n\
            - [x] AC2: Cited test file does NOT live in the PR diff (\u{1f9ea} testID: tests/missing.test.ts)\n\
            - [x] AC3: Spec only (\u{1f4c4} not code: updated docs)\n";
        let files = vec!["tests/foo.test.ts".to_string()];
        let task_acs = vec![
            (
                "AC1".to_string(),
                "Cited test file lives in the PR diff".to_string(),
            ),
            (
                "AC2".to_string(),
                "Cited test file does NOT live in the PR diff".to_string(),
            ),
            ("AC3".to_string(), "Spec only".to_string()),
        ];
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &task_acs,
            body,
            &files,
            &AlwaysPassTestRunner,
        );
        assert_eq!(failures.len(), 1, "expected one failure, got: {failures:?}");
        assert!(
            failures[0].contains("AC2") && failures[0].contains("tests/missing.test.ts"),
            "failure must pinpoint AC2"
        );
    }

    #[test]
    fn mechanical_evidence_subsection_scoping_only_checks_current_task() {
        // Sibling task's AC cites a file that is in the PR diff — but a
        // different subsection should not be checked against this task.
        let body = "## Acceptance Criteria\n\
            ### Task 5e35dc25 \u{2014} Current task\n\
            - [x] AC1: Cited test file lives in the PR diff (\u{1f9ea} testID: tests/foo.test.ts)\n\
            ### Task aabbccdd \u{2014} Sibling task\n\
            - [x] AC1: Sibling test file (\u{1f9ea} testID: tests/sibling.test.ts)\n";
        let files = vec!["tests/foo.test.ts".to_string()];
        let task_acs = vec![(
            "AC1".to_string(),
            "Cited test file lives in the PR diff".to_string(),
        )];
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &task_acs,
            body,
            &files,
            &AlwaysPassTestRunner,
        );
        assert!(
            failures.is_empty(),
            "sibling AC must not be checked against this task: {failures:?}"
        );
    }

    #[test]
    fn mechanical_evidence_no_task_acs_returns_empty() {
        let body = "## Acceptance Criteria\n\
            - [x] AC1: anything";
        let failures = mechanical_evidence_failures(
            "5e35dc25-aed5-4064-8f11-a99413d18612",
            &[],
            body,
            &[],
            &AlwaysPassTestRunner,
        );
        assert!(failures.is_empty(), "no-task-ACs short-circuit failed");
    }
}
