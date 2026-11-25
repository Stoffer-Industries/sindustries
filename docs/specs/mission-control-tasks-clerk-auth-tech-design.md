---
status: shipped
task_id: ddd2f57d-0e22-499f-a785-190f81c10683
product_spec: brain/tasks/specs/in-progress/mission-control-tasks-clerk-auth-2026-11-24.md
shipped_pr: 1122
shipped_date: 2026-11-25
---

# Clerk login for Mission Control and the Tasks app — Tech Design

## Links and delivery coordinates

- Product spec: `brain/tasks/specs/in-progress/mission-control-tasks-clerk-auth-2026-11-24.md` (Tom-approved 2026-11-24)
- Task ID: `ddd2f57d-0e22-499f-a785-190f81c10683`
- Task title: `Clerk login for Mission Control and the Tasks app`
- Branch: `task-ddd2f57d-clerk-auth`
- Worktree: `/Volumes/WD1/worktrees/rowan/rowan-task-ddd2f57d-clerk-auth`
- Primary repository: `Stoffer-Industries/sindustries`
- Product-spec repository: the private OpenClaw workspace/brain repository (outside this repository)
- Existing designs: `docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md` and `docs/specs/content-scheduler-auth-tech-design.md`
- System references: `docs/systems/mission-control.md`, `docs/systems/tasks.md`, `docs/systems/gymtrack.md`, and `docs/ARCHITECTURE.md`

## Product intent summary

Mission Control and the standalone Tasks app must fail closed before rendering task data. Both browser apps use the existing production Sindustries Clerk identity pool already used by GymTrack; this work does not create, migrate, or link another identity. Neither app exposes self-serve sign-up. Product access is a separate server-side allowlist keyed by Clerk's immutable user ID, with Tom's existing Clerk identity as the initial member.

Mission Control is the primary product entry point, but both Mission Control and Tasks are Clerk satellites of GymTrack's existing primary domain. Both use satellite auto-sync so the existing primary session is recognized before either protected UI mounts, including when Tasks loads cross-origin in the iframe. A clean standalone Tasks visit may still enter Clerk's sign-in round trip. Agents remain machine identities: their current `Authorization: Bearer <service credential>` contract stays unchanged and Clerk user tokens are not issued to them.

This design also closes the iframe gap recorded in `docs/systems/mission-control.md`: Mission Control supplies an explicit sandbox and Tasks emits a `frame-ancestors` response header restricted to Mission Control.

## Ownership boundary check

- **Identity issuer:** Clerk is the sole browser identity source of truth. The verified issuer/subject pair identifies the human. Email is metadata, never an authorization key. This must reuse GymTrack's Clerk application/user pool.
- **API-owned resource:** `services/tasks-api` owns product access as deployment configuration mapping Clerk `sub` to the Tasks actor used by existing audit and permission rules. A valid Clerk identity absent from this allowlist receives `403 AUTH_FORBIDDEN`.
- **Database-backed domain data:** tasks, comments, approvals, attention owners, tags, dependencies, and analytics remain in Tasks Postgres. No task-domain migration is required. Existing `ApprovalSession` rows/table become inert after cutover and remain for a later cleanup rather than adding destructive scope here.
- **UI-local state:** each SPA's `@clerk/react` provider owns session hydration, refresh, sign-in navigation, and sign-out. Apps keep only loading/authenticated/unauthorized presentation state. They never persist JWTs themselves.
- **Shared package/cross-app contract:** the durable contract is Clerk issuer + subject, satellite configuration, and a Clerk session JWT in the Tasks API bearer header. Keep thin provider/gate modules app-local; both are satellites, while Tasks additionally carries iframe-specific policy. Both pin `@clerk/react@6.17.0`, matching GymTrack. Extract only if a third restricted SPA adopts the exact same gate.
- **Workflow/cron/skill/OpenClaw boundary:** no workflow, cron, or skill receives a Clerk token. Existing callers retain their scoped Tasks API service credential. Clerk dashboard/domain setup, Vercel/Fly secrets, allowlist values, and live checks are operator work outside this repository.

Tasks API is the correct enforcement point because UI hiding cannot protect data, and it already owns task identity/audit policy. Mission Control must not become an auth proxy.

### Incremental delivery

1. Land server verification, allowlist configuration, compatibility tests, and protected reads.
2. Land both SPA gates/token-bearing clients plus iframe/CSP hardening.
3. Provision Clerk domains and runtime secrets; deploy Tasks API, then Tasks, then Mission Control.

The API accepts Clerk JWTs and current service credentials from the first cut, so no interim browser shim is needed. The legacy password-backed browser session is retired rather than retained as a second human identity system.

## Authentication and authorization contract

### Browser flow

1. Mission Control boots under `ClerkProvider`. Until Clerk loads, it renders a neutral loading state and makes no domain requests.
2. With no session, Mission Control uses Clerk satellite auto-sync and redirects to the existing primary sign-in route. There is no `SignUp` component, `/sign-up` route, or sign-up CTA.
3. After sign-in, Mission Control calls `GET /api/v1/auth/session` with a fresh Clerk session JWT. `200` unlocks the shell; `403` renders “Not authorized” without mounting tabs or fetch effects.
4. The Tasks iframe boots as a satellite with satelliteAutoSync enabled. Its first-load sync round trip recognizes the existing primary session without user interaction; Tasks then repeats the API allowlist check and renders without another sign-in prompt.
5. A clean standalone Tasks visit follows the satellite sign-in URL and returns to the original Tasks URL. This may prompt independently but creates no second account.
6. Both apps call Clerk's token getter for every Tasks API request. Tokens stay in Clerk-managed state and are not copied to localStorage or app cookies.

GymTrack's public sign-up remains enabled in the shared Clerk instance. This task cannot disable it. “No public sign-up” means these two apps expose no sign-up surface and Tasks API separately denies every non-allowlisted subject. Creating an identity through GymTrack never grants Tasks access.

### API principal resolution

Refactor duplicate parsing in `requireAuth.ts` and `approvalAuth.ts` behind one authenticator:

1. Constant-time compare the bearer value to `TASKS_API_APPROVAL_SERVICE_CREDENTIALS`. Exact match yields the unchanged `{ actor, kind: 'service' }` principal and approval grants.
2. Otherwise verify it as a Clerk session JWT with Clerk's supported backend verifier. Validate signature, expiry/not-before, issuer, and `azp`/authorized party against exact Mission Control and Tasks origins.
3. Resolve verified `sub` through `TASKS_API_CLERK_AUTHORIZED_USERS`. A match yields `{ actor, clerkUserId, kind: 'clerk_session' }`; no match returns `403 AUTH_FORBIDDEN`.
4. Missing, malformed, expired, wrong-issuer, or wrong-party tokens return sanitized `401 AUTH_REQUIRED`.

Service matching stays first, preserving current opaque machine tokens byte-for-byte. Identity is never inferred from email, request body, `x-actor`, or unverified claims. The mapped actor feeds existing approval and attention-owner policy. The central result populates both `req.user` and the approval-principal adapter so approval routes do not verify twice or drift.

### Protected routes

Authentication applies to every method under:

- `/api/v1/tasks/**`
- `/api/v1/tags/**`
- `/api/v1/task-types/**/required-approvals`
- `/api/v1/feature-task-analytics/**`
- `GET /api/v1/auth/session`

`/health`, `/api/v1/health`, and CORS OPTIONS remain public. CORS allows credentials/Authorization only for exact configured Mission Control and Tasks origins.

Legacy `POST` and `DELETE /api/v1/auth/session` are removed. `GET` becomes the bearer-authenticated principal read. `TASKS_API_APPROVAL_USERS` and session-TTL configuration retire. The Prisma `ApprovalSession` model remains unused for a later cleanup.

## Mission Control ↔ Tasks iframe security

### Primary/satellite setup

- GymTrack's existing domain remains the Clerk instance's sole primary. Mission Control and Tasks are both satellites and use its absolute sign-in URL.
- Both apps configure Clerk's satellite settings, including `satelliteAutoSync=true`: `isSatellite`, their environment domain, and the absolute existing-primary sign-in URL; return navigation preserves each app's original URL.
- Production and staging pairs are explicit. Preview domains are not implicitly trusted and receive no production API access.
- The same Clerk application/key family as GymTrack is mandatory. A second application/user pool is prohibited.

### Sandbox

`apps/mission-control/src/tabs/TasksTab.jsx` emits:

```jsx
<iframe
  src={tasksAppUrl()}
  sandbox="allow-scripts allow-same-origin allow-forms"
  allow="clipboard-write"
  referrerPolicy="strict-origin-when-cross-origin"
/>
```

`allow-scripts` supports React/Clerk, `allow-same-origin` supports origin-bound Clerk state and API behavior, and `allow-forms` supports app forms. Do not initially add top-navigation or popup permissions: the embedded board is already authenticated, while standalone sign-in is not sandboxed. If live satellite evidence requires more, review the exact capability before widening.

### CSP

Tasks Vercel responses, including SPA fallbacks, set a response header:

```text
Content-Security-Policy: frame-ancestors https://mission-control.sindustries.co.nz https://mission-control.staging.sindustries.co.nz
```

No wildcard, generic subdomain, preview domain, or unrelated product is allowed. Local Vite uses the exact configured localhost Mission Control origin only in development. `X-Frame-Options` must not conflict. The sandbox limits iframe capability; `frame-ancestors` limits embedders, so both are required.

## Implementation plan and file/module scope

### 1. Tasks API

- `services/tasks-api/package.json` and lockfiles: add/pin Clerk's supported server package (`@clerk/backend`).
- `src/config/env.ts`: add Clerk verification key/secret, `TASKS_API_CLERK_AUTHORIZED_USERS`, and `TASKS_API_CLERK_AUTHORIZED_PARTIES`. Validate users as unique nonblank `{ clerkUserId, actor }` rows and production parties as exact HTTPS origins. Extend redaction tests.
- `src/middleware/authenticate.ts` (new): own service matching, Clerk verification, allowlist resolution, and normalized principal/errors.
- `src/middleware/requireAuth.ts`: delegate to the shared authenticator and accept `service` or `clerk_session`.
- `src/middleware/approvalAuth.ts`: reuse the principal while preserving `ACTOR_PERMISSIONS` and grant/revoke distinctions.
- `src/app.ts`: gate all domain reads and writes, leaving health/OPTIONS public; retain exact-origin CORS.
- `src/routes/approvalSessions.ts`: replace password/cookie lifecycle with principal GET (or rename to `authSession.ts` while preserving the GET URL); unmount POST/DELETE.
- Tests: add verifier-adapter, allowlist, wrong-party/expired JWT, all protected reads, actor mapping, and unchanged service credential read/write/approval coverage.

### 2. Browser gates

- `apps/mission-control/package.json`, `apps/tasks/package.json`, root lockfile: add exact `@clerk/react@6.17.0`.
- New `src/auth/clerkConfig.js`, `AuthBoundary.jsx`, and `token.js` in each app: fail-fast config, loading/signed-out/unauthorized states, and an in-memory token getter. Clear the getter on unmount/sign-out.
- `apps/mission-control/src/main.jsx`: mount primary `ClerkProvider` and boundary outside `App`.
- `apps/tasks/src/main.jsx`: mount satellite `ClerkProvider` and boundary outside `App`.
- Component tests mock Clerk at the provider seam and assert children never mount before authorization.

### 3. API clients and Tasks UI

- `apps/mission-control/src/tasksApi.js` and `apps/tasks/src/tasksApi.ts`: add a fresh bearer token to every Tasks API call; refuse to fetch if token acquisition fails.
- Tasks `fetchAuthSession` remains but is bearer-backed. Remove `LoginPayload`, `login`, and cookie `logout`.
- `useCurrentUser.js`, `ApprovalsSection.jsx`, and `AttentionOwnersPanel.jsx`: consume the established principal; remove inline username/password and cookie logout. Preserve row-level API errors.
- Unit tests assert bearer headers on every method, no fetch without token, and no password UI.

Mission Control's non-Tasks clients remain unchanged. The shell gate prevents anonymous mounting, but each owning service remains responsible for future server authorization; this task does not proxy them through Tasks API.

### 4. iframe/header hardening

- `TasksTab.jsx` and its test: exact sandbox/referrer policy.
- `apps/tasks/vercel.json`: `frame-ancestors` on all SPA responses/fallbacks.
- `apps/tasks/vite.config.js` and tests: development-only exact shell-origin header.
- Add config tests rejecting wildcard ancestors/conflicting `X-Frame-Options`, plus live `curl -I` smoke.

### 5. Shipped documentation

- Update both app `SPEC.md` files with sign-in, unauthorized, standalone, embedded flows and E2E references.
- Update `docs/systems/mission-control.md` with satellite/sandbox/CSP posture.
- Update `docs/systems/tasks.md` from password sessions/open reads to Clerk JWT + allowlist while retaining service credentials.
- Mark this design shipped with PR/date in the implementation PR.

## Data model and API changes

No domain schema migration is needed. Clerk stores identity; Tasks API configuration stores the small product-access mapping. No email, password hash, Clerk token, or duplicate profile is added to Tasks Postgres.

### Runtime configuration

- Both SPAs: `VITE_CLERK_PUBLISHABLE_KEY`
- Mission Control: VITE_CLERK_SATELLITE_DOMAIN and VITE_CLERK_SIGN_IN_URL for the existing primary
- Tasks: `VITE_CLERK_SATELLITE_DOMAIN`, `VITE_CLERK_SIGN_IN_URL`, existing `VITE_SHELL_ORIGIN`
- API: Clerk secret/JWT key, `TASKS_API_CLERK_AUTHORIZED_USERS='[{"clerkUserId":"user_...","actor":"Tom"}]'`, exact authorized-party origins
- Existing `TASKS_API_APPROVAL_SERVICE_CREDENTIALS`: unchanged

| Request | Result |
| --- | --- |
| Health / OPTIONS | unchanged and public |
| Domain route with no, invalid, or expired user token | `401 AUTH_REQUIRED` |
| Valid Clerk token, subject not allowlisted | `403 AUTH_FORBIDDEN` with non-invitation copy |
| Valid allowlisted Clerk token | existing response; actor from allowlist |
| Existing service bearer | unchanged response, actor, and permissions |
| Auth-session GET with allowlisted Clerk token | actor/displayName/approvalTypes only; no token/profile leakage |
| Auth-session POST/DELETE | retired (`404` after unmount) |

## `.openclaw` and operator boundary

1. Confirm the GymTrack production Clerk instance.s existing primary sign-in URL and register both Mission Control and Tasks as satellites; do not attempt to create a second primary.
2. Register both production/staging satellite domains, redirects, allowed origins, and auto-sync settings in that existing application. Do not create another user pool.
3. Read Tom's immutable Clerk user ID from Clerk Backend API/Dashboard and provision its `Tom` mapping; do not key from email.
4. Provision publishable keys to Vercel and verification secret/key plus allowlist/parties to Fly. Never expose server secrets through Vite.
5. Deploy API → Tasks → Mission Control, run staging cross-domain/header checks, then promote. Keep previous releases for rollback.
6. If sandboxing blocks a required Clerk capability, return evidence to this design before widening it.

## Workflow, cron, and skill changes

- Feature-task workflow and gates: no logic change.
- Agent skills/callers: no command/header change. `tasks_api_client.py` and workflows retain scoped service tokens; add compatibility tests instead of editing callers.
- Cron: no change and no browser/Clerk user-token acquisition.
- Deployment manifests/environment matrices: require server Clerk configuration and frontend public Clerk/domain values before promotion; secrets stay external.

## Test plan

Automated layers:

1. API unit/integration: verifier adapter, issuer/expiry/party failures, subject allowlist, `401` vs `403`, actor mapping, all protected routes, approvals, service compatibility, CORS, and public health.
2. Component/unit: both gates; no child fetch before authorization; no sign-up link; unauthorized copy; token injection; password UI removal; iframe attributes.
3. Tasks Playwright: unauthenticated standalone redirect, authorized load, unauthorized state, and bearer-backed mutation, using Clerk's supported test token/invited CI identity only if no human credential is stored.
4. Mission Control Playwright: redirect and shell gate. Cross-domain satellite checks run against deployed staging because local origins do not reproduce Clerk's configured domain handshake.
5. Live staging: clean-browser single sign-in, iframe no-second-prompt, direct Tasks behavior, one read/reversible mutation, and `curl -I` CSP evidence.

### Acceptance-criterion verification matrix

| AC | Verification | Layer / fallback |
| --- | --- | --- |
| AC1 | Clean Mission Control and Tasks contexts redirect before children mount; unauthenticated API GET and mutation return `401` before handlers/Prisma. | Playwright for visible flow + API integration for real boundary. |
| AC2 | Tom's existing Clerk subject reaches both apps and resolves to actor `Tom`; configs pin the GymTrack Clerk key/issuer family. | Staging E2E/manual with Tom's real account because fixtures cannot prove the production record; API integration covers subject mapping. |
| AC3 | No sign-up route/CTA; signed JWT for a non-allowlisted subject gets `403`; both apps render “Not authorized” without domain UI. | Component + API integration; staging E2E with test identity where available. |
| AC4 | Sign into Mission Control once, then assert iframe board appears without sign-in UI/second interaction. | Cross-domain staging Playwright preferred. If Clerk anti-bot/testing policy blocks it, record the blocker and use manual Chromium/WebKit plus component/config tests; local E2E is insufficient. |
| AC5 | Fresh standalone Tasks visit prompts/round-trips and returns to Tasks board. | Staging Playwright; same documented manual fallback if Clerk disallows automation. |
| AC6 | Representative GET, write, comment, and approval calls with current service credential preserve actor/permission behavior; agent client uses no new flags. | API integration/contract tests. |
| AC7 | Exact iframe sandbox/referrer attributes; config has only approved ancestors; deployed root and SPA route return matching CSP. | Component + config/file tests + live header smoke; browser verifies allowed embed. |

## Rollout and rollback

Prove service credentials in staging, deploy the protected API, then immediately deploy Tasks and Mission Control. Old frontends receive deliberate fail-closed `401` during the short coordinated window. Roll back all three surfaces together; never leave new frontends against reopened API reads, and do not re-enable the password store as an emergency path.

## Open questions and risks for Quinn review

1. **Resolved topology:** Clerk permits one primary domain per instance, so GymTrack remains primary and both internal apps are satellites using satellite auto-sync. A second application/user pool remains prohibited.
2. Confirm Tom's immutable `user_...` ID and canonical actor spelling `Tom`.
3. Should staging register in the production Clerk application? A separate staging application would not prove AC2 and must not become the production plan.
4. Does Clerk's supported testing-token flow work across custom primary/satellite domains? If not, AC4/AC5 need documented manual staging evidence; Tom's password/OAuth refresh/session token must not enter CI.
5. Test the least-privilege sandbox in Chromium and WebKit. Any widening needs evidence naming the blocked Clerk operation.
6. Confirm whether to create a later `ApprovalSession` cleanup task after rollback confidence; it is not required here.
7. Gating Mission Control hides its other tabs from anonymous users, but does not add Clerk verification to Bookmarks or Content Scheduler APIs. If “cannot view Mission Control” means every underlying service API must become private, that is additional cross-service scope requiring owner-specific designs.
