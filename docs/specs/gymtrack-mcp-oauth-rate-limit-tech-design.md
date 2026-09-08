---
status: draft
task_id: 37bbc104-613e-4266-b5f7-cd7de08b4551
product_spec: n/a (audit-driven hardening)
shipped_pr: null
shipped_date: null
---

# Tech Design — Rate-limit gymtrack-mcp public OAuth endpoints

## 1. Product intent

Audit finding from `docs/repo-audits/2026-W37.md` (T1.1, Security, High):

> gymtrack-mcp public OAuth endpoints have no rate limiting. `/oauth/register`
> (`src/app.js:347`) is open Dynamic Client Registration
> (`registration_endpoint_auth_methods_supported: ["none"]`,
> `src/app.js:342`) — any unauthenticated caller can create an OAuth client row
> via `repo.createDynamicOAuthClient` (`src/app.js:359`) with no throttle.
> `/oauth/token` (`src/app.js:498`) is likewise unthrottled. **Consequence:**
> unbounded client-registration rows (DB growth / storage abuse) and an
> unmetered surface for credential-stuffing the token endpoint.

Goal: add a fixed-window rate limit per source IP to every unauthenticated
write surface on the gymtrack-mcp OAuth server, mirroring the shape used in
the sibling `content-scheduler-api`. Health and discovery GETs remain
unthrottled so MCP client discovery (`/.well-known/*`) and liveness
probes still work under load.

## 2. Repo / branch / worktree

- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-37bbc104-gymtrack-mcp-oauth-rate-limit` (from `origin/main`,
  HEAD `9c03b68` at design time)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-37bbc104-gymtrack-mcp-oauth-rate-limit`
- **Task:** `37bbc104-613e-4266-b5f7-cd7de08b4551` (code task, assignee Rowan)
- **Audit source:** `docs/repo-audits/2026-W37.md` (finding T1.1)

## 3. Service boundary and data ownership

**Owner:** `services/gymtrack-mcp` (the OAuth authorization server + MCP
resource server — same package, single Express app). The rate limit is
HTTP-middleware-scoped to this service and shares no state with any sibling
service. No cross-service contract, no shared package.

**Why not a shared `service-rate-limit-middleware`:** the audit explicitly
recommends inlining the shape (`reuse the shape of
content-scheduler-api/src/middleware/rateLimit.ts` rather than pulling a new
dep). Sibling services each carry their own copy; the cross-service extraction
is a separate queued follow-up. Following that pattern here keeps the diff
small, reviewable, and consistent with how the three sibling services already
ship.

**Why not `express-rate-limit`:** `gymtrack-mcp/package.json` currently
declares only `express` + `@supabase/supabase-js` (no rate-limit dep). The
fixed-window contract is ~30 lines of straightforward code — adding a dep for
it expands supply-chain surface area for a security change without changing
the user-visible behaviour. The audit sketch (`fixed-window, in-memory Map
keyed by IP`) is exactly what hand-rolling gives us.

**Data ownership:** none added. The middleware holds an in-memory `Map<ip,
{count, windowStartMs}>` keyed by `req.ip`. Map entries are evicted on a
fixed schedule (sweep every `windowMs`) — see §6 for eviction policy.

## 4. `.openclaw` boundary notes

None. The change is fully self-contained inside `services/gymtrack-mcp/` and
the docs subtree. No agent config, scheduler, or workflow change.

## 5. Implementation plan

### 5.1 New file

`services/gymtrack-mcp/src/middleware/rateLimit.js` — hand-rolled
fixed-window per-IP rate limiter. Exports
`createRateLimit({ name, windowMs, max, exemptPaths })` matching the
ergonomics of the TS sibling (`content-scheduler-api/src/middleware/rateLimit.ts`).

- **Window:** `windowMs` milliseconds (default 60_000).
- **Limit:** `max` requests per IP per window (default 10, configurable via
  env `GYMTRACK_MCP_OAUTH_RATE_LIMIT` and `GYMTRACK_MCP_OAUTH_RATE_WINDOW_MS`).
- **Key:** `req.ip` (Express resolves this from `X-Forwarded-For` /
  `req.socket.remoteAddress`; gymtrack-mcp sits behind Fly so trust-proxy is
  configured at the deployment layer).
- **On first hit in window:** record `windowStartMs`, count = 1, pass through.
- **On hits ≤ max:** increment, pass through.
- **On hit > max:** respond `429 Too Many Requests` with the existing JSON
  error envelope: `{ error: { code: 'RATE_LIMITED', message: 'Too many
  requests; try again later' } }` — matches the content-scheduler shape
  exactly so client error handling is uniform across services.
- **`Retry-After` header:** set to the remaining ms in the window, rounded
  up to seconds (RFC 6585).
- **`X-RateLimit-*` headers:** emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` on every response (sibling services use
  `standardHeaders: 'draft-7'`, which is a different header scheme — we
  match the content-scheduler X-RateLimit headers for consistency with the
  audit shape rather than the IETF draft, since gymtrack-mcp is plain JS
  and Express 4 headers are easier to reason about).
- **Logging:** `console.warn` on every 429 with `{ name, ip, method, path }`
  (matches content-scheduler line `console.warn('[content-scheduler-api
  rate-limit] blocked …', …)` so log scrapers can pattern-match across
  services).
- **Eviction:** setInterval-based sweep every `windowMs` removes entries
  whose `windowStartMs + windowMs < now`. Track handle on the returned
  middleware so `server.close()` can `clearInterval` it cleanly — no
  leaked timers between tests.

### 5.2 Edits to `services/gymtrack-mcp/src/app.js`

Mount the middleware **only on the OAuth write routes**, after the body
parsers and after the JSON error envelope is established, but **before** the
route handlers. Concretely, replace the current naked route mounts with:

- `app.post('/oauth/register', oauthRateLimit, async (req, res) => { … })`
  (line 347)
- `app.post('/oauth/token', oauthRateLimit, async (req, res) => { … })`
  (line 498)
- `app.get('/oauth/authorize', oauthRateLimit, async (req, res) => { … })`
  (line 396) — AC3 covers GETs hitting `repo.createOAuthAuthorizationCode`
- `app.post('/oauth/authorize/decision', oauthRateLimit, async (req, res) =>
  { … })` (line 430) — POST decision is part of the authorize flow and
  should be throttled with the same envelope

Routes that **remain unthrottled** (per AC4):

- `app.get('/'…)` (line 319) — root
- `app.get('/health'…)` (line 327) — health probe
- `app.get('/.well-known/oauth-authorization-server'…)` (line 331)
- `app.get('/.well-known/oauth-protected-resource'…)` (line 387)
- `app.post('/oauth/revoke'…)` (line 620) — **excluded on purpose**:
  revocation requires a presented bearer token; abuse requires already
  possessing a valid token, which is bounded by the token-issuance rate
  limit above. Including revoke would break the legitimate "client app
  uninstalls → revoke" path if a deployment ever hits the limit.
- `app.post('/mcp'…)` (line 644) — JSON-RPC surface, not part of AC1–AC3
  scope; rate-limiting the MCP surface is a separate concern (covered by
  per-client Bearer auth, not IP throttling).

### 5.3 Env config

Add to `services/gymtrack-mcp/src/config.js`:

- `oauthRateLimitMax` (default 10)
- `oauthRateLimitWindowMs` (default 60_000)

Read from `process.env.GYMTRACK_MCP_OAUTH_RATE_LIMIT` /
`process.env.GYMTRACK_MCP_OAUTH_RATE_WINDOW_MS` with the existing
`loadConfig()` pattern. Defaults are conservative for a public
unauthenticated surface; can be tuned per environment without a deploy if
the deploy platform allows env override.

### 5.4 Files touched (summary)

- `services/gymtrack-mcp/src/middleware/rateLimit.js` — **new** (~60 LoC)
- `services/gymtrack-mcp/src/app.js` — mount middleware on 4 routes (~4 LoC diff)
- `services/gymtrack-mcp/src/config.js` — 2 new config fields (~6 LoC diff)
- `services/gymtrack-mcp/test/rateLimit.test.js` — **new** (~120 LoC)
- `services/gymtrack-mcp/package.json` — no dep change

## 6. Operational notes

- **In-memory state:** the limiter is per-process. With gymtrack-mcp running
  as a single Fly app instance in `syd`, that's a single map. If/when the
  service scales horizontally, the limit will become per-instance (each
  instance has its own window) — that's the same posture as
  content-scheduler-api today, and the audit does not call this out as a
  defect. Distributed rate limiting (e.g. Redis-backed) is a separate
  decision if/when the deployment shape changes.
- **Clock skew:** windows are wall-clock per process. Acceptable for a
  security hardening whose primary goal is bounding per-source-IP abuse;
  precise global fairness is not a requirement.
- **Memory ceiling:** worst case = `windowMs / 1000 * max_unique_IPs` active
  entries. At default `windowMs=60_000`, `max=10`, ~10k unique IPs in a
  minute, each entry is ~80 bytes → ~800 KB. Well within the Fly machine
  envelope.

## 7. AC-by-AC verification matrix

| AC  | Behaviour expected                                                                                          | Test layer       | Test file / location                                              |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| AC1 | Repeated `POST /oauth/register` from one IP → 429 after threshold; first request succeeds; error envelope matches `{ error, message }` | vitest (integration) | `test/rateLimit.test.js` — `register: 429s after 10 in window`, `first-request always passes`, `response shape matches content-scheduler envelope` |
| AC2 | `POST /oauth/token` throttled with same shape; legitimate in-window exchanges unaffected; over-limit → 429    | vitest (integration) | `test/rateLimit.test.js` — `token: in-window success, over-limit 429` |
| AC3 | `GET /oauth/authorize` (and any other OAuth GETs hitting `repo.createOAuthAuthorizationCode`) throttled same shape | vitest (integration) | `test/rateLimit.test.js` — `authorize: 429 after threshold`        |
| AC4 | Health and discovery GETs (`/health`, `/.well-known/*`) exempt — never 429 even after threshold             | vitest (integration) | `test/rateLimit.test.js` — `exempt: /health and .well-known/* are never throttled`, `exempt: exempt even when IP is over limit` |
| AC5 | New vitest cases cover (a) first-request success, (b) 429 after threshold, (c) window reset, (d) exemption of `.well-known/*` and `/health` | vitest | All four assertions in `test/rateLimit.test.js` (one per sub-AC)    |
| AC6 | Existing gymtrack-mcp vitest suite (24 tests) remains green; CI `gymtrack-mcp-tests` job passes              | CI | `.github/workflows/ci.yml:531` — `gymtrack-mcp-tests` job on the PR branch |

**E2E coverage:** not possible for this task. The unauthenticated OAuth
write surface is a programmatic HTTP API (no user-visible UI flow), the
MCP client discovery path is exempt from rate-limiting, and the existing
integration tests via `supertest` already exercise the Express app in the
same shape the production server uses. Vitest + supertest is the
proportional fallback.

## 8. Open questions and risks

1. **`/health` vs `/healthz`** — AC4 wording says `/healthz`, the code has
   `/health` (`src/app.js:327`). No `/healthz` route exists. Treating this as
   a typo in the AC and applying exemption to the existing `/health` route;
   the audit explicitly exempts "health/discovery `.well-known` GETs" which
   matches `/health`. Flagging in case Tom wants to standardise on
   `/healthz` later — that's a separate refactor, not in this PR.

2. **`/oauth/authorize/decision` POST** — not explicitly named in AC1–AC3,
   but it's the second half of the authorize flow and shares the same
   abuse profile (a GET followed by a POST both hit
   `repo.createOAuthAuthorizationCode`). Including it in the throttle set
   for consistency. If Tom prefers strict AC scope, drop it and add a
   follow-up task — the diff still passes AC1–AC6.

3. **`/oauth/revoke` excluded on purpose** — see §5.2. If a future threat
   model wants revoke throttled, that's a follow-up.

4. **Single-instance assumption** — see §6. Documenting here so reviewers
   don't ask "why not Redis" in the PR review.

5. **Config defaults** — 10 req / 60 s per IP is conservative. If the W37
   audit traffic shape suggests a different default, Tom can override via
   env without a code change.

## 9. Definition of Done

- Tech design merged via the implementation PR (this doc moves to
  `status: shipped` with `shipped_pr` and `shipped_date` in the same PR).
- All 6 ACs covered by tests in `services/gymtrack-mcp/test/`.
- Existing 24-test vitest suite green; CI `gymtrack-mcp-tests` job green on
  the PR branch.
- No new runtime dependencies in `package.json`.
- System spec note: if any `docs/systems/gymtrack-mcp.md` exists at ship
  time, mention the new middleware in its operational surface section;
  otherwise leave the systems doc tree alone (audit follow-up: the systems
  doc for gymtrack-mcp is currently absent — adding one is out of scope
  for this security fix).
- `apps/gymtrack/SPEC.md`: no update — user-visible behaviour is unchanged
  (the only new behaviour is a 429 response on abuse, which is a backend
  hardening rather than a user-facing flow change).
