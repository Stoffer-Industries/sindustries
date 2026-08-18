---
status: draft
task_id: 6350f444-ad32-4f99-b5f7-c0c587d70098
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/gymtrack-agent-connect-2026-08-18.md
shipped_pr: null
shipped_date: null
---

# GymTrack — fix Connect-Agent CTA links — tech design

## Product spec link

- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/gymtrack-agent-connect-2026-08-18.md`
- Task API detail: `http://localhost:4001/api/v1/tasks/6350f444-ad32-4f99-b5f7-c0c587d70098`
- Tom's bug report (2026-08-18, Telegram): the ChatGPT link on the GymTrack Connect-to-your-agent CTA opens the ChatGPT home page; the Claude link lands on the generic connectors page with no useful instructions.

## Task and repository

- Task ID: `6350f444-ad32-4f99-b5f7-c0c587d70098`
- Task title: `💻 🐛 GymTrack agent-connect links don't lead anywhere useful`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-6350f444-gymtrack-agent-connect-links`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-6350f444-gymtrack-agent-connect-links`
- Owner: Rowan (implementation + smoke-check) · Tom (manual UI verification)

## Product intent summary

The Connect-to-your-agent CTA on the GymTrack frontend (`apps/gymtrack/src/components/ConnectAgentCta.jsx`) advertises two paths: Claude and ChatGPT. The Claude link (`https://claude.ai/settings/connectors`) goes to the generic connectors list with no pre-fill or reference to GymTrack's MCP URL, and the ChatGPT link (`https://chatgpt.com/admin/ca`) opens the ChatGPT home page. Both are bad first-touch UX — a user landing on either has no idea what to do next beyond the in-page copy that does not travel with them.

The fix is two-part: (1) confirm the current correct URL for each provider's custom-MCP-connector creation flow (these URLs change independently of our code), and (2) if a provider supports a prefill/query-param deep link, use it; otherwise restructure the on-page copy so the MCP URL and OAuth client ID are easy to copy-paste once the user lands on the provider's generic connector page. The existing copy already publishes the MCP URL and the OAuth client ID, but it does not make them actionable once the user clicks the link and leaves the page.

## Service boundary and data ownership

- This is a **frontend-only** fix. No backend code, no API changes, no DB changes, no Prisma migration.
- The fix is scoped to `apps/gymtrack/src/components/ConnectAgentCta.jsx` and a new test file at `apps/gymtrack/src/components/ConnectAgentCta.test.jsx`. The MCP URL and OAuth client ID are already exposed via `mcpUrl('/mcp')` from `apps/gymtrack/src/lib/mcpConfig.js` — no change there.
- No `.openclaw` boundary, no secrets, no cron, no skills affected. The CTA is a static React component with hardcoded provider URLs.
- The on-page copy restructure is intentionally **client-side** (not a generated deep link) because:
  - Anthropic's connectors page does not currently expose a documented query-param prefill for the MCP URL.
  - OpenAI's custom MCP connector creation screen has shifted URLs twice in 2026; embedding the URL in the CTA is brittle and creates a maintenance footgun.
  - The "land on the generic connector page with copy-paste-ready URL and client ID" pattern is the durable surface; it survives provider URL changes.

## `.openclaw` boundary notes

- No `.openclaw` file edits required. No cron required. No secrets involved.
- The smoke-check step (AC3) is a manual URL check that the implementer runs locally after the code change. It does not require `.openclaw` infrastructure.

## Implementation plan

### 1. Investigate the current correct URLs

Before editing any code, run web searches and open the actual provider pages to confirm the current correct URL for each provider's custom MCP connector creation flow:

- **Claude (Anthropic)**:
  - Current candidate URLs to test:
    - `https://claude.ai/settings/connectors` (the current generic connectors list — the page we already link to, but lacks pre-fill)
    - `https://claude.ai/settings/connectors/new` (the connector-creation screen — unconfirmed, may not exist)
    - `https://claude.ai/connectors` (alternative path)
  - Evidence to capture: an OAuth client ID pre-fill via query param if supported (e.g. `?client_id=claude-desktop`); if none exist, the alternative is to use the existing generic connectors URL and rely on the on-page copy.
- **ChatGPT (OpenAI)**:
  - Current candidate URLs to test:
    - `https://chatgpt.com/admin/ca` (the current href — Tom reports it 404s to homepage)
    - `https://chatgpt.com/admin/mcp` (the canonical admin-MCP page if it exists)
    - `https://platform.openai.com/docs/mcp` (the developer docs page — fallback if the admin page is gated)
    - `https://chat.com/admin/mcp` (alternative TLD)
  - Evidence to capture: a working URL that lands on a custom-MCP-connector creation screen for a normal/plus account; the admin/ca path 404s to home, so we need a different landing page.

Document the search results in the PR description so the URL choice is auditable. Citations should include the date the URL was last verified (Tom's report is 2026-08-18; the search results should be the same week).

### 2. Update `AGENT_CONNECT_OPTIONS` in `ConnectAgentCta.jsx`

Edit the file at `apps/gymtrack/src/components/ConnectAgentCta.jsx`:

- Replace each `href` with the verified URL from step 1.
- If a provider supports a prefill query param, append it with the connector MCP URL or client ID. For example, if Claude supports `?mcp_url=<url>`, add it. If not, leave the URL as the generic connector page and rely on the copy.
- Update the `instructions` text to reflect the verified path:
  - Claude: "Open Settings → Connectors → Add custom connector. Paste the MCP URL and OAuth client ID below."
  - ChatGPT: "Open Settings → Connectors → Create. Paste the MCP URL and OAuth client ID below."
  - If the URL paths change per-provider, the instructions should call out the exact path so the user lands on the right screen.
- Keep the `clientId` field unchanged (`claude-desktop` and `chatgpt`).
- Keep the `endpoint` (MCP URL) display unchanged.

The current file:

```jsx
export const AGENT_CONNECT_OPTIONS = [
  {
    id: 'claude',
    name: 'Claude',
    clientId: 'claude-desktop',
    href: 'https://claude.ai/settings/connectors',
    instructions: 'Add a custom connector, then approve GymTrack access.'
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    clientId: 'chatgpt',
    href: 'https://chatgpt.com/admin/ca',
    instructions: 'Create an MCP app, scan its tools, then approve GymTrack access.'
  }
];
```

The proposed file after the fix (illustrative — exact URLs depend on step 1):

```jsx
export const AGENT_CONNECT_OPTIONS = [
  {
    id: 'claude',
    name: 'Claude',
    clientId: 'claude-desktop',
    href: 'https://claude.ai/settings/connectors',
    instructions: 'Open Settings → Connectors → Add custom connector. Paste the MCP URL and OAuth client ID below.'
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    clientId: 'chatgpt',
    href: '<verified-chatgpt-url>',
    instructions: 'Open Settings → Connectors → Create. Paste the MCP URL and OAuth client ID below.'
  }
];
```

### 3. Restructure the on-page copy so the MCP URL and client ID are copy-paste-ready

The current already-existing endpoint/client-id blocks are good but a user who clicks the link and lands on the provider's page cannot copy from them. The fix:

- Keep the existing per-option `clientId` block (already displays the OAuth client ID in a `<code>` element).
- Add a small "Copy" button next to each `<code>` block (MCP URL and per-option client ID) using the existing icon-button pattern in `apps/gymtrack/src/components/`. Pattern: render a button next to the code that calls `navigator.clipboard.writeText(endpoint)` and shows a transient "Copied" state.
- The copy function is the same one used elsewhere in the app; copy-paste from any existing component that uses `navigator.clipboard.writeText` (e.g. `ConnectedAgentsPage.jsx` if it has a token-copy button). If no pattern exists, add a tiny utility at `apps/gymtrack/src/lib/clipboard.js` and reuse it.
- The "copy" affordance is the durable UX surface even if the provider URL changes — the user can always copy the values from the GymTrack page and paste them into the provider's connector creation form, regardless of the provider's URL structure.

### 4. Add a smoke-check script + document the verification step

The provider URLs change independently of our code, so a smoke-check must be documented and re-run at least quarterly. The script:

- File: `apps/gymtrack/scripts/smoke-check-agent-connect-urls.sh` (bash, no new dependencies).
- Behavior: HEAD-request each provider URL with `curl -sIL -o /dev/null -w "%{http_code} %{url_effective}\n"` and assert the final HTTP status is `200` and the final URL lands on the connectors page (not the home page).
- The smoke check is not part of CI (the URLs are subject to provider-controlled redirects and rate limiting); it is a manual step the implementer runs after the fix and an ops checklist item for the next provider-URL audit.
- Document the smoke-check in the PR description and in `apps/gymtrack/README.md` if a README exists, with a "last verified" date stamp.

### 5. Add a component test

Add `apps/gymtrack/src/components/ConnectAgentCta.test.jsx`:

- Use the existing `@testing-library/react` + `vitest` pattern from `apps/gymtrack/src/components/ConnectedAgentsPage.test.jsx`.
- Cover:
  - MCP URL is rendered with the `data-testid="connect-agent-mcp-url"` attribute.
  - Both provider links have the expected `href`, `target="_blank"`, and `rel="noopener noreferrer"`.
  - The new copy buttons call `navigator.clipboard.writeText` with the correct value (mock the clipboard).
  - The `instructions` text for each provider matches the verified path strings from step 1.
- The test asserts the **current verified href**, not a hardcoded "claude-2026-08-18" snapshot. When the smoke check fails, the test should also be updated in the same PR.

## Data model and API contract changes

**None.** No Prisma migration. No API changes. No new fields. The component is purely presentational.

## Workflow, cron, and skill changes

- **Cron**: none. Do not add a periodic URL-check cron.
- **Skills**: no skill changes.
- **Documentation**: append a "Agent-connect links verification" section to `apps/gymtrack/README.md` (if present) with the smoke-check command and the last-verified date.

## Test plan

### Automated tests

- New: `apps/gymtrack/src/components/ConnectAgentCta.test.jsx` — see Implementation plan § 5.
- Existing tests should remain green. Specifically `apps/gymtrack/src/App.test.jsx` (which mounts the app) and any test that imports `ConnectAgentCta` should not break.
- No backend tests are affected.

### AC verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Manual / URL research. Implementer opens the verified ChatGPT URL in a browser (normal account, not admin) and confirms it lands on a custom-MCP-connector creation screen, not the home page. Also a unit test asserts the href is the verified URL. | Screenshot of the ChatGPT connector creation screen + the `href` test assertion in the PR description. |
| AC2 | Manual / URL research + UI copy. Implementer opens the verified Claude URL (or keeps the existing generic connectors URL if no prefill is supported) and confirms the on-page copy makes the MCP URL and client ID copy-paste-ready. The new copy buttons are tested in `ConnectAgentCta.test.jsx`. | Screenshot of the updated CTA showing the copy buttons + the copy-button test in the PR description. |
| AC3 | Manual / smoke-check + documentation. After the change, run `apps/gymtrack/scripts/smoke-check-agent-connect-urls.sh`; the script must print `200 <url>` for each provider URL. The PR description includes the script output and the "last verified <date>" line in the documented step. | Script output + the documented verification step in the PR description. |

### Pre-commit sanity

Before opening the PR, the implementer must:

1. Run the smoke-check script and capture the output.
2. Run the new component test and confirm it passes.
3. Run the full GymTrack app test suite (`npm test` in `apps/gymtrack`) and confirm no regressions.
4. Open the dev build of the GymTrack frontend and visually verify the CTA renders correctly with the copy buttons in the browser.

## Open questions and risks

1. **Provider URL churn.** Anthropic and OpenAI have moved their connector creation URLs in 2026 (`chatgpt.com/admin/ca` already 404s; `claude.ai/settings/connectors` may shift). The smoke-check script is the durable answer, but it is a manual step. A future improvement is to ingest the URLs from a config endpoint with a "`last_verified`" field and a CI cron — but that is out of scope for this bug-fix-sized task.
2. **Clipboard permission UX.** Modern browsers require `navigator.clipboard.writeText` to be triggered in a user-gesture context. The new copy buttons are real `<button>` elements, so this is satisfied. The test should mock the clipboard and verify the function is called.
3. **Provider prefill support.** If a provider later exposes a documented query-param prefill for the MCP URL, the cleanest follow-up is to add it to the URL but keep the on-page copy as the durable fallback. The implementation should not block on prefill support.
4. **No new dependencies.** The clipboard API is a browser native; the smoke-check script uses `curl` already installed on macOS. No new npm packages.
5. **Mobile / responsive behavior.** The copy buttons should be tap-friendly on mobile. The existing `btn-primary` styling is the same pattern used elsewhere; the new button can use a smaller icon-button variant.
6. **i18n.** The current copy is English-only. The bug fix does not introduce new strings; it refactors existing ones. i18n is a separate concern out of scope here.
7. **Test for missing provider.** If a provider's URL ever returns a non-200 in the smoke check, the right answer is to remove the provider option from the CTA rather than silently send the user to a broken page. The smoke check script and a follow-up note in the README document this. The current fix does not add a CI gate for this — it is a manual contract.

## Runbook cheat sheet

```bash
# 1. Investigate the verified URLs
- Open https://claude.ai/settings/connectors and check for a prefill or query-param deep link
- Open ChatGPT admin/connectors URLs (chatgpt.com/admin/mcp, chat.com/admin/mcp, etc.) until one lands on a working custom connector screen

# 2. Update the component
$EDITOR apps/gymtrack/src/components/ConnectAgentCta.jsx
# (update AGENT_CONNECT_OPTIONS href + instructions + add copy buttons)

# 3. Add the component test
$EDITOR apps/gymtrack/src/components/ConnectAgentCta.test.jsx
# (cover href, copy buttons, instructions text)

# 4. Add the smoke-check script
$EDITOR apps/gymtrack/scripts/smoke-check-agent-connect-urls.sh
chmod +x apps/gymtrack/scripts/smoke-check-agent-connect-urls.sh

# 5. Run the tests
cd apps/gymtrack
npm test -- src/components/ConnectAgentCta.test.jsx
npm test  # full suite

# 6. Run the smoke check
bash scripts/smoke-check-agent-connect-urls.sh
```
