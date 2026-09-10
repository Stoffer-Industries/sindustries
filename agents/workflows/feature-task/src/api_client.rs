//! HTTP client + envelope I/O surface for the feature-task workflow lobster.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a 7,796-line / 160-item god file"). This module hosts
//! the `ApiStatusError` structured error + its `Display`/`Error` impls,
//! the `Envelope` constructor (`output`) + stdin reader (`read_envelope`),
//! the `ureq`-backed HTTP helpers (`api_get`, `api_get_task`,
//! `authenticated_api_patch_request`, `api_patch`, `api_delete`,
//! `handle_api_result`, `api_status_error`), the lobster service token
//! resolver (`lobster_service_token`) + comment posting (`add_comment`),
//! and the `SPEC_CHECKSUM_MISMATCH` extractor
//! (`spec_checksum_mismatch_message`).
//!
//! `pub(crate)` surface (consumed by `main.rs`, `verify_delivery.rs`,
//! `feedback_aggregate.rs`, `post_merge.rs`, `brain_spec_lifecycle.rs`,
//! `product_spec_parsing.rs`, and the `mod tests` blocks in those
//! modules):
//!
//! - `output` — build the JSON envelope returned to stdout.
//! - `read_envelope` — read the previous-stage envelope from stdin.
//! - `api_get_task` — GET `/tasks/:id`.
//! - `api_patch` — PATCH `/tasks/:id` with `TASKS_API_APPROVAL_TOKEN`
//!   bearer (revoking or upserting structured approvals).
//! - `api_delete` — DELETE helper used to revoke a structured
//!   TaskApproval row (e.g. `DELETE /tasks/:id/approvals/spec` on spec
//!   drift).
//! - `add_comment` — POST a comment via the lobster's own service token.
//! - `spec_checksum_mismatch_message` — extract the `SPEC_CHECKSUM_MISMATCH`
//!   409 message from an API error.
//! - `ApiStatusError` (struct + `Display` + `Error`) — the structured
//!   surface used by `brain_spec_lifecycle::block_on_spec_drift_fluid` and
//!   the spec-resync flow.
//!
//! Private to this module:
//!
//! - `api_get` — internal generic JSON wrapper for `api_get_task`.
//! - `authenticated_api_patch_request` — sets the bearer header.
//! - `handle_api_result` — flattens `ureq::Error::Status` into
//!   `ApiStatusError`.
//! - `api_status_error` — builds `ApiStatusError` from a non-2xx
//!   `ureq::Response`.
//! - `lobster_service_token` — `FEATURE_TASK_LOBSTER_TOKEN` (actor
//!   `feature_task_lobster`) preferred; falls back to
//!   `TASKS_API_APPROVAL_TOKEN` (actor `Rowan`) when the per-agent
//!   token isn't provisioned yet.

use crate::{Envelope, LobsterState, Task};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fmt,
    io::{self, Read},
};

/// Structured representation of a non-2xx response from the Tasks API.
/// Carries the HTTP status, an optional machine-readable error code
/// (e.g. `SPEC_CHECKSUM_MISMATCH`), and the human-readable message.
/// Used by `spec_checksum_mismatch_message` and by `Display`/`Error`
/// impls so `anyhow!` chains surface the API context.
#[derive(Debug)]
pub(crate) struct ApiStatusError {
    status: u16,
    code: Option<String>,
    message: String,
}

impl fmt::Display for ApiStatusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.code {
            Some(code) => write!(f, "API returned {} {code}: {}", self.status, self.message),
            None => write!(f, "API returned {}: {}", self.status, self.message),
        }
    }
}

impl std::error::Error for ApiStatusError {}

/// Build the JSON envelope the lobster writes to stdout for every stage
/// handler. Centralized here so the constructor signature stays in one
/// place (callers pass `(criteria_met, already_past, action_taken,
/// task, lobster_state, failures)` rather than constructing the
/// `Envelope` literal directly).
pub(crate) fn output(
    criteria_met: bool,
    already_past: bool,
    action_taken: &str,
    task: Task,
    lobster_state: LobsterState,
    failures: Vec<String>,
) -> Envelope {
    Envelope {
        criteria_met,
        already_past,
        action_taken: action_taken.to_string(),
        task,
        lobster_state,
        failures,
    }
}

/// Read the previous-stage envelope from stdin. Each stage handler
/// consumes its predecessor's JSON envelope and emits a new one to
/// stdout.
pub(crate) fn read_envelope() -> Result<Envelope> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    serde_json::from_str(input.trim()).context("expected JSON envelope on stdin")
}

pub(crate) fn api_get<T: for<'de> Deserialize<'de>>(base_url: &str, path: &str) -> Result<T> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let value: Value = ureq::get(&url).call()?.into_json()?;
    serde_json::from_value(value.get("data").cloned().unwrap_or(value))
        .context("decode API response")
}

pub(crate) fn api_get_task(base_url: &str, task_id: &str) -> Result<Task> {
    api_get(base_url, &format!("/tasks/{task_id}"))
}

fn authenticated_api_patch_request(url: &str) -> ureq::Request {
    let mut request = ureq::patch(url);
    if let Ok(token) = std::env::var("TASKS_API_APPROVAL_TOKEN") {
        let token = token.trim();
        if !token.is_empty() {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
    }
    request
}

pub(crate) fn api_patch<T: for<'de> Deserialize<'de>>(
    base_url: &str,
    task_id: &str,
    payload: Value,
) -> Result<T> {
    let url = format!("{}/tasks/{task_id}", base_url.trim_end_matches('/'));
    let value: Value = handle_api_result(authenticated_api_patch_request(&url).send_json(payload))?;
    serde_json::from_value(value.get("data").cloned().unwrap_or(value))
        .context("decode API patch response")
}

/// DELETE wrapper used to revoke a structured TaskApproval row
/// (e.g. `DELETE /tasks/:id/approvals/spec` when spec drift is detected).
pub(crate) fn api_delete(base_url: &str, path: &str) -> Result<Value> {
    let token = std::env::var("TASKS_API_APPROVAL_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow!("TASKS_API_APPROVAL_TOKEN is required to revoke structured approvals")
        })?;
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    handle_api_result(
        ureq::delete(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .call(),
    )
}

/// Token used for the lobster's own service-identity calls (comments, the
/// `qa_agent` bootstrap gate): prefers the per-agent `FEATURE_TASK_LOBSTER_TOKEN`
/// (actor `feature_task_lobster`), falling back to the shared
/// `TASKS_API_APPROVAL_TOKEN` (actor `Rowan`) when the per-agent token isn't
/// provisioned yet.
fn lobster_service_token() -> Option<String> {
    std::env::var("FEATURE_TASK_LOBSTER_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("TASKS_API_APPROVAL_TOKEN")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

pub(crate) fn add_comment(base_url: &str, task_id: &str, text: &str) -> Result<()> {
    let url = format!(
        "{}/tasks/{task_id}/comments",
        base_url.trim_end_matches('/')
    );
    // The comment author is now derived from the authenticated session
    // (task 0719a8e3). Body-supplied author is rejected with 403 if it
    // disagrees with the authenticated actor, so we never set it here.
    let token = lobster_service_token().ok_or_else(|| {
        anyhow!(
            "FEATURE_TASK_LOBSTER_TOKEN (or TASKS_API_APPROVAL_TOKEN) is required to post comments"
        )
    })?;
    handle_api_result(
        ureq::post(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(json!({"text": text})),
    )?;
    Ok(())
}

pub(crate) fn handle_api_result(
    response: std::result::Result<ureq::Response, ureq::Error>,
) -> Result<Value> {
    match response {
        Ok(response) => Ok(response.into_json()?),
        Err(ureq::Error::Status(status, response)) => {
            Err(api_status_error(status, response)).context("API request failed")
        }
        Err(err) => Err(err).context("API request failed"),
    }
}

fn api_status_error(status: u16, response: ureq::Response) -> ApiStatusError {
    let fallback = response.status_text().to_string();
    let value = response.into_json::<Value>().ok();
    let code = value
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let message = value
        .as_ref()
        .and_then(|value| value.pointer("/error/message"))
        .and_then(Value::as_str)
        .unwrap_or(&fallback)
        .to_string();
    ApiStatusError {
        status,
        code,
        message,
    }
}

/// Extract the `SPEC_CHECKSUM_MISMATCH` 409 message from an API error.
/// Returns `Some(message)` only when the status is 409 AND the error
/// code is exactly `SPEC_CHECKSUM_MISMATCH` (the lobe distinguishes it
/// from the unrelated `SPEC_CHECKSUM_LOCKED` lock-out error used during
/// approval-flow guard windows).
pub(crate) fn spec_checksum_mismatch_message(err: &anyhow::Error) -> Option<String> {
    let api_err = err.downcast_ref::<ApiStatusError>()?;
    (api_err.status == 409 && api_err.code.as_deref() == Some("SPEC_CHECKSUM_MISMATCH"))
        .then(|| api_err.message.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_api_spec_checksum_mismatch_as_blocked_message() {
        let err = Err::<(), _>(ApiStatusError {
            status: 409,
            code: Some("SPEC_CHECKSUM_MISMATCH".to_string()),
            message: "ACs modified after spec approval".to_string(),
        })
        .context("API request failed")
        .unwrap_err();

        assert_eq!(
            spec_checksum_mismatch_message(&err).as_deref(),
            Some("ACs modified after spec approval")
        );
    }

    #[test]
    fn ignores_other_api_conflicts_for_spec_checksum_handling() {
        let err = Err::<(), _>(ApiStatusError {
            status: 409,
            code: Some("SPEC_CHECKSUM_LOCKED".to_string()),
            message: "specChecksum is locked".to_string(),
        })
        .context("API request failed")
        .unwrap_err();

        assert!(spec_checksum_mismatch_message(&err).is_none());
    }

    #[test]
    fn api_patch_request_uses_tasks_api_approval_token() {
        let previous = std::env::var_os("TASKS_API_APPROVAL_TOKEN");
        std::env::set_var("TASKS_API_APPROVAL_TOKEN", "test-service-token");

        let request = authenticated_api_patch_request("http://localhost/tasks/task-1");

        match previous {
            Some(value) => std::env::set_var("TASKS_API_APPROVAL_TOKEN", value),
            None => std::env::remove_var("TASKS_API_APPROVAL_TOKEN"),
        }
        assert_eq!(
            request.header("Authorization"),
            Some("Bearer test-service-token")
        );
    }

    #[test]
    fn lobster_service_token_prefers_feature_task_lobster_token() {
        let previous_lobster = std::env::var_os("FEATURE_TASK_LOBSTER_TOKEN");
        let previous_shared = std::env::var_os("TASKS_API_APPROVAL_TOKEN");
        std::env::set_var("FEATURE_TASK_LOBSTER_TOKEN", "lobster-token");
        std::env::set_var("TASKS_API_APPROVAL_TOKEN", "shared-token");

        let token = lobster_service_token();

        match previous_lobster {
            Some(value) => std::env::set_var("FEATURE_TASK_LOBSTER_TOKEN", value),
            None => std::env::remove_var("FEATURE_TASK_LOBSTER_TOKEN"),
        }
        match previous_shared {
            Some(value) => std::env::set_var("TASKS_API_APPROVAL_TOKEN", value),
            None => std::env::remove_var("TASKS_API_APPROVAL_TOKEN"),
        }
        assert_eq!(token.as_deref(), Some("lobster-token"));
    }

    #[test]
    fn lobster_service_token_falls_back_to_shared_token() {
        let previous_lobster = std::env::var_os("FEATURE_TASK_LOBSTER_TOKEN");
        let previous_shared = std::env::var_os("TASKS_API_APPROVAL_TOKEN");
        std::env::remove_var("FEATURE_TASK_LOBSTER_TOKEN");
        std::env::set_var("TASKS_API_APPROVAL_TOKEN", "shared-token");

        let token = lobster_service_token();

        match previous_lobster {
            Some(value) => std::env::set_var("FEATURE_TASK_LOBSTER_TOKEN", value),
            None => std::env::remove_var("FEATURE_TASK_LOBSTER_TOKEN"),
        }
        match previous_shared {
            Some(value) => std::env::set_var("TASKS_API_APPROVAL_TOKEN", value),
            None => std::env::remove_var("TASKS_API_APPROVAL_TOKEN"),
        }
        assert_eq!(token.as_deref(), Some("shared-token"));
    }
}
