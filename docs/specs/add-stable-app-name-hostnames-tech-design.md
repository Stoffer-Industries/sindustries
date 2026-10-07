---
status: draft
task_id: 5cb4a8fe-6069-4b3c-b2ef-0b8dc61cdb3c
product_spec: brain/tasks/specs/open/stable-app-name-hostnames.md
shipped_pr: null
shipped_date: null
---

# Add stable app-name hostnames for staging and production

## Links and delivery metadata

- Task: `5cb4a8fe-6069-4b3c-b2ef-0b8dc61cdb3c`
- Task title: `💻 Add stable app-name hostnames for staging and production`
- Task type: `code` (`code-task-workflow`)
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-5cb4a8fe-6069-4b3c-b2ef-0b8dc61cdb3c-stable-app-name-hostnames`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/rowan-stable-app-name-hostnames`
- Tech design: `docs/specs/add-stable-app-name-hostnames-tech-design.md`
- Companion (workstream 2 of 7): task `2850c5ac-252e-404a-863b-b83755b2f618` (`cloud-staging-environment`) — this design consumes the staging topology that workstream delivers.

## Clarification and assumptions

No clarification is needed before design approval because the staging topology prerequisite (`2850c5ac`) and the cloud deployment foundation (`b2f62c36`) own the underlying Fly/Vercel bindings; this design wires stable hostnames on top of those bindings without changing process topology. Implementation must stop if any prerequisite is incomplete or its delivered interface differs from the assumptions below.

Assumptions:

1. `sindustries.co.nz` is the canonical brand domain (per `docs/designs/brand-spec.md` and `docs/specs/mc-sindustries-brand-site-tab-tech-design.md`); it is already registered and the DNS zone is operator-editable. The foundation's `sindustries.dev` reservation is **superseded for staging and production** by this design — see Open Question 1 for the rationale and required Quinn confirmation.
2. DNS/TLS secrets (registrar token, DNS provider token, optional API tokens for Fly/Vercel `certs add`) are Quinn-owned and stay outside this repo. The design references provider APIs by name only.
3. The auto-post worker has no public URL and continues to have none — only its upstream HTTP API and the auto-post BullMQ queue are addressable. This is recorded in the matrix below.
4. CORS configuration is per-service via the `CORS_ALLOWED_ORIGINS` CSV env var already shipped in `services/content-scheduler-api`; parallel treatment for `services/tasks-api` and `services/budget-api` is in scope where missing.
5. Frontend build-time API base URLs are `VITE_TASKS_API_BASE_URL`, `VITE_CONTENT_SCHEDULER_API_BASE_URL`, `VITE_BOOKMARK_STATE_BASE_URL`, `VITE_TASKS_APP_URL`, and `VITE_SHELL_ORIGIN` (consumed by `apps/mission-control`, `apps/tasks`). No Expo/RN build-time URLs are touched — GymTrack stays out of scope per AC1.
6. Production DNS/TLS may be left in a documented-but-unprovisioned state at PR close, provided no production credentials are written, no staging URL resolves to production data, and AC6's blocker checklist records every remaining step.

## Scope

In scope:

- Define and commit the staging and production hostname matrix for the six public surfaces in AC1.
- Add Fly custom domains + Let's Encrypt certs for the four staging HTTP Fly apps; document the production counterpart without applying it.
- Add the matching custom domains to the three Vercel frontends (`apps/tasks`, `apps/gymtrack` (documented-only — see Out of scope), `apps/mission-control`); production mirrors follow the same DNS plan.
- Update each service's `CORS_ALLOWED_ORIGINS` (or equivalent middleware) to allow the stable staging origins and (after Quinn sign-off) the production origins.
- Update each Vercel project's build-time env vars to point at the stable API hostnames.
- Update the staging deploy workflows (`.github/workflows/deploy-staging-*.yml`) to smoke-check via the stable hostname.
- Update the cloud-system doc (`docs/systems/cloud-platform.md`), the cloud deploy-runbook references in this repo, and the staging validation doc template to use stable hostnames; keep `*.fly.dev` / `*.vercel.app` URLs only as documented fallback paths where AC4 permits.
- Add `tests/cloud/stable-hostname-verification.mjs` (and its `*.schema.json`) to prove AC5 end-to-end against staging; document the production counterpart as a manual Quinn gate.
- Record DNS/TLS setup steps and remaining production blockers in the PR description for AC6.

Out of scope:

- Production data migration or cutover (tasks `f2c23e26`, `d37681e1`, `020f423e`).
- Auto-post worker public hostname (none required; the worker is queue-bound, not HTTP-bound).
- GymTrack (`apps/gymtrack`) production hostname — the MVP tech design (`docs/specs/gymtrack-mvp-tech-design.md` Q2) leaves the production hostname unsettled. This task keeps GymTrack on its current Vercel default and `gymtrack.stoffer.industries` plan; a separate task will adopt `gymtrack.sindustries.co.nz` once the MVP lands.
- Choosing the DNS provider or migrating `sindustries.co.nz` registrar — Quinn-owned.
- Replacing the foundation's `sindustries.dev` reservation with a stale-cleanup PR — surface as a follow-up; do not delete in this PR.
- New feature work in any app beyond hostname/CORS/build-URL alignment.

## Hostname matrix (the contract)

| Surface | Staging hostname | Production hostname | Notes |
|---|---|---|---|
| Mission Control (frontend) | `mission-control.staging.sindustries.co.nz` | `mission-control.sindustries.co.nz` | Vercel custom domain on `apps/mission-control`. |
| Tasks app (frontend) | `tasks.staging.sindustries.co.nz` | `tasks.sindustries.co.nz` | Vercel custom domain on `apps/tasks`. |
| Tasks API | `tasks-api.staging.sindustries.co.nz` | `tasks-api.sindustries.co.nz` | Fly custom domain on `sindustries-tasks-api-<env>`. |
| Budget API | `budget-api.staging.sindustries.co.nz` | `budget-api.sindustries.co.nz` | Fly custom domain on `sindustries-budget-api-<env>`. |
| Content Scheduler API | `content-scheduler-api.staging.sindustries.co.nz` | `content-scheduler-api.sindustries.co.nz` | Fly custom domain on `sindustries-content-scheduler-api-<env>`. |
| Health probe | `health-probe.staging.sindustries.co.nz` | `health-probe.sindustries.co.nz` | Fly custom domain on `sindustries-health-probe-<env>`. |
| Auto-post worker | **(none)** | **(none)** | No HTTP surface; reachable only through the upstream `content-scheduler-api` and its BullMQ consumer. Health is observed via `GET /api/v1/content-scheduler/auto-post/health` on the stable Content Scheduler API URL, not via a separate worker hostname. |

Rules baked into the matrix:

1. The hostname equals `<service>.staging.sindustries.co.nz` or `<service>.sindustries.co.nz` — no port numbers, no path prefixes. Path prefixes belong in the API URL contract (`/api/v1/...`).
2. Frontends reference backends by stable hostname + path prefix only; they never construct URLs from `import.meta.env.DEV` defaults at runtime.
3. The health probe is a public Fly app because it is referenced by hosted observability + Uptime check tooling; that decision was made in `docs/specs/hosted-observability-migration-alerts-tech-design.md` and is reaffirmed here.
4. The auto-post worker row exists to make the explicit non-public nature auditable — Quinn reviewers and downstream operators must see "no public URL" recorded, not a gap.

## Architecture and ownership boundary

### Natural source of truth

This is an **infra/workflow boundary change with a documentation-driven source of truth**. The stable hostnames are a new contractual layer between DNS, Fly, Vercel, and the service CORS / build-URL configuration. There is no new application code, no new database column, and no new API route; the durable artifact is:

- a checked-in matrix (this design + `docs/systems/cloud-platform.md`),
- a smoke-check contract (`tests/cloud/stable-hostname-verification.mjs` + schema),
- per-provider config references (custom domain strings only — no secrets).

No service-local source of truth is appropriate. Trying to encode the hostname inside each service or each frontend would duplicate the matrix and create drift.

### Domain ownership

| Asset | Owner | Lives in |
|---|---|---|
| `sindustries.co.nz` DNS zone | Quinn | DNS provider (TBD with Quinn; see OQ1) |
| `staging.sindustries.co.nz` delegation | Quinn | DNS provider — apex CNAME wildcard or per-hostname records |
| Fly app + Let's Encrypt cert binding per custom domain | Quinn (operator) / Rowan (manifest reference) | `fly certs add <hostname> --app <fly-app>` |
| Vercel custom domain + auto-cert | Quinn (operator) / Rowan (manifest reference) | Vercel project settings |
| Service CORS allowlist per environment | Rowan | `CORS_ALLOWED_ORIGINS` env var in each service's deploy env |
| Frontend build-time API base URLs | Rowan | Vercel project env vars |
| CI smoke check endpoints | Rowan | `.github/workflows/deploy-staging-*.yml` |
| Stable hostname smoke harness | Rowan | `tests/cloud/stable-hostname-verification.mjs` |

Quinn retains control of every credential; Rowan writes only the manifest references, env var names, and DNS record names. The design makes the boundary explicit so the implementation PR cannot accidentally include a token.

### Routing topology (after this task)

```
client ──▶ *.staging.sindustries.co.nz (DNS CNAME → *.fly.dev / *.vercel.app)
              │
              ├─▶ Vercel edge ──▶ apps/{tasks,mission-control} (stable build URLs)
              │
              └─▶ Fly edge (HTTPS, LE cert)
                     ├─▶ sindustries-tasks-api-staging          → services/tasks-api         (/health, /api/v1/...)
                     ├─▶ sindustries-budget-api-staging         → services/budget-api        (/health, /api/v1/...)
                     ├─▶ sindustries-content-scheduler-api-staging → services/content-scheduler-api
                     │                                                          (/health, /api/v1/content-scheduler/...)
                     │                                                          (/api/v1/content-scheduler/auto-post/health)
                     └─▶ sindustries-health-probe-staging       → infra/cloud/observability/health-probe (/healthz)

client ──▶ *.sindustries.co.nz → production counterpart (Vercel + Fly, identical topology)

auto-post worker ── (no public URL) ──▶ BullMQ / Redis ──▶ content-scheduler-api
```

The migration is additive: `*.fly.dev` and `*.vercel.app` URLs continue to serve until Quinn confirms they can be decommissioned. AC4 documents the decommission plan; it does not execute it.

## Implementation plan and file scope

### 1. Operator-side DNS + cert provisioning (Quinn, audit-only for Rowan)

1. Quinn creates one CNAME per staging hostname pointing at the matching Fly app's `*.fly.dev` target:
   - `tasks-api.staging.sindustries.co.nz` → `sindustries-tasks-api-staging.fly.dev`
   - `budget-api.staging.sindustries.co.nz` → `sindustries-budget-api-staging.fly.dev`
   - `content-scheduler-api.staging.sindustries.co.nz` → `sindustries-content-scheduler-api-staging.fly.dev`
   - `health-probe.staging.sindustries.co.nz` → `sindustries-health-probe-staging.fly.dev`
2. Quinn adds each Fly custom domain with `fly certs add <hostname> --app <fly-app>` per Fly app. Fly auto-issues a Let's Encrypt certificate once the CNAME is live.
3. Quinn adds each Vercel custom domain via the Vercel project settings UI or `vercel domains add <hostname> <project>`. Vercel auto-issues the cert.
4. Production CNAMEs follow the same plan but are not created in this PR — the design records them and AC6 lists them as a remaining blocker for Quinn.

Rowan's PR includes a `## DNS / TLS setup` section in the PR body listing each CNAME + cert command exactly as the operator runs it, so Quinn can copy-paste; the PR diff contains zero secret values.

### 2. Repo-side manifest references (no secret values)

- Add a per-hostname comment block at the top of each `infra/cloud/fly/<service>.fly.toml` recording the stable hostname + the corresponding production hostname (commented out — does not apply automatically). Example for `tasks-api.fly.toml`:
  ```toml
  # Stable hostnames (Quinn-owned DNS):
  #   staging:    tasks-api.staging.sindustries.co.nz
  #   production: tasks-api.sindustries.co.nz
  # Add via `fly certs add tasks-api.staging.sindustries.co.nz --app sindustries-tasks-api-staging`
  ```
- No code changes to the Fly toml files are required to serve traffic on a custom domain — Fly honours it once the cert is in place. The comments are the only repo-side artefact for Fly.

### 3. Service CORS allowlist updates

For each HTTP service, append the stable staging origins to `CORS_ALLOWED_ORIGINS` in the staging deploy environment:

- `services/tasks-api` — add the `CORS_ALLOWED_ORIGINS` env var (if absent in this service) parsing the same CsvList shape as `services/content-scheduler-api/src/config/env.ts`; add the staging frontends and a placeholder row that Quinn replaces with the production origins once production DNS lands.
- `services/budget-api` — same as above; ensure the existing `app.ts` mount passes through the env var.
- `services/content-scheduler-api` — append the staging frontends to `services/content-scheduler-api/.env.example` and document the production counterparts in a comment.

Each service's existing local-dev CsvList default stays untouched so local development remains unchanged.

### 4. Frontend build-time API URL updates

For each Vercel project, set the following env vars in the Vercel project settings (per environment: Preview / Production). The values are the stable hostnames; the path prefixes are unchanged.

- `apps/tasks` (Vercel project: `sindustries-tasks`):
  - `VITE_TASKS_API_BASE_URL` → `https://tasks-api.<env>.sindustries.co.nz/api/v1`
- `apps/mission-control` (Vercel project: `sindustries-mission-control`):
  - `VITE_TASKS_API_BASE_URL` → `https://tasks-api.<env>.sindustries.co.nz/api/v1`
  - `VITE_CONTENT_SCHEDULER_API_BASE_URL` → `https://content-scheduler-api.<env>.sindustries.co.nz/api/v1`
  - `VITE_BOOKMARK_STATE_BASE_URL` → (unset in local; staging/prod set to the mission-control origin or empty depending on bookmark-state deployment — see `apps/mission-control/SPEC.md`)
  - `VITE_TASKS_APP_URL` → `https://tasks.<env>.sindustries.co.nz`
  - `VITE_SHELL_ORIGIN` → `https://mission-control.<env>.sindustries.co.nz`
- `apps/gymtrack` — no change in this PR (out of scope).

The PR includes a one-page `## Vercel env var matrix` table in the PR body mapping every project + env var + value so Quinn can paste them. The PR diff contains zero secret values; Vercel env vars are applied via the dashboard / Vercel CLI by Quinn.

### 5. Deploy workflow updates

- `.github/workflows/deploy-staging-tasks-api.yml`, `deploy-staging-budget-api.yml`, `deploy-staging-content-scheduler-api.yml`, `deploy-staging-health-probe.yml`: replace `https://$FLY_APP.fly.dev/health` (or `/healthz`) with the stable staging hostname. Keep the `*.fly.dev` URL as a documented `<!-- fallback -->` line above the active command, and add a comment recording AC4's documented-fallback rule.
- `.github/workflows/cloud-staging-validate.yml`: extend the smoke phase to call the stable hostnames for every check. The provider URL becomes `file` URL evidence in the redacted JSON artifact.

### 6. Documentation updates

- `docs/systems/cloud-platform.md`:
  - Replace the `Domain` decision row with `sindustries.co.nz` (staging subdomain `*.staging.sindustries.co.nz`; production apex `*.sindustries.co.nz`); note that the foundation's `*.sindustries.dev` reservation is superseded by this task and remains documented for audit only.
  - Add a `Stable hostname matrix` subsection that links back to the tech design.
- New: `docs/runbooks/stable-hostname-cutover.md` (Quinn-owned operator doc — Quinn authors this in their own workspace per `agents/definitions/README.md` "Where operational runbooks live"). The repo-side artefact is a short pointer here:
  ```
  > The stable-hostname cutover runbook lives in `~/.openclaw/workspace/docs/infra/runbooks/stable-hostname-cutover.md` (Quinn-owned). This repo references it; do not duplicate.
  ```
- `tests/cloud/staging-validation.schema.json` — extend the result schema with `stableHostnameChecks: { … }` covering the new smoke contract.
- `infra/cloud/README.md` — update the CORS example row from `https://mission-control.sindustries.dev` to `https://mission-control.staging.sindustries.co.nz` and add a sentence pointing at the matrix above.

### 7. Stable-hostname smoke harness

Create `tests/cloud/stable-hostname-verification.mjs` (Node ESM, no new test framework) plus `tests/cloud/fixtures/stable-hostname.json` listing the seven stable staging surfaces (Mission Control, Tasks app, Tasks API, Budget API, Content Scheduler API, health probe, auto-post health endpoint). For each surface the harness performs:

- `GET <stable-hostname>/<health-path>` (where applicable) — expects `200` + JSON body containing the matching health shape.
- A CORS preflight (`Origin: https://<frontend-hostname>`) against each API surface — expects `Access-Control-Allow-Origin` matching the request origin.
- An authenticated staging workflow call (using the synthetic session fixture owned by `2850c5ac`) — expects the workflow to complete without falling back to a `*.fly.dev` URL.
- A `nslookup` / `dig` (via `node:dns/promises` resolver) on each hostname — expects the CNAME chain to terminate at the matching `*.fly.dev` or `*.vercel.app` target.

The harness emits JSON conforming to `tests/cloud/stable-hostname-verification.schema.json` with per-surface `{ host, expected, status: "ok"|"fail", details, evidence }` rows. AC5's "automated or scripted verification" line maps directly onto this harness.

The harness is wired into `.github/workflows/cloud-staging-validate.yml` as an additional phase after the existing smoke checks; it never invokes secrets on the command line.

### 8. Production hostname wiring (documented, not applied)

- The matrix records production hostnames; AC6 explicitly does not require production traffic in this PR.
- Quinn creates production CNAMEs at their own pace; production certs follow the same `fly certs add` / Vercel domain-add pattern.
- A one-line placeholder note in `infra/cloud/env/<service>.env.example` documents which production hostname each `*_ALLOWED_ORIGINS` row should point at once Quinn flips staging→production parity.

### 9. PR description

The PR body (separate from the tech design) lists:

- The seven-surface hostname matrix.
- The DNS / TLS setup steps for Quinn (per-section command lines, no secrets).
- The Vercel env var matrix.
- The smoke harness run + JSON evidence link.
- The remaining production blockers (CNAMEs, certs, env-var promotion) for AC6.

The PR body does **not** include the task AC checklist (per the tech-design skill — ACs in a merged PR body are treated as "covered"). The matrix is the only AC-bearing content in the PR body.

## Data model and API contract

No database schema or API contract change. The only HTTP behaviour change is CORS preflight responses accepting the stable staging origins and (after Quinn signs off) the production origins; the existing CsvList parser in `services/content-scheduler-api/src/config/env.ts` is reused.

## Workflow, cron, and skill changes

- No Lobster workflow change. The task stays in the `code-task-workflow` path with the structured `tech_design` approval already in flight.
- No new cron.
- One new skill reference: the smoke harness script is invoked from `.github/workflows/cloud-staging-validate.yml`; no skill is required.
- One repo-side documentation pointer to a Quinn-owned runbook (see §6).

## `.openclaw` boundary

This task is **fully repo-contained** — no `~/.openclaw/` edits. The DNS / TLS / Vercel / Fly operator steps are Quinn-owned and audited via the PR body's `## DNS / TLS setup` section plus the redacted harness JSON artifact. If implementation discovers an OpenClaw-side blocker (e.g. a smoke harness command requires an env var the agent cannot read), Rowan stops and posts `[openclaw-needed]` with the exact Quinn-owned path, validation command, and rollback. No such blocker is anticipated.

## Test plan and AC verification matrix

| AC | Planned verification | Layer / evidence |
|---|---|---|
| AC1 — Tech design defines the complete staging and production hostname matrix and explicitly records that the auto-post worker has no public URL | This document's "Hostname matrix" section is the artifact; a CI / lint check (`tests/cloud/check-stable-hostname-matrix.test.mjs`) parses the matrix and asserts each row's required fields plus the "no public URL" annotation on the worker row. | Unit test on the matrix document + manual reviewer inspection. |
| AC2 — Staging hostnames resolve only to staging, production hostnames resolve only to production, with HTTPS certificates valid for every public hostname | `tests/cloud/stable-hostname-verification.mjs` runs DNS resolution + `GET https://<hostname>/<health>` for every staging hostname; a separate manual Quinn gate runs the same check for production hostnames before they are pointed at live data. Cert validity is asserted via `tls.connect()` peer certificate check in the harness. | Black-box environment E2E; production counterpart to Quinn's manual gate. |
| AC3 — Vercel domains, Fly custom domains, CORS/origin configuration, frontend build-time API URLs, and service-to-service base URLs are updated consistently for both environments | PR body matrix + a script (`tests/cloud/check-stable-url-coverage.test.mjs`) that diffs `services/**/.env.example`, `apps/**/.env.example`, `infra/cloud/fly/*.fly.toml`, and `.github/workflows/*.yml` to ensure no URL contract still hardcodes a `*.fly.dev` or `*.vercel.app` host as the **only** path. AC4 documents which fallback paths remain. | Script test + PR review. |
| AC4 — CI deploy workflows, health probes, staging validation, rollback/status tooling, and operator documentation use the stable hostnames; provider URLs remain only as documented fallback paths | Grep-based test (`tests/cloud/check-stable-url-fallbacks.test.mjs`) that asserts every remaining `*.fly.dev` / `*.vercel.app` reference in `.github/workflows/*.yml`, `infra/cloud/**/*.sh`, and `docs/**/*.md` is annotated with a `<!-- stable-fallback -->` comment or appears in a documented-migration section. | Static assertion test + PR diff. |
| AC5 — Automated or scripted verification proves frontend roots/assets, API health, auto-post health, and representative authenticated staging workflows work through the stable hostnames | `tests/cloud/stable-hostname-verification.mjs` emits a JSON artifact that includes (a) `GET <stable-hostname>` for every frontend returns `200` with HTML containing the app shell, (b) `GET <api-hostname>/health` returns the documented health JSON for tasks/budget/content-scheduler/health-probe, (c) `GET <content-scheduler-api-hostname>/api/v1/content-scheduler/auto-post/health` returns the documented auto-post health, (d) authenticated staging workflow (synthetic session fixture from `2850c5ac`) round-trips Tasks API + Budget API + Content Scheduler through stable URLs only. | Black-box environment E2E via `cloud-staging-validate.yml`; fixture output uploaded as a redacted artifact. |
| AC6 — Production hostname configuration is verified without deploying staging credentials or pointing any staging URL at production data, and the PR records DNS/TLS setup and any remaining production blockers | PR body `## Production blockers` section lists (a) production CNAMEs pending, (b) production Fly certs pending, (c) production Vercel domains pending, (d) production CORS promotion step, (e) production env-var promotion step. Quinn's structured `qa_agent` approval is gated on the staging DNS/TLS smoke output plus the production-blockers list. | Manual Quinn gate + PR review. |

Additional gates:

- Existing Tasks API, Budget API, Content Scheduler API, Mission Control, Tasks app unit + integration tests pass.
- `infra/cloud/fly/*.fly.toml` `flyctl config validate` passes for every file (run via the existing deploy workflow dry-run path; no live deploy).
- CORS preflight tests for the new origins pass in `services/content-scheduler-api/test/*.test.ts` (add a new test file rather than editing existing fixtures).
- No secret values appear in the PR diff (`scripts/check-no-secrets.sh` or equivalent — flag in PR description if the existing secret-scanner does not cover docs/runbooks).

## Risks and mitigations

1. **Domain mismatch with the foundation.** The foundation's `docs/specs/cloud-deployment-foundation-tech-design.md` reserves `*.sindustries.dev`; this design switches the staging + production convention to `*.sindustries.co.nz`. **Mitigation:** Open Question 1 captures the deviation for Quinn's explicit confirmation. If Quinn rejects, this design is revised, not silently re-aligned.
2. **DNS provider unknown.** If the `sindustries.co.nz` zone is held by a provider whose API tokens we do not yet have, Quinn cannot create CNAMEs in time. **Mitigation:** OQ1 includes a DNS-provider question; if unknown, the PR ships only the repo-side artefacts and Quinn runs the operator steps out-of-band.
3. **Cert issuance latency.** Let's Encrypt can take up to a few minutes after a CNAME lands; deploy workflows that smoke-check via the stable hostname need a longer `for i in {1..20}` retry loop. **Mitigation:** Bump the existing 10-attempt smoke loop to 20 attempts with 5 s sleep; document the change in the PR.
4. **Staging-only origin reset by deploy.** Some deploy platforms rotate machines and re-evaluate the `force_https` / cert binding on each release. **Mitigation:** Verify cert persists after a canary release by re-running the smoke harness once after `deploy-staging-tasks-api.yml` triggers; capture the result in the PR evidence.
5. **Auto-post health endpoint surface.** The auto-post health route is mounted on `content-scheduler-api`, not on the worker; the matrix records this explicitly so a future operator does not attempt to add a worker hostname. **Mitigation:** The matrix's worker row plus the harness's "no worker hostname" assertion both record the rule.
6. **CORS parser divergence.** Tasks API and Budget API do not currently parse `CORS_ALLOWED_ORIGINS`. **Mitigation:** Either reuse `services/content-scheduler-api/src/config/env.ts`'s `CsvList` helper by extracting it to a shared package, or duplicate the parser with a clear `// Mirrors services/content-scheduler-api/src/config/env.ts CsvList` comment and a TODO pointing at the extraction task. Prefer the shared-package path if the extraction is already in flight; otherwise duplicate and file the extraction as a follow-up.
7. **Provider fallback drift.** AC4 permits `*.fly.dev` / `*.vercel.app` to remain in some files, which is correct, but reviewers must not interpret those references as live. **Mitigation:** The `<!-- stable-fallback -->` annotation is a parseable marker; the `check-stable-url-fallbacks.test.mjs` script asserts every such reference is annotated.
8. **Staging data isolation.** Wiring production hostnames into CORS could allow a misconfigured browser to send staging credentials to production. **Mitigation:** The CORS allowlist is per-environment; staging CORS explicitly excludes production origins, and vice versa. The harness asserts no hostname appears in both staging and production CsvLists.

## Open questions

1. **OQ1 — Canonical staging + production domain.** Confirm that `sindustries.co.nz` (with `*.staging.sindustries.co.nz` delegation) supersedes the foundation's `*.sindustries.dev` reservation for staging and production. If Quinn wants to keep `.dev` for staging and use `.co.nz` for production, the matrix splits per-environment. **Needs Quinn.**
2. **OQ2 — DNS provider for `sindustries.co.nz`.** Name the provider so the PR's `## DNS / TLS setup` section lists the exact CNAME-creation command Quinn will run (Cloudflare / Route 53 / Gandi / other). **Needs Quinn.**
3. **OQ3 — Production rollout window.** AC6 defers production CNAMEs + certs to Quinn. Is there a target window, or does production DNS land as part of the production-cutover task (`020f423e`)? If the latter, this PR's AC6 evidence is limited to staging; the production-blockers list is the durable artifact. **Needs Quinn.**
4. **OQ4 — CORS extraction vs duplication.** Tasks API and Budget API need a `CsvList` parser. Is the shared-package extraction already scoped, or should this task duplicate with a follow-up? See Item 6 of "Risks and mitigations". **Needs Quinn.** (Default: duplicate + follow-up; revise if Quinn says otherwise.)
5. **OQ5 — GymTrack production hostname.** Out of scope per AC1; confirm we are not pulling `gymtrack.sindustries.co.nz` into this task. **Needs Quinn.** (Default: confirm scope, defer to a separate task.)

## Acceptance criteria

Per the tech-design skill: this section is intentionally empty in the tech-design doc. The full AC list lives in the task description; the PR body mirrors it once the implementation PR opens. Listing ACs here would create a false "covered by merge" stamp at merge time.