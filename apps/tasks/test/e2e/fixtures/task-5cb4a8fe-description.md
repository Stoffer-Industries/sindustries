**Context:** Replace provider-shaped staging URLs such as `sindustries-tasks-api-staging.fly.dev` with stable app-name hostnames, for example `tasks-api.staging.sindustries.co.nz`, and establish the matching production hostname convention without cross-environment ambiguity. Cover the deployed frontends, HTTP APIs, and operational health endpoint; keep the auto-post worker non-public because it has no HTTP surface. DNS/TLS ownership and any required provider configuration must be documented without committing credentials. A tech design is required before implementation because this changes deployment, DNS, TLS, and environment URL contracts.

---

**Acceptance Criteria**

- [x] AC1: A reviewed tech design defines the complete staging and production hostname matrix, including Mission Control, Tasks app, Tasks API, Budget API, Content Scheduler API, and health probe, and explicitly records that the auto-post worker has no public URL.
- [x] AC2: Staging hostnames resolve only to staging deployments and production hostnames resolve only to production deployments, with HTTPS certificates valid for every public hostname.
- [x] AC3: Vercel domains, Fly custom domains, CORS/origin configuration, frontend build-time API URLs, and service-to-service base URLs are updated consistently for both environments.
- [x] AC4: CI deploy workflows, health probes, staging validation, rollback/status tooling, and operator documentation use the stable hostnames; provider-specific `*.fly.dev` and `*.vercel.app` URLs remain only as documented migration or provider fallback paths where necessary.
- [x] AC5: Automated or scripted verification proves frontend roots/assets, API health endpoints, the Content Scheduler auto-post health endpoint, and representative authenticated staging workflows work through the stable hostnames.
- [x] AC6: Production hostname configuration is verified without deploying staging credentials or pointing any staging URL at production data, and the PR records DNS/TLS setup and any remaining production blockers.

---

**Workstreams**
- Owner: Rowan
  ACs: AC1, AC2, AC3, AC4, AC5, AC6
  Branch: task-5cb4a8fe-6069-4b3c-b2ef-0b8dc61cdb3c-stable-app-name-hostnames
  PR: https://github.com/Stoffer-Industries/sindustries/pull/774 (MERGED — slice 1 of 5: matrix + static checks; slices 2-5 merged via #775, #776: CORS, deploy workflow smoke loops, smoke harness, Vercel env var matrix, production-blockers list)
- Owner: Rowan
  ACs: AC1, AC2, AC5
  Branch: task-5cb4a8fe-staging-cname-contract
  PR: https://github.com/Stoffer-Industries/sindustries/pull/968 (MERGED 2026-11-11T01:43Z — slice 6: per-environment `cnameTargets` in infra/cloud/hostname-matrix.json, the AC2 cross-environment alias guard (static check + runtime), and the harness no longer short-circuiting on a DNS failure)
- Owner: Rowan
  ACs: AC2, AC5
  Branch: task-5cb4a8fe-harness-transport-classification
  PR: https://github.com/Stoffer-Industries/sindustries/pull/969 (MERGED 2026-11-11T14:04Z, merge commit 28330bda — slice 7: every HTTPS/CORS probe carries a `failureMode`, and a failed response reads a bounded, credential-redacted body excerpt so a proxy error page is separable from the deployment's own error page)

- Owner: Rowan
  ACs: AC2 (verification path only), AC5 (verification path only) — no parent AC is claimed as delivered by this slice
  Branch: task-5cb4a8fe-live-hostname-verify
  PR: https://github.com/Stoffer-Industries/sindustries/pull/973 (READY for review, opened 2026-11-12 — slice 8: dispatch-only public-internet runner for the AC5 live hostname harness, plus the contract test that keeps it dispatch-only, credential-free and proxy-free)

- Owner: Rowan
  ACs: AC6 (evidence register + its CI guard only) — no parent AC is claimed as delivered by this slice
  Branch: task-5cb4a8fe-ac6-production-blockers-register
  PR: https://github.com/Stoffer-Industries/sindustries/pull/974 (READY for review, opened 2026-11-12 — slice 9: the AC6 evidence register corrected against the live control planes, plus the static check that keeps it in lockstep with the matrix)

**Outstanding (not code-gated in Rowan's lane — see the latest [rowan-progress] comment for evidence)**
- AC2 staging TLS clause for the two Vercel frontends: **now evidenced** — the public-internet runner returned `verdict: pass` for every public staging surface, both frontends included (run `43595192346`, 2026-11-14T12:30Z), so the staging hostnames resolve to the staging deployments with valid certificates. The earlier "no staging deployment serves them" reading was an artefact of the operator host's egress proxy. The **production** half of AC2 is **now evidenced** — every per-surface production hostname resolves to the matrix's production CNAME target and presents a certificate whose CN is the hostname itself (read back 2026-11-18; recorded in `docs/cloud/production-blockers.md` §9 and in the committed operator read-back `docs/cloud/production-provisioning-readback.md` §4).
- AC3 Vercel domain-binding half: **now evidenced** — both production Vercel projects exist and carry bound, verified production custom domains (2026-11-18, task `5044e708`); recorded in `docs/cloud/production-blockers.md` §3 and §9.
- AC5 frontend roots/assets: **now evidenced** by the same public-runner verdict (`verdict: pass`; both frontend roots answer HTTP 200 through their stable staging hostnames). The representative authenticated staging workflow is **now evidenced** — PR #993 (merged 2026-11-14) records the proxy-free authenticated staging-validation run `43606147320` with `verdict: pass` and 15/15 recorded checks passing.
- AC6 production DNS/TLS/env-var promotion: Quinn's manual gate per the tech design §8 (register rows in docs/cloud/production-blockers.md). The register is corrected against the live control planes and guarded by a static check (slice 9, PR #974), and slice 11 (PR #1020) closes the §1 DNS rows and the §2 API TLS row that still read `Pending` against the live production hostnames. What remains on the production side is the smoke-and-cutover activity tracked as task `020f423e` and the cross-environment safety net in §8, which the static checks enforce.
- The non-proxy verification path now exists (slice 8, PR #973) and **has been exercised** (2026-11-15): `.github/workflows/stable-hostname-live-verify.yml` ran on `main` at `e2c58158` as run `43595192346` (artifact `stable-hostname-verification-43595192346-1`) and returned `verdict: pass` for all six public staging surfaces. The earlier expectation that this run would fail on the two frontend rows is retired — those rows pass. The run does not cover the representative authenticated staging workflow (reported as `skip`) or the production half.
- Owner: Rowan
  ACs: AC5 (live-verification evidence only), AC2 (staging half, verification only) — no parent AC is claimed as delivered by this slice
  Branch: task-5cb4a8fe-ac5-public-runner-verdict
  PR: https://github.com/Stoffer-Industries/sindustries/pull/992 (READY for review, opened 2026-11-15 — slice 10: the platform system doc now records the public-internet runner's measured `verdict: pass` instead of the stale "the two Vercel frontends are expected to fail" expectation, and the `cloud-staging-validate.yml` row no longer claims the stable hostnames fail to resolve)
- Owner: Rowan
  ACs: AC2 (production half, evidence only), AC6 (register rows only) — no parent AC is claimed as delivered by this slice
  Branch: task-5cb4a8fe-ac6-production-api-readback
  PR: https://github.com/Stoffer-Industries/sindustries/pull/1020 (READY for review, opened 2026-11-18 — slice 11: the §1 DNS rows and the §2 API TLS row closed against a 2026-11-18 live read-back plus the §9 evidence, and the stale "the production hostnames still have no DNS records" claim in `docs/systems/cloud-platform.md` corrected)
- Next structured gate: Ash's `qa_agent` mechanical re-verification on the current tree (the 2026-10-23 revocation predates #968/#969 and the slices since). Tom's `accepted` approval follows.