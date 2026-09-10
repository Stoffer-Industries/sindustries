//! Brain-spec lifecycle for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a 7,796-line / 160-item god file"). This module hosts
//! the source-of-truth state machine for the brain-spec archive + chat-approval
//! lifecycle, the spec-drift AC4 resync flow, the cross-stage manual-block
//! helper, and the structured spec re-approval detection.
//!
//! `pub(crate)` surface (consumed by `main.rs`, `feedback_aggregate.rs`,
//! `post_merge.rs`, and `verify_delivery.rs`):
//!
//! - `archive_done_task_spec` — done-transition stage handler.
//! - `archive_done_task_specs_sweep` — reconciliation sweep CLI.
//! - `block_on_spec_drift_fluid` — fluid spec-drift block.
//! - `publish_spec_approval_handoff` — explicit workflow handoff to Tom.
//! - `manual_block_failures` / `block_with_manual_block` — `blocked: true`
//!   gate failure path.
//! - `structured_spec_reapproval_after_auto_revoke` — Tasks-API-side spec
//!   re-approval detection.
//! - `resync_spec_and_reset_checksum` — AC4 brain-spec resync.
//! - `safe_brain_spec_path` / `replace_ac_section` / `atomic_write` /
//!   `refresh_task_spec_checksum` / `reset_task_spec_checksum` — resync helpers.
//! - `is_typescript_spec_path` / `task_product_spec_is_typescript_spec` —
//!   spec-type branching.
//! - `apply_archive_outcome` / `rewrite_description_and_refresh` /
//!   `to_in_progress_relative` / `post_spec_archive_retryable` /
//!   `post_spec_archive_conflict` — archive outcome plumbing.
//! - `list_done_tasks` / `percent_encode_assignee` — sweep CLI helpers.
//!
//! Brain-spec lifecycle types stay in this module because they are read
//! from `main.rs` dispatch (see `crate::brain_spec_lifecycle::StageArgs`,
//! `ArchiveDoneTaskSpecsSweepArgs`, etc.). A future `ac_parsing.rs` extraction
//! may move the `ac_parsing::*` helpers back into `main.rs`; for now they
//! remain co-located with the rest of the brain-spec surface.

use crate::analytics;
use crate::product_spec_parsing::{
    acceptance_criteria_checksum, acceptance_criteria_text, brain_spec_approved_by_tom,
    drift_episode_fingerprint, latest_resync_record_matches_drift, product_spec, spec_checksum,
    spec_checksum_failures, task_is_open, workspace_root,
};
use crate::task_approvals;
use crate::{
    add_comment, api_delete, api_get_task, api_patch, archive_task_spec_for_done_task, comment_text,
    rewrite_spec_line_in_description, spec_checksum_mismatch_message, workflow_handoff, write_state,
    ArchiveDoneTaskSpecsSweepArgs, ArchiveOutcome, Envelope, LobsterState, StageArgs, Task,
    BRAIN_DIR, TASK_SPECS_DONE_DIR, TASK_SPECS_IN_PROGRESS_DIR,
};
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn archive_done_task_spec(args: &StageArgs, mut env: Envelope) -> Result<Envelope> {
    let outcome = archive_task_spec_for_done_task(&env.task, workspace_root(args));
    apply_archive_outcome(&mut env, args, &outcome);
    Ok(env)
}

/// Apply an [`ArchiveOutcome`] to the envelope: rewrite the description when
/// appropriate, post task comments on retryable / conflict outcomes, and
/// record a structured `action_taken` for the heartbeat summary.
pub(crate) fn apply_archive_outcome(
    env: &mut Envelope,
    args: &StageArgs,
    outcome: &ArchiveOutcome,
) {
    match outcome {
        ArchiveOutcome::Moved { from_rel, to_rel } => {
            rewrite_description_and_refresh(env, args, from_rel, to_rel);
            env.action_taken = "post_merge_archived_task_spec".to_string();
        }
        ArchiveOutcome::AlreadyArchived { to_rel } => {
            let from_rel = to_in_progress_relative(to_rel);
            rewrite_description_and_refresh(env, args, &from_rel, to_rel);
            env.action_taken = "post_merge_archive_already_present".to_string();
        }
        ArchiveOutcome::NotApplicable { reason } => {
            env.action_taken = format!("post_merge_archive_noop_{}", reason.as_tag());
        }
        ArchiveOutcome::Retryable {
            from_rel,
            to_rel,
            reason,
        } => {
            post_spec_archive_retryable(args, env, from_rel, to_rel, reason);
        }
        ArchiveOutcome::Conflict { from_rel, to_rel } => {
            post_spec_archive_conflict(args, env, from_rel, to_rel);
        }
    }
}

pub(crate) fn to_in_progress_relative(to_rel: &str) -> String {
    if let Some(suffix) = to_rel.strip_prefix(TASK_SPECS_DONE_DIR) {
        format!("{TASK_SPECS_IN_PROGRESS_DIR}{suffix}")
    } else {
        to_rel.to_string()
    }
}

pub(crate) fn rewrite_description_and_refresh(
    env: &mut Envelope,
    args: &StageArgs,
    from_rel: &str,
    to_rel: &str,
) {
    if args.dry_run {
        env.action_taken = "would_archive_task_spec".to_string();
        return;
    }
    let description = env.task.description.clone().unwrap_or_default();
    let new_description = match rewrite_spec_line_in_description(&description, from_rel, to_rel) {
        Some(d) => d,
        None => return,
    };
    if new_description == description {
        return;
    }
    if let Err(err) = api_patch::<Task>(
        &args.base_url,
        &env.task.id,
        json!({"description": new_description}),
    ) {
        env.failures
            .push(format!("description rewrite failed: {err}"));
        return;
    }
    if let Err(err) = api_get_task(&args.base_url, &env.task.id).map(|t| env.task = t) {
        env.failures
            .push(format!("refresh after rewrite failed: {err}"));
    }
}

pub(crate) fn post_spec_archive_retryable(
    args: &StageArgs,
    env: &mut Envelope,
    from_rel: &str,
    to_rel: &str,
    reason: &str,
) {
    env.action_taken = "post_merge_archive_retryable".to_string();
    env.criteria_met = false;
    env.failures
        .push(format!("spec archive retryable: {reason}"));
    if args.dry_run {
        return;
    }
    let fingerprint = format!("spec_archive_retryable:{from_rel}:{to_rel}:{reason}");
    if env.lobster_state.failure_fingerprint.as_deref() == Some(&fingerprint) {
        return;
    }
    env.lobster_state.failure_fingerprint = Some(fingerprint);
    let body = format!(
        "[spec-archive-retryable]\nfrom: {from_rel}\nto: {to_rel}\nreason: {reason}\nretry: the next reconciliation sweep will retry automatically; resolve the underlying filesystem access issue to clear.\n"
    );
    let _ = add_comment(&args.base_url, &env.task.id, &body);
    let _ = write_state(&args.base_url, &env.task.id, &env.lobster_state, None);
}

pub(crate) fn post_spec_archive_conflict(
    args: &StageArgs,
    env: &mut Envelope,
    from_rel: &str,
    to_rel: &str,
) {
    env.action_taken = "post_merge_archive_conflict".to_string();
    env.criteria_met = false;
    env.failures
        .push(format!("spec archive conflict at {to_rel}"));
    if args.dry_run {
        return;
    }
    let fingerprint = format!("spec_archive_conflict:{from_rel}:{to_rel}");
    if env.lobster_state.failure_fingerprint.as_deref() == Some(&fingerprint) {
        return;
    }
    env.lobster_state.failure_fingerprint = Some(fingerprint);
    let body = format!(
        "[spec-archive-conflict]\nfrom: {from_rel}\nto: {to_rel}\nreason: destination already exists with different content; both files left in place.\naction: resolve the content mismatch and run the reconciliation sweep again.\n"
    );
    let _ = add_comment(&args.base_url, &env.task.id, &body);
    let _ = write_state(&args.base_url, &env.task.id, &env.lobster_state, None);
}

/// Reconciliation sweep: visit every `status=done` task (optionally filtered
/// by `--assignee`) and archive any spec still under
/// `brain/tasks/specs/in-progress/`. Used to close the historical backlog and
/// to recover when a single `post_merge` run skipped the archive step (e.g.
/// the recent iCloud/TCC `Operation not permitted` incident). Idempotent —
/// already-archived specs return `AlreadyArchived` and are no-ops.
///
/// Output envelope's `action_taken` is one of:
/// - `archive_sweep_summary: scanned=<n> moved=<n> already=<n> retryable=<n> conflict=<n> not_applicable=<n>`
pub(crate) fn archive_done_task_specs_sweep(
    args: ArchiveDoneTaskSpecsSweepArgs,
) -> Result<Envelope> {
    let base_url = args.base_url.trim_end_matches('/').to_string();
    let assignee_filter = args
        .assignee
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let tasks = list_done_tasks(&base_url, assignee_filter)?;
    let mut moved = 0usize;
    let mut already = 0usize;
    let mut retryable = 0usize;
    let mut conflict = 0usize;
    let mut not_applicable = 0usize;
    let mut failures: Vec<String> = Vec::new();
    let stage_args = StageArgs {
        base_url: args.base_url.clone(),
        dry_run: args.dry_run,
        repo: args.repo.clone(),
        workspace_root: args.workspace_root.clone(),
    };
    let workspace = workspace_root(&stage_args);

    for task in &tasks {
        let outcome = archive_task_spec_for_done_task(task, workspace);
        let mut env = Envelope {
            task: task.clone(),
            ..Envelope::default()
        };
        apply_archive_outcome(&mut env, &stage_args, &outcome);
        match &outcome {
            ArchiveOutcome::Moved { .. } => moved += 1,
            ArchiveOutcome::AlreadyArchived { .. } => already += 1,
            ArchiveOutcome::Retryable {
                from_rel,
                to_rel,
                reason,
            } => {
                retryable += 1;
                failures.push(format!(
                    "{} ({} -> {}): {}",
                    env.task.id, from_rel, to_rel, reason
                ));
            }
            ArchiveOutcome::Conflict { from_rel, to_rel } => {
                conflict += 1;
                failures.push(format!(
                    "{} conflict {} -> {}",
                    env.task.id, from_rel, to_rel
                ));
            }
            ArchiveOutcome::NotApplicable { .. } => not_applicable += 1,
        }
    }

    let envelope = Envelope {
        criteria_met: retryable == 0 && conflict == 0,
        already_past: false,
        action_taken: format!(
            "archive_sweep_summary: scanned={} moved={} already={} retryable={} conflict={} not_applicable={}",
            tasks.len(),
            moved,
            already,
            retryable,
            conflict,
            not_applicable
        ),
        task: Task::default(),
        lobster_state: LobsterState::default(),
        failures,
    };
    Ok(envelope)
}

pub(crate) fn list_done_tasks(base_url: &str, assignee: Option<&str>) -> Result<Vec<Task>> {
    let mut url = format!("{}/tasks?status=done&limit=10000", base_url);
    if let Some(a) = assignee {
        url.push_str("&assignee=");
        url.push_str(&percent_encode_assignee(a));
    }
    let body: Value = ureq::get(&url).call()?.into_json()?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut tasks = Vec::new();
    for item in data {
        let task: Task = serde_json::from_value(item)?;
        tasks.push(task);
    }
    Ok(tasks)
}

/// Percent-encode an assignee filter value. Assignee names are alphanumeric
/// display names; only a small set of characters can land in the URL: space,
/// `+`, `&`, `#`. Encode just those to avoid a full URL-escape dependency.
pub(crate) fn percent_encode_assignee(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '+' => out.push_str("%2B"),
            '&' => out.push_str("%26"),
            '#' => out.push_str("%23"),
            other => out.push(other),
        }
    }
    out
}

pub(crate) fn is_typescript_spec_path(spec_path: &str) -> bool {
    let path = spec_path.trim();
    path.ends_with("_spec.ts") || path.ends_with(".spec.ts")
}

pub(crate) fn task_product_spec_is_typescript_spec(task: &Task) -> bool {
    product_spec(task)
        .map(|spec| is_typescript_spec_path(&spec.path))
        .unwrap_or(false)
}

pub(crate) fn safe_brain_spec_path(spec_path_str: &str, workspace_root: &Path) -> Result<PathBuf> {
    let stripped = spec_path_str.trim();
    if stripped.is_empty() {
        return Err(anyhow!("brain spec path is empty"));
    }
    if !stripped.ends_with(".md") {
        return Err(anyhow!(
            "brain spec path `{stripped}` must end in `.md`; refusing to rewrite `{spec_path_str}`"
        ));
    }
    if stripped.contains("..") {
        return Err(anyhow!(
            "brain spec path `{stripped}` must not contain `..`; refusing to rewrite `{spec_path_str}`"
        ));
    }

    let target = if Path::new(stripped).is_absolute() {
        PathBuf::from(stripped)
    } else {
        if !stripped.starts_with("brain/") {
            return Err(anyhow!(
                "brain spec path `{stripped}` is not inside `{BRAIN_DIR}/`; refusing to rewrite"
            ));
        }
        workspace_root.join(Path::new(stripped))
    };

    // The file's parent must already exist before resync can rewrite the file.
    // Canonicalise the parent so symlinked brain directories are handled safely
    // without allowing a task description to escape the workspace brain.
    let canonical_workspace =
        fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf());
    let canonical_brain = fs::canonicalize(canonical_workspace.join(BRAIN_DIR))
        .unwrap_or_else(|_| canonical_workspace.join(BRAIN_DIR));
    let canonical_parent = target
        .parent()
        .ok_or_else(|| anyhow!("brain spec path `{}` has no parent", target.display()))?
        .canonicalize()
        .with_context(|| format!("canonicalizing brain spec parent `{}`", target.display()))?;
    if !canonical_parent.starts_with(&canonical_brain) {
        return Err(anyhow!(
            "brain spec path `{}` resolves outside of `{}`; refusing to rewrite",
            target.display(),
            canonical_brain.display()
        ));
    }
    Ok(target)
}

/// Replace the Acceptance Criteria section of a brain spec markdown file
/// with the supplied AC lines. If the section is missing it is appended at
/// the end so the next write still produces a clean spec. The function does
/// NOT touch any non-AC content (front-matter, headings above the AC section,
/// prose between sections, headings below). Returns the rewritten content.
///
/// `ac_lines` are the full bullet text WITHOUT the `- [ ] ` checkbox prefix
/// (matching the format used elsewhere for `acceptance_criteria_text`). Each
/// line is wrapped with `- [ ] ` and trimmed.
pub(crate) fn replace_ac_section(content: &str, ac_lines: &[String]) -> String {
    // Header regex captures the leading hash run so we know the section level.
    const HEADER_PATTERN: &str = r"(?im)^\s{0,3}(#{1,6})\s+Acceptance Criteria\s*:?\s*$\n?";
    let header_re = Regex::new(HEADER_PATTERN).expect("header pattern compiles");

    // Compute the new AC block as lines.
    let mut new_block_lines: Vec<String> = ac_lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| format!("- [ ] {line}"))
        .collect();
    if new_block_lines.is_empty() {
        // Nothing to put in the AC section — preserve the existing content
        // unchanged so we never erase ACs the spec relies on.
        return content.to_string();
    }

    if let Some(header_cap) = header_re.captures(content) {
        let header_match = header_cap.get(0).unwrap();
        let header_level = header_cap.get(1).unwrap().as_str().len();
        // Only headings at the captured level or higher end the AC section.
        // Deeper headings (`### …`, `#### …`, …) belong to the section's body
        // and must not truncate the rewrite.
        let closer_pattern = format!(r"(?m)^\s{{0,3}}#{{1,{header_level}}}\s+\S");
        let next_re = Regex::new(&closer_pattern).unwrap_or_else(|e| {
            panic!("closer pattern compiles for header level {header_level}: {e}")
        });
        let section_start = header_match.end();
        let tail = &content[section_start..];
        let next_match = next_re.find(tail);
        let section_end = next_match.map_or(content.len(), |m| section_start + m.start());
        let head = &content[..section_start];
        let tail = &content[section_end..];
        // Trim trailing whitespace-only lines in the head before injecting
        // bullets, so the new bullets sit on their own line.
        let head_trimmed = head.trim_end_matches('\n');
        let mut out =
            String::with_capacity(head.len() + new_block_lines.len() * 40 + tail.len() + 8);
        out.push_str(head_trimmed);
        out.push('\n');
        for line in &new_block_lines {
            out.push_str(line);
            out.push('\n');
        }
        // Ensure exactly one blank line separates the AC block from the next
        // heading (or end of file).
        let tail_trimmed = tail.trim_start_matches('\n');
        if !tail_trimmed.is_empty() {
            out.push('\n');
            out.push_str(tail_trimmed);
        }
        return out;
    }

    // No `## Acceptance Criteria` heading: append a new section at the end.
    new_block_lines.insert(0, String::from("## Acceptance Criteria"));
    new_block_lines.push(String::new()); // trailing blank line
    let mut out = content.trim_end_matches('\n').to_string();
    out.push_str("\n\n");
    for line in &new_block_lines {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Write `content` to `path` atomically: write to a sibling temp file, then
/// rename onto the target. Avoids leaving the brain spec half-written if the
/// process is killed mid-write.
pub(crate) fn atomic_write(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create parent directory for {}", path.display()))?;
    }
    let mut tmp = path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "spec".to_string());
    let tmp_name = format!(".{}.resync-{}", file_name, std::process::id());
    tmp.set_file_name(tmp_name);
    fs::write(&tmp, content)
        .with_context(|| format!("write temp file {} during atomic write", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| {
        format!(
            "rename {} -> {} during atomic write",
            tmp.display(),
            path.display()
        )
    })?;
    Ok(())
}

/// Re-snapshot the spec checksum on the task object so subsequent
/// `spec_checksum_failures` calls evaluate against the resync-cleared value.
pub(crate) fn refresh_task_spec_checksum(task: &mut Task) {
    task.spec_checksum = Some(spec_checksum(task));
}

/// Reset the task's stored `specChecksum` to `new_checksum` via a two-step
/// PATCH: first `{specChecksum: null}` to clear the locked value, then
/// `{specChecksum: <new sha256>}` to set the new one. The Tasks API rejects
/// non-null mutations of an already-locked `specChecksum` with
/// `SPEC_CHECKSUM_LOCKED` (409), so the clear step is mandatory.
pub(crate) fn reset_task_spec_checksum(
    base_url: &str,
    task_id: &str,
    new_checksum: &str,
) -> Result<Task> {
    api_patch::<Task>(base_url, task_id, json!({"specChecksum": null}))?;
    api_patch::<Task>(base_url, task_id, json!({"specChecksum": new_checksum}))
}

/// Run the AC4 resync flow: rewrite the brain spec AC section from the
/// task description, reset `task.specChecksum` to the matching sha256, and
/// post a `[spec-resynced]` comment that records the checksum + drift
/// fingerprint of this episode. Returns an envelope with `criteria_met =
/// true` on success so the caller can stop blocking the workflow. On
/// failure the envelope carries a single failure describing what went
/// wrong; the caller turns that into the standard blocked-spec-drift
/// response.
pub(crate) fn resync_spec_and_reset_checksum(
    args: &StageArgs,
    mut env: Envelope,
    drift_failures: &[String],
    drift_fingerprint: &str,
    _repo: &Path,
) -> Result<Envelope> {
    let task_id = env.task.id.clone();
    let base_url = args.base_url.clone();
    let workspace_root = workspace_root(args).to_path_buf();

    // 1. Resolve and validate the spec path.
    let spec = product_spec(&env.task).ok_or_else(|| {
        anyhow!("task description is missing `**Spec:** <path>.md` line; cannot resync")
    })?;
    let spec_path = match safe_brain_spec_path(&spec.path, &workspace_root) {
        Ok(path) => path,
        Err(err) => {
            return Ok(Envelope {
                criteria_met: false,
                already_past: env.already_past,
                action_taken: "spec_resync_blocked_unsafe_path".to_string(),
                task: env.task.clone(),
                lobster_state: env.lobster_state.clone(),
                failures: vec![format!(
                    "Refusing to resync brain spec at `{}`: {err}. Tom must rewrite the spec by hand.",
                    spec.path
                )],
            });
        }
    };

    // 2. Compute the new AC lines from the task description.
    let description = env.task.description.clone().unwrap_or_default();
    let ac_lines = acceptance_criteria_text(&description);
    if ac_lines.is_empty() {
        return Ok(Envelope {
            criteria_met: false,
            already_past: env.already_past,
            action_taken: "spec_resync_blocked_no_acs".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![
                "Task description has no acceptance criteria; cannot resync spec.".to_string(),
            ],
        });
    }
    let new_checksum = acceptance_criteria_checksum(&ac_lines);
    // The legacy `- [x] **Approved by Tom**` marker no longer lives in task
    // descriptions (e2aba106 WS1 froze the description-handling surface and
    // WS2 removed the lobster's reads/writes of the task-description checkbox).
    // Pass AC lines through verbatim so the brain spec's AC section is rebuilt
    // from the same source the checksum was computed over.
    let spec_ac_lines: Vec<String> = ac_lines.to_vec();

    // 2b. Validate the product spec still claims to be approved by Tom before we
    //     overwrite its AC section. If Tom has since flipped the spec to
    //     unapproved, refuse so the workflow cannot blindly overwrite a
    //     rolled-back artifact.
    let pre_existing_text = match fs::read_to_string(&spec_path) {
        Ok(text) => text,
        Err(err) => {
            return Ok(Envelope {
                criteria_met: false,
                already_past: env.already_past,
                action_taken: "spec_resync_blocked_read_failed".to_string(),
                task: env.task.clone(),
                lobster_state: env.lobster_state.clone(),
                failures: vec![format!(
                    "Could not read brain spec at `{}`: {err}.",
                    spec_path.display()
                )],
            });
        }
    };
    if !brain_spec_approved_by_tom(&pre_existing_text) {
        return Ok(Envelope {
            criteria_met: false,
            already_past: env.already_past,
            action_taken: "spec_resync_blocked_spec_revoked".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![format!(
                "Brain spec at `{}` is no longer marked Approved by Tom; refusing to resync.",
                spec_path.display()
            )],
        });
    }

    if args.dry_run {
        return Ok(Envelope {
            criteria_met: true,
            already_past: env.already_past,
            action_taken: "spec_resync_dry_run".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![format!(
                "dry-run: would rewrite `{}` with {} AC line(s) and set checksum to `{}`.",
                spec_path.display(),
                ac_lines.len(),
                new_checksum
            )],
        });
    }

    // 3. Rewrite the AC section atomically. We do this BEFORE the API PATCH
    //    so a write failure cannot leave the task with a freshly-reset
    //    checksum and a stale spec on disk.
    let rewritten = replace_ac_section(&pre_existing_text, &spec_ac_lines);
    if rewritten != pre_existing_text {
        if let Err(err) = atomic_write(&spec_path, &rewritten) {
            return Ok(Envelope {
                criteria_met: false,
                already_past: env.already_past,
                action_taken: "spec_resync_blocked_write_failed".to_string(),
                task: env.task.clone(),
                lobster_state: env.lobster_state.clone(),
                failures: vec![format!(
                    "Could not rewrite brain spec at `{}`: {err}.",
                    spec_path.display()
                )],
            });
        }
    }

    // 4. Reset the stored `specChecksum` via two-step PATCH (clear + set).
    match reset_task_spec_checksum(&base_url, &task_id, &new_checksum) {
        Ok(updated) => env.task = updated,
        Err(err) => {
            return Ok(Envelope {
                criteria_met: false,
                already_past: env.already_past,
                action_taken: "spec_resync_blocked_checksum_reset_failed".to_string(),
                task: env.task.clone(),
                lobster_state: env.lobster_state.clone(),
                failures: vec![format!(
                    "Brain spec was rewritten but the Tasks API rejected the checksum reset: {err}."
                )],
            });
        }
    }
    if env.task.spec_checksum.as_deref() != Some(&new_checksum) {
        let actual = env
            .task
            .spec_checksum
            .clone()
            .unwrap_or_else(|| "<null>".to_string());
        return Ok(Envelope {
            criteria_met: false,
            already_past: env.already_past,
            action_taken: "spec_resync_blocked_checksum_mismatch".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![format!(
                "Tasks API reported a different `specChecksum` than expected: got `{actual}`, wanted `{new_checksum}`."
            )],
        });
    }

    // 5. Post the `[spec-resynced]` comment with the current episode binding.
    let drift_summary = drift_failures.join(" / ");
    let trimmed_summary: String = drift_summary.chars().take(280).collect();
    let resync_comment = format!(
        "[spec-resynced] {summary}\nchecksum={checksum}\ndriftFingerprint={fp}\n",
        summary = trimmed_summary,
        checksum = new_checksum,
        fp = drift_fingerprint,
    );
    if let Err(err) = add_comment(&base_url, &task_id, &resync_comment) {
        return Ok(Envelope {
            criteria_met: false,
            already_past: env.already_past,
            action_taken: "spec_resync_blocked_comment_failed".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![format!(
                "Brain spec was rewritten and `specChecksum` was reset, but posting the `[spec-resynced]` comment failed: {err}."
            )],
        });
    }

    // 6. Refresh the in-memory task and clear drift state for the next episode.
    refresh_task_spec_checksum(&mut env.task);
    env.lobster_state.spec_drift_uncheck_applied = Some(false);
    env.lobster_state.failure_fingerprint = None;

    Ok(Envelope {
        criteria_met: true,
        already_past: env.already_past,
        action_taken: "spec_resynced".to_string(),
        task: env.task.clone(),
        lobster_state: env.lobster_state.clone(),
        failures: Vec::new(),
    })
}

/// Block on spec drift with the fluid AC lifecycle behaviour: detect drift,
/// uncheck the approval marker when present, and post a checklist comment
/// summarising the drift. Returns `None` if drift is fully cleared
/// (marker re-checked and Quinn has resynced).
pub(crate) fn block_on_spec_drift_fluid(
    args: &StageArgs,
    mut env: Envelope,
    action: &str,
) -> Result<Option<Envelope>> {
    // Code tasks intentionally do not participate in the product-spec
    // lifecycle. Their pipeline shares the delivery/feedback stages with
    // feature tasks, but must not run feature-task spec checksum or approval
    // handling here. In particular, historical `specChecksum` values on a
    // code task must not make the shared stages require a `spec` approval.
    if env.task.task_type.as_deref() == Some("code") {
        return Ok(None);
    }
    let raw_failures = spec_checksum_failures(&env.task);
    if raw_failures.is_empty() {
        return Ok(None);
    }
    if task_is_open(&env.task) {
        // Open tasks keep the legacy hard-block behaviour; no marker tracking.
        env.criteria_met = false;
        env.action_taken = format!("{action}_blocked_spec_drift");
        env.failures = raw_failures;
        return Ok(Some(env));
    }
    // e2aba106 WS2: the legacy description PATCH that auto-unchecked
    // `**Approved by Tom**` is gone. The TypeScript-spec branch still surfaces a
    // hard block (Quinn must resync manually via `[spec-resynced]`); the message
    // wording is unchanged so existing `[spec-resynced]`-bound tests stay valid.
    if task_product_spec_is_typescript_spec(&env.task) {
        env.criteria_met = false;
        env.action_taken = format!("{action}_blocked_spec_drift");
        let mut failures = raw_failures;
        failures.push(
            "Spec drift was detected for a TypeScript spec test file; the lobster will not auto-uncheck `**Approved by Tom**` for `_spec.ts`/`.spec.ts` specs. Resolve the drift manually or post a fresh `[spec-resynced]` record."
                .to_string(),
        );
        env.failures = failures;
        publish_spec_approval_handoff(args, &mut env)?;
        return Ok(Some(env));
    }
    // e2aba106 WS2: approval state is now exclusively structured TaskApproval
    // rows. The legacy `- [x] **Approved by Tom**` checkbox is no longer read
    // from the task description; the lobster looks up the `spec` approval row
    // and routes the drift response through the structured API.
    let spec_approval = env
        .task
        .approvals
        .iter()
        .find(|a| a.approval_type == "spec");
    let spec_is_approved = spec_approval.is_some_and(|a| a.state == "approved");
    if spec_is_approved {
        // Drift + approved spec. Three sub-cases:
        //   (a) WE previously revoked this approval (state flag set) and Tom
        //       has now re-approved it on the new spec — run resync.
        //   (b) A `[spec-resynced]` comment exists whose bound fingerprint
        //       matches the current drift episode and whose checksum matches
        //       the stored checksum — trust the comment, allow progress.
        //   (c) Otherwise this is the first time we've seen this drift
        //       episode: revoke the spec approval via DELETE, post a
        //       checklist, and set the uncheck-applied flag so a later
        //       re-approval triggers resync. Stale `[spec-resynced]`
        //       comments from previous episodes fall into the revoke branch.
        let fingerprint = drift_episode_fingerprint(&raw_failures);
        let we_actioned_episode = env.lobster_state.spec_drift_uncheck_applied == Some(true);
        let api_reapproval_after_auto_revoke =
            structured_spec_reapproval_after_auto_revoke(&env.task);
        let fresh_resync_record = latest_resync_record_matches_drift(
            &env.task,
            &fingerprint,
            env.task.spec_checksum.as_deref(),
        );

        // Dry-run fast path: report what would happen without writing.
        if args.dry_run {
            if we_actioned_episode
                || api_reapproval_after_auto_revoke
                || fresh_resync_record
                || task_approvals::spec_check_should_skip_legacy_mutation(&env.task)
            {
                return Ok(None);
            }
            env.criteria_met = false;
            env.action_taken = format!("{action}_blocked_spec_drift");
            env.failures = raw_failures;
            return Ok(Some(env));
        }

        if we_actioned_episode || api_reapproval_after_auto_revoke || fresh_resync_record {
            // Case (a) or (b): resync is appropriate.
            return match resync_spec_and_reset_checksum(
                args,
                env,
                &raw_failures,
                &fingerprint,
                &args.repo,
            ) {
                Ok(resynced) => {
                    // Return Some in both success and soft-failure cases so
                    // the caller can update its in-memory env with the fresh
                    // task and lobster_state. Callers check criteria_met to
                    // decide whether to bail out or continue.
                    Ok(Some(resynced))
                }
                Err(err) => Err(err),
            };
        }

        // Case (c): first encounter of this drift episode. As with the
        // spec-check legacy-mutation guard above, an already-approved
        // structured spec is authoritative. Checksum drift alone is
        // non-fatal here, so do not revoke that approval through the
        // workflow credential (which may intentionally be scoped to Quinn's
        // tech-design approval only). A future explicit approval lifecycle
        // action may still move this task into case (a) or (b).
        if task_approvals::spec_check_should_skip_legacy_mutation(&env.task) {
            return Ok(None);
        }

        let mut failures = raw_failures.clone();
        failures.push(
            "Structured `spec` TaskApproval is still approved and `[spec-resynced]` has not been posted. \
             Quinn will revoke the structured approval; after that, Tom must re-approve `spec` via POST /tasks/:id/approvals on the new spec."
                .to_string(),
        );
        env.criteria_met = false;
        env.action_taken = format!("{action}_blocked_spec_drift");
        env.failures = failures.clone();
        // Idempotency: only DELETE + comment when the fingerprint changes.
        let joined_fingerprint = failures.join("\n");
        let already_acted = env.lobster_state.failure_fingerprint.as_deref()
            == Some(&joined_fingerprint)
            && env
                .lobster_state
                .spec_drift_uncheck_applied
                .unwrap_or(false);
        if !already_acted {
            if let Err(err) = api_delete(
                &args.base_url,
                &format!("/tasks/{}/approvals/spec", env.task.id),
            ) {
                if let Some(message) = spec_checksum_mismatch_message(&err) {
                    // Tasks-api rejected the DELETE (e.g. ACs also changed).
                    // Surface that as a hard block.
                    env.criteria_met = false;
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(Some(env));
                }
                return Err(err);
            }
            env.task = api_get_task(&args.base_url, &env.task.id)?;
            env.lobster_state.spec_drift_uncheck_applied = Some(true);
        }
        publish_spec_approval_handoff(args, &mut env)?;
        let checklist = format!(
            "[feature-task-progress-checklist]\n{}\n",
            failures.join("\n")
        );
        if env.lobster_state.failure_fingerprint.as_deref() != Some(&joined_fingerprint) {
            if let Err(err) = add_comment(&args.base_url, &env.task.id, &checklist) {
                if let Some(message) = spec_checksum_mismatch_message(&err) {
                    // Should not happen because comments are now drift-tolerant,
                    // but treat any 409 as a hard block anyway.
                    env.criteria_met = false;
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(Some(env));
                }
                return Err(err);
            }
            env.lobster_state.failure_fingerprint = Some(joined_fingerprint);
        }
        write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
        Ok(Some(env))
    } else {
        // No approved `spec` TaskApproval (either revoked or absent).
        // Hard-block until Tom approves via the structured API.
        env.criteria_met = false;
        env.action_taken = format!("{action}_blocked_spec_drift");
        env.failures = vec!["Structured `spec` TaskApproval is missing or revoked. \
             Approve via POST /tasks/:id/approvals (type=spec) before drift can be re-evaluated."
            .to_string()];
        publish_spec_approval_handoff(args, &mut env)?;
        Ok(Some(env))
    }
}

/// A spec-drift block can happen in any active lifecycle state, so it cannot
/// rely on the normal open → ready transition to publish ownership. Persist
/// the same explicit handoff used by the queue classifier so task cards show
/// Tom whenever the workflow is waiting on his spec approval, including when
/// the task is already in `doing` or `acceptance`.
pub(crate) fn publish_spec_approval_handoff(args: &StageArgs, env: &mut Envelope) -> Result<()> {
    if args.dry_run {
        return Ok(());
    }
    api_patch::<Task>(
        &args.base_url,
        &env.task.id,
        json!({
            "workflowHandoff": workflow_handoff(
                "product_spec_approver",
                "spec",
                "Product spec approval is required",
            )
        }),
    )?;
    env.task = api_get_task(&args.base_url, &env.task.id)?;
    Ok(())
}

/// Return true when the Tasks API already revoked the structured spec
/// approval after an AC edit and Tom subsequently approved it again.
///
/// API-side AC edits cannot set the lobster's local
/// `spec_drift_uncheck_applied` flag, so the ordered immutable audit comments
/// are the durable cross-system evidence for this path. The Tasks API returns
/// comments oldest-first; require its exact auto-revoke audit followed by its
/// exact approval audit. Structured approval state remains the gate source.
pub(crate) fn structured_spec_reapproval_after_auto_revoke(task: &Task) -> bool {
    if !task
        .approvals
        .iter()
        .any(|approval| approval.approval_type == "spec" && approval.state == "approved")
    {
        return false;
    }

    let mut saw_auto_revoke = false;
    for comment in &task.comments {
        match comment_text(comment).trim() {
            "Approval spec revoked by Tasks API after acceptance criteria changed." => {
                saw_auto_revoke = true;
            }
            "Approval spec approved by Tom." if saw_auto_revoke => return true,
            _ => {}
        }
    }
    false
}

pub(crate) fn manual_block_failures(task: &Task) -> Vec<String> {
    if task.blocked {
        vec![
            "Task is manually blocked (`blocked: true`); clear the block to allow progression. \
             (`dependencyBlocked` is a separate computed flag and is not affected.)"
                .to_string(),
        ]
    } else {
        Vec::new()
    }
}

/// `comment_tag` is the bracket tag written on the manual-block comment
/// (e.g. `[feature-task-blocked]` or `[code-task-blocked]`).
pub(crate) fn block_with_manual_block(
    args: &StageArgs,
    mut env: Envelope,
    action: &str,
    failures: Vec<String>,
    comment_tag: &str,
) -> Result<Envelope> {
    env.criteria_met = false;
    env.action_taken = format!("{action}_blocked");
    env.failures = failures.clone();
    if args.dry_run {
        return Ok(env);
    }
    let fingerprint = failures.join("\n");
    if env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
        env.lobster_state.failure_fingerprint = Some(fingerprint);
        if let Err(err) = add_comment(
            &args.base_url,
            &env.task.id,
            &format!("{comment_tag}\n{}", failures.join("\n")),
        ) {
            if let Some(message) = spec_checksum_mismatch_message(&err) {
                env.action_taken = format!("{action}_blocked_spec_drift");
                env.failures = vec![message];
                return Ok(env);
            }
            return Err(err);
        }
        if let Err(err) = write_state(&args.base_url, &env.task.id, &env.lobster_state, None) {
            if let Some(message) = spec_checksum_mismatch_message(&err) {
                env.action_taken = format!("{action}_blocked_spec_drift");
                env.failures = vec![message];
                return Ok(env);
            }
            return Err(err);
        }
    }
    // Best-effort analytics emission (AC2): manual blocks are also gate
    // failures from the analytics perspective. Capacity-classified by
    // `classify_failure` since the body always contains "blocked: true".
    analytics::emit_gate_failure_events(args, &env.task, action, &env.failures);
    Ok(env)
}
