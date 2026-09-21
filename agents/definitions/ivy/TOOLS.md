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

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

## Identities

Ivy has different names in different systems — use the right one per system, not the GitHub login everywhere:

- **GitHub login:** `ivystoffer` (`GH_CONFIG_DIR=~/.config/gh-ivy`)
- **Tasks API `assignee` value:** `Ivy` (capitalized first name — NOT the GitHub login; e.g. `?assignee=Ivy`, not `?assignee=ivystoffer`)
- **Telegram account:** not yet a dedicated bot account — if this changes, record it here

## Tasks API

- **Credential env:** `IVY_TASKS_API_APPROVAL_TOKEN`, stored in `~/.openclaw/.env`. Pass it as `token=` to `tasks_api_client.py`'s `api_request`/`service_token_env` helpers (or as the bearer token on raw `curl`/`httpx` calls) so comments and writes attribute to `Ivy`, not Quinn.
- **Do not fall back to the shared `TASKS_API_APPROVAL_TOKEN`** for your own actions — that one authenticates as Quinn. It existed server-side (`TASKS_API_APPROVAL_SERVICE_CREDENTIALS`, actor `Ivy`) before this env var was added on 2026-08-21; if a session predates that, comments and writes will show up misattributed to Quinn — same bug class Rowan hit and logged in retro-notes (`tasks-api-actor-attribution-quinn-default`, 2026-08-21).

## GitHub

- **Account:** ivystoffer
- **GH_CONFIG_DIR:** `~/.config/gh-ivy`
- **The shared shim `agents/lib/gh-with-agent-token.sh` (sourced at session-init) wraps every `gh` invocation so the ambient `GITHUB_TOKEN` does not silently authenticate as the wrong identity.** Just call `gh ...` — do **not** prefix with `GH_CONFIG_DIR=...` or invoke `command gh` directly; do not rely on the legacy prefix pattern below. The shim drops the bare `GITHUB_TOKEN` / `GH_TOKEN` and re-exports `GH_TOKEN=$IVY_GITHUB_TOKEN` + `GH_CONFIG_DIR=~/.config/gh-ivy` for the child process.
- Token: stored in `~/.openclaw/.env` as `IVY_GITHUB_TOKEN`
- Repo access: Stoffer-Industries/sindustries (Contents R/W, Pull requests R/W)

### Examples (legacy prefix pattern — preferred path is the shim now)
```
GH_CONFIG_DIR=~/.config/gh-ivy gh pr create ...
GH_CONFIG_DIR=~/.config/gh-ivy gh pr comment <url> --body "..."
GH_CONFIG_DIR=~/.config/gh-ivy gh pr review <number> --repo Stoffer-Industries/sindustries
GH_CONFIG_DIR=~/.config/gh-ivy gh pr view <url>
```

## Related

- [Agent workspace](/concepts/agent-workspace)
