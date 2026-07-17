---
status: draft
task_id: 436e3c2f-d593-4e58-a4b0-0abcc39778d4
product_spec: brain/tasks/specs/in-progress/lobster-pr-body-json-decode-2026-07-17.md
shipped_pr: null
shipped_date: null
---

# Tech Design: Lobster `pr_body` JSON-decode fix

**Task:** 🔧 🐛 Lobster pr_body: handle JSON-encoded gh output  
**Task ID:** `436e3c2f-d593-4e58-a4b0-0abcc39778d4`  
**Branch:** `task-436e3c2f-lobster-pr-body-json-decode`  
**Worktree:** `~/workspaces/rowan/sindustries-task-436e3c2f-lobster-pr-body-json-decode`  
**Repo:** `Stoffer-Industries/sindustries`

---

## Product intent

> The feature-task lobster's `verify_delivery` gate correctly parses PR bodies regardless of how gh encodes the output. Currently, PR bodies containing certain Unicode characters (e.g. `→`) cause gh 2.87.3's `--jq .body` to emit a JSON-encoded string (quote-wrapped, `\n` escaped) instead of raw text. The lobster's `pr_body()` function passes this directly to regex matchers, which then fail to find any line-boundary matches.

Source: `brain/tasks/specs/in-progress/lobster-pr-body-json-decode-2026-07-17.md`

---

## `.openclaw` boundary notes

None. This fix is entirely within the `sindustries` repo. No `.openclaw` config changes, no gateway restarts, no cross-repo changes.

---

## Root cause

`pr_body()` at `agents/workflows/feature-task/src/main.rs:2884` runs:

```
gh pr view <url> --json body --jq .body
```

When the PR body contains non-ASCII Unicode (e.g. `→`), gh 2.87.3 occasionally emits the `jq`-evaluated result as a JSON-encoded string: the value is surrounded by double quotes, and newlines are represented as `\n`. Example output:

```
"## Acceptance Criteria\n- [x] AC1: The lobster → thing\n"
```

Rather than:

```
## Acceptance Criteria
- [x] AC1: The lobster → thing
```

`body_has_checked_acceptance()` and the AC regex matchers all use `(?m)^` multiline anchors. These anchors match against real newlines, not the two-character sequence `\n`. Consequently, when gh emits the JSON-encoded form, no AC lines are found and the gate emits:

> PR <url> does not show checked acceptance criteria in its body.

---

## Implementation plan

**Scope: `agents/workflows/feature-task/src/main.rs`, `pr_body()` function only.**

### Change

After collecting `output.stdout` from gh, check whether the trimmed UTF-8 string starts with `"`. If it does, attempt to JSON-decode it as a `serde_json::Value::String` and use the decoded string as the body. If decoding fails, fall through to the raw string (preserving current behaviour for any unexpected gh output format).

The crate already imports `serde_json` (see line 6), so no new dependency is needed.

```rust
fn pr_body(url: &str) -> Result<String> {
    let output = Command::new("gh")
        .args(["pr", "view", url, "--json", "body", "--jq", ".body"])
        .output()?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string()));
    }
    let raw = String::from_utf8(output.stdout)?;
    // gh 2.87.3 sometimes emits a JSON-encoded string (quote-wrapped, \n-escaped)
    // when the PR body contains non-ASCII Unicode. Transparently decode it.
    let trimmed = raw.trim();
    if trimmed.starts_with('"') {
        if let Ok(serde_json::Value::String(decoded)) = serde_json::from_str(trimmed) {
            return Ok(decoded);
        }
    }
    Ok(raw)
}
```

### Why this is safe

- `serde_json` is already a dependency; no Cargo.toml change.
- The check is gated on the string starting with `"`, which raw (unencoded) PR bodies never do — they start with markdown content.
- If `serde_json::from_str` fails or returns a non-string variant (e.g. the body genuinely starts with `"`), we fall through and return the raw string unchanged.
- No other callers of `pr_body()` are affected; the function signature and return type are unchanged.
- `body_has_checked_acceptance()` and all AC regex matchers receive real newline-separated text in both the existing case and the JSON-encoded case after this fix.

### Files changed

| File | Change |
|---|---|
| `agents/workflows/feature-task/src/main.rs` | `pr_body()` — add JSON-decode fast path |

No other files change.

---

## Data model / API contract changes

None. The Tasks API, lobster YAML config, task state schema, and envelope format are all unchanged.

---

## Workflow, cron, and skill changes

None.

---

## Test plan

### AC verification matrix

| AC | Description | Test layer | Test location | Approach |
|---|---|---|---|---|
| AC1 | `verify_delivery` does not report "does not show checked acceptance criteria" for a PR body with `→` and correctly formatted AC checkboxes | Manual / integration | — | After shipping, run lobster against task `b179c0e3`; confirm it advances to `acceptance`. AC2 verifies this indirectly. |
| AC2 | Task `b179c0e3` advances from `doing` to `acceptance` on next lobster run after fix ships | Manual / integration | — | Observe lobster heartbeat result after merge. |
| AC3 | A unit test covers the case where `pr_body` output starts with `"` (JSON-encoded) and confirms the body is correctly decoded to raw text with real newlines | Unit | `agents/workflows/feature-task/src/main.rs`, `mod tests` | See below |

**Why E2E is not chosen for AC1/AC2:** The `pr_body()` function shells out to `gh`, which requires a live GitHub PR and authenticated CLI. Mocking the subprocess in Rust unit tests would require significant scaffolding not present in this codebase. The unit test for AC3 validates the decode logic in isolation; AC1 and AC2 are verified by the natural lobster run post-merge, which is the most direct signal available.

### AC3 unit test

The existing `mod tests` block is at `src/main.rs:3098`. The new test goes there, adjacent to the other parser/body tests. It cannot call `pr_body()` directly (subprocess), so the decode logic will be extracted into a small pure helper:

```rust
/// Decode the raw stdout of `gh pr view --jq .body` into a PR body string.
/// gh 2.87.3+ sometimes JSON-encodes the body (quote-wrapped, \n-escaped)
/// when the body contains non-ASCII Unicode. This function transparently
/// handles both the raw and JSON-encoded forms.
fn decode_pr_body_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('"') {
        if let Ok(serde_json::Value::String(decoded)) = serde_json::from_str(trimmed) {
            return decoded;
        }
    }
    raw.to_string()
}
```

`pr_body()` calls `decode_pr_body_output(&raw)`. The test:

```rust
#[test]
fn pr_body_decode_handles_json_encoded_output() {
    // gh 2.87.3 emits a JSON-encoded string when the body contains Unicode like →
    let gh_output = "\"## Acceptance Criteria\\n- [x] AC1: foo → bar (not tested: unit)\\n\"";
    let decoded = decode_pr_body_output(gh_output);
    assert!(decoded.contains('\n'), "decoded body must contain real newlines");
    assert!(
        body_has_checked_acceptance(&decoded),
        "body_has_checked_acceptance must match after decode"
    );
    // Raw (non-encoded) output must pass through unchanged
    let raw = "## Acceptance Criteria\n- [x] AC1: foo (not tested: unit)\n";
    assert_eq!(decode_pr_body_output(raw), raw);
}
```

---

## Open questions and risks

| # | Question / Risk | Assessment |
|---|---|---|
| 1 | Could a PR body legitimately start with a `"` character? | Extremely unlikely in practice — markdown bodies start with headings or prose. The `serde_json::from_str` fallthrough handles the edge case safely. |
| 2 | Does gh 2.87.3 always JSON-encode on non-ASCII, or only sometimes? | The spec notes this is observed behaviour; the fix handles both cases regardless of frequency. |
| 3 | Could future gh versions change the encoding behaviour again? | The decode logic is additive (raw strings still pass through); a future version reverting to raw would just hit the fallthrough branch. No fragility introduced. |
| 4 | Is `serde_json::from_str` on a non-JSON string expensive? | Negligible. It's called at most once per PR URL per lobster run, and fails fast on the first invalid byte. |
