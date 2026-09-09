---
status: draft
task_id: 696f2487-4817-4ecb-83fb-480b6ce654cc
product_spec: n/a (code task; spec is the task description)
shipped_pr: null
shipped_date: null
---

# Tech design — GymTrack: re-add ChatGPT connector onboarding to Agents tab

## Context

- **Task:** `696f2487-4817-4ecb-83fb-480b6ce654cc`
- **Spec source:** task description (no separate product spec; this is a code task)
- **Branch:** `696f2487-readd-chatgpt-connect` (off `origin/main` at PR-time)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/696f2487-readd-chatgpt-connect`
- **PR:** task PR only (no separate tech-design PR; this doc lives on the implementation branch)
- **Supersedes:** `docs/specs/gymtrack-remove-chatgpt-connect-option-2026-08-21-tech-design.md` (task `91994011`) — that design's "ChatGPT intentionally excluded" rationale is corrected by this task and will be annotated as shipped-then-superseded on merge.

## Problem statement

`apps/gymtrack/src/components/ConnectAgentCta.jsx` currently exposes only Claude in the Agents tab CTA. ChatGPT was intentionally removed on 2026-08-23 (task `91994011`, commit `11d99a42`) on the assumption that custom MCP connectors with write actions were restricted to ChatGPT Business / Enterprise / Edu plans.

OpenAI's current published docs (`help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt`, verified 2026-09-09) confirm Developer Mode / custom MCP connectors with write actions are available on **any paid plan** — Plus, Pro, Business, Enterprise, or Edu — and only the **Free** tier is excluded. Tom has personally verified this on a ChatGPT Pro tier account (added GymTrack as a custom connector and observed both read and write tools being usable).

The `chatgpt` OAuth client ID is already seeded in `apps/gymtrack/supabase/migrations/20260804070000_mcp_oauth.sql` (line 305, `redirect_uris = array['https://chatgpt.com/connector_platform_oauth_redirect']`) and in `gymtrack-mcp`. Wiring is mechanical — there is no new service, no new OAuth issuer, no new env var.

## Assumptions

- **Wiring reuses the seeded `chatgpt` client ID end-to-end.** No new OAuth registration, no new migration, no new redirect URI. The seeded row's redirect URI matches the published ChatGPT custom-connector platform-redirect.
- **Card copy explains the Free-tier limitation.** OpenAI's published restriction is one line; users on Free should not be led to a dead end.
- **No `.openclaw` boundary change.** No new secrets, env vars, deploy steps, or operator actions. The seeded OAuth row already lives in Supabase.
- **No service boundary change.** Touched files are inside the GymTrack SPA + an existing tech-design doc + `apps/gymtrack/SPEC.md`. No `gymtrack-mcp` change.
- **Live test against `gymtrack-mcp.fly.dev/mcp` is feasible** for AC2 (Tom has done this manually on Pro; Quinn or the implementer can repeat against staging or prod).
- **The `docs/runbooks/gymtrack-agent-connect.md` file the prior design referenced no longer exists** (Tom removed all sindustries runbooks on 2026-09-08, commit `b2435dc9`; they live in `~/.openclaw/workspace/docs/infra/` instead). Stale references in `ConnectAgentCta.jsx`, `WorkoutsTab.test.jsx`, `apps/gymtrack/README.md`, and `apps/gymtrack/SPEC.md` are *not* this task's scope — they are pre-existing tech debt. The implementation will leave them as-is to keep this PR scoped; a follow-up audit finding already covers them.

## In-scope

1. **`apps/gymtrack/src/components/ConnectAgentCta.jsx`** — add a new entry to `AGENT_CONNECT_OPTIONS` for `{ id: 'chatgpt', name: 'ChatGPT', clientId: 'chatgpt', href: <static ChatGPT connector URL>, instructions: <onboarding steps> }`. Pattern matches the Claude entry: `{ id, name, clientId, href or buildHref, instructions }`. The `buildHref` indirection is preserved (still required for the Claude entry); ChatGPT uses a static `href` because its connector screen does not need the MCP URL encoded as a query parameter.
2. **`apps/gymtrack/src/components/WorkoutsTab.test.jsx`** — restore the ChatGPT assertions removed by task `91994011`: `getByTestId('connect-chatgpt')` exists and points at the ChatGPT connector URL, `getByText('chatgpt')` matches the OAuth client ID display. Keep the Claude assertions verbatim.
3. **`apps/gymtrack/SPEC.md`** — update the "Connect and authorize an external MCP client" flow §1 to reflect ChatGPT is supported again with the Free-tier limitation noted, and update the `/workouts` row in the Screens table to drop the "ChatGPT was intentionally removed" parenthetical. Note the stale `docs/runbooks/gymtrack-agent-connect.md` reference and that the runbook was moved out of the repo on 2026-09-08; this PR does not fix that stale link.
4. **`docs/specs/gymtrack-remove-chatgpt-connect-option-2026-08-21-tech-design.md`** — annotate as superseded by this design (add a one-paragraph "Superseded" note at the top linking to task `696f2487` and to this design doc). Update frontmatter `status` to `superseded` (or keep `shipped` and rely on the prose note — to be decided at PR time).

## Out-of-scope

- Stale-reference cleanup in `ConnectAgentCta.jsx`, `WorkoutsTab.test.jsx`, `apps/gymtrack/README.md` (the runbook path they reference was deleted on 2026-09-08). Pre-existing tech debt; a separate code-garden task.
- Re-introducing `docs/runbooks/gymtrack-agent-connect.md` into sindustries — Tom's 2026-09-08 instruction is to keep all runbooks out of the Edge-managed checkout. If anything ChatGPT-onboarding-related needs a runbook, it goes in `~/.openclaw/workspace/docs/infra/` instead.
- Detecting the user's ChatGPT plan tier at runtime. The card copy notes the Free-tier exclusion; that's the whole UX story.
- Removing or editing the seeded `chatgpt` OAuth row in `20260804070000_mcp_oauth.sql` or in `gymtrack-mcp` — it is the live row this task relies on.
- Re-validating the Claude end-to-end smoke flow. Already covered by PR #496 (task `6350f444`).
- Adding a third connector (e.g. Gemini, Perplexity). Same-shape extension, separate task if Quinn wants it.
- Updating the W37 audit findings for stale references — those findings exist; the fixes are a separate code-garden or audit-ledger task.

## Architecture approach

This is a UI / docs change with no service-contract impact. The OAuth issuer (`https://gymtrack-mcp.fly.dev`), the MCP endpoint (`/mcp`), the consent URL (`/agent-consent`), the seeded `chatgpt` OAuth client row, and the OAuth allowlist all remain unchanged. The `AGENT_CONNECT_OPTIONS` array shape is the existing per-provider config pattern; ChatGPT slots in identically to Claude.

**Connector URL choice.** ChatGPT's custom-connector setup runs inside a workspace's settings pane (`Settings → Apps → Create`) rather than via a single public deep link with pre-filled params. The published flow is: user opens ChatGPT, navigates to workspace settings → Apps → Developer Mode → Create, fills the MCP server URL `https://gymtrack-mcp.fly.dev/mcp`, picks OAuth, scans tools, authorises, and saves. There is no `https://chatgpt.com/...` URL that pre-fills the connector form the way `https://claude.ai/customize/connectors?modal=add-custom-connector&...` does for Claude. The card's `href` will point at `https://chatgpt.com/` (the ChatGPT root) with a `target="_blank"` so the connector opens in a new tab; the card `instructions` field carries the per-step text. This is a documentation/UX choice, not a contract choice.

**Why no `buildHref`.** `buildHref(mcpEndpoint)` exists for Claude because Claude's connector modal accepts the MCP URL as a query parameter (`connectorUrl=...`). ChatGPT's connector screen takes the MCP URL as a form field inside its own UI, so there is nothing to encode into the query string. Static `href` is correct here; the `buildHref` indirection is preserved on Claude for forward compatibility.

**Service boundary and data ownership.**

| Layer | Owner | Change |
| --- | --- | --- |
| GymTrack SPA | Rowan | `ConnectAgentCta.jsx`, `WorkoutsTab.test.jsx` |
| GymTrack behavioural spec | Rowan | `apps/gymtrack/SPEC.md` |
| GymTrack historical tech design | Rowan | annotate `gymtrack-remove-chatgpt-connect-option-2026-08-21-tech-design.md` |
| GymTrack Supabase migrations | (unchanged) | `chatgpt` row already seeded; reused as-is |
| `gymtrack-mcp` OAuth issuer | (unchanged) | `chatgpt` client already registered; reused as-is |
| Tom's `~/.openclaw/workspace/docs/infra/` runbooks | (unchanged) | no ChatGPT-onboarding runbook needed for this PR |

## Onboarding copy (target for the card `instructions` field)

Mirrors the existing Claude card structure:

> 1. Open ChatGPT workspace settings → Apps → Create (or enable Developer Mode).
> 2. MCP endpoint: `https://gymtrack-mcp.fly.dev/mcp`.
> 3. Choose OAuth, scan tools, authorise, and create the app.
> 4. In a new chat: Tools → Use connectors → select GymTrack.
> 5. Test with a read prompt (e.g. "list my three most recent workouts").
>
> Requires any paid ChatGPT plan (Plus or above). Free tier does not support Developer Mode custom connectors.

The Free-tier caveat is a one-line note appended to the instructions (matches the card's existing layout — Claude has a single `instructions` paragraph; ChatGPT will too).

## Milestones

- **WS1 — Re-add ChatGPT card + collateral updates.** All four file changes in a single PR. PR opens as draft; convert to ready-for-review after CI is green and Quinn has approved this design.

## Risks / open questions

- **Free-tier dead-end risk (low, mitigated).** Users on ChatGPT Free will click the card, reach the workspace settings, and see no Developer Mode option. The Free-tier caveat in the card copy mitigates this; a one-line "(Plus or above)" mention keeps the surprise out. No client-side plan detection is feasible in a consumer SPA (matches the assumption from task `91994011`'s design).
- **OpenAI docs drift.** OpenAI's plan-tier support for custom MCP connectors has changed before (Free → Plus was added between the original removal and now). The Free-tier caveat is a one-line maintenance burden if OpenAI expands or contracts access again; future agents should re-verify `help.openai.com/en/articles/12584461` before changing this card.
- **Stale `docs/runbooks/gymtrack-agent-connect.md` references (pre-existing).** Three code/doc references and one README reference still point at the deleted runbook. Out of scope for this PR; flagged for code-garden follow-up.

## AC matrix (verification plan)

| AC | Plan |
| --- | --- |
| **AC1** `AGENT_CONNECT_OPTIONS` includes a ChatGPT entry matching the Claude card pattern, and tests/copy are updated. | Unit test in `WorkoutsTab.test.jsx` asserts `connect-chatgpt` exists and links to the ChatGPT connector URL; `grep -n chatgpt apps/gymtrack/src/components/ConnectAgentCta.jsx` returns the new entry's `clientId: 'chatgpt'` and `instructions` text. |
| **AC2** End-to-end connector setup against `gymtrack-mcp.fly.dev/mcp` succeeds with the seeded `chatgpt` OAuth client ID. | Live smoke test: Quinn (or Rowan, with Quinn's blessing) adds GymTrack as a ChatGPT custom connector on a paid-tier account, authorises via the OAuth consent screen, and runs a write tool call (e.g. `plan_workout`). PR body records the test account tier and tool-call result. |
| **AC3** Card copy notes the Free-tier limitation. | Vitest snapshot / explicit text assertion: card `instructions` text contains "Free tier does not support" (or equivalent). Manual review of `apps/gymtrack/SPEC.md` § "Connect and authorize an external MCP client" confirms the caveat appears in the spec copy too. |
| **AC4** `apps/gymtrack/SPEC.md` and the 2026-08-21 tech design doc reflect that ChatGPT is supported again and why (plan-tier requirement corrected). | PR includes both updates. Diff review confirms: (a) SPEC.md "ChatGPT option (intentionally absent)" paragraph is rewritten to describe the supported entry; (b) `gymtrack-remove-chatgpt-connect-option-2026-08-21-tech-design.md` has a new "Superseded by task `696f2487`" note linking to this design. |

## Open questions for Quinn

None blocking. The Free-tier caveat wording is the only judgement call and is captured in § "Onboarding copy" above; Quinn can adjust during review.