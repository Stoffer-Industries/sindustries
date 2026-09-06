# Tech Design — Clean up GymTrack agent-consent screen copy (task edef0a21)

**Status:** Draft (awaiting Quinn approval via structured `tech_design` approval)
**Task:** https://api.localhost/tasks/edef0a21-6823-4cc8-b67c-a957987c69d4 (full UUID on Tasks API)
**Branch:** `edef0a21-gymtrack-consent-copy` (off `origin/main`, commit `bf399ad`)
**Author:** Rowan (Staff Engineer)
**Date:** 2026-09-06

---

## Problem

The GymTrack OAuth consent screen (`apps/gymtrack/src/components/AgentConsentPage.jsx:94`) renders the raw client redirect URI verbatim to the end user:

```jsx
<p className="workout-card-meta">Redirect: {request.redirect_uri}</p>
```

For a Claude-Desktop-style agent the user sees something like `Redirect: https://claude.example/callback`. For OpenClaw-on-localhost the user sees `Redirect: http://127.0.0.1:8789/callback`. Tom flagged this while connecting OpenClaw to GymTrack on 2026-09-06: the raw URL is leaky, looks unpolished, and most well-known consent screens (GitHub, Slack, Notion, …) don't surface the redirect target — it is a server-side OAuth concern, not user-facing information.

The screen *already* shows the requesting client name (with `client_id` fallback) and the requested scopes; AC2 of this task is already satisfied by the existing layout. AC1 is the actual change: stop displaying the redirect target.

## Goals (and non-goals)

**In scope**
- Remove the raw `redirect_uri` display line from `AgentConsentPage.jsx`.
- Add a Vitest test asserting that the redirect text is not present, and that the client name + scope list still render (defensive coverage for AC1/AC2 since no `AgentConsentPage.test.jsx` exists today).
- Update `apps/gymtrack/src/App.test.jsx` if the existing `/agent-consent` routing assertion references the redirect text. (Audit shows it asserts URL construction only, so this is expected to be a no-op — but the audit is recorded in WS3.)

**Out of scope**
- Redesigning the consent screen layout (card style, button placement, etc.). Out of scope; this task is copy-only.
- Adding new UI affordances for the user to inspect scopes, hostnames, or redirect URIs. If we ever want a "details" disclosure for power users, that's a separate task.
- Changing the OAuth redirect-handling logic on the callback page or the API. The redirect URL still flows through `submitAgentConsentDecision` server-side exactly as before.
- Translating/localising the screen copy. The app currently runs English-only; locale work is a separate initiative.

## Source-of-truth docs

- `apps/gymtrack/src/components/AgentConsentPage.jsx` (the file)
- `apps/gymtrack/src/lib/connectedAgents.js` (`fetchOAuthClient`, `submitAgentConsentDecision` — read-only reference for what flows server-side)
- `apps/gymtrack/src/components/AgentConsentPage.test.jsx` (to be created — does not exist today)
- `apps/gymtrack/src/App.test.jsx` (audit for any redirect-text assertion)

## Architecture / approach

A single-line JSX delete plus one new test file.

1. **`apps/gymtrack/src/components/AgentConsentPage.jsx`** — delete line 94 (`<p className="workout-card-meta">Redirect: {request.redirect_uri}</p>`). The surrounding card structure (heading, scope list, button row) stays intact. `request.redirect_uri` is still in `request` because `submitAgentConsentDecision` consumes it — the variable is no longer rendered, but the request object continues to flow through unchanged. No other JSX or import changes needed.

2. **`apps/gymtrack/src/components/AgentConsentPage.test.jsx`** — new Vitest file. Renders `<AgentConsentPage />` with a router wrapper that supplies the URL params `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method`; mocks `fetchOAuthClient` to return `{ client_id, client_name, redirect_uris }`; asserts:
   - The client name (`client_name` or fallback to `client_id`) renders in the `<h2>`.
   - The scope list renders one `<li>` per scope.
   - `screen.queryByText(/Redirect:/i)` returns `null` (the contract change).
   - Approve and Cancel buttons are present and respond to clicks via the existing `handleDecision` flow (existing test patterns to follow).
   The test reuses the existing `vi.fn()` mock style already used in `App.test.jsx` and `ConnectedAgentsPage.test.jsx`.

3. **`apps/gymtrack/src/App.test.jsx`** — audit confirms no change is needed. The existing assertion `expect(mockSignInWithOAuthRedirect).toHaveBeenCalledWith(provider, '/agent-consent?client_id=claude-desktop&redirect_uri=...')` is about URL construction, not rendered text. WS3 records this audit so future readers know the file was reviewed.

## Service boundary and data ownership

- **Owner:** `apps/gymtrack` is the only repo affected. The change is one render line in a React component plus one new test file.
- **No data model changes.** The `redirect_uri` still arrives via query string and still flows into `submitAgentConsentDecision`.
- **No API contract changes.** The OAuth consent endpoint (`POST /api/v1/connected-agents/consent`) is untouched.
- **No shared package or cross-app contract implications.** This is a UI-local copy change; the natural source of truth (the JSX itself) is exactly where it lives.

## Milestones

All milestones land on the same PR (the change is too small to merit a slice):

- **M1 (this PR):** delete line 94 of `AgentConsentPage.jsx`; create `AgentConsentPage.test.jsx` with the four assertions above; audit confirms `App.test.jsx` does not need changes.

## Risk and mitigations

- **Risk: removing the redirect display hides a URL the user should be able to verify (security UX).**
  Mitigation: the redirect URL is not the relevant security signal — the requested *scopes* are. The screen still shows every scope (`history:read`, `workouts:write`, `progression:read`, …) which is what a security-conscious user actually inspects. Power-user "details" disclosure (if desired later) is a separate, scoped task.

- **Risk: existing tests fail because they assert the redirect text.**
  Mitigation: audit (`grep -rn 'Redirect\\|redirect_uri' apps/gymtrack/src`) shows only `AgentConsentPage.jsx` itself renders the literal `Redirect:` text; `App.test.jsx` asserts URL *construction*, not rendered text. No existing test will fail. WS3 records the audit so future readers can verify the same conclusion.

- **Risk: `AgentConsentPage.test.jsx` flakiness from router/state mocking.**
  Mitigation: follow the exact pattern used by `ConnectedAgentsPage.test.jsx` and `AgentOAuthCallbackPage.test.jsx` (both already exist and use the same router+auth setup). If a different testing utility is needed, use `MemoryRouter` from `react-router-dom` (already in deps) to inject URL params.

## Test plan

1. Existing test suite: `pnpm --filter @sindustries/gymtrack test` — all existing tests must continue to pass. The audit-confirmed no-op in `App.test.jsx` is the gate.
2. New test: `apps/gymtrack/src/components/AgentConsentPage.test.jsx` — four assertions (client name, scopes, no redirect text, approve/cancel buttons present).
3. Manual smoke: `pnpm --filter @sindustries/gymtrack dev`, navigate to `/agent-consent?client_id=…&redirect_uri=…&scope=…&state=…&code_challenge=…&code_challenge_method=S256`, confirm the rendered card no longer shows the redirect URL.

## Open questions

None blocking.

## AC ↔ verification matrix

| AC | Verification |
|---|---|
| AC1 | Code review of `apps/gymtrack/src/components/AgentConsentPage.jsx`: the `<p>Redirect: …</p>` line is removed; `request.redirect_uri` still flows into `submitAgentConsentDecision`. New test asserts `screen.queryByText(/Redirect:/i)` returns `null`. |
| AC2 | New test asserts `<h2>` contains the client name (or `client_id` fallback) and `<li>` elements render one per scope. Manual smoke confirms the same. |
| AC3 | Audit grep + new test file. The single render-line change plus the new test file is the test update; `App.test.jsx` requires no changes. |