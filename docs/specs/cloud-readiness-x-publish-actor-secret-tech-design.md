---
status: draft
task_id: 38d2ee65-a6c0-4952-a8ca-ad03d4856eb1
product_spec: n/a (audit-driven: docs/repo-audits/2026-W29.md Theme 3 / Milestone 0-C)
shipped_pr: null
shipped_date: null
---

# Cloud readiness: gate Content Scheduler X publish with actor secret

## Links

- Product spec: n/a — derived from `docs/repo-audits/2026-W29.md` Theme 3 / Milestone 0-C
- Tech design: `docs/specs/cloud-readiness-x-publish-actor-secret-tech-design.md`
- Task: `38d2ee65-a6c0-4952-a8ca-ad03d4856eb1`
- Tasks API record: `http://localhost:4001/api/v1/tasks/38d2ee65-a6c0-4952-a8ca-ad03d4856eb1`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-38d2ee65-cloud-readiness-x-publish-actor-secret`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: none — runtime config only.

## Scope

The Content Scheduler service exposes a publish endpoint that, when `X_CLIENT=real`, posts to the real X API. The current guard is `x-actor: user`, a header any client can forge. Before cloud exposure we need a shared-secret check so unauthenticated callers cannot trigger real posts.

This task adds a `requireActorSecret` middleware to `services/tasks-api` that validates `x-actor-secret` against `process.env.X_ACTOR_SECRET` when the env var is configured. When `X_ACTOR_SECRET` is unset the middleware is a no-op and the existing dev/test path is preserved.

## Ownership boundary

- The actor secret is a runtime-config concern, owned by the service that performs the side effect. Content Scheduler's X publish path lives in `services/tasks-api`, so the middleware belongs there alongside the existing publish handler.
- We deliberately reuse the same header-name convention (`x-actor-*`) and the same env-var naming pattern (`X_ACTOR_*`) as the existing X client config so the surface stays self-consistent.
- No new shared package is introduced. The middleware is a 30-line module reused by both Content Scheduler publish and any future actor-gated routes.

## Implementation plan

File/module scope:

- `services/tasks-api/src/middleware/requireActorSecret.ts` — new middleware. Reads `X_ACTOR_SECRET` from `process.env`. When unset, calls `next()` immediately. When set, compares `req.header('x-actor-secret')` using `crypto.timingSafeEqual` on equal-length buffers; mismatched/missing header returns 401 before any X API call is attempted.
- `services/tasks-api/src/routes/contentScheduler.ts` (or current publish route) — wire the middleware into the publish handler for `POST /items/:id/publish`. Apply only to the real-publish branch (when `X_CLIENT === 'real'`), so mock/dev paths remain unblocked.
- `services/tasks-api/src/server.ts` (or app bootstrap) — register middleware globally before the publish route, with a helper that resolves the secret once at boot and logs at startup whether the gate is active.
- `services/tasks-api/.env.example` — document `X_ACTOR_SECRET` alongside `X_CLIENT`, `X_API_BEARER_TOKEN`, and `X_HANDLE`. Include a comment: "leave unset in dev/test to keep the publish path open; set in cloud to gate real posts".
- `services/tasks-api/test/actor-secret.test.ts` — new. Covers: (a) unset secret → request proceeds; (b) set secret + matching header → 200; (c) set secret + missing header → 401 before any X fetch is attempted; (d) set secret + wrong-length header → 401 (no crash); (e) CI assertion that the publish route does not call the X client when the gate rejects.
- `services/tasks-api/test/contract/publish.test.ts` (or existing publish tests) — extend with a guard-rail assertion that with `X_ACTOR_SECRET` set, unauthenticated publish returns 401 before the X client is invoked (mock the X client and assert it was not called).

## Data model / API contract

- New request header: `x-actor-secret: <string>` — required when `X_ACTOR_SECRET` env var is set.
- New env var: `X_ACTOR_SECRET` — optional in dev/test, required in cloud. Not committed to `.env`; sourced from cloud runtime secrets.
- Failure mode: `401 { error: "actor_secret_required" | "actor_secret_mismatch" }` with no body leakage about which side failed.

## Workflow / cron / skill changes

- None. No Lobster pipeline touches this surface; no cron touches Content Scheduler publish.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — publish route validates `x-actor-secret` against `process.env.X_ACTOR_SECRET` when env var set | `actor-secret.test.ts`: case (b) proves pass; case (c)/(d) prove reject. Asserts the check happens before `XClient.post` is awaited. |
| AC2 — missing/mismatched secret returns 401 before any X API call is attempted | `contract/publish.test.ts` spies on the X client and asserts it is **not** called for 401 cases; asserts response status is 401 and body is the gate error. |
| AC3 — local/dev/test mode usable when secret unset, behavior documented | `actor-secret.test.ts` case (a) + README/.env.example note that leaving `X_ACTOR_SECRET` unset keeps the publish path open. CI matrix runs tests with the env var unset and expects pass. |
| AC4 — `services/tasks-api/.env.example` documents `X_ACTOR_SECRET` | File diff check in PR review. |
| AC5 — CI proves unauthenticated publish blocked when secret configured | CI job sets `X_ACTOR_SECRET=test-secret` and runs the publish contract test with no header → expects 401; same job runs with matching header → expects the X client mock to be invoked. |

User-visible ACs: AC1, AC2, AC3, AC5 are exercised via the API contract test (no app UI involved). E2E is not applicable — the gated route is an internal API surface, not a user-facing flow.

## Open questions and risks

- **Shared-secret rotation**: how does `X_ACTOR_SECRET` get rotated in cloud without downtime? Out of scope for this task; document in the README runbook that rotation requires a coordinated deploy.
- **Where the header is sourced from**: the publish path is currently only invoked from Content Scheduler's own internal caller. If a future browser-facing endpoint ever calls publish, the secret must not be embedded in client code. Flag this as a follow-up if/when that surface appears.
- **Header length mismatch**: `timingSafeEqual` requires equal-length buffers — handle that case explicitly to avoid crashes on malformed input.

## Linked audit

- `docs/repo-audits/2026-W29.md` — Theme 3 (Cloud-readiness: Content Scheduler X publish path), Milestone 0-C, severity High.