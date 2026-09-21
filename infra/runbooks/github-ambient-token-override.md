# Runbook — Ambient `GITHUB_TOKEN` overriding per-agent `GH_CONFIG_DIR` identity

**Status:** in-progress structural fix (PR #TBD per task b0d1b42e).
**Pattern-slug:** `ambient-gh-token-overrides-profile`
**Factory-retro score:** 15 (5 occurrences × weight 3) — highest-impact pattern of the 2026-09-14 pass.

## What this looks like

A fresh agent session (most commonly Rowan) runs:

```sh
GH_CONFIG_DIR=~/.config/gh-rowan gh api user --jq .login
```

…and gets back `quinnstoffer` instead of `rowanstoffer`. The PR or review comment is then authored by the wrong identity. Symptom classes:

1. `gh pr create` opens a PR as `quinnstoffer` despite the prefix.
2. `gh pr review --approve` is rejected as a self-review because GitHub sees the reviewer as the PR author (case study: PR #658, 2026-09-13).
3. `gh pr list --author rowanstoffer` returns empty even though PRs exist.

## Why it happens

`gh` resolves credentials in this order (highest priority first):

1. `GH_TOKEN` / `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` env vars.
2. `GH_CONFIG_DIR`/hosts.yml profile (`oauth_token` / `token` field).
3. Keyring / secure store.

The bare `GITHUB_TOKEN` Quinn exports from `~/.openclaw/.env` is a `repo`-scoped classic PAT. It wins over any per-agent `GH_CONFIG_DIR=~/.config/gh-<agent>` config. The prefix alone does not unset the env var; the agent must `unset GITHUB_TOKEN GH_TOKEN` (or wrap with `env -u …`) for the per-agent identity to take effect.

## How to recover when it bites

Until the structural fix lands, the per-agent manual workaround is:

```sh
unset GITHUB_TOKEN GH_TOKEN
GH_CONFIG_DIR=~/.config/gh-rowan GH_TOKEN="$ROWAN_GITHUB_TOKEN" gh api user --jq .login
# expect: rowanstoffer
```

Substitute the agent token env var for the agent actually running the command (`ROWAN_GITHUB_TOKEN`, `ASH_GITHUB_TOKEN`, `IVY_GITHUB_TOKEN`). This costs 3–12 minutes per occurrence because the PR or comment usually has to be closed/reopened or amended. Do **not** rely on `gh auth switch` — it does not change the env-var precedence.

## Structural fix (PR #TBD, task b0d1b42e)

A shared shell shim at `agents/lib/gh-with-agent-token.sh` is sourced at every agent's session-init. It wraps `gh` so that:

- `GITHUB_TOKEN` and `GH_TOKEN` are unset in the child process (so the per-agent `GH_TOKEN` wins).
- `GH_CONFIG_DIR` is set to `~/.config/gh-<agent>`.
- `GH_TOKEN` is set to `$<AGENT>_GITHUB_TOKEN` (already part of the env contract).

Allow-list: `rowan`, `ash`, `ivy`. Quinn and Lox are intentionally absent — their documented write-op convention depends on the ambient `GITHUB_TOKEN` being authoritative.

Graceful degradation: when `<AGENT>_GITHUB_TOKEN` is unset (gateway hasn't propagated the per-agent scope yet), the shim still unsets the ambient vars before falling back to `command gh`, so the agent does not silently authenticate as the wrong identity — they get a `gh auth required` error instead of an attribution bug.

## Observability (AC3)

The retro-notes pattern slug `ambient-gh-token-overrides-profile` is the durable regression signal. Anyone who hits this bug and writes a fresh retro-note (`brain/ops/retro-notes/<date>.md`) using that slug will be picked up by the next `factory-retro` weekly scan and re-opened as a feature task. AC3 of task b0d1b42e is satisfied when zero new occurrences are logged for 7 days post-fix — that window starts when the gateway-side per-agent token scoping lands (Quinn-orchestrated follow-up).

## Affected PRs (evidence)

PR #584 / #585 (2026-09-08), #602 / #616 / #617 (2026-09-10), #645 / #646 / #647 / #650 / #651 / #652 / #653 / #654 (2026-09-12 cluster), #658 (2026-09-13 — self-review rejection case study). Full occurrence history: `brain/ops/retro-notes/2026-09-08.md`, `2026-09-10.md`, `2026-09-12.md`, `2026-09-13.md`, `2026-09-14.md`.
