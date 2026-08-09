# feature-task workflow — local development

This crate (`feature-task`) ships the Rust implementation that the Python
`run.py` wraps. Use this guide when you change Rust code under
`agents/workflows/feature-task/src/`.

## Quality gates

CI enforces two gates on PRs that touch `agents/workflows/feature-task/**`:

1. **`cargo test`** — runs in `.github/workflows/ci.yml` (`feature-task-workflow-tests`).
2. **`cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings`** — runs in `.github/workflows/feature-task-clippy.yml` (`feature-task clippy`).

Both must be green before the PR can move to acceptance. See
[`../../docs/specs/feature-task-clippy-ci-gate-tech-design.md`](../../docs/specs/feature-task-clippy-ci-gate-tech-design.md)
for the gate rollout plan and `CLIPPY_NOTES.md` for the baseline cleanup
inventory.

## Local commands

Run from the repository root:

```bash
# Compile + run the Rust unit tests (matches `feature-task-workflow-tests`).
cargo test --manifest-path agents/workflows/feature-task/Cargo.toml

# Run clippy with warnings as errors (matches `feature-task clippy`).
cargo clippy \
  --manifest-path agents/workflows/feature-task/Cargo.toml \
  --all-targets \
  -- -D warnings
```

Both commands must exit zero locally before pushing. If clippy fails, fix the
warning before requesting review — temporary exceptions must be called out in
the PR description with a documented rationale.

## Lobster PR-body evidence gate (opt-in)

Set `CLIPPY_ENFORCE=true` to make the lobster's `verify_delivery` stage
require a PR-body line containing the canonical clippy command for any PR
that touches `agents/workflows/feature-task/**`:

```
cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings
```

The gate is **off by default** — it ships disabled so the rollout can be
flipped on once the CI gate has been green for ≥1 week. When the gate is
enabled and a Rust workflow PR omits the evidence line, the lobster emits
`[feature-task-progress-checklist] missing clippy evidence for Rust workflow PR. Run: <command>`.

PR-body matching is anchored on the exact command string (not on markdown
structure), so the matching line can live anywhere in the PR body — inside
or outside a code fence. Non-Rust / content-only PRs are skipped outright.

## When the gate was added

See task `cbe3333a-4982-456a-85c6-54a0844fb3f5` (Add feature-task clippy CI
gate). The baseline that made the gate green landed in `1a0fc7df` (Clean
feature-task clippy baseline); see `CLIPPY_NOTES.md` for the warning inventory
that was addressed.

## Related docs

- `CLIPPY_NOTES.md` — baseline cleanup inventory and remaining `#[allow(...)]`
  annotations.
- `code-task.lobster.yaml`, `feature-task.lobster.yaml` — lobster configs that
  run this binary in CI/dev.
- `run.py` — Python orchestrator that invokes the binary.