# Tech design — GymTrack: remove ChatGPT connect option

- **Task:** `91994011-5c34-4af5-8ef4-40daac604e64` (split out of `6350f444` on 2026-08-21 during acceptance review)
- **Spec source:** task description (no separate product spec; this is a code task)
- **Branch:** `task-91994011-remove-chatgpt-connect-option` (off `origin/main` at PR-time)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-91994011-remove-chatgpt-connect-option`
- **PR:** task PR only (no separate tech-design PR; this doc lives on the implementation branch)

## Problem statement

The GymTrack "Connect to your agent" CTA (`apps/gymtrack/src/components/ConnectAgentCta.jsx`) currently offers two connector entries — Claude and ChatGPT. Per OpenAI's published docs (`help.openai.com`: "Developer mode and MCP apps in ChatGPT"), custom MCP connectors with **write** actions (which GymTrack needs) are only available on ChatGPT Business / Enterprise / Edu workspace plans. **Pro** is read-only custom MCP. **Plus / Free** are not listed as supported at all.

GymTrack's actual user base is personal / lower-tier ChatGPT accounts (Plus or below), not paid workspace seats. For those users the ChatGPT option leads nowhere useful — the connector is not available to them. The Claude-only URL fix from task `6350f444` (PR #496, merged 2026-08-21) handled a related but separate problem (the wrong Claude URL); the ChatGPT problem is structural and requires removal rather than repair.

## Assumptions

- Hard-removal is preferred over conditional / disabled copy because there is no reliable client-side signal for plan tier in a consumer SPA, and a "check your plan" CTA on this surface would be more confusing than helpful. (Approved by Quinn 2026-08-20T20:50:28Z.)
- The seeded `chatgpt` OAuth client ID in `gymtrack-mcp` is left in place — it is inert without a connector UI asking for it, and removing it is out of scope for this PR. (Approved by Quinn 2026-08-20T20:31:18Z.)
- No `.openclaw` boundary change is required: this PR does not introduce new secrets, env vars, deploy steps, or operator actions.
- No service boundary change. Touched files are entirely inside the GymTrack SPA (`apps/gymtrack/`) and the existing runbook.

## In-scope

- `apps/gymtrack/src/components/ConnectAgentCta.jsx` — drop the `{ id: 'chatgpt', ... }` entry from `AGENT_CONNECT_OPTIONS` and the ChatGPT-only `connect-agent-footnote` paragraph.
- `apps/gymtrack/src/components/WorkoutsTab.test.jsx` — rename the chatgpt-touching test, drop the `connect-chatgpt` testId and chatgpt OAuth client ID assertions, keep all Claude assertions verbatim.
- `docs/runbooks/gymtrack-agent-connect.md` — remove ChatGPT references from the intro and CTA list, drop the ChatGPT end-to-end section, add a new "ChatGPT intentionally excluded" section citing OpenAI's plan-tier restriction so a future agent doesn't silently re-add the entry.

## Out-of-scope

- Detecting the user's ChatGPT plan tier at runtime.
- Support-team briefing for the small minority of users on Business / Enterprise / Edu plans.
- Removing the `chatgpt` OAuth client row from `apps/gymtrack/supabase/migrations/20260804070000_mcp_oauth.sql` or from `gymtrack-mcp`. The runbook's "Supabase OAuth clients" table will retain the row.
- Re-validating the Claude end-to-end smoke flow; that was covered by PR #496 (task `6350f444`).

## Architecture approach

This is a UI / docs change with no service contract impact. The OAuth issuer (`https://gymtrack-mcp.fly.dev`), the MCP endpoint (`/mcp`), the consent URL (`/agent-consent`), and the OAuth allowlist all remain unchanged. Clients that have already configured ChatGPT as a GymTrack connector will simply stop seeing the option in the GymTrack UI; their existing consent in `gymtrack_oauth_consents` is unaffected.

The `buildHref` indirection introduced in PR #483 is preserved on the Claude entry (it remains the only consumer of the builder pattern after this change), so a future provider can opt back in by adding a new `AGENT_CONNECT_OPTIONS` entry with either a static `href` or a `buildHref` function.

## Service boundary and data ownership

No service boundary change. All edits are inside the existing GymTrack SPA + runbook surface.

| Layer | Owner | Change |
| --- | --- | --- |
| GymTrack SPA | Rowan | `ConnectAgentCta.jsx`, `WorkoutsTab.test.jsx` |
| GymTrack runbook | Rowan | `docs/runbooks/gymtrack-agent-connect.md` |
| GymTrack Supabase migrations | (unchanged) | `chatgpt` row retained |
| `gymtrack-mcp` OAuth issuer | (unchanged) | `chatgpt` client retained |

## Milestones

- **WS1 — Hard-remove ChatGPT entry + collateral updates.** All three file changes in a single PR. PR opens as draft; convert to ready-for-review after CI is green.

## Risks / open questions

- None for Quinn. All design questions were resolved in the approval comment on 2026-08-20T20:31:18Z.

## AC matrix (verification plan)

| AC | Plan |
| --- | --- |
| **AC1** ChatGPT entry removed from `AGENT_CONNECT_OPTIONS` and tests/copy updated. | Unit test in `WorkoutsTab.test.jsx` asserts Claude-only CTA; `grep -n chatgpt apps/gymtrack/src/components/ConnectAgentCta.jsx` returns no matches. |
| **AC2** Confirm via OpenAI's docs — hard removal vs conditional copy. | Hard removal, per approved design. Cited at `https://help.openai.com/en/articles/12512198-developer-mode-and-mcp-apps-in-chatgpt` in the new runbook section. |
| **AC3** Runbook updated to note ChatGPT is intentionally excluded and why. | New `## ChatGPT intentionally excluded` section in `docs/runbooks/gymtrack-agent-connect.md` cites OpenAI's plan-tier restriction and links to the OpenAI docs URL. |
