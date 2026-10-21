---
status: draft
task_id: e89db27f-6d78-418e-91c1-0759f8779d06
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# GymTrack Browser Error Telemetry → Grafana — Tech Design

## Product spec link

- Task: `e89db27f-6d78-418e-91c1-0759f8779d06` (💻 Add GymTrack browser error telemetry to Grafana)
- Task title: "Add GymTrack browser error telemetry to Grafana"
- Sibling task: `bb09eaed` (Migrate GymTrack identity from Supabase Auth to Clerk) — this task is the durable observability layer for the same auth surface; the two stay separate and unrelated in scope.
- Product spec: n/a (the task is a code task with no separate `brain/tasks/specs/...` document; the design intent is captured in the task description and AC text).

## Task and repository

- **Task ID:** `e89db27f-6d78-418e-91c1-0759f8779d06`
- **Task title:** 💻 Add GymTrack browser error telemetry to Grafana
- **Task type:** `code` — the lobster dispatches this through `agents/workflows/feature-task/code-task.lobster.yaml`; no product spec is required and the tech design gate is **required** because the task description explicitly flags "Rowan must add a bounded tech design before implementation" (the change touches the browser-to-observability boundary and handles security-sensitive auth context).
- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-e89db27f-gymtrack-browser-error-telemetry`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/task-e89db27f-gymtrack-browser-error-telemetry`
- **PR:** (pending — open as **DRAFT** after Quinn approves this design; convert to ready-for-review when AC1–AC4 evidence is wired and `[implementer-prs]` is posted)

## Product intent summary

The Clerk auth cutover on `bb09eaed` exposed a recurring problem: failures such as a stalled Turnstile challenge, a `needs_client_trust` second-factor rejection, or a transient PostgREST 502 during sign-in only become visible when a user reports them. The current observability stack (`docs/systems/observability.md`, the `cloud-overview` / `db-health` / `migration-alerts` dashboards, the `sindustries_db_up` / `sindustries_fly_app_health` metrics) covers the **server** side — Fly app health, DB health, request latency, queue depth — but the **browser** runs in users' devices and emits no signals to the hosted backend at all. A failing client either retries silently or surfaces as a user report.

This task adds production browser-side error reporting for GymTrack: uncaught exceptions, unhandled promise rejections, and explicitly handled Clerk auth failures are exported to the hosted Grafana observability stack with enough context (environment, release, route, operation, provider, safe Clerk error code/status) to diagnose without re-deriving the failure from a user report. It reuses the existing hosted Grafana stack and adds a small browser→relay→Loki surface; it does **not** extend the existing OTel/Node pipeline (the browser cannot safely bundle the OTLP auth headers) and does **not** introduce Sentry, Bugsnag, or any third-party error service.

## Service boundary and data ownership

### Why the browser cannot use the existing OTLP path directly

`packages/otel-node` exports `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` as runtime env vars and ships a `Basic <base64(instance_id:api_key)>` header. Both values are operator-supplied and live in Fly secrets for the health-probe and the Node services (`docs/systems/observability.md` § "Account ownership, secrets, and billing"). If those values are bundled into the Vite client at build time they end up in the shipped JS and can be extracted by any user — the same problem every browser-side telemetry integration has to solve.

### Three options I considered, and the one I picked

1. **Direct browser → Grafana Cloud Loki HTTP push** with a separate Loki "browser" tenant and a write-only API key. **Rejected** — the write-only key is still extractable from the bundle, and rate-limiting at the Loki edge is the only mitigation. Operationally simpler but trust-bounded.
2. **Server-side relay on the existing `services/gymtrack-mcp` Fly app.** **Rejected** — couples an unrelated MCP service to a generic browser-telemetry surface; would require an `INTERNAL_TELEMETRY_TOKEN` that every browser caller has to embed, and changes the MCP service boundary.
3. **New tiny Vercel serverless function `apps/gymtrack/api/telemetry.js` that accepts sanitized browser events and forwards to Loki with the server-held `GRAFANA_CLOUD_OTLP_HEADERS`.** **Chosen** — the function lives next to the rest of the GymTrack Vercel deployment, holds the OTLP credentials as Vercel environment variables, validates a per-deploy shared token from the browser, and applies rate-limiting + size limits before forwarding. No third-party service introduced; the existing hosted Grafana stack absorbs the new event source.

### Service ownership and data flow

- **Browser (`apps/gymtrack/src/lib/browserTelemetry.js`)** — installs global `window.onerror` and `window.onunhandledrejection` listeners, exposes `reportAuthError(error, context)` for the Clerk/Supabase auth path, applies redaction, dedupes, enforces volume control, and POSTs the sanitized event to `/api/telemetry`. Module load is gated on `VITE_TELEMETRY_ENABLED === '1'` so dev/CI builds do not emit to staging.
- **Vercel serverless function (`apps/gymtrack/api/telemetry.js`)** — accepts a POST from the browser with `Authorization: Bearer <VITE_TELEMETRY_TOKEN>`, validates the token against `TELEMETRY_RELAY_TOKEN` (Vercel env var, not bundled), enforces a 32 KB body cap, drops events without the required context fields, and forwards to Grafana Cloud Loki's `/loki/api/v1/push` with `Content-Type: application/json`. Returns `204 No Content` on success, `400` on validation failure, `429` on rate limit, `502` on upstream failure. All responses are non-blocking and uncacheable.
- **Hosted Grafana Cloud Loki** — the existing tenant absorbs the new event source. The tenant was provisioned by `bootstrap-observability.sh` (task `4b3d6e9c`); Loki's HTTP push endpoint is the standard Grafana Cloud log ingestion path.
- **Dashboard** — new `apps/gymtrack/grafana/dashboards/gymtrack-browser-errors.json` (committed to the same branch, provisioned by the same bootstrap script) lists browser events with the retained context fields. The dashboard is queryable through the existing `GRAFANA_CLOUD_INSTANCE_URL`; no new owner is created.

### What stays out of the browser bundle

- The Grafana Cloud OTLP / Loki credentials — only the Vercel function holds them.
- The Clerk publishable key stays in the bundle (already is; `VITE_CLERK_PUBLISHABLE_KEY` is a publishable value by Clerk's contract).
- A new per-deploy shared token (`VITE_TELEMETRY_TOKEN` ↔ `TELEMETRY_RELAY_TOKEN`) is generated once at deploy time by Quinn and lives in Vercel environment variables for the function and as a build-time-injected literal for the browser. It is **not** an OAuth token and has no user identity; it is a relay identifier so an attacker cannot spoof events to the function. The token is rotated on Quinn's discretion; rotation invalidates the in-flight build until the next deploy.

### What is not owned here

- **Server-side error visibility** — already covered by the OTel pipeline in `docs/systems/observability.md`. This task does not extend the server side.
- **User session replay / console capture** — out of scope. Sentry-style full replay is a separate decision and a separate service.
- **A generic cross-app error telemetry package** — premature. If Budget, Tasks, or Mission Control adopt the same pattern, the shared package is a follow-up; for now the redaction helper and the relay surface live in GymTrack.

## `.openclaw` boundary notes

- **Quinn-owned secrets** — `TELEMETRY_RELAY_TOKEN` (Vercel function env), `GRAFANA_CLOUD_OTLP_ENDPOINT` (already in `infra/cloud/observability/env/.env.example`), `GRAFANA_CLOUD_OTLP_HEADERS` (already in `infra/cloud/observability/env/.env.example`). The new secret is the relay token, generated once and rotated on Quinn's discretion; the existing two are reused.
- **Vercel environment contract** — `TELEMETRY_RELAY_TOKEN` is added to the GymTrack Vercel project. The browser-side counterpart `VITE_TELEMETRY_TOKEN` is the same value, generated by Quinn, and injected as a Vite build-time env var. Quinn's deploy notes record that both are set together, by variable name and mode — never by value, since this repository is public and comment bodies are outside every secret scanner's reach.
- **No DNS / hosting changes** — Vercel serverless functions are already a supported surface for this app (the existing `apps/gymtrack/api/agent/*.js` handlers use the same model).
- **No `.openclaw` cron changes** — Loki's HTTP push is asynchronous; no scheduled job is required.
- **Hosted Grafana dashboard provisioning** — the new `gymtrack-browser-errors.json` dashboard is provisioned by the existing `bootstrap-observability.sh` (the script's `dashboards` subcommand is a wildcard upload of every JSON in `infra/cloud/observability/grafana/dashboards/`). The dashboard path for this task is `apps/gymtrack/grafana/dashboards/gymtrack-browser-errors.json`, and the bootstrap script learns that directory in a one-line change. Quinn's `bootstrap-observability.sh all` re-run picks it up. Alternatively, the dashboard can be hand-uploaded through the Grafana UI; either is acceptable.

## Implementation plan

### File / module scope

```
apps/gymtrack/
  src/
    lib/
      browserTelemetry.js          # NEW — global listeners, redaction, dedupe, volume control, fetch relay
      browserTelemetry.test.js     # NEW — unit tests for redaction, dedupe, volume, error→payload mapping
      clerkAuth.jsx                # EDIT — call reportAuthError() at every { data: null, error: ... } return in signIn / signUp / verifySignInSecondFactor / signOut / startOAuthRedirect / the Phase 4 link RPC path
      supabaseAuth.jsx             # EDIT — call reportAuthError() at every { data: null, error: ... } return in signIn / signUp / signOut
      main.jsx                     # EDIT — call installBrowserTelemetry() once at module load (gated on VITE_TELEMETRY_ENABLED)
    components/
      LoginScreen.jsx              # EDIT (no behaviour change) — none; the dispatch happens inside signIn()
      SignUpPage.jsx               # EDIT (no behaviour change) — none
  api/
    telemetry.js                   # NEW — Vercel serverless function: token check, body cap, rate limit, Loki forward
    telemetry.test.js              # NEW — handler-level tests (token mismatch, body cap, rate limit, success path)
  vercel.json                      # EDIT — none expected; the catch-all rewrite does not intercept Vercel serverless function paths (Vercel routes functions first, then rewrites)
  grafana/
    dashboards/
      gymtrack-browser-errors.json # NEW — Grafana dashboard JSON for browser event source
infra/cloud/observability/
  bootstrap-observability.sh       # EDIT — one-line addition so the dashboards subcommand also picks up apps/gymtrack/grafana/dashboards/*.json
apps/gymtrack/SPEC.md              # EDIT — add a "Browser error telemetry" section under "Error handling"
docs/systems/observability.md      # EDIT — add a "Browser-side error telemetry" subsection that references the new surface, lists retained fields, names the redaction boundary, and names the production verification procedure (AC5)
docs/specs/
  gymtrack-browser-error-telemetry-tech-design.md  # this document
```

### Detailed behaviour

#### `apps/gymtrack/src/lib/browserTelemetry.js`

- **Module-level constants** — `MAX_EVENTS_PER_MINUTE = 5`, `MAX_PAYLOAD_BYTES = 8 * 1024`, `RELAY_URL = '/api/telemetry'`, `RELAY_TOKEN = import.meta.env.VITE_TELEMETRY_TOKEN`. The module exports `installBrowserTelemetry()`, `reportAuthError(error, context)`, and a private `redactEvent(event)`.
- **Install path** — `installBrowserTelemetry()` registers `window.addEventListener('error', …)`, `window.addEventListener('unhandledrejection', …)`, and a periodic flush on `visibilitychange === 'hidden'` so the page can drain a small in-memory queue before unload. The function is idempotent; calling it twice is a no-op (guarded by a module-level `installed` boolean).
- **Auth-error path** — `reportAuthError(error, context)` is called from every `{ data: null, error: new Error(...) }` return in `apps/gymtrack/src/lib/clerkAuth.jsx` (signIn, signUp, verifySignInSecondFactor, signOut, startOAuthRedirect) and `apps/gymtrack/src/lib/supabaseAuth.jsx` (signIn, signUp, signOut). The `context` argument is a small object: `{ provider: 'clerk' | 'supabase', operation: 'signin' | 'signup' | 'verify2fa' | 'signout' | 'oauth', errorCode: clerkSafeErrorCode(error), status: clerkSafeStatus(error) }`. The error message goes through `clerkErrorMessage` / the Supabase equivalent — it is already a user-facing string and is treated as untrusted; only the safe code / status are reported.
- **Redaction** — a fixed allow-list of fields is retained: `environment`, `release`, `route`, `operation`, `provider`, `errorCode`, `status`, `message` (truncated to 200 chars, lowercased, and stripped of emails via `/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i → '[redacted-email]'`), `stack` (truncated to 1 KB and stripped of the same patterns + `Bearer\s+[A-Za-z0-9._-]+` + `password[=:]\s*\S+`), `userAgent`, `timestamp`. The browser bundle cannot leak what it does not put in the payload.
- **Dedupe** — a per-minute rolling counter on `errorCode + operation + route` collapses repeats to one event per minute; the counter is the only memory state and is reset on `visibilitychange === 'visible'`.
- **Volume control** — a hard `MAX_EVENTS_PER_MINUTE = 5` cap on the in-memory queue prevents retry storms. Excess events are dropped silently (no error, no retry).
- **Send path** — `navigator.sendBeacon(RELAY_URL, payload)` for `visibilitychange === 'hidden'`; `fetch(RELAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer ${RELAY_TOKEN}\` }, body: JSON.stringify(payload), keepalive: true })` otherwise. Both calls are wrapped in `try { … } catch { /* swallow */ }`; the function never throws. The fetch has a 2-second `AbortController` timeout.
- **Gating** — `installBrowserTelemetry()` reads `import.meta.env.VITE_TELEMETRY_ENABLED`; if it is not the literal string `'1'`, the function returns without registering listeners. The default is "not enabled" so dev/CI builds do not emit.

#### `apps/gymtrack/api/telemetry.js`

- **Handler shape** — `export default async function handler(req, res)` matching the existing `apps/gymtrack/api/agent/*.js` style.
- **Auth** — `if (req.headers.authorization !== \`Bearer ${process.env.TELEMETRY_RELAY_TOKEN}\`) return res.status(401).end();`. The token comparison is `crypto.timingSafeEqual` against the expected value to avoid timing leakage.
- **Method check** — only `POST` is accepted; anything else returns `405` with `Allow: POST`.
- **Body cap** — the raw body is read with `getRawBody()` (Vercel helper) and rejected at `> 32 KB` with `413`. The parsed JSON is rejected at `> 8 KB` of structured fields with `400`.
- **Validation** — the payload must contain `environment` (string), `release` (string), `route` (string), `operation` (string), `errorCode` (string or null), `status` (string or null), and `timestamp` (ISO-8601 UTC). Missing required fields → `400`. The relay **re-redacts** the message / stack with the same allow-list before forwarding to Loki — defence in depth, in case the browser bundle is stale or the upstream caller is malicious.
- **Rate limit** — a process-local token bucket keyed on the relay token (`MAX_EVENTS_PER_MINUTE_PER_TOKEN = 60`, refill 60/min) returns `429` when exhausted. The bucket is per-function-instance; Vercel can route the same client to different instances, so the effective limit is approximately `60 * instance_count`. This is intentional — the goal is to stop a single misbehaving client, not to enforce a global quota.
- **Loki forward** — `fetch(process.env.GRAFANA_CLOUD_OTLP_ENDPOINT.replace('/v1/', '/loki/api/v1/push'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': process.env.GRAFANA_CLOUD_OTLP_HEADERS }, body: JSON.stringify({ streams: [{ stream: { …retained fields…, app: 'gymtrack', source: 'browser' }, values: [[\`${Date.now()}000000\`, JSON.stringify(reRedacted)] ] }] }) })`. The `otlp-gateway-<region>.grafana.net` endpoint that the existing stack uses accepts the Loki push path at the same host when the request path is `/loki/api/v1/push`; this is documented in Grafana Cloud's HTTP API. If the upstream returns non-2xx, the function returns `502`.
- **Response** — `204 No Content` on success; the function never returns the relay token or the upstream response body.
- **Token rotation** — Quinn rotates `TELEMETRY_RELAY_TOKEN` and the Vite-injected `VITE_TELEMETRY_TOKEN` together (they must be the same value). Rotation invalidates the in-flight build until the next deploy; the relay returns `401` for events from a stale build. There is no automatic re-issuance.

#### `apps/gymtrack/src/lib/clerkAuth.jsx` and `supabaseAuth.jsx` edits

- One-line additions at every `{ data: null, error: new Error(...) }` return: `reportAuthError(error, { provider, operation, errorCode: clerkSafeErrorCode(error), status: clerkSafeStatus(error) })`. The `clerkSafeErrorCode` / `clerkSafeStatus` helpers extract `error?.errors?.[0]?.code` / `error?.status` from Clerk's envelope; if either is missing the helper returns `null`. The Supabase equivalent reads `error?.code` / `error?.status`. The full list of touchpoints is enumerated in the test plan below.

#### `apps/gymtrack/src/main.jsx` edit

- One call to `installBrowserTelemetry()` after the `AuthProvider` mount but before `createRoot(...).render(...)`. The call is idempotent so the React `StrictMode` double-render in dev is safe.

#### `apps/gymtrack/grafana/dashboards/gymtrack-browser-errors.json`

- A new Grafana dashboard JSON with one panel — a `logs` panel that queries `{app="gymtrack", source="browser"}` from Loki and groups by `errorCode` and `operation`. Provisioned by the existing `bootstrap-observability.sh` (one-line addition to the script). The dashboard references `${DS_PROMETHEUS}` style datasource placeholders that the bootstrap script already rewrites.

#### `infra/cloud/observability/bootstrap-observability.sh` edit

- One-line addition: extend the `dashboards` subcommand to also `find apps/gymtrack/grafana/dashboards -name '*.json'` (in addition to the existing `infra/cloud/observability/grafana/dashboards`). Quinn re-runs `bootstrap-observability.sh dashboards` after the PR merges; the new dashboard appears in the hosted Grafana within the same provisioning cycle.

#### `docs/systems/observability.md` and `apps/gymtrack/SPEC.md` edits

- `docs/systems/observability.md` gets a "Browser-side error telemetry" subsection listing: the new event source, the `apps/gymtrack/src/lib/browserTelemetry.js` ↔ `apps/gymtrack/api/telemetry.js` ↔ Loki flow, the retained fields, the redaction boundary, and the production verification procedure (Quinn runs `bash infra/cloud/observability/bootstrap-observability.sh dashboards` to provision, then triggers a synthetic auth failure from a browser, then queries the dashboard with `{app="gymtrack", source="browser"}` to confirm ingestion).
- `apps/gymtrack/SPEC.md` gets a "Browser error telemetry" section under "Error handling" with a short user-visible statement: "Production browser errors are reported to the hosted Grafana observability stack. No user-visible UI change; failures still render inline as before."

## Data model and API contract changes

**No database or schema changes.** The change is a new client → server → Loki event surface and a new dashboard.

**No public GymTrack API contract changes.** The existing `/api/agent/*` routes are untouched. The new `/api/telemetry` endpoint is internal: it accepts events from the GymTrack browser bundle, not from third parties.

**No Clerk / Supabase contract changes.** This task only reads errors that Clerk and Supabase already return to the browser; it does not add or remove any provider-side calls.

## Workflow, cron, and skill changes

- **Cron:** none. Loki push is asynchronous; the relay is event-driven.
- **Skills:** no agent skill changes. The heartbeat procedure is unchanged.
- **Workflow:** the lobster `code-task-workflow` is unchanged. The new `[implementer-prs]` and QA-approval flow follow the existing pattern (Ash owns `qa_agent`, Tom owns `accepted`).

## Test plan

### AC verification matrix

| AC | Spec text | Planned verification | Fallback test layer |
| --- | --- | --- | --- |
| AC1 | Uncaught browser exceptions, unhandled promise rejections, and explicitly handled GymTrack authentication failures are exported from production to the hosted Grafana observability stack with environment, release, route, operation, provider, and safe Clerk error code or status context. | **E2E (Playwright, production).** Drive a real sign-in failure through `/login` (wrong password) and assert the `gymtrack-browser-errors` dashboard shows the event with the retained fields. **E2E (Playwright, production).** Throw an uncaught error from a `useEffect` mounted on a temporary test route and assert ingestion. **Unit.** `apps/gymtrack/src/lib/browserTelemetry.test.js` asserts each event source calls the relay with the retained fields. | If the live Grafana dashboard is not yet provisioned, the test asserts the `/api/telemetry` request body directly via Playwright's `page.on('request', …)` capture and validates the Loki push happened with the expected shape. |
| AC2 | Telemetry never includes passwords, session tokens, authorization headers, CAPTCHA payloads, full email addresses, or other credentials and personal data; automated tests prove redaction for representative Clerk and Supabase error envelopes. | **Unit.** A redacted-fixture table in `browserTelemetry.test.js` enumerates representative Clerk and Supabase error envelopes and asserts no `password=`, no `Bearer …`, no `clerk-captcha` payload, no email regex match survives redaction. **Unit.** The same fixture table is applied to the server-side re-redact path in `apps/gymtrack/api/telemetry.test.js`. | None — the redaction boundary is security-critical and must be covered by automated tests, not manual review. |
| AC3 | Export failure is non-blocking and does not break sign-in, sign-up, navigation, or page rendering; duplicate-event and volume controls prevent retry storms. | **Unit.** `browserTelemetry.test.js` mocks `fetch` to reject and asserts the calling auth flow still resolves with the original `{ data: null, error }` shape — the auth flow is unaffected. **E2E (Playwright).** Disable network in the browser context for the relay URL, drive a sign-in flow, assert the failure renders inline as before. **Unit.** The dedupe counter is exercised with 10 rapid events sharing the same `errorCode + operation + route` and asserts only one POST is sent. **Unit.** The volume cap is exercised with 10 distinct events in the same minute and asserts only `MAX_EVENTS_PER_MINUTE` POSTs are sent. | None — the non-blocking + dedupe + volume cap is a hard contract. |
| AC4 | A harmless induced production auth failure and a captured browser exception are both queryable in Grafana, with evidence and the operator query or dashboard path recorded in the PR or runbook. | **E2E (Playwright, production).** Quinn (or Rowan with Quinn's approval) induces a wrong-password sign-in on the production host and a `setTimeout(() => { throw new Error('gymtrack-browser-error-telemetry-evidence-2026-XX-XX') }, 0)` pasted into the devtools console on the production page. The PR body records the Grafana query that surfaces both events with timestamps within 60 seconds of the trigger. The PR body lists the dashboard URL and the Loki query `{app="gymtrack", source="browser"} \|= "gymtrack-browser-error-telemetry-evidence"`. | If Playwright is unable to drive the production Clerk flow (e.g. Turnstile is misconfigured), the fallback is a curl-based manual trigger + a Playwright assertion that the unhandled-rejection path is the captured event. |
| AC5 | GymTrack system documentation identifies the browser telemetry path, ownership, retained fields, redaction boundary, and production verification procedure. | **Doc review.** `docs/systems/observability.md` has a "Browser-side error telemetry" subsection listing the flow, the retained fields, the redaction boundary, and the production verification procedure. `apps/gymtrack/SPEC.md` has a "Browser error telemetry" section under "Error handling". The PR description links both files. | None — documentation is a hard gate. |

### Automated tests (added in this PR)

- `apps/gymtrack/src/lib/browserTelemetry.test.js`:
  - `reportAuthError` builds the expected payload for Clerk envelopes (`{ errors: [{ code, longMessage, status }] }`).
  - `reportAuthError` builds the expected payload for Supabase envelopes (`{ message, code, status, name }`).
  - Redaction strips email addresses, `Bearer …` tokens, `password=…` and `password: …` from `message` and `stack`.
  - `installBrowserTelemetry` registers exactly one `error` listener and one `unhandledrejection` listener (idempotency).
  - 10 events with the same `errorCode + operation + route` produce one POST in 60s.
  - 10 distinct events in 60s produce at most `MAX_EVENTS_PER_MINUTE` POSTs.
  - A `fetch` rejection in the relay does not throw out of `reportAuthError` or the global listeners.
  - When `VITE_TELEMETRY_ENABLED` is not `'1'`, `installBrowserTelemetry` registers no listeners.
- `apps/gymtrack/src/lib/clerkAuth.test.jsx` and `apps/gymtrack/src/lib/supabaseAuth.test.jsx`:
  - Every `{ data: null, error: new Error(...) }` return in the existing tests now also calls `reportAuthError` with the expected context. The test harness asserts the call site was reached.
- `apps/gymtrack/api/telemetry.test.js`:
  - Token mismatch → `401`.
  - Wrong method → `405` with `Allow: POST`.
  - Body over the cap → `413`.
  - Missing required field → `400`.
  - Re-redaction strips a synthetic `Bearer xyz` and email from a forwarded payload.
  - Upstream non-2xx → `502`.
  - Happy path → `204`, Loki push called with the expected shape.
- `apps/gymtrack/src/main.jsx` integration:
  - `installBrowserTelemetry` is called exactly once on module load and is a no-op when the env var is unset.

### Live verification (run by Quinn, recorded in the PR)

1. After the PR merges, Quinn re-runs `bootstrap-observability.sh dashboards` to provision the new dashboard.
2. Quinn rotates `TELEMETRY_RELAY_TOKEN` and `VITE_TELEMETRY_TOKEN` to a fresh value, sets both as Vercel env vars, and triggers a deploy. The fresh value is written to `infra/cloud/observability/.env.local` (mode `0600`, git-excluded) and piped into `vercel env add` from there. It is never pasted into a PR body, review, inline comment, task comment, or chat message: the repository is public, those artifacts are permanent, and no secret scanner reads comment bodies. The runbook procedure in `docs/systems/observability.md` § "Browser-side error telemetry" carries the value-free fingerprint check that confirms both arms hold the same value.
3. Quinn opens the production `/login` in a private window, submits an email with the wrong password, and confirms the failure is rendered inline.
4. Quinn opens the hosted Grafana dashboard, runs the query `{app="gymtrack", source="browser"}` over the last 5 minutes, and confirms the event is present with the retained fields.
5. Quinn pastes `setTimeout(() => { throw new Error('gymtrack-browser-error-telemetry-evidence-2026-XX-XX') }, 0)` into the devtools console on that same production page and confirms the uncaught exception shows up in the same Grafana query. No deploy-only debug route: a route shipped to production must be removed again on a separate cadence, and a forgotten one is a live footgun.
6. Quinn records the dashboard URL and the Grafana query in the PR comment for AC4 evidence.

## Open questions and risks

1. **Vercel function cold start latency.** A 200ms cold start on the first event after a deploy is acceptable for non-blocking telemetry; not a regression. If the first sign-in after a deploy happens before the function is warm, the in-memory rate-limit bucket on a single instance could allow slightly more than the per-instance cap. Documented in the relay implementation.
2. **Token leakage from the bundle.** `VITE_TELEMETRY_TOKEN` is intentionally a build-time-injected literal; it is a relay identifier, not a user secret. A leaked token can only emit events; it cannot read them. Documented in the `apps/gymtrack/SPEC.md` update.
3. **Loki push quota.** Grafana Cloud's free tier accepts `5 GB / day` of log volume (per the `infra/cloud/observability/README.md` upgrade path). A misbehaving client could exhaust the quota; the relay's per-instance rate limit caps the worst case at `60 * instance_count` events/min. The bootstrap script's `sindustries_cost_alert` will fire if the quota approaches the threshold; the documented escalation is to rotate `TELEMETRY_RELAY_TOKEN` to invalidate stale clients.
4. **Token rotation requires a redeploy.** `VITE_TELEMETRY_TOKEN` is a build-time literal; rotating the relay token without re-deploying leaves the browser with the old value. Quinn's deploy notes record that both are set together.
5. **Browser error volume on the first day of a real Clerk failure.** If the Clerk instance is misconfigured, the volume cap may mask the second through fifth failures in the same minute. This is a deliberate trade-off; the auth flow's existing inline error banner is the user-visible signal. The volume cap can be tuned in `MAX_EVENTS_PER_MINUTE` if it proves too aggressive in practice.
6. **What happens if the Vercel function is unavailable.** `reportAuthError` and the global listeners swallow fetch errors silently; the auth flow is unaffected. The user-visible failure is the same as before this task. The `sindustries_fly_app_health` / Vercel platform alert covers the function being down.
7. **Dashboard provisioning via the bootstrap script.** The one-line addition to `bootstrap-observability.sh` runs on Quinn's next `bootstrap` invocation. If the script is not re-run, the new dashboard is missing from the hosted Grafana; this is a Quinn-side operational step, not a code change.
8. **Cross-app reuse.** If Budget or Tasks adopt the same pattern, the redaction helper, the relay, and the dashboard are GymTrack-specific. The shared package is a follow-up task with its own tech design; not in scope here.

## AC matrix (cross-reference)

| AC | Spec text | Implementation reference |
| --- | --- | --- |
| AC1 | Uncaught browser exceptions, unhandled promise rejections, and explicitly handled GymTrack authentication failures are exported from production to the hosted Grafana observability stack with environment, release, route, operation, provider, and safe Clerk error code or status context. | `apps/gymtrack/src/lib/browserTelemetry.js` (global listeners + `reportAuthError`) + `apps/gymtrack/src/lib/clerkAuth.jsx` and `supabaseAuth.jsx` (auth-error call sites) + `apps/gymtrack/api/telemetry.js` (relay) + `apps/gymtrack/grafana/dashboards/gymtrack-browser-errors.json` (dashboard) + `docs/systems/observability.md` § "Browser-side error telemetry". |
| AC2 | Telemetry never includes passwords, session tokens, authorization headers, CAPTCHA payloads, full email addresses, or other credentials and personal data; automated tests prove redaction for representative Clerk and Supabase error envelopes. | `apps/gymtrack/src/lib/browserTelemetry.js` `redactEvent()` (client-side allow-list) + `apps/gymtrack/api/telemetry.js` server-side re-redact (defence in depth) + `apps/gymtrack/src/lib/browserTelemetry.test.js` redacted-fixture table + `apps/gymtrack/api/telemetry.test.js` re-redaction test. |
| AC3 | Export failure is non-blocking and does not break sign-in, sign-up, navigation, or page rendering; duplicate-event and volume controls prevent retry storms. | `apps/gymtrack/src/lib/browserTelemetry.js` `try { … } catch { /* swallow */ }` on the send path + dedupe counter + `MAX_EVENTS_PER_MINUTE` volume cap + `apps/gymtrack/src/lib/browserTelemetry.test.js` non-blocking + dedupe + volume tests + Playwright e2e with the relay URL blocked. |
| AC4 | A harmless induced production auth failure and a captured browser exception are both queryable in Grafana, with evidence and the operator query or dashboard path recorded in the PR or runbook. | Quinn's live verification (recorded in the PR description) + the Grafana query `{app="gymtrack", source="browser"}` and the dashboard URL + the devtools-console throw that produces the captured exception. |
| AC5 | GymTrack system documentation identifies the browser telemetry path, ownership, retained fields, redaction boundary, and production verification procedure. | `docs/systems/observability.md` § "Browser-side error telemetry" + `apps/gymtrack/SPEC.md` § "Browser error telemetry" (under "Error handling"). |
