# TOOLS.md - Local Notes


Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Identities

Rowan has different names in different systems — use the right one per system, not the GitHub login everywhere:

- **GitHub login:** `rowanstoffer` (`GH_CONFIG_DIR=~/.config/gh-rowan`)
- **Tasks API `assignee` value:** `Rowan` (capitalized first name — NOT the GitHub login; e.g. `?assignee=Rowan`, not `?assignee=rowanstoffer`)
- **Telegram account:** `rowan` (`channels.telegram.accounts.rowan`)

## Tasks API

- **Credential env:** `ROWAN_TASKS_API_APPROVAL_TOKEN`, stored in `~/.openclaw/.env`. The Tasks API client auto-selects this token when the Rowan runtime identity is available; for explicit programmatic writes, pass it as `token=` to `tasks_api_client.py`'s `api_request`/`service_token_env` helpers (or as the bearer token on raw `curl`/`httpx` calls) so comments and writes attribute to `Rowan`, not Quinn.
- **Do not fall back to the shared `TASKS_API_APPROVAL_TOKEN`** for your own actions — that one authenticates as Quinn. It existed server-side (`TASKS_API_APPROVAL_SERVICE_CREDENTIALS`, actor `Rowan`) before this env var was added on 2026-08-21; if a session predates that, `[implementer-prs]` comments and similar writes will show up misattributed to Quinn — same bug class as PR #497's comment on task `782d778e`.

## GitHub

- **Account:** rowanstoffer
- **GH_CONFIG_DIR:** `~/.config/gh-rowan`
- **Token:** there is NO `ROWAN_GITHUB_TOKEN` in `~/.openclaw/.env` (verified 2026-11-14 — the only `*GITHUB_TOKEN` key in that file is `GITHUB_WEBHOOK_SECRET`). The working credential is the one the `gh` profile `~/.config/gh-rowan` holds (host keyring). Check that profile without allowing an ambient token to select another account: `env -u GITHUB_TOKEN -u GH_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-rowan" gh auth status`.
- Repo access: Stoffer-Industries/sindustries (Contents R/W, Pull requests R/W)
- **Usage:** the shared bash/zsh-compatible shim `agents/lib/gh-with-agent-token.sh` wraps `gh` to drop ambient `GITHUB_TOKEN`/`GH_TOKEN` values and route every invocation through Rowan's own token + `GH_CONFIG_DIR`. The shim is materialised into the workspace at `~/.openclaw/workspace/agents/lib/gh-with-agent-token.sh`; `~/.openclaw/workspace/agents/rowan/.gh-shim.sh` sources it without exporting a global agent identity (both emitted by `scripts/ops/sync-agent-definitions.sh`). The wrapper resolves Rowan from session-scoped runtime context such as `CODEX_HOME`. Once that snippet is sourced from shell init, just call `gh ...` — do **not** prefix with `GH_CONFIG_DIR=...` or manually unset ambient token variables yourself, and do **not** invoke `command gh` directly (that bypasses the shim and re-introduces the ambient-token override). The legacy `GH_CONFIG_DIR=~/.config/gh-rowan gh ...` pattern still works for one-off scripts that have not yet been updated, but new code should rely on the shim.
- **For write operations:** no prefix needed once the shim is sourced — the shim unsets any ambient `GITHUB_TOKEN`/`GH_TOKEN` and scopes `GH_CONFIG_DIR=~/.config/gh-rowan`. It re-exports a token only when the per-agent `*_GITHUB_TOKEN` variable exists; today it does not, so the shim falls back to the profile's own keyring credential.

### Git commits and pushes (sindustries repo)

**Work only inside your own worktree** (see `WORKFLOW.md` → Worktrees). Never
commit in `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries` — that
checkout is Edge-managed and a pre-commit hook will block you.

The sindustries repo local git config is set to Quinn's identity. Always
override the author when committing, and push using an explicit HTTPS URL
whose credential helper is scoped to Rowan's GitHub profile, so you never
touch the stored remote:

```bash
# From your worktree (e.g. /Volumes/WD1/worktrees/rowan/<name>):
# Commit as Rowan (override local config inline)
git -c user.name="rowanstoffer" -c user.email="rowanstoffer@gmail.com" commit -m "..."
# Push as Rowan — through gh's credential helper, scoped to Rowan's profile,
# NOT a hand-built token URL. Unset GH_TOKEN as well as GITHUB_TOKEN: gh treats
# environment credentials as authoritative, so an ambient token could silently
# authenticate the push as another agent.
# The old hand-built token URL sent an empty password and failed with
# "Invalid username or token", which reads like a revoked credential rather
# than a missing variable.
env -u GITHUB_TOKEN -u GH_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-rowan" \
  git -c credential.helper= \
    -c 'credential.https://github.com.helper=!gh auth git-credential' \
    push "https://github.com/Stoffer-Industries/sindustries.git" <branch>
```

If the scoped `gh auth status` command above shows no active `rowanstoffer`
account, re-authenticate through the same profile rather than hunting for a PAT
in an `.env` file:

```bash
env -u GITHUB_TOKEN -u GH_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-rowan" \
  gh auth login --hostname github.com
```

Never print a token value into a log, a task comment or a PR.

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
