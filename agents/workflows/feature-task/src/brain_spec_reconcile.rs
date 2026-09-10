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
