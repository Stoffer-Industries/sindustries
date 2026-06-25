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
- **Token:** stored in `~/.openclaw/.env` as `QUINN_GITHUB_TOKEN` (classic PAT, `repo` scope)
- Repo access: Stoffer-Industries/sindustries (Pull requests R/W, Contents R/W)
- Repo access: Stoffer-Industries/workspace (Pull requests R/W, Contents R/W)
- **Usage:** Prefix read commands with `GH_CONFIG_DIR=~/.config/gh-quinn gh ...`
- **For write operations** (PR review, merge): use `GITHUB_TOKEN="$QUINN_GITHUB_TOKEN" gh ...` — the classic PAT lacks `read:org` so can't be stored in gh-quinn config, but works fine via env var

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
