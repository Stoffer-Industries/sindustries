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

## Inter-Session Escalations — reaching Tom

When you need to reach Tom — whether escalating a failure, asking for approval, or confirming a self-heal — use the Telegram message CLI from the Lox account:

```
openclaw message send --channel telegram --account lox --target 6435140143 --message "<your message here>"
```

Do NOT reply as plain text expecting it to reach Tom — that depends on what channel the session is attached to and is unreliable. Do NOT use `sessions_send` to `agent:lox:telegram:direct:6435140143` for Tom-facing alerts; it can echo back through Lox's own sessions and look handled without Tom seeing it.

Include all relevant context in the message since Tom won't have main session history.
