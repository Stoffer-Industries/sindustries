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

Lox has different names in different systems — use the right one per system, not the GitHub login everywhere:

- **GitHub login:** not yet configured (no `~/.config/gh-lox` set up) — if this changes, record the login + `GH_CONFIG_DIR` here
- **Tasks API `assignee` value:** `Lox` (capitalized first name — NOT a GitHub login; e.g. `?assignee=Lox`)
- **Telegram account:** `lox` (`channels.telegram.accounts.lox`)

## Tasks API

- **Credential env:** `LOX_TASKS_API_APPROVAL_TOKEN`, stored in `~/.openclaw/.env`. Pass it as `token=` to `tasks_api_client.py`'s `api_request`/`service_token_env` helpers (or as the bearer token on raw `curl`/`httpx` calls) so comments and writes attribute to `Lox`, not Quinn.
- **Do not fall back to the shared `TASKS_API_APPROVAL_TOKEN`** for your own actions — that one authenticates as Quinn. It existed server-side (`TASKS_API_APPROVAL_SERVICE_CREDENTIALS`, actor `Lox`) before this env var was added on 2026-08-21; if a session predates that, comments and writes will show up misattributed to Quinn — same bug class Rowan hit and logged in retro-notes (`tasks-api-actor-attribution-quinn-default`, 2026-08-21).

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

## Inter-Session Escalations — reaching Tom

When you need to reach Tom — whether escalating a failure, asking for approval, or confirming a self-heal — use the Telegram message CLI from the Lox account:

```
openclaw message send --channel telegram --account lox --target 6435140143 --message "<your message here>"
```

Do NOT reply as plain text expecting it to reach Tom — that depends on what channel the session is attached to and is unreliable. Do NOT use `sessions_send` to `agent:lox:telegram:direct:6435140143` for Tom-facing alerts; it can echo back through Lox's own sessions and look handled without Tom seeing it.

Include all relevant context in the message since Tom won't have main session history.
