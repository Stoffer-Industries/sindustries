# Runbook — Agent GitHub identity profile declared but never provisioned

**Status:** structural fix in flight (graceful degradation in `agent_task_queue.py`).
**Pattern-slug:** `agent-github-identity-profile-unprovisioned`
**Applies to:** any agent in `GITHUB_IDENTITIES` (`agents/skills/ops/tasks-api/scripts/agent_task_queue.py`) whose `~/.config/gh-<agent>` profile dir or `*_GITHUB_TOKEN` env var is absent.

## What this looks like

```sh
python3 agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Lox --json
```

…dies with a bare traceback ending in `subprocess.CalledProcessError` /
`exit status 4`, from:

```
gh api 'repos/Stoffer-Industries/sindustries/pulls?state=open&per_page=100'
```

## Why it happens

`GITHUB_IDENTITIES` is a **static map** in the queue script. Adding an agent to it
is a code change that *assumes* a credential exists. Three preconditions must all
hold, and none of them are checked:

1. `~/.config/gh-<agent>/` directory exists (`gh auth status` succeeds).
2. `<AGENT>_GITHUB_TOKEN` is present in `~/.openclaw/.env` and exported.
3. The GitHub account actually exists (a `gh api users/<agent>stoffer` 404 means
   the account was never created — a human action, not a code action).

If any is missing, the whole `gh api` call fails and takes the **entire JSON
queue** down with it — even though the Tasks API half of the queue was healthy.

This is why the class recurs: commit `7863feff` added Lox to `GITHUB_IDENTITIES`
to fix `agent-task-queue-rejects-lox-attention-owner-2026-09-09`. The code
support landed; the credential never did. The crash was masked until a later
`gh`-path refactor made it fatal.

## Ordering rule: enrichment must never destroy the queue

`fetch_github_prs` and `fetch_linked_delivery_prs` are **enrichment layered on top
of** the Tasks API queue. A missing GitHub profile is a degradation of *richness*,
not of *existence*. The structural fix therefore:

- checks provisioning up front via `_is_identity_provisioned()` (profile dir **or**
  token env present) and returns `[]` with a WARN instead of raising;
- catches `_GhApiTimeout` and `subprocess.CalledProcessError` per-URL in the
  fan-out hydration so one bad PR link cannot abort its siblings;
- surfaces `prHydrationDegraded: "<reason>"` in the JSON envelope so callers do
  not have to infer the cause from empty PR-derived fields.

The marker covers **both** degradation causes, because both otherwise produce an
envelope byte-identical to "genuinely no open PRs":

| `prHydrationDegraded`                     | Meaning                                                    |
| ----------------------------------------- | ---------------------------------------------------------- |
| `unprovisioned`                            | Neither `~/.config/gh-<agent>` nor `<AGENT>_GITHUB_TOKEN`   |
| `gh-api-failure: exit <n>`                 | Provisioned, but `gh api` exited non-zero (revoked/expired token, auth failure) |
| `gh-api-failure: timed out after <n>s`     | Provisioned, but `gh api` exceeded `_GH_API_TIMEOUT_SECONDS`  |
| *absent*                                  | Hydration ran; an empty PR section genuinely means no open PRs |

Callers must treat an empty `reviewRequests` / `authoredPrFeedback` section as
**unknown**, not empty, whenever this key is present.

## How to diagnose

```sh
ls -d ~/.config/gh-<agent>                                   # profile dir?
env | grep -i '<AGENT>_GITHUB_TOKEN'                          # token exported?
GH_CONFIG_DIR=~/.config/gh-<agent> gh auth status              # logged in?
env -u GITHUB_TOKEN -u GH_TOKEN gh api users/<agent>stoffer   # account exists? (404 = no)
```

Note the `env -u GITHUB_TOKEN -u GH_TOKEN` prefix — without it an **ambient**
`GITHUB_TOKEN` masks the per-agent profile entirely. That is a separate class of
fault; see [`github-ambient-token-override.md`](./github-ambient-token-override.md).

## How to fully fix (human action)

The durable fix is provisioning the identity, not degrading around it:

1. Create the GitHub account (or an org-owned agent bot account).
2. Provision `~/.config/gh-<agent>` and `<AGENT>_GITHUB_TOKEN` in
   `~/.openclaw/.env`.
3. Re-run `agent_task_queue.py --assignee <agent> --json` and confirm
   `prHydrationDegraded` is absent and PR hydration is populated.

Degradation is the safety net so an unprovisioned account costs *queue richness*
instead of *the whole heartbeat duty*. Do not treat a green heartbeat as
"identity healthy" while this flag is set.

## Related incidents

- `lox-github-identity-unconfigured-2026-10-20` — latent, blast radius verified
  zero-miss at time of opening (0 tasks named Lox in `attentionOwners`).
- `ivy-github-identity-unconfigured-keyring-invalid-2026-09-12` — Ivy's variant:
  profile existed, keyring credential was invalid.
