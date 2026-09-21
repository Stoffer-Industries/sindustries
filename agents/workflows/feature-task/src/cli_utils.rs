//! CLI dispatch / load_task / pr_body / gh_command helpers for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W38 audit follow-up, finding A3:
//! "Feature-task `main.rs` remains a god file after W37 A3 first tranche
//! — second tranche required to bring `main.rs` below ~3,000 lines").
//! This module hosts the three small CLI-adjacency helpers that don't
//! fit into any of the per-stage carved modules:
//! - `gh_command()` — build a `std::process::Command` for `gh` using the
//!   explicit feature-task CLI identity. Used by `pr_body`,
//!   `product_spec_parsing::inspect_pr`,
//!   and `analytics::gh_pr_body`.
//! - `pr_body(url)` — fetch the body of a GitHub PR via `gh pr view`,
//!   routed through `pr_gates::decode_pr_body_output` for the markdown
//!   normalisation. Used by `post_merge` and `verify_delivery`.
//! - `load_task(base_url, task_id)` — dispatch handler for the
//!   `load-task` subcommand: `GET /tasks/{id}`, parse the lobster state,
//!   wrap into the standard envelope.
//!
//! `pub(crate)` surface (only `main.rs` and sibling modules consume
//! these). `gh_command` stays public because four sibling modules read
//! it; the other two are read by `post_merge` / `verify_delivery`
//! (`pr_body`) and `main` only (`load_task`).
//!
//! Tech design: `docs/specs/feature-task-main-rs-carve-w38-tech-design.md`
//! Slice 2 of the W38+ second tranche.

use anyhow::{anyhow, Result};
use std::process::Command;

use crate::api_client;
use crate::lobster_state;
use crate::pr_gates;
use crate::{Envelope, Task};

/// Build a `std::process::Command` for `gh` using the feature-task identity.
/// `gh` gives token environment variables precedence over `GH_CONFIG_DIR`, so
/// remove them to prevent an ambient gateway credential from changing the
/// account that owns the read. Kept as `pub(crate)` because four sibling
/// modules read it.
pub(crate) fn gh_command() -> Command {
    let mut cmd = Command::new("gh");
    let config_dir = std::env::var("FEATURE_TASK_GH_CONFIG_DIR")
        .unwrap_or_else(|_| "~/.config/gh-quinn".to_string());
    let config_dir = if let Some(home) = std::env::var_os("HOME") {
        config_dir.replace('~', &home.to_string_lossy())
    } else {
        config_dir
    };
    cmd.env("GH_CONFIG_DIR", config_dir)
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN");
    cmd
}

/// Fetch the body of a GitHub PR via `gh pr view --json body --jq .body`,
/// routed through `pr_gates::decode_pr_body_output` for the markdown
/// normalisation that downstream AC parsers expect.
pub(crate) fn pr_body(url: &str) -> Result<String> {
    let output = gh_command()
        .args(["pr", "view", url, "--json", "body", "--jq", ".body"])
        .output()?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string()));
    }
    let raw = String::from_utf8(output.stdout)?;
    Ok(pr_gates::decode_pr_body_output(&raw))
}

/// Dispatch handler for the `load-task` subcommand: `GET /tasks/{id}`,
/// parse the lobster state, wrap into the standard envelope.
pub(crate) fn load_task(base_url: &str, task_id: &str) -> Result<Envelope> {
    let task: Task = api_client::api_get(base_url, &format!("/tasks/{task_id}"))?;
    let state = lobster_state::parse_lobster_state(&task);
    Ok(api_client::output(
        true,
        false,
        "loaded_task",
        task,
        state,
        vec![],
    ))
}
