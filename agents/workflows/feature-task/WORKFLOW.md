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

## Brain checkbox → structured spec approval reconciliation

Before dispatching per-task workflows, `run.py` scans only
`brain/tasks/specs/open/*.md`. An exact checked marker — the
`- [x]` checkbox line whose label is `**Approved by Tom**` in a brain-spec
file — is treated as Tom's request to grant the linked
active feature task's structured `spec` approval. The reconciler requires one
exact `**Spec:**` link and confirms that the Tasks API policy requires `spec`
for feature tasks. It then writes through the authenticated approval endpoint;
the resulting `TaskApproval` row remains the sole workflow gate source.

The sweep is idempotent: an already-approved row produces no API write or
second audit comment. The per-task `spec-check` stage applies the same defensive
guard before legacy brain-spec/task-description reconciliation: if any actor
already owns an approved structured `spec` row, it skips that mutation entirely.
The fluid drift guard applies the same rule when checksum drift is non-fatal:
it does not revoke that authoritative approval through the workflow credential.
This preserves approval ownership and avoids retrying mutations with a principal
that cannot own `spec` approval, while continuing normal gate evaluation.
Unchecked markers, revoked API rows, missing or duplicate links, inaccessible
files, code tasks, and specs outside the open task-spec directory never grant
approval and are reported as diagnostics. A revoked API row is deliberately not
re-approved from a stale checked marker because API state is authoritative.

The existing feature-task runner performs this reconciliation once per pass,
so no separate cron is needed. Its environment must provide Tom's scoped
`TASKS_API_APPROVAL_TOKEN` (the runner also loads that key from
`~/.openclaw/.env`); the Tasks API still derives the actor and permitted
approval type.

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