# feature-task workflow

This document is the working agreement for changes that touch `agents/workflows/feature-task/`. Other workflows are out of scope.

## Scope

Any pull request that edits files under `agents/workflows/feature-task/**` — Rust source, fixtures, Cargo manifests, or this workflow's own docs — must satisfy the Rust quality gates below **before the PR is opened or marked ready for review**.

## Rust quality gates

Run both commands locally from the repo root. Both must exit zero before opening or readoing a PR:

```bash
# Tests
cargo test --manifest-path agents/workflows/feature-task/Cargo.toml

# Clippy (deny warnings; equivalent to the CI gate from task cbe3333a)
cargo clippy \
  --manifest-path agents/workflows/feature-task/Cargo.toml \
  --all-targets \
  -- -D warnings
```

A passing local run is the bar for opening the PR. If CI exposes a clippy regression the same PR opened, fix it before requesting review — do not punt the fix to a follow-up.

## Review-readiness rule

Clippy failures must be fixed before review unless the PR explicitly documents an accepted temporary exception in the PR body (for example: a `#[allow(...)]` annotation with a stated rationale, or a deferred-cleanup note linked to a tracked task). An unannotated failure blocks review.

The same rule applies to `cargo test` failures: a green test run is required to mark the PR ready.

## Out of scope

This requirement does **not** apply to PRs that do not touch Rust source in this workflow:

- Content-only PRs (markdown in `apps/<app>/**`, `docs/**`, etc.) — no Rust changes, no clippy run.
- PRs limited to other workflows under `agents/workflows/` that have their own Rust crates — those workflows are responsible for their own gates.
- PRs limited to YAML/JSON configuration that does not change Rust behaviour.

When in doubt: if the diff does not change a `.rs` file under `agents/workflows/feature-task/src/`, skip the Rust gates.

## Related

- CI gate workflow: `.github/workflows/feature-task-clippy.yml` (task `cbe3333a`).
- Baseline cleanup notes: `agents/workflows/feature-task/CLIPPY_NOTES.md` (task `1a0fc7df`).
- PR-opening guidance template: `agents/skills/dev/pr-open/SKILL.md` (Validation section).