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

## GitHub

- **Account:** ivystoffer
- **GH_CONFIG_DIR:** `~/.config/gh-ivy`
- **CRITICAL: Prefix ALL `gh` commands with `GH_CONFIG_DIR=~/.config/gh-ivy`** — no exceptions. This includes `gh pr create`, `gh pr comment`, `gh pr review`, `gh pr view`, and any other `gh` subcommand. Without this prefix, commands fall back to the default identity (rowanstoffer) and your actions appear as the wrong user.
- Token: stored in `~/.openclaw/.env` as `IVY_GITHUB_TOKEN`
- Repo access: Stoffer-Industries/sindustries (Contents R/W, Pull requests R/W)

### Examples
```
GH_CONFIG_DIR=~/.config/gh-ivy gh pr create ...
GH_CONFIG_DIR=~/.config/gh-ivy gh pr comment <url> --body "..."
GH_CONFIG_DIR=~/.config/gh-ivy gh pr review <number> --repo Stoffer-Industries/sindustries
GH_CONFIG_DIR=~/.config/gh-ivy gh pr view <url>
```

## Related

- [Agent workspace](/concepts/agent-workspace)
