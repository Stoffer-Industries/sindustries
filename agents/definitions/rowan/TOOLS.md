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

## GitHub

- **Account:** rowanstoffer
- **GH_CONFIG_DIR:** `~/.config/gh-rowan`
- **Token:** stored in `~/.openclaw/.env` as `ROWAN_GITHUB_TOKEN` (fine-grained PAT)
- Repo access: Stoffer-Industries/sindustries (Contents R/W, Pull requests R/W)
- **Usage:** `GH_CONFIG_DIR=~/.config/gh-rowan gh ...`
- **For write operations:** `GITHUB_TOKEN="$ROWAN_GITHUB_TOKEN" gh ...`

### Git commits and pushes (sindustries repo)

The sindustries repo local git config is set to Quinn's identity. Always
override the author when committing, and push using an explicit URL with your
PAT so you never touch the stored remote:

```bash
source ~/.openclaw/.env
# Commit as Rowan (override local config inline)
git -c user.name="rowanstoffer" -c user.email="rowanstoffer@gmail.com" commit -m "..."
# Push as Rowan (explicit URL, does not change stored origin)
git push "https://rowanstoffer:${ROWAN_GITHUB_TOKEN}@github.com/Stoffer-Industries/sindustries.git" <branch>
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
