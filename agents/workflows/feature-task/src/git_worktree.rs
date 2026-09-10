//! Git-worktree cleanup helpers for the feature-task workflow lobster.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a 7,796-line / 160-item god file"). This module hosts
//! the best-effort `git worktree remove --force` sweep that runs at the
//! post-merge stage so implementer task worktrees do not accumulate after
//! their PR merges.
//!
//! `pub(crate)` surface (consumed by `main.rs`, `post_merge.rs`, and
//! the cross-cutting `mod tests` block in `main.rs`):
//!
//! - `cleanup_task_worktree_for_task` — top-level entry point. Lists
//!   registered worktrees for the primary repo, filters to those whose
//!   path/branch matches the task prefix, then removes each.
//! - `format_worktree_cleanup_summary` — render the per-worktree
//!   outcome list for the post-merge `[feature-task-progress-checklist]`
//!   comment.
//! - `WorktreeEntry` / `WorktreeCleanupOutcome` / `WorktreeCleanupResult`
//!   — types returned by the helpers and surfaced in the summary.
//!
//! Private to this module:
//!
//! - `parse_git_worktree_porcelain` — parse `git worktree list
//!   --porcelain` output into a `Vec<WorktreeEntry>`. Pure function;
//!   no I/O.
//! - `task_id_prefix` — slice the leading 8 chars of the task UUID for
//!   the `task-<prefix>` marker used in worktree/branch names.
//! - `select_matching_task_worktrees` — filter a list of registered
//!   worktrees to those matching the task marker, never the primary
//!   `sindustries` checkout.
//! - `remove_worktrees_best_effort` — best-effort `git worktree remove
//!   --force` runner. Missing paths map to `AlreadyAbsent` (idempotent
//!   re-runs); other failures map to `Failed(message)`. Never returns
//!   `Err`.
//!
//! `post_merge.rs` consumes `cleanup_task_worktree_for_task` and
//! `format_worktree_cleanup_summary` via `crate::git_worktree::*` paths
//! after PR-H lands (W37 A3 main.rs carve).

use std::{
    path::{Path, PathBuf},
    process::Command,
};

/// Number of leading UUID chars used in worktree/branch names like
/// `sindustries-task-<8chars>-<slug>`.
const TASK_ID_PREFIX_LEN: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreeEntry {
    path: PathBuf,
    branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WorktreeCleanupOutcome {
    Removed,
    AlreadyAbsent,
    Failed(String),
}

#[derive(Debug, Clone)]
pub(crate) struct WorktreeCleanupResult {
    path: PathBuf,
    branch: Option<String>,
    pub(crate) outcome: WorktreeCleanupOutcome,
}

/// Parse `git worktree list --porcelain` output into a list of
/// `WorktreeEntry` records. Empty / whitespace-only output returns an
/// empty `Vec`. Detached worktrees have `branch = None`.
fn parse_git_worktree_porcelain(output: &str) -> Vec<WorktreeEntry> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    for block in output.split("\n\n") {
        let mut path: Option<PathBuf> = None;
        let mut branch: Option<String> = None;
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(rest.trim()));
            } else if let Some(rest) = line.strip_prefix("branch ") {
                // Strip the `refs/heads/` prefix to match typical branch names.
                let name = rest
                    .trim()
                    .strip_prefix("refs/heads/")
                    .unwrap_or(rest.trim());
                branch = Some(name.to_string());
            }
        }
        if let Some(p) = path {
            entries.push(WorktreeEntry { path: p, branch });
        }
    }
    entries
}

/// Return the 8-char task-id prefix used in feature-task worktree/branch names,
/// e.g. `ba116063-382a-446c-ab91-c01b60d9a7c3` -> `ba116063`.
fn task_id_prefix(task_id: &str) -> &str {
    let cut = TASK_ID_PREFIX_LEN.min(task_id.len());
    &task_id[..cut]
}

/// Select worktrees that should be removed for the given task. Matches both
/// the worktree path and the branch name against `task-<prefix>`. The input
/// entries come from `git -C <primary_repo> worktree list`, so they are already
/// scoped to worktrees registered to this repository. Never remove the primary
/// worktree used to run the workflow.
fn select_matching_task_worktrees<'a>(
    entries: &'a [WorktreeEntry],
    task_id: &str,
    primary_repo: &Path,
) -> Vec<&'a WorktreeEntry> {
    let prefix = task_id_prefix(task_id);
    let marker = format!("task-{prefix}");
    let primary_repo = primary_repo
        .canonicalize()
        .unwrap_or_else(|_| primary_repo.to_path_buf());
    entries
        .iter()
        .filter(|entry| {
            let entry_path = entry
                .path
                .canonicalize()
                .unwrap_or_else(|_| entry.path.clone());
            if entry_path == primary_repo {
                return false;
            }
            let path_str = entry.path.to_string_lossy();
            let path_match = path_str.contains(&marker);
            let branch_match = entry
                .branch
                .as_deref()
                .map(|b| b.contains(&marker))
                .unwrap_or(false);
            path_match || branch_match
        })
        .collect()
}

/// Run `git worktree remove --force <path>` for each candidate. Missing
/// paths are reported as `AlreadyAbsent` so re-runs stay idempotent.
/// All other failures are captured as `Failed(<message>)` and surfaced as
/// non-fatal warnings; this function never returns Err.
fn remove_worktrees_best_effort(
    repo: &Path,
    candidates: &[WorktreeEntry],
) -> Vec<WorktreeCleanupResult> {
    let mut results = Vec::with_capacity(candidates.len());
    for entry in candidates {
        let path = &entry.path;
        if !path.exists() {
            results.push(WorktreeCleanupResult {
                path: path.clone(),
                branch: entry.branch.clone(),
                outcome: WorktreeCleanupOutcome::AlreadyAbsent,
            });
            continue;
        }
        let output = Command::new("git")
            .args([
                "-C",
                repo.to_string_lossy().as_ref(),
                "worktree",
                "remove",
                "--force",
            ])
            .arg(path)
            .output();
        let outcome = match output {
            Ok(out) if out.status.success() => WorktreeCleanupOutcome::Removed,
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let combined = if stderr.is_empty() { stdout } else { stderr };
                WorktreeCleanupOutcome::Failed(if combined.is_empty() {
                    format!(
                        "git worktree remove exited with status {:?}",
                        out.status.code()
                    )
                } else {
                    combined
                })
            }
            Err(err) => WorktreeCleanupOutcome::Failed(format!("failed to spawn git: {err}")),
        };
        results.push(WorktreeCleanupResult {
            path: path.clone(),
            branch: entry.branch.clone(),
            outcome,
        });
    }
    results
}

/// Top-level worktree cleanup for a feature task. Returns a list of cleanup
/// results (empty when nothing matched). Failures are non-fatal by design.
pub(crate) fn cleanup_task_worktree_for_task(
    repo: &Path,
    task_id: &str,
) -> Vec<WorktreeCleanupResult> {
    let list_output = Command::new("git")
        .args([
            "-C",
            repo.to_string_lossy().as_ref(),
            "worktree",
            "list",
            "--porcelain",
        ])
        .output();
    let stdout = match list_output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        Ok(out) => {
            // Treat `git worktree list` failure as a soft warning so the lobster
            // can still advance the task; surface the error in the results.
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return vec![WorktreeCleanupResult {
                path: PathBuf::from("<git-worktree-list>"),
                branch: None,
                outcome: WorktreeCleanupOutcome::Failed(if stderr.is_empty() {
                    format!(
                        "git worktree list exited with status {:?}",
                        out.status.code()
                    )
                } else {
                    stderr
                }),
            }];
        }
        Err(err) => {
            return vec![WorktreeCleanupResult {
                path: PathBuf::from("<git-worktree-list>"),
                branch: None,
                outcome: WorktreeCleanupOutcome::Failed(format!("failed to spawn git: {err}")),
            }];
        }
    };
    let entries = parse_git_worktree_porcelain(&stdout);
    let candidates: Vec<WorktreeEntry> = select_matching_task_worktrees(&entries, task_id, repo)
        .into_iter()
        .cloned()
        .collect();
    remove_worktrees_best_effort(repo, &candidates)
}

pub(crate) fn format_worktree_cleanup_summary(results: &[WorktreeCleanupResult]) -> String {
    if results.is_empty() {
        return "No matching task worktrees found for this task.".to_string();
    }
    results
        .iter()
        .map(|r| {
            let branch = r.branch.as_deref().unwrap_or("(detached)");
            let status = match &r.outcome {
                WorktreeCleanupOutcome::Removed => "removed".to_string(),
                WorktreeCleanupOutcome::AlreadyAbsent => "already absent (idempotent)".to_string(),
                WorktreeCleanupOutcome::Failed(msg) => format!("FAILED: {msg}"),
            };
            format!("- {} (branch: {}) -> {}", r.path.display(), branch, status)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parse_worktree_porcelain_handles_main_and_task_worktrees() {
        let sample = "\
worktree /Users/quinnstoffer/workspaces/implementer/sindustries
HEAD 0123456789abcdef0123456789abcdef01234567
branch refs/heads/main

worktree /Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-lobster-worktree-cleanup
HEAD fedcba9876543210fedcba9876543210fedcba98
branch refs/heads/task-ba116063-lobster-worktree-cleanup

worktree /Users/quinnstoffer/workspaces/implementer/sindustries-task-zz999999-orphan
HEAD 1111111111111111111111111111111111111111
detached
";
        let entries = parse_git_worktree_porcelain(sample);
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries[0].path,
            PathBuf::from("/Users/quinnstoffer/workspaces/implementer/sindustries")
        );
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(
            entries[1].branch.as_deref(),
            Some("task-ba116063-lobster-worktree-cleanup")
        );
        assert_eq!(entries[2].branch, None, "detached entries have no branch");
    }

    #[test]
    fn parse_worktree_porcelain_handles_empty_output() {
        let entries = parse_git_worktree_porcelain("");
        assert!(entries.is_empty());
        let entries = parse_git_worktree_porcelain("\n\n\n");
        assert!(entries.is_empty());
    }

    #[test]
    fn task_id_prefix_takes_first_eight_chars() {
        assert_eq!(
            task_id_prefix("ba116063-382a-446c-ab91-c01b60d9a7c3"),
            "ba116063"
        );
        // Short id safety: never panic, just return the whole id.
        assert_eq!(task_id_prefix("abc"), "abc");
    }

    #[test]
    fn select_matching_task_worktrees_finds_only_task_worktrees() {
        let entries = vec![
            WorktreeEntry {
                path: PathBuf::from("/Users/quinnstoffer/workspaces/implementer/sindustries"),
                branch: Some("main".to_string()),
            },
            WorktreeEntry {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-lobster-worktree-cleanup",
                ),
                branch: Some("task-ba116063-lobster-worktree-cleanup".to_string()),
            },
            WorktreeEntry {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-b179c0e3-bookmark-analytics-postgres",
                ),
                branch: Some("task-b179c0e3-bookmark-analytics-postgres".to_string()),
            },
            // A registered worktree outside the primary checkout root is still
            // valid; implementers keep task worktrees in dedicated workspace roots.
            WorktreeEntry {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/lox/sindustries-task-ba116063-bogus",
                ),
                branch: Some("task-ba116063-bogus".to_string()),
            },
            // Branch-prefixed worktree whose path lives outside the primary root
            // should still be removed because it is registered to this repo.
            WorktreeEntry {
                path: PathBuf::from("/tmp/some-other-worktree"),
                branch: Some("task-ba116063-anything".to_string()),
            },
        ];
        let matches = select_matching_task_worktrees(
            &entries,
            "ba116063-382a-446c-ab91-c01b60d9a7c3",
            Path::new("/Users/quinnstoffer/workspaces/implementer/sindustries"),
        );
        assert_eq!(matches.len(), 3);
        let paths: Vec<String> = matches
            .iter()
            .map(|entry| entry.path.to_string_lossy().to_string())
            .collect();
        assert!(paths
            .iter()
            .any(|path| path.contains("sindustries-task-ba116063-lobster-worktree-cleanup")));
        assert!(paths
            .iter()
            .any(|path| path.contains("workspaces/lox/sindustries-task-ba116063-bogus")));
        assert!(paths
            .iter()
            .any(|path| path.contains("/tmp/some-other-worktree")));
    }

    #[test]
    fn select_matching_task_worktrees_never_picks_primary_sindustries() {
        let entries = vec![WorktreeEntry {
            path: PathBuf::from("/Users/quinnstoffer/workspaces/implementer/sindustries"),
            branch: Some("main".to_string()),
        }];
        let matches = select_matching_task_worktrees(
            &entries,
            "ba116063-382a-446c-ab91-c01b60d9a7c3",
            Path::new("/Users/quinnstoffer/workspaces/implementer/sindustries"),
        );
        assert!(
            matches.is_empty(),
            "primary worktree must never be selected"
        );
    }

    #[test]
    fn select_matching_task_worktrees_handles_branch_only_match() {
        // A worktree whose path does not include the task marker but whose
        // branch does (e.g. renamed path) should still match.
        let entries = vec![WorktreeEntry {
            path: PathBuf::from("/Users/quinnstoffer/workspaces/implementer/some-odd-path"),
            branch: Some("task-ba116063-renamed".to_string()),
        }];
        let matches = select_matching_task_worktrees(
            &entries,
            "ba116063-382a-446c-ab91-c01b60d9a7c3",
            Path::new("/Users/quinnstoffer/workspaces/implementer/sindustries"),
        );
        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn format_worktree_cleanup_summary_handles_empty() {
        assert_eq!(
            format_worktree_cleanup_summary(&[]),
            "No matching task worktrees found for this task."
        );
    }

    #[test]
    fn format_worktree_cleanup_summary_mixes_outcomes() {
        let results = vec![
            WorktreeCleanupResult {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-a",
                ),
                branch: Some("task-ba116063-a".to_string()),
                outcome: WorktreeCleanupOutcome::Removed,
            },
            WorktreeCleanupResult {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-b",
                ),
                branch: Some("task-ba116063-b".to_string()),
                outcome: WorktreeCleanupOutcome::AlreadyAbsent,
            },
            WorktreeCleanupResult {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-c",
                ),
                branch: None,
                outcome: WorktreeCleanupOutcome::Failed("permission denied".to_string()),
            },
        ];
        let summary = format_worktree_cleanup_summary(&results);
        assert!(summary.contains("removed"), "got: {summary}");
        assert!(summary.contains("already absent"), "got: {summary}");
        assert!(
            summary.contains("FAILED: permission denied"),
            "got: {summary}"
        );
        assert!(summary.contains("(detached)"), "got: {summary}");
    }

    #[test]
    fn remove_worktrees_best_effort_marks_missing_paths_as_already_absent() {
        let dir = tempdir().unwrap();
        let repo = dir.path();
        // No worktrees registered; the missing-path entry must be reported
        // as AlreadyAbsent without invoking git.
        let results = remove_worktrees_best_effort(
            repo,
            &[WorktreeEntry {
                path: dir.path().join("nonexistent"),
                branch: Some("task-ba116063-x".to_string()),
            }],
        );
        assert_eq!(results.len(), 1);
        assert!(matches!(
            results[0].outcome,
            WorktreeCleanupOutcome::AlreadyAbsent
        ));
    }
}
