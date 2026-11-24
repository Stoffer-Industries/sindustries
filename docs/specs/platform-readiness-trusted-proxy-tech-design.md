---
status: draft
task_id: 14103839-2a42-4dfb-98c3-361cb1b76b8c
product_spec: brain/research/w46-platform-readiness-and-trusted-proxy.md
shipped_pr: null
shipped_date: null
---

# Platform readiness and trusted-proxy boundary tech design

## Product intent

This design implements the two decisions approved after the W46 platform-readiness and trusted-proxy research:

1. The consolidated Fly platform is ready only when its HTTP children respond to real health probes and the listener-less queue worker emits a fresh heartbeat. A bounded startup grace period and consecutive-failure threshold prevent slow boots and one-off probe failures from causing false restart loops. The existing shared-fate staging trade-off remains deliberate: one persistently unhealthy child makes the platform unhealthy and may restart the Machine.
2. The three proxied Express services use one narrow, named trust boundary for the in-container router. The router replaces client-controlled forwarding data with the Fly edge's `Fly-Client-IP` value, and all three rate limiters use the IPv6-safe `ipKeyGenerator` helper. Cloudflare is not part of the API ingress path and is not trusted.

No clarification is needed before implementation. Tom has approved the readiness/shared-fate behavior and the Fly-edge-only proxy topology in the task description. The remaining numeric defaults are implementation parameters with conservative, bounded defaults and environment overrides described below.

## Delivery context

- **Task:** `14103839-2a42-4dfb-98c3-361cb1b76b8c` — Implement reviewed platform readiness probes and trusted-proxy boundary
- **Product/research source:** `brain/research/w46-platform-readiness-and-trusted-proxy.md`
- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-14103839-platform-readiness-trusted-proxy`
- **Worktree:** `/Volumes/WD1/worktrees/quinn/task-14103839-platform-readiness-trusted-proxy`
- **Expected implementation PR:** one draft code-task PR on this branch after tech-design approval

## Ownership and source-of-truth boundaries

### Readiness

The readiness contract belongs to the existing platform runtime boundary:

- `infra/cloud/platform/platform-services.mjs` owns child declarations and each HTTP child's health target.
- `infra/cloud/platform/platform-supervisor.mjs` owns probe scheduling, startup grace, failure counters, freshness evaluation, and the aggregate `/status` readiness verdict.
- `services/content-scheduler-api/src/workers/autoPostWorkerMain.ts` owns the worker's ability to prove that its event loop is alive by emitting a dedicated heartbeat signal.
- `docs/systems/cloud-platform.md` owns the shipped operator-facing semantics and defaults.

Process state remains lifecycle data and is not reused as health evidence. The worker heartbeat is a dedicated signal rather than ordinary stdout activity, so application logs cannot accidentally keep a hung worker healthy.

### Trusted client identity

This is a shared package/cross-service contract, not service-local state. A new private workspace package, `@sindustries/http-security`, will own:

- the named Express `trust proxy` setting for the platform router (`loopback`);
- the shared client-IP rate-limit key helper that delegates to `express-rate-limit`'s `ipKeyGenerator`;
- small contract tests proving the helper is IPv6-safe and the trust setting is narrow rather than `true` or a topology-sensitive hop count.

Each service keeps ownership of its rate-limit policy (window, maximum, response body, and logging) but imports the shared identity helper. This is the durable boundary: three service-local copies would be similarly easy to create but would introduce three security-sensitive sources of truth.

The router remains the only ingress hop visible to the services. `infra/cloud/platform/nginx.conf.template` will overwrite, rather than append, forwarded identity using the Fly-provided `Fly-Client-IP`. The service therefore trusts the named loopback router peer, not an arbitrary count of forwarded hops. Cloudflare ranges are intentionally absent.

### Data ownership

No database schema, persistent domain data, or public API resource changes are required. Readiness observations and failure counters are in-memory runtime state and reset when the supervisor or child restarts. The worker heartbeat is ephemeral operational state.

## Proposed implementation

### 1. Declare health contracts and bounded defaults

Extend `infra/cloud/platform/platform-services.mjs` so each HTTP child declares its loopback health target (currently `/health` on its own port) and the queue worker declares a heartbeat role instead of an HTTP target.

The supervisor will read bounded positive-integer settings from environment variables, with defaults documented in `--help` and `docs/systems/cloud-platform.md`:

- `PLATFORM_HEALTH_PROBE_INTERVAL_MS` — default `2000` ms;
- `PLATFORM_HEALTH_PROBE_TIMEOUT_MS` — default `750` ms, comfortably below Fly's 2-second health-check timeout;
- `PLATFORM_HEALTH_FAILURE_THRESHOLD` — default `3` consecutive failures;
- `PLATFORM_STARTUP_GRACE_MS` — default `30000` ms;
- `PLATFORM_WORKER_HEARTBEAT_INTERVAL_MS` — default `5000` ms;
- `PLATFORM_WORKER_HEARTBEAT_MAX_AGE_MS` — default `15000` ms.

Invalid, zero, negative, or internally inconsistent values will fail startup validation rather than silently weakening readiness. Probe work will run concurrently and outside the `/status` request path so the status endpoint remains cheap and bounded.

### 2. Track HTTP probe state separately from process lifecycle

Add a health observation to each `Child` without changing its existing `state`, restart, drain, or crash behavior. The observation records:

- last probe time and last success time;
- last result/error category;
- consecutive successes and failures;
- current readiness reason (`startup-grace`, `healthy`, `failure-threshold`, `not-running`, or `heartbeat-stale`).

On start/restart, the health observation resets and the child's bounded startup grace begins. During grace, a running child does not make the aggregate platform unready merely because its listener has not bound yet. A successful probe ends uncertainty and marks the child healthy. After grace, a child without a successful probe is unready. Once healthy, transient failures below the configured threshold preserve readiness; reaching the threshold makes the child unready until a subsequent successful probe resets the failure count.

HTTP probes use Node's built-in HTTP client or `fetch` against `127.0.0.1:<port>/health`, accept only a 2xx response, enforce the per-probe timeout, and consume/close the response. A bound-but-hung listener therefore times out and eventually crosses the failure threshold.

`supervisor.status()` will expose the observation alongside existing lifecycle diagnostics. Aggregate `ready` requires the router to be running and every child readiness observation to be ready. `/status` and routed `/__status` retain the existing `200`/`503` contract.

### 3. Add a dedicated queue-worker heartbeat

Add a small heartbeat emitter to `autoPostWorkerMain.ts` after worker bootstrap succeeds. It writes a reserved, versioned marker on its own timer, for example `SINDUSTRIES_PLATFORM_HEARTBEAT auto-post-worker v1 <timestamp>`. The interval comes from `PLATFORM_WORKER_HEARTBEAT_INTERVAL_MS`, supplied to the worker by the supervisor.

The supervisor recognizes that exact marker only for a child declared with the worker-heartbeat role, records the timestamp as dedicated health evidence, and may suppress the marker from ordinary application log output. Other stdout/stderr lines continue to update diagnostic `lastOutputAt` but never update worker health.

The worker is ready while running during startup grace, then only while its dedicated heartbeat age is within `PLATFORM_WORKER_HEARTBEAT_MAX_AGE_MS`. A live process with a blocked event loop stops emitting markers and becomes unready. This keeps the signal process-local and ephemeral; it does not add a database/Redis write or make readiness dependent on an external persistence round trip.

### 4. Sanitize identity at the router

Update all six service proxy locations in `infra/cloud/platform/nginx.conf.template` through a shared nginx snippet or an equivalent rendered common block so hostname and provider-prefix routes cannot drift.

For service-bound requests the router will:

- replace `X-Forwarded-For` with the Fly edge's `Fly-Client-IP` value instead of using `$proxy_add_x_forwarded_for`;
- set `X-Real-IP` to the same controlled value;
- fall back to the immediate peer address when `Fly-Client-IP` is absent, never to a client-provided forwarding header;
- continue forwarding scheme and host as today.

This means a caller's `X-Forwarded-For` value is discarded before Express sees it. The provider-host path-prefix routes and stable-hostname routes produce the same client identity.

### 5. Apply one shared Express trust/rate-limit contract

Create `packages/http-security/` as a private TypeScript workspace package. Its narrow API will expose:

- `configurePlatformTrustedProxy(app)`, which sets Express `trust proxy` to the named `loopback` subnet;
- `platformClientIpRateLimitKey(req)`, which passes the resolved `req.ip` to `ipKeyGenerator` and safely falls back to the socket address if needed.

Add the package as a workspace dependency of tasks-api, budget-api, and content-scheduler-api. Each `createApp` will call the configuration helper before any middleware reads `req.ip`. Each existing service-local rate-limit middleware will set `keyGenerator: platformClientIpRateLimitKey`; policy and response formatting stay local.

The package will not trust `true`, a numeric hop count, Cloudflare ranges, or general private-network ranges. The only service-side trusted peer is the co-located loopback router. The Fly edge's asserted client address is accepted only after nginx has replaced the client-controlled header.

### 6. Documentation and staging release evidence

Update `docs/systems/cloud-platform.md` with:

- aggregate readiness semantics;
- startup grace, probe threshold, and worker freshness defaults/overrides;
- the shared-fate restart trade-off;
- the Fly edge → nginx → loopback service trust chain;
- operator diagnostics and rollback notes.

No app `SPEC.md` changes are needed because this is infrastructure/security behavior, not a user-facing app flow.

After CI passes, deploy this branch to staging using the existing staging platform workflow. Before any production change:

1. observe at least one complete normal startup and a period longer than the startup grace plus failure window;
2. confirm `/__status` remains `200`, every HTTP child reports successful probes, and the worker heartbeat stays fresh;
3. inspect Fly logs for restart-loop or repeated probe-failure evidence;
4. exercise each stable API hostname through Fly and confirm legitimate health/API traffic still succeeds;
5. run the trusted-proxy/rate-limit staging verification with two controlled client identities where the environment permits, recording request/result evidence without exposing secrets or personal IPs.

Attach sanitized command output/log excerpts to the implementation PR. Production deployment is out of scope until AC6 evidence is reviewed.

## API and configuration contract changes

No public product API changes are planned.

The platform status JSON gains per-child health fields. Existing fields and `ready` remain backward-compatible; only the meaning of `ready` becomes stricter after startup grace.

New environment variables are operational overrides, not secrets:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PLATFORM_HEALTH_PROBE_INTERVAL_MS` | `2000` | HTTP child probe cadence |
| `PLATFORM_HEALTH_PROBE_TIMEOUT_MS` | `750` | Per-probe deadline |
| `PLATFORM_HEALTH_FAILURE_THRESHOLD` | `3` | Consecutive failures before unready |
| `PLATFORM_STARTUP_GRACE_MS` | `30000` | Maximum slow-start grace |
| `PLATFORM_WORKER_HEARTBEAT_INTERVAL_MS` | `5000` | Worker marker cadence |
| `PLATFORM_WORKER_HEARTBEAT_MAX_AGE_MS` | `15000` | Maximum healthy heartbeat age |

No `.openclaw` config, cron, skill, workflow definition, credential, or scheduler change is required. Repository-owned GitHub workflow changes should be unnecessary unless staging evidence shows the existing deploy workflow cannot target a task branch safely; that would be raised as a separate review point rather than improvised.

## Test plan

### Automated layers

- Extend `infra/cloud/platform/tests/platform-supervisor.test.mjs` with injected clock/probe/timer dependencies for deterministic startup grace, threshold, recovery, hung-listener, worker-heartbeat, restart-reset, and drain tests.
- Add router rendering/config assertions proving all six routes overwrite forwarding identity and never use `$proxy_add_x_forwarded_for`.
- Add `packages/http-security` unit tests for the named trust setting and `ipKeyGenerator` delegation, including IPv4 and IPv6 inputs.
- Add service-level Supertest regressions for spoofed `X-Forwarded-For` and independent proxied clients. Tests will bind requests to controlled socket/header facts matching the router contract rather than relying on public internet addresses.
- Run each affected workspace's typecheck/test suite plus `npm run test:platform-supervisor` and the cloud platform static/config suites.

### Acceptance-criterion verification matrix

| AC | Planned verification | Layer |
| --- | --- | --- |
| AC1 | Supervisor tests start a bound-but-nonresponsive HTTP child, advance through the failure threshold, and assert child/aggregate readiness becomes false; worker tests prove ordinary output does not refresh health while a dedicated fresh marker does. | integration/unit |
| AC2 | Fake-clock tests assert a running slow-start HTTP child and worker report ready only during the bounded 30-second grace, transition to probe/heartbeat health when signals arrive, and become unready when grace expires without evidence. Defaults and overrides are asserted in docs/help tests. | unit/file |
| AC3 | Shared-package tests assert `loopback` is the only Express trust setting; service construction tests assert all three apps use it; nginx template tests assert identity is replaced from Fly's edge header on all six routes and Cloudflare/trust-all/hop-count settings are absent. | unit/file/integration |
| AC4 | Shared helper tests spy on or exercise `ipKeyGenerator`; service middleware tests assert all three rate limiters use the shared helper and IPv6 addresses are subnet-normalized. | unit/integration |
| AC5(a) | Hung-but-alive child fixture crosses the threshold and `/status` returns 503. | integration |
| AC5(b) | Delayed healthy child remains ready during grace, then records probe success and remains ready after grace. | integration |
| AC5(c) | Requests with forged `X-Forwarded-For` outside the trusted loopback hop resolve to the socket/router-controlled identity and share the expected bucket. | integration |
| AC5(d) | Two controlled Fly-client identities passed through the sanitized router contract receive independent rate-limit buckets in each service. | integration |
| AC6 | Staging deploy evidence shows no restart loop over a period exceeding grace plus threshold, fresh child/worker observations in `/__status`, successful legitimate proxied requests, and controlled distinct/spoofed identity checks. Evidence is attached to the PR before production consideration. | staging/manual |

No browser E2E test is appropriate: the acceptance criteria concern process health, proxy topology, and API middleware rather than a user-visible browser flow. The fallback layers above exercise the actual supervisor, router contract, Express middleware, and live staging ingress.

## Rollout and rollback

1. Land tests and implementation together on the task branch.
2. Deploy to staging only and collect AC6 evidence before any production change.
3. If staging enters a restart loop, roll back to the previous image using the existing cloud-platform rollback procedure. Environment overrides may temporarily increase the bounded grace/threshold only for diagnosis; they are not a substitute for fixing a bad probe.
4. If legitimate client identity is wrong, roll back the image. Do not weaken Express to `true` or a numeric hop count as an emergency workaround.

The change has no data migration and rollback does not discard state.

## Risks and open questions

- **Probe endpoint semantics:** the existing `/health` endpoints may prove only HTTP responsiveness, not every downstream dependency. That is sufficient for this task's hung-listener contract; expanding them to deep database/Redis readiness would be a separate availability decision.
- **Grace masks early failure:** a running process is provisionally ready during grace. The grace is deliberately bounded, exposed in status reasons, and covered by tests. Crashed/restarting children are never treated as ready merely because the clock is inside grace.
- **Shared-fate restart sensitivity:** three consecutive timeouts can restart all colocated services. AC6 explicitly verifies normal staging operation before production consideration.
- **Worker heartbeat scope:** the marker proves the worker event loop is alive, not that every downstream provider is healthy. Existing worker error/retry behavior remains responsible for job-level failures.
- **Header provenance:** nginx relies on Fly overwriting `Fly-Client-IP` at the public edge. The router never trusts client-provided `X-Forwarded-For`; direct non-Fly reachability falls back to the peer address. Staging verification must confirm the real edge supplies the header as expected.
- **Numeric defaults:** the proposed values are conservative starting points, not product policy. If current staging boot data shows 30 seconds is insufficient, adjust the documented default in the reviewed implementation rather than adding an unbounded grace period.

There are no unresolved product or architecture decisions blocking implementation after Quinn's design review.
