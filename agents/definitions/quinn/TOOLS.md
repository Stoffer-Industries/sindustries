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

## Identities

Quinn has different names in different systems — use the right one per system, not the GitHub login everywhere:

- **GitHub login:** `quinnstoffer` (`GH_CONFIG_DIR=~/.config/gh-quinn`)
- **Tasks API `assignee` value:** `Quinn` (capitalized first name — NOT the GitHub login; e.g. `?assignee=Quinn`, not `?assignee=quinnstoffer`)
- **Telegram account:** `quinn` (default bot account in `channels.telegram.accounts.quinn`)

## Quinn's Accounts & Devices

### Identity
- **Email:** quinnstoffer@gmail.com
- **Apple ID:** quinnstoffer@gmail.com (this is Quinn's account, not Tom's)

### Phone
- **Number:** +64284052295
- **Device:** Solana Seeker (spare phone, NZ SIM)
- **Potential:** SMS, on-device apps, crypto/Solana features

### Notes
- Apple Notes shared with Quinn via iCloud
- Use `memo` CLI to read/write notes

## Quinn's Accounts
- **Email:** quinnstoffer@gmail.com (Quinn's Gmail — used for gog auth + calendar sharing)
- Google Calendar: Tom shares his calendars (tomstoffer@gmail.com) with quinnstoffer@gmail.com

## Calendar Conventions
- **"Busy" blocks in the morning** = Tom's riding time
- **"Busy" blocks in the afternoon** = kids pickup / activities with them
- **Canonical ical binary:** `/Users/quinnstoffer/.openclaw/workspace/tools/ical/ical`
- **For writing todos/focus blocks** → use `ical` CLI to book into Tom's iCal
- **For external meetings with others** → use Tom's GCal (`tomstoffer@gmail.com`)
- **For writing family events or things the family should be aware of** → use `ical` CLI to book into Family iCal
- Tom uses iOS Calendar as his client; Gmail calendar is shared into it

## GitHub

- **Account:** quinnstoffer
- **GH_CONFIG_DIR:** `~/.config/gh-quinn`
- **Credential storage:** the dedicated `gh-quinn` profile owns the credential in the host keychain; do not use an ambient `GITHUB_TOKEN` or `GH_TOKEN`.
- Repo access: Stoffer-Industries/sindustries (Pull requests R/W, Contents R/W)
- Repo access: Stoffer-Industries/workspace (Pull requests R/W, Contents R/W)
- **Usage:** Prefix every GitHub command, including writes, with `GH_CONFIG_DIR=~/.config/gh-quinn gh ...`; verify `gh api user --jq '.login'` returns `quinnstoffer` before writes.
- **No ambient fallback:** never set or rely on `GITHUB_TOKEN`/`GH_TOKEN` for Quinn operations. A missing or mismatched profile must fail closed rather than inherit another agent's credential.
- **Shim:** `agents/lib/gh-with-agent-token.sh` scopes Quinn to `~/.config/gh-quinn` and removes ambient token variables. Do not bypass that identity boundary.

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
