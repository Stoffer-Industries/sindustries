//! Brain-spec reconciliation and archive lifecycle planning.
//!
//! Extracted from `main.rs` (2026-W38+ second tranche, Slice 3 of the W37
//! A3 main.rs carve continuation). This module hosts the pre-decision
//! brain-spec reconciliation + chat-spec lifecycle move planning that
//! previously sat in `main.rs` (lines 336-1007 post Slice 2), alongside
//! the archive planning cluster. The post-decision archive/cleanup
//! outcome helpers remain in `brain_spec_lifecycle.rs` (per W37 PR-E
//! #626); the split is deliberate —
//! `brain_spec_reconcile.rs` plans and proposes; `brain_spec_lifecycle.rs`
//! applies the chosen outcome and rewrites description/spec-checksum
//! state.
//!
//! `pub(crate)` surface (consumed by `main.rs`, `brain_spec_lifecycle.rs`,
//! `spec_check_ready.rs`):
//!
//! - `reconciliation_spec_link` / `plan_brain_spec_approval` /
//!   `feature_policy_requires_spec` / `grant_reconciled_spec_approval` /
//!   `reconcile_brain_spec_approvals` — brain-spec reconciliation
//!   `BrainSpecApprovalPlan` enum + 5 planning/applied functions.
//! - `bootstrap_task_spec_layout` / `normalize_rel_path` /
//!   `plan_chat_spec_lifecycle_move` / `move_approved_chat_spec_if_needed`
//!   — spec lifecycle setup.
//! - `plan_task_spec_archive` / `resolve_archive_plan` — archive planning.
//! - `rewrite_spec_line_in_description` / `archive_task_spec_for_done_task`
//!   — archive execution + description rewriting.
//! - `ArchiveSpecPlan` / `ArchiveOutcome` / `ArchiveSkipReason` /
//!   `ChatApprovalMovePlan` enums — archive outcome types.
//! - Constants `BRAIN_DIR` / `TASK_SPECS_DIR` / `TASK_SPECS_OPEN_DIR` /
//!   `TASK_SPECS_IN_PROGRESS_DIR` / `TASK_SPECS_DONE_DIR` /
//!   `BRAIN_SPEC_APPROVAL_NOTE_PREFIX` / `TASK_SPEC_LIFECYCLE_DIRS` —
//!   brain-spec path and lifecycle constants.
//!
//! The corresponding `#[cfg(test)]` cases stay in `main.rs::tests` for
//! Slice 4 (`tests_integration.rs` + per-module test blocks) to
//! relocate.

use crate::api_client;
use crate::lobster_state;
use crate::product_spec_parsing;
use crate::{Envelope, LobsterState, ReconcileBrainSpecApprovalsArgs, StageArgs, Task};
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const BRAIN_DIR: &str = "brain";

// ---- Spec archive path helpers (feature task c40ae956) ----
//
// When a feature task transitions to `done`, the spec referenced in the task's
// `**Spec:**` line should move from `brain/tasks/specs/` into
// `brain/tasks/specs/done/`. The boundary is intentionally narrow:
//   1. Only specs under `brain/tasks/specs/in-progress/<slug>.md` are eligible.
//   2. Specs already under `brain/tasks/specs/done/` are a no-op (idempotent).
//   3. `brain/tasks/specs/open/`, `brain/bookmarks/specs/`, `docs/specs/`, and other paths are out of scope.
//
// These helpers intentionally differ from `safe_brain_spec_path`, which is
// permissive about the brain subtree to support spec resync. The archive path
// is much stricter — only one subtree, one target directory.

pub(crate) const TASK_SPECS_DIR: &str = "brain/tasks/specs";
pub(crate) const TASK_SPECS_OPEN_DIR: &str = "brain/tasks/specs/open";
pub(crate) const TASK_SPECS_IN_PROGRESS_DIR: &str = "brain/tasks/specs/in-progress";
pub(crate) const TASK_SPECS_DONE_DIR: &str = "brain/tasks/specs/done";
const BRAIN_SPEC_APPROVAL_NOTE_PREFIX: &str = "Reconciled from checked brain spec";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrainSpecApprovalPlan {
    Grant { task_id: String },
    AlreadyApproved { task_id: String },
    Unchecked,
    Revoked { task_id: String },
    MissingLink,
    Ambiguous { task_ids: Vec<String> },
}

/// Parse the single exact task/spec link used by approval reconciliation.
/// Unlike the normal compatibility parser, duplicate Spec lines are rejected:
/// a human approval must never be attached through an ambiguous description.
pub(crate) fn reconciliation_spec_link(task: &Task) -> Option<String> {
    let description = task.description.as_deref().unwrap_or("");
    let line_re = Regex::new(r"(?im)^\s*\*\*Spec:\*\*\s+(.+?)\s*$").unwrap();
    let mut captures = line_re.captures_iter(description);
    let first = captures.next()?;
    if captures.next().is_some() {
        return None;
    }
    product_spec_parsing::extract_spec_path_from_line(first.get(1)?.as_str())
        .map(|spec| normalize_rel_path(&spec.path))
}

pub(crate) fn plan_brain_spec_approval(
    spec_path: &str,
    spec_text: &str,
    tasks: &[Task],
) -> BrainSpecApprovalPlan {
    if !product_spec_parsing::brain_spec_approved_by_tom(spec_text) {
        return BrainSpecApprovalPlan::Unchecked;
    }
    let normalized = normalize_rel_path(spec_path);
    let mut matches: Vec<&Task> = tasks
        .iter()
        .filter(|task| task.task_type.as_deref() == Some("feature"))
        .filter(|task| reconciliation_spec_link(task).as_deref() == Some(normalized.as_str()))
        .collect();
    matches.sort_by(|a, b| a.id.cmp(&b.id));
    if matches.is_empty() {
        return BrainSpecApprovalPlan::MissingLink;
    }
    if matches.len() > 1 {
        return BrainSpecApprovalPlan::Ambiguous {
            task_ids: matches.iter().map(|task| task.id.clone()).collect(),
        };
    }
    let task = matches[0];
    if lobster_state::spec_is_approved(task) {
        return BrainSpecApprovalPlan::AlreadyApproved {
            task_id: task.id.clone(),
        };
    }
    if task
        .approvals
        .iter()
        .any(|approval| approval.approval_type == "spec" && approval.state == "revoked")
    {
        return BrainSpecApprovalPlan::Revoked {
            task_id: task.id.clone(),
        };
    }
    BrainSpecApprovalPlan::Grant {
        task_id: task.id.clone(),
    }
}

pub(crate) fn feature_policy_requires_spec(base_url: &str) -> Result<bool> {
    let value: Value = api_client::api_get(base_url, "/task-types/feature/required-approvals")?;
    let required = value
        .get("requiredApprovals")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow!("feature required-approvals response omitted `requiredApprovals`")
        })?;
    Ok(required.iter().any(|value| value.as_str() == Some("spec")))
}

pub(crate) fn grant_reconciled_spec_approval(
    base_url: &str,
    task_id: &str,
    spec_path: &str,
) -> Result<()> {
    // Deliberately not `TASKS_API_APPROVAL_TOKEN` (Quinn's tech_design-only
    // credential) — the server's ACTOR_PERMISSIONS table only grants `spec`
    // to `Tom` and to the dedicated `brain_spec_reconciler` service identity
    // (`services/tasks-api/src/middleware/approvalAuth.ts`). Reusing Quinn's
    // token here 403s every time (`APPROVAL_TYPE_FORBIDDEN`), which is why
    // this reconciliation silently never succeeded before.
    let token = std::env::var("TASKS_API_BRAIN_SPEC_RECONCILER_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "TASKS_API_BRAIN_SPEC_RECONCILER_TOKEN is required to reconcile checked brain specs"
            )
        })?;
    let url = format!(
        "{}/tasks/{task_id}/approvals",
        base_url.trim_end_matches('/')
    );
    let note = format!("{BRAIN_SPEC_APPROVAL_NOTE_PREFIX} `{spec_path}`.");
    api_client::handle_api_result(
        ureq::post(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(json!({"type": "spec", "note": note})),
    )?;
    Ok(())
}

/// Scan `brain/tasks/specs/open/*.md` and `brain/tasks/specs/in-progress/*.md`,
/// map checked specs to one active feature task, and grant the structured
/// spec approval through the Tasks API. Both directories hold specs a task
/// can still legitimately reference (`a5a4ed8f` moves specs to `in-progress`
/// once implementation starts, well before Tom has necessarily approved them),
/// so scanning `open` alone silently stops reconciling a spec the moment work
/// begins on it. The API row remains the gate source; revoked rows, missing
/// links, and ambiguous links are diagnostics and never trigger a write.
pub(crate) fn reconcile_brain_spec_approvals(
    args: ReconcileBrainSpecApprovalsArgs,
) -> Result<Envelope> {
    if !feature_policy_requires_spec(&args.base_url)? {
        return Ok(api_client::output(
            true,
            false,
            "brain_spec_approval_reconciliation_skipped: feature_policy_has_no_spec_gate",
            Task::default(),
            LobsterState::default(),
            vec![],
        ));
    }

    let tasks = lobster_state::list_all_active_tasks(&args.base_url)?;
    let mut paths = Vec::new();
    for spec_dir_const in [TASK_SPECS_OPEN_DIR, TASK_SPECS_IN_PROGRESS_DIR] {
        let dir = args.workspace_root.join(spec_dir_const);
        let entries = fs::read_dir(&dir)
            .with_context(|| format!("reading task specs directory `{}`", dir.display()))?;
        for entry in entries {
            let entry = entry.with_context(|| format!("reading entry in `{}`", dir.display()))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let accessible_file = entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false);
            paths.push((path, spec_dir_const, accessible_file));
        }
    }
    paths.sort_by(|a, b| a.0.cmp(&b.0));

    let mut checked = 0usize;
    let mut granted = 0usize;
    let mut already = 0usize;
    let mut unchecked = 0usize;
    let mut failures = Vec::new();
    for (path, spec_dir_const, accessible_file) in paths {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("<invalid>");
        let spec_rel = format!("{spec_dir_const}/{file_name}");
        if !accessible_file {
            failures.push(format!(
                "Task spec `{spec_rel}` is not an accessible regular file; no approval granted."
            ));
            continue;
        }
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) => {
                failures.push(format!(
                    "Could not read open task spec `{spec_rel}`: {err}; no approval granted."
                ));
                continue;
            }
        };
        match plan_brain_spec_approval(&spec_rel, &text, &tasks) {
            BrainSpecApprovalPlan::Unchecked => unchecked += 1,
            BrainSpecApprovalPlan::AlreadyApproved { .. } => {
                checked += 1;
                already += 1;
            }
            BrainSpecApprovalPlan::Grant { task_id } => {
                checked += 1;
                if args.dry_run {
                    granted += 1;
                } else if let Err(err) =
                    grant_reconciled_spec_approval(&args.base_url, &task_id, &spec_rel)
                {
                    failures.push(format!("Could not grant structured `spec` approval for task `{task_id}` linked from `{spec_rel}`: {err}."));
                } else {
                    granted += 1;
                }
            }
            BrainSpecApprovalPlan::Revoked { task_id } => {
                checked += 1;
                failures.push(format!("Task `{task_id}` has a revoked structured `spec` approval; `{spec_rel}` remains checked, but API revocation is authoritative. Re-check through a fresh human action before granting."));
            }
            BrainSpecApprovalPlan::MissingLink => {
                checked += 1;
                failures.push(format!("Checked task spec `{spec_rel}` has no exact, unambiguous `**Spec:**` link from an active feature task requiring `spec`; no approval granted."));
            }
            BrainSpecApprovalPlan::Ambiguous { task_ids } => {
                checked += 1;
                failures.push(format!("Checked task spec `{spec_rel}` is linked by multiple active feature tasks ({}); no approval granted.", task_ids.join(", ")));
            }
        }
    }

    Ok(api_client::output(
        failures.is_empty(),
        false,
        &format!(
            "brain_spec_approval_reconciliation: checked={checked} granted={granted} already_approved={already} unchecked={unchecked} failures={}",
            failures.len()
        ),
        Task::default(),
        LobsterState::default(),
        failures,
    ))
}

pub(crate) const TASK_SPEC_LIFECYCLE_DIRS: [&str; 4] = ["open", "in-progress", "done", "archived"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchiveSpecPlan {
    Move {
        from_rel: String,
        to_rel: String,
        from_abs: PathBuf,
        to_abs: PathBuf,
    },
    AlreadyArchived,
    OpenSpecCannotArchive,
    NotTaskSpec,
    MissingSpecRef,
}

/// Outcome of an attempt to archive a task spec for a task that has reached
/// `done`. This is the orchestrator-facing result returned by
/// [`archive_task_spec_for_done_task`] and is the input for both the
/// done-transition trigger and the reconciliation sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchiveOutcome {
    /// Spec was moved and the task description was rewritten.
    Moved { from_rel: String, to_rel: String },
    /// Spec was already in the done directory; description was rewritten.
    AlreadyArchived { to_rel: String },
    /// No work to do: spec is missing, not a task spec, an open spec, or
    /// the parser could not extract a path from the Spec line.
    NotApplicable { reason: ArchiveSkipReason },
    /// Filesystem or path-resolution failure; the task should remain `done`
    /// and the next reconciliation sweep will retry. The caller is expected
    /// to surface a `[spec-archive-retryable]` task comment and an attention
    /// owner pointing at Quinn.
    Retryable {
        from_rel: String,
        to_rel: String,
        reason: String,
    },
    /// Destination file exists with different content from the source. Both
    /// files are left in place; a `[spec-archive-conflict]` comment must be
    /// posted. Reconciliation sweep will not retry until a human resolves it.
    Conflict { from_rel: String, to_rel: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchiveSkipReason {
    NotTaskSpec,
    MissingSpecRef,
    OpenSpecCannotArchive,
    UnparseableSpecLine,
}

impl ArchiveSkipReason {
    pub(crate) fn as_tag(&self) -> &'static str {
        match self {
            ArchiveSkipReason::NotTaskSpec => "not_task_spec",
            ArchiveSkipReason::MissingSpecRef => "missing_spec_ref",
            ArchiveSkipReason::OpenSpecCannotArchive => "open_spec_cannot_archive",
            ArchiveSkipReason::UnparseableSpecLine => "unparseable_spec_line",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChatApprovalMovePlan {
    Move { from_rel: String, to_rel: String },
    AlreadyMoved { from_rel: String, to_rel: String },
    Noop,
}

/// Decide what should happen to the spec referenced from this task's Spec line.
/// Pure function: no filesystem access. The caller resolves the relative paths
/// to absolute paths once the workspace root is known.
pub(crate) fn bootstrap_task_spec_layout(workspace_root: &Path) -> Result<()> {
    let specs_root = workspace_root.join(TASK_SPECS_DIR);
    for dir in TASK_SPEC_LIFECYCLE_DIRS {
        fs::create_dir_all(specs_root.join(dir)).with_context(|| {
            format!(
                "creating task specs lifecycle dir `{}`",
                specs_root.join(dir).display()
            )
        })?;
    }
    for entry in fs::read_dir(&specs_root)
        .with_context(|| format!("reading task specs root `{}`", specs_root.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !TASK_SPEC_LIFECYCLE_DIRS.contains(&name.as_str()) {
            return Err(anyhow!(
                "unexpected subdir under `{}`: `{}`; expected only open/, in-progress/, done/, archived/",
                specs_root.display(),
                name
            ));
        }
    }
    Ok(())
}

pub(crate) fn normalize_rel_path(path: &str) -> String {
    path.trim().trim_start_matches("./").to_string()
}

pub(crate) fn plan_chat_spec_lifecycle_move(
    spec_path: &str,
    spec_text: &str,
    structured_approved: bool,
) -> ChatApprovalMovePlan {
    let normalized = normalize_rel_path(spec_path);
    if !normalized.ends_with(".md") || normalized.contains("..") {
        return ChatApprovalMovePlan::Noop;
    }
    let open_prefix = format!("{TASK_SPECS_OPEN_DIR}/");
    let in_progress_prefix = format!("{TASK_SPECS_IN_PROGRESS_DIR}/");
    if let Some(suffix) = normalized.strip_prefix(&open_prefix) {
        if suffix.is_empty()
            || suffix.contains('/')
            || (!structured_approved
                && !product_spec_parsing::brain_spec_approved_by_tom(spec_text))
        {
            return ChatApprovalMovePlan::Noop;
        }
        let suffix = suffix.to_string();
        return ChatApprovalMovePlan::Move {
            from_rel: normalized,
            to_rel: format!("{TASK_SPECS_IN_PROGRESS_DIR}/{suffix}"),
        };
    }
    if let Some(suffix) = normalized.strip_prefix(&in_progress_prefix) {
        if !suffix.is_empty() && !suffix.contains('/') {
            return ChatApprovalMovePlan::AlreadyMoved {
                from_rel: format!("{TASK_SPECS_OPEN_DIR}/{suffix}"),
                to_rel: normalized,
            };
        }
    }
    ChatApprovalMovePlan::Noop
}

pub(crate) fn move_approved_chat_spec_if_needed(
    args: &StageArgs,
    mut env: Envelope,
) -> Result<Envelope> {
    let Some(spec) = product_spec_parsing::product_spec(&env.task) else {
        return Ok(env);
    };
    let normalized = normalize_rel_path(&spec.path);
    let open_prefix = format!("{TASK_SPECS_OPEN_DIR}/");
    if let Some(suffix) = normalized.strip_prefix(&open_prefix) {
        let to_rel = format!("{TASK_SPECS_IN_PROGRESS_DIR}/{suffix}");
        if product_spec_parsing::workspace_root(args)
            .join(&to_rel)
            .exists()
        {
            let description = env.task.description.clone().unwrap_or_default();
            if let Some(new_desc) =
                rewrite_spec_line_in_description(&description, &normalized, &to_rel)
            {
                api_client::api_patch::<Task>(
                    &args.base_url,
                    &env.task.id,
                    json!({"description": new_desc}),
                )?;
                env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
                env.action_taken = "repaired_chat_spec_in_progress_path".to_string();
            }
            return Ok(env);
        }
    }
    let spec_abs = product_spec_parsing::resolve_product_spec_path(
        &spec.path,
        &args.repo,
        product_spec_parsing::workspace_root(args),
    );
    let spec_text = match fs::read_to_string(&spec_abs) {
        Ok(text) => text,
        Err(_) => return Ok(env),
    };
    let plan = plan_chat_spec_lifecycle_move(
        &spec.path,
        &spec_text,
        lobster_state::spec_is_approved(&env.task),
    );
    let (from_rel, to_rel, should_move) = match plan {
        ChatApprovalMovePlan::Move { from_rel, to_rel } => (from_rel, to_rel, true),
        ChatApprovalMovePlan::AlreadyMoved { from_rel, to_rel } => (from_rel, to_rel, false),
        ChatApprovalMovePlan::Noop => return Ok(env),
    };
    let from_abs = product_spec_parsing::workspace_root(args).join(&from_rel);
    let to_abs = product_spec_parsing::workspace_root(args).join(&to_rel);
    if should_move && from_abs.exists() {
        if let Some(parent) = to_abs.parent() {
            fs::create_dir_all(parent)?;
        }
        if !to_abs.exists() {
            fs::rename(&from_abs, &to_abs).with_context(|| {
                format!(
                    "moving approved chat spec from `{}` to `{}`",
                    from_abs.display(),
                    to_abs.display()
                )
            })?;
        }
    }
    let description = env.task.description.clone().unwrap_or_default();
    if let Some(new_desc) = rewrite_spec_line_in_description(&description, &from_rel, &to_rel) {
        api_client::api_patch::<Task>(
            &args.base_url,
            &env.task.id,
            json!({"description": new_desc}),
        )?;
        env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
        env.action_taken = "moved_approved_chat_spec_to_in_progress".to_string();
    }
    Ok(env)
}

pub(crate) fn plan_task_spec_archive(spec_path: Option<&str>) -> ArchiveSpecPlan {
    let Some(path) = spec_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return ArchiveSpecPlan::MissingSpecRef;
    };
    let normalized = normalize_rel_path(path);
    if !normalized.ends_with(".md") || normalized.contains("..") {
        return ArchiveSpecPlan::NotTaskSpec;
    }
    let done_prefix = format!("{TASK_SPECS_DONE_DIR}/");
    if normalized.starts_with(&done_prefix) {
        return ArchiveSpecPlan::AlreadyArchived;
    }
    let open_prefix = format!("{TASK_SPECS_OPEN_DIR}/");
    if normalized.starts_with(&open_prefix) {
        return ArchiveSpecPlan::OpenSpecCannotArchive;
    }
    let in_progress_prefix = format!("{TASK_SPECS_IN_PROGRESS_DIR}/");
    let Some(suffix) = normalized.strip_prefix(&in_progress_prefix) else {
        return ArchiveSpecPlan::NotTaskSpec;
    };
    if suffix.is_empty() || suffix.contains('/') || !suffix.ends_with(".md") {
        return ArchiveSpecPlan::NotTaskSpec;
    }
    let suffix = suffix.to_string();
    ArchiveSpecPlan::Move {
        from_rel: normalized,
        to_rel: format!("{TASK_SPECS_DONE_DIR}/{suffix}"),
        from_abs: PathBuf::new(),
        to_abs: PathBuf::new(),
    }
}

/// Resolve the `from_abs`/`to_abs` paths against the workspace root and ensure
/// the source exists. Returns `Err` only on filesystem or path-canonicalization
/// failures — caller decides how to surface them.
pub(crate) fn resolve_archive_plan(
    plan: ArchiveSpecPlan,
    workspace_root: &Path,
) -> Result<ArchiveSpecPlan> {
    let ArchiveSpecPlan::Move {
        from_rel, to_rel, ..
    } = plan
    else {
        return Ok(plan);
    };
    let from_abs = workspace_root.join(&from_rel);
    let to_abs = workspace_root.join(&to_rel);
    // Ensure the destination directory exists before deciding whether this is
    // a first move or an idempotent stale-Spec-line repair.
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating archive directory `{}`", parent.display()))?;
    }
    if !from_abs.exists() && !to_abs.exists() {
        return Ok(ArchiveSpecPlan::NotTaskSpec);
    }
    Ok(ArchiveSpecPlan::Move {
        from_rel,
        to_rel,
        from_abs,
        to_abs,
    })
}

/// Rewrite the task description's `**Spec:** <path>` line to point at the new
/// archived path. If the line is missing, the description is returned unchanged.
/// Returns `None` if no rewrite was needed (line missing or already at the new path).
/// Tolerates inline annotations in `(...)`, `[...]`, or backticks — the
/// annotation is preserved by re-attaching it after the new path.
pub(crate) fn rewrite_spec_line_in_description(
    description: &str,
    old_path: &str,
    new_path: &str,
) -> Option<String> {
    // Match the bold-prefixed form used in feature-task descriptions:
    //   **Spec:** <anything until EOL>
    // Case-insensitive on `Spec`. Allow optional trailing whitespace before EOL.
    let re = Regex::new(r"(?m)^(\s*\*\*Spec:\*\*\s+)(.+?)\s*$").ok()?;
    let mut updated = false;
    let rewritten = re.replace_all(description, |caps: &regex::Captures| {
        let prefix = &caps[1];
        let existing = caps[2].trim();
        // Strip a trailing inline annotation so we can compare the bare path.
        let existing_path =
            product_spec_parsing::strip_trailing_annotation(existing).unwrap_or(existing);
        let existing_path = existing_path
            .trim_end_matches([',', '.', ';'])
            .trim()
            .trim_matches('`');
        if existing_path == new_path {
            // Already points at the archived path — leave it.
            caps[0].to_string()
        } else if existing_path == old_path {
            updated = true;
            // Preserve any trailing inline annotation by re-attaching it.
            let annotation_suffix = if existing.len() > existing_path.len() {
                &existing[existing_path.len()..]
            } else {
                ""
            };
            format!("{prefix}{new_path}{annotation_suffix}")
        } else {
            // Some other spec line, leave it alone.
            caps[0].to_string()
        }
    });
    if updated {
        Some(rewritten.into_owned())
    } else {
        None
    }
}

/// Attempt to archive the task's referenced spec for a task that has reached
/// `done`. This is the pure decision + filesystem step shared by the
/// done-transition trigger and the reconciliation sweep. It does **not**
/// issue API calls; the caller is responsible for translating the
/// [`ArchiveOutcome`] into envelope actions, description rewrites, and
/// task comments.
///
/// Idempotency:
/// - If the destination already exists with content matching the source,
///   returns [`ArchiveOutcome::AlreadyArchived`].
/// - If the destination already exists with **different** content, returns
///   [`ArchiveOutcome::Conflict`] and leaves both files in place.
/// - Otherwise renames the source to the destination and returns
///   [`ArchiveOutcome::Moved`].
///
/// Retryable errors (e.g. `fs::rename` failure due to permission/disk)
/// surface as [`ArchiveOutcome::Retryable`] rather than panicking — the
/// task must stay `done` and the next sweep will retry.
pub(crate) fn archive_task_spec_for_done_task(
    task: &Task,
    workspace_root: &Path,
) -> ArchiveOutcome {
    let Some(spec) = product_spec_parsing::product_spec(task) else {
        return ArchiveOutcome::NotApplicable {
            reason: ArchiveSkipReason::UnparseableSpecLine,
        };
    };
    let plan = plan_task_spec_archive(Some(&spec.path));
    let (from_rel, to_rel) = match &plan {
        ArchiveSpecPlan::Move {
            from_rel, to_rel, ..
        } => (from_rel.clone(), to_rel.clone()),
        ArchiveSpecPlan::AlreadyArchived => {
            return ArchiveOutcome::AlreadyArchived {
                to_rel: spec.path.clone(),
            };
        }
        ArchiveSpecPlan::OpenSpecCannotArchive => {
            return ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::OpenSpecCannotArchive,
            };
        }
        ArchiveSpecPlan::NotTaskSpec => {
            return ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::NotTaskSpec,
            };
        }
        ArchiveSpecPlan::MissingSpecRef => {
            return ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::MissingSpecRef,
            };
        }
    };

    let resolved = match resolve_archive_plan(plan, workspace_root) {
        Ok(p) => p,
        Err(err) => {
            return ArchiveOutcome::Retryable {
                from_rel,
                to_rel,
                reason: format!("resolve archive plan: {err}"),
            };
        }
    };
    let ArchiveSpecPlan::Move {
        from_abs, to_abs, ..
    } = resolved
    else {
        return ArchiveOutcome::NotApplicable {
            reason: ArchiveSkipReason::NotTaskSpec,
        };
    };

    if to_abs.exists() {
        // Pre-existing destination. Compare content; only call it AlreadyArchived
        // if the content matches the source. Otherwise leave both files in place
        // and surface a Conflict.
        let source_matches = match (fs::read(&from_abs), fs::read(&to_abs)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if source_matches {
            return ArchiveOutcome::AlreadyArchived { to_rel };
        }
        return ArchiveOutcome::Conflict { from_rel, to_rel };
    }

    if let Err(err) = fs::rename(&from_abs, &to_abs) {
        return ArchiveOutcome::Retryable {
            from_rel,
            to_rel,
            reason: format!("rename: {err}"),
        };
    }

    ArchiveOutcome::Moved { from_rel, to_rel }
}

// In-module tests for brain_spec_reconcile. Moved from main.rs::tests
// in Slice 4 of the W37 A3 main.rs carve (W38+ second tranche). 30
// cases cover plan_task_spec_archive (9), spec_lifecycle_bootstrap +
// plan_chat_spec_lifecycle_move (5), rewrite_spec_line_in_description
// (4), resolve_archive_plan (2), archive_task_spec_for_done_task (10)
// + helpers. Per-module test block pattern continues the W37 first
// tranche (PR-A1 #621, PR-A2 #624, PR-B #623, PR-C #624, PR-D #625,
// PR-E #626, PR-F #632, PR-G #636, PR-H #639, PR-I #640, PR-J #641).
//
// The `archive_spec_*` helpers (task_with_description,
// write_in_progress_spec) stay colocated with the tests that use
// them because they describe test fixtures, not production behavior.
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;


    #[test]
    fn plan_task_spec_archive_moves_eligible_spec() {
        let plan = plan_task_spec_archive(Some("brain/tasks/specs/in-progress/example-2026.md"));
        match plan {
            ArchiveSpecPlan::Move {
                from_rel, to_rel, ..
            } => {
                assert_eq!(from_rel, "brain/tasks/specs/in-progress/example-2026.md");
                assert_eq!(to_rel, "brain/tasks/specs/done/example-2026.md");
            }
            other => panic!("expected Move plan, got {other:?}"),
        }
    }

    #[test]
    fn plan_task_spec_archive_strips_leading_dot_slash() {
        let plan = plan_task_spec_archive(Some("./brain/tasks/specs/in-progress/example-2026.md"));
        assert!(matches!(plan, ArchiveSpecPlan::Move { .. }));
    }

    #[test]
    fn plan_task_spec_archive_treats_already_archived_as_noop() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/done/example-2026.md")),
            ArchiveSpecPlan::AlreadyArchived
        );
        // An absolute path that points inside done/ is also a no-op.
        let plan = plan_task_spec_archive(Some("/abs/brain/tasks/specs/done/example-2026.md"));
        // Absolute paths don't match the done-prefix, but they're rejected as NotTaskSpec.
        assert_eq!(plan, ArchiveSpecPlan::NotTaskSpec);
    }

    #[test]
    fn plan_task_spec_archive_rejects_bookmark_specs() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/bookmarks/specs/example.md")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_rejects_docs_specs() {
        assert_eq!(
            plan_task_spec_archive(Some("docs/specs/example.md")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_rejects_subdirectory() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/in-progress/sub/foo.md")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_rejects_non_md() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/in-progress/example.txt")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_rejects_dotdot() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/in-progress/../escapee.md")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_missing_or_empty_is_missing() {
        assert_eq!(
            plan_task_spec_archive(None),
            ArchiveSpecPlan::MissingSpecRef
        );
        assert_eq!(
            plan_task_spec_archive(Some("")),
            ArchiveSpecPlan::MissingSpecRef
        );
        assert_eq!(
            plan_task_spec_archive(Some("   ")),
            ArchiveSpecPlan::MissingSpecRef
        );
    }


    #[test]
    fn spec_lifecycle_bootstrap_creates_expected_dirs_and_is_idempotent() {
        let workspace = tempdir().unwrap();
        bootstrap_task_spec_layout(workspace.path()).unwrap();
        for dir in [
            TASK_SPECS_OPEN_DIR,
            TASK_SPECS_IN_PROGRESS_DIR,
            TASK_SPECS_DONE_DIR,
        ] {
            assert!(workspace.path().join(dir).is_dir(), "missing {dir}");
        }
        bootstrap_task_spec_layout(workspace.path()).unwrap();
    }

    #[test]
    fn spec_lifecycle_bootstrap_rejects_unexpected_subdir() {
        let workspace = tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("brain/tasks/specs/other")).unwrap();
        let err = bootstrap_task_spec_layout(workspace.path()).unwrap_err();
        assert!(err.to_string().contains("unexpected subdir"));
    }

    #[test]
    fn spec_lifecycle_moves_structured_approved_open_spec_without_legacy_marker() {
        assert_eq!(
            plan_chat_spec_lifecycle_move(
                "brain/tasks/specs/open/example.md",
                "- [ ] **Approved by Tom**\n",
                true,
            ),
            ChatApprovalMovePlan::Move {
                from_rel: "brain/tasks/specs/open/example.md".to_string(),
                to_rel: "brain/tasks/specs/in-progress/example.md".to_string()
            }
        );
    }

    #[test]
    fn spec_lifecycle_legacy_marker_still_moves_without_structured_approval() {
        let checked = "- [x] **Approved by Tom**\n";
        assert_eq!(
            plan_chat_spec_lifecycle_move("brain/tasks/specs/open/example.md", checked, false,),
            ChatApprovalMovePlan::Move {
                from_rel: "brain/tasks/specs/open/example.md".to_string(),
                to_rel: "brain/tasks/specs/in-progress/example.md".to_string()
            }
        );
        assert_eq!(
            plan_chat_spec_lifecycle_move(
                "brain/tasks/specs/open/example.md",
                "- [ ] **Approved by Tom**\n",
                false,
            ),
            ChatApprovalMovePlan::Noop
        );
    }

    #[test]
    fn spec_lifecycle_never_plans_reverse_move() {
        let unchecked = "- [ ] **Approved by Tom**\n";
        assert_eq!(
            plan_chat_spec_lifecycle_move(
                "brain/tasks/specs/in-progress/example.md",
                unchecked,
                true,
            ),
            ChatApprovalMovePlan::AlreadyMoved {
                from_rel: "brain/tasks/specs/open/example.md".to_string(),
                to_rel: "brain/tasks/specs/in-progress/example.md".to_string()
            }
        );
        assert_eq!(
            plan_chat_spec_lifecycle_move("brain/tasks/specs/done/example.md", unchecked, true,),
            ChatApprovalMovePlan::Noop
        );
    }

    #[test]
    fn spec_lifecycle_archive_moves_only_in_progress_to_done() {
        let plan = plan_task_spec_archive(Some("brain/tasks/specs/in-progress/example.md"));
        match plan {
            ArchiveSpecPlan::Move {
                from_rel, to_rel, ..
            } => {
                assert_eq!(from_rel, "brain/tasks/specs/in-progress/example.md");
                assert_eq!(to_rel, "brain/tasks/specs/done/example.md");
            }
            other => panic!("expected move, got {other:?}"),
        }
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/open/example.md")),
            ArchiveSpecPlan::OpenSpecCannotArchive
        );
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/done/example.md")),
            ArchiveSpecPlan::AlreadyArchived
        );
    }

    #[test]
    fn rewrite_spec_line_replaces_old_path_with_new() {
        let description = "\
**Spec:** brain/tasks/specs/in-progress/example-2026.md

## Outcome

Whatever.
";
        let rewritten = rewrite_spec_line_in_description(
            description,
            "brain/tasks/specs/in-progress/example-2026.md",
            "brain/tasks/specs/done/example-2026.md",
        )
        .expect("rewrite should fire when paths differ");
        assert!(rewritten.contains("**Spec:** brain/tasks/specs/done/example-2026.md"));
        assert!(!rewritten.contains("**Spec:** brain/tasks/specs/in-progress/example-2026.md\n"));
    }

    #[test]
    fn lifecycle_spec_path_rewrite_preserves_approval_marker_and_acceptance_criteria() {
        let description = "\
**Spec:** brain/tasks/specs/open/example-2026.md
- [x] **Approved by Tom**

## Acceptance Criteria
- [ ] AC1: Keep this exact text
";
        let rewritten = rewrite_spec_line_in_description(
            description,
            "brain/tasks/specs/open/example-2026.md",
            "brain/tasks/specs/in-progress/example-2026.md",
        )
        .expect("open spec path should be rewritten");
        assert_eq!(
            rewritten,
            "**Spec:** brain/tasks/specs/in-progress/example-2026.md\n- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Keep this exact text\n"
        );
    }

    #[test]
    fn rewrite_spec_line_returns_none_when_already_archived() {
        let description = "\
**Spec:** brain/tasks/specs/done/example-2026.md

## Outcome

Whatever.
";
        let rewritten = rewrite_spec_line_in_description(
            description,
            "brain/tasks/specs/in-progress/example-2026.md",
            "brain/tasks/specs/done/example-2026.md",
        );
        assert!(rewritten.is_none(), "already archived must be a no-op");
    }

    #[test]
    fn rewrite_spec_line_returns_none_when_spec_line_missing() {
        let description = "## Outcome\nNo spec line here.\n";
        let rewritten = rewrite_spec_line_in_description(
            description,
            "brain/tasks/specs/in-progress/example-2026.md",
            "brain/tasks/specs/done/example-2026.md",
        );
        assert!(rewritten.is_none());
    }

    // ---- resolve_archive_plan (filesystem) ----

    #[test]
    fn resolve_archive_plan_moves_existing_spec_into_done() {
        let workspace = tempdir().unwrap();
        let live = workspace.path().join("brain/tasks/specs/in-progress");
        fs::create_dir_all(&live).unwrap();
        let src = live.join("example-2026.md");
        fs::write(&src, "# Example\n").unwrap();

        let plan = plan_task_spec_archive(Some("brain/tasks/specs/in-progress/example-2026.md"));
        let resolved = resolve_archive_plan(plan, workspace.path()).expect("plan resolves");
        let ArchiveSpecPlan::Move {
            from_abs, to_abs, ..
        } = resolved
        else {
            panic!("expected Move plan");
        };
        assert_eq!(from_abs, src);
        assert_eq!(
            to_abs,
            workspace
                .path()
                .join("brain/tasks/specs/done/example-2026.md")
        );
        // done/ dir is created on demand.
        assert!(to_abs.parent().unwrap().exists());
    }

    #[test]
    fn resolve_archive_plan_returns_not_task_spec_when_source_missing() {
        let workspace = tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("brain/tasks/specs")).unwrap();
        // Intentionally do not create the source file.
        let plan = plan_task_spec_archive(Some("brain/tasks/specs/missing-2026.md"));
        let resolved = resolve_archive_plan(plan, workspace.path()).expect("plan resolves");
        assert_eq!(resolved, ArchiveSpecPlan::NotTaskSpec);
    }

    // These tests moved to `pr_gates.rs` (W36 audit A3+A4 — module
    // extraction); the W36 A2 fail-closed tests live there too.
    // ---- AC1/AC2/AC3/AC4/AC5/AC6: archive_task_spec_for_done_task outcomes ----

    fn task_with_description(desc: &str) -> Task {
        Task {
            id: "test-task".to_string(),
            description: Some(desc.to_string()),
            ..Task::default()
        }
    }

    fn write_in_progress_spec(workspace: &Path, slug: &str, content: &str) -> PathBuf {
        let dir = workspace.join(TASK_SPECS_IN_PROGRESS_DIR);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(slug);
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn archive_spec_parses_inline_annotated_spec_line() {
        // AC3: legacy inline annotation form must remain parseable.
        let desc = "Some prose.\n\n**Spec:** brain/tasks/specs/in-progress/example.md (legacy inline note)\n\nAC1: ...";
        let parsed = product_spec_parsing::parse_product_spec_ref(desc).expect("must parse");
        assert_eq!(parsed.path, "brain/tasks/specs/in-progress/example.md");

        // Backtick-wrapped path with trailing comma.
        let desc2 = "**Spec:** `brain/tasks/specs/in-progress/foo.md`,\n";
        assert_eq!(
            product_spec_parsing::parse_product_spec_ref(desc2)
                .unwrap()
                .path,
            "brain/tasks/specs/in-progress/foo.md"
        );

        // Bracket annotation.
        let desc3 = "**Spec:** brain/tasks/specs/in-progress/bar.md [archived ticket]";
        assert_eq!(
            product_spec_parsing::parse_product_spec_ref(desc3)
                .unwrap()
                .path,
            "brain/tasks/specs/in-progress/bar.md"
        );

        // Whitespace-only annotation is still parseable.
        let desc4 = "**Spec:** brain/tasks/specs/in-progress/baz.md (a b c)";
        assert_eq!(
            product_spec_parsing::parse_product_spec_ref(desc4)
                .unwrap()
                .path,
            "brain/tasks/specs/in-progress/baz.md"
        );
    }

    #[test]
    fn archive_spec_rejects_unparseable_spec_line() {
        // Multi-token path with whitespace -> reject (returns None).
        assert!(product_spec_parsing::parse_product_spec_ref(
            "**Spec:** brain/tasks/specs/in-progress/foo bar.md"
        )
        .is_none());
        // Bracket-only residue (no path component) -> reject.
        assert!(product_spec_parsing::parse_product_spec_ref("**Spec:** (just a note)").is_none());
    }

    #[test]
    fn archive_task_spec_for_done_task_moves_eligible_spec() {
        let workspace = tempdir().unwrap();
        let slug = "happy-path-2026.md";
        let content = "# happy path\n";
        write_in_progress_spec(workspace.path(), slug, content);

        let desc = format!("**Spec:** brain/tasks/specs/in-progress/{slug}");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        match outcome {
            ArchiveOutcome::Moved { from_rel, to_rel } => {
                assert_eq!(from_rel, format!("brain/tasks/specs/in-progress/{slug}"));
                assert_eq!(to_rel, format!("brain/tasks/specs/done/{slug}"));
            }
            other => panic!("expected Moved, got {other:?}"),
        }

        // File moved; destination content matches source content.
        let done = workspace.path().join(TASK_SPECS_DONE_DIR).join(slug);
        assert!(done.exists());
        assert_eq!(fs::read_to_string(done).unwrap(), content);
        // Source no longer exists.
        assert!(!workspace
            .path()
            .join(TASK_SPECS_IN_PROGRESS_DIR)
            .join(slug)
            .exists());
    }

    #[test]
    fn archive_task_spec_for_done_task_treats_inline_annotation_as_movable() {
        let workspace = tempdir().unwrap();
        let slug = "inline-annotated-2026.md";
        write_in_progress_spec(workspace.path(), slug, "inline content\n");

        let desc =
            format!("**Spec:** brain/tasks/specs/in-progress/{slug} (legacy annotation preserved)");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        assert!(matches!(outcome, ArchiveOutcome::Moved { .. }));
    }

    #[test]
    fn archive_task_spec_for_done_task_idempotent_on_pre_existing_destination() {
        let workspace = tempdir().unwrap();
        let slug = "idempotent-2026.md";
        let content = "same content\n";
        write_in_progress_spec(workspace.path(), slug, content);
        // Pre-create destination with the same content.
        let done_dir = workspace.path().join(TASK_SPECS_DONE_DIR);
        fs::create_dir_all(&done_dir).unwrap();
        fs::write(done_dir.join(slug), content).unwrap();

        let desc = format!("**Spec:** brain/tasks/specs/in-progress/{slug}");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        match outcome {
            ArchiveOutcome::AlreadyArchived { to_rel } => {
                assert_eq!(to_rel, format!("brain/tasks/specs/done/{slug}"));
            }
            other => panic!("expected AlreadyArchived, got {other:?}"),
        }
    }

    #[test]
    fn archive_task_spec_for_done_task_surfaces_conflict_when_destination_differs() {
        let workspace = tempdir().unwrap();
        let slug = "conflict-2026.md";
        write_in_progress_spec(workspace.path(), slug, "new content\n");
        let done_dir = workspace.path().join(TASK_SPECS_DONE_DIR);
        fs::create_dir_all(&done_dir).unwrap();
        fs::write(done_dir.join(slug), "different content\n").unwrap();

        let desc = format!("**Spec:** brain/tasks/specs/in-progress/{slug}");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        match outcome {
            ArchiveOutcome::Conflict { from_rel, to_rel } => {
                assert_eq!(from_rel, format!("brain/tasks/specs/in-progress/{slug}"));
                assert_eq!(to_rel, format!("brain/tasks/specs/done/{slug}"));
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
        // Both files left in place.
        assert!(workspace
            .path()
            .join(TASK_SPECS_IN_PROGRESS_DIR)
            .join(slug)
            .exists());
        assert!(workspace
            .path()
            .join(TASK_SPECS_DONE_DIR)
            .join(slug)
            .exists());
    }

    #[test]
    fn archive_task_spec_for_done_task_returns_retryable_when_filesystem_fails() {
        let workspace = tempdir().unwrap();
        let slug = "fs-fail-2026.md";
        let in_progress = write_in_progress_spec(workspace.path(), slug, "fs fail content\n");
        // Make the in-progress file read-only so rename fails on macOS/Linux.
        let mut perms = fs::metadata(&in_progress).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&in_progress, perms).unwrap();

        let desc = format!("**Spec:** brain/tasks/specs/in-progress/{slug}");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());

        // The file may have been moved to done/ or still be at in-progress/ depending on
        // whether the readonly bit blocked the rename. Make both paths writable so the
        // tempdir cleanup doesn't fail. Using PermissionsExt::set_mode avoids the clippy
        // `permissions_set_readonly_false` warning (set_readonly(false) makes the file
        // world-writable on Unix).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for candidate in [
                in_progress.clone(),
                workspace.path().join(TASK_SPECS_DONE_DIR).join(slug),
            ] {
                if let Ok(meta) = fs::metadata(&candidate) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o644);
                    let _ = fs::set_permissions(&candidate, perms);
                }
            }
        }
        #[cfg(not(unix))]
        {
            for candidate in [
                in_progress.clone(),
                workspace.path().join(TASK_SPECS_DONE_DIR).join(slug),
            ] {
                if let Ok(meta) = fs::metadata(&candidate) {
                    let mut perms = meta.permissions();
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&candidate, perms);
                }
            }
        }

        // On some filesystems readonly rename still succeeds; only assert Retryable if rename failed.
        match outcome {
            ArchiveOutcome::Retryable { .. } => { /* expected when rename fails */ }
            ArchiveOutcome::Moved { .. } => {
                // Filesystem permitted the rename despite readonly bit (some FS allow it).
            }
            other => panic!("expected Retryable or Moved, got {other:?}"),
        }
    }

    #[test]
    fn archive_task_spec_for_done_task_skips_non_task_spec_paths() {
        let workspace = tempdir().unwrap();
        // Bookmark spec path is not a task spec.
        let desc = "**Spec:** brain/bookmarks/specs/example.md";
        let task = task_with_description(desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        assert!(matches!(
            outcome,
            ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::NotTaskSpec
            }
        ));
    }

    #[test]
    fn archive_task_spec_for_done_task_skips_open_spec_paths() {
        let workspace = tempdir().unwrap();
        let desc = "**Spec:** brain/tasks/specs/open/example.md";
        let task = task_with_description(desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        assert!(matches!(
            outcome,
            ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::OpenSpecCannotArchive
            }
        ));
    }

    #[test]
    fn archive_task_spec_for_done_task_treats_already_archived_as_noop() {
        let workspace = tempdir().unwrap();
        let desc = "**Spec:** brain/tasks/specs/done/example.md";
        let task = task_with_description(desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        match outcome {
            ArchiveOutcome::AlreadyArchived { to_rel } => {
                assert_eq!(to_rel, "brain/tasks/specs/done/example.md");
            }
            other => panic!("expected AlreadyArchived, got {other:?}"),
        }
    }

    #[test]
    fn archive_task_spec_for_done_task_handles_missing_spec_line() {
        let workspace = tempdir().unwrap();
        let desc = "No spec line here.\n\n## Outcome\n...";
        let task = task_with_description(desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        assert!(matches!(
            outcome,
            ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::UnparseableSpecLine
            }
        ));
    }

    #[test]
    fn rewrite_spec_line_in_description_preserves_inline_annotation() {
        let desc = "**Spec:** brain/tasks/specs/in-progress/foo.md (legacy inline note)";
        let updated = rewrite_spec_line_in_description(
            desc,
            "brain/tasks/specs/in-progress/foo.md",
            "brain/tasks/specs/done/foo.md",
        )
        .expect("must rewrite");
        assert!(
            updated.contains("brain/tasks/specs/done/foo.md"),
            "rewritten: {updated}"
        );
        assert!(
            updated.contains("(legacy inline note)"),
            "annotation must be preserved: {updated}"
        );
    }

}
