# Runbook — Production runtime configuration

**Owner:** Rowan (engineering)
**Applies to:** every cloud-deployed SIndustries service (`tasks-api`, `budget-api`, `gymtrack-mcp`). `apps/gymtrack` web app is out of scope for secret management (its `VITE_*` values are public-by-design) but is documented in the AC4 verification matrix below for completeness.
**Related:** tech design `docs/specs/cloud-readiness-production-runtime-configuration-tech-design.md`, task `206927ed-d851-47af-8864-0056487e0c4e`, parent migration `brain/tasks/specs/open/sindustries-cloud-migration.md` (workstream 2 of 7).

## Why this exists

Every cloud-deployed service boots against a per-service `src/config.ts` module that parses and validates the environment at module load. If any required value is missing or malformed the process refuses to start with a structured `config_validation_failed` log line — names of offending keys, never values — and exits non-zero so the orchestrator (systemd, fly, k8s) marks the deployment unhealthy. No secret value is ever logged, written to `process.env` of a downstream process, or echoed in any HTTP response.

This runbook is the operator-facing view of that contract: every required key, owner, rotation expectation, source of truth, and failure mode. Use it during deploys, secret rotation, and incident response.

## The contract per service

Each service owns a single `src/config.ts` (or `src/config/env.ts` re-exported through `src/config/index.ts`). Service code reads configuration exclusively through that module — never via `process.env` for snapshot values (PORT, NODE_ENV, DATABASE_URL, CORS_ALLOWED_ORIGINS, rate-limit constants, JSON body limit, adapter kind). Credential/toggle values that may legitimately change at runtime (the X client toggle, approval user list, service credentials, the `X_ACTOR_SECRET` gate value) continue to read from `process.env` at call time; the boot-time schema validates their shape and cross-field constraints at module load.

### `tasks-api` — required keys

| Key | Type | Required when | Owner | Rotation | Source of truth | Failure mode |
|---|---|---|---|---|---|---|
| `NODE_ENV` | `production` \| `development` \| `test` | always | platform (Quinn) | per-deploy | secret manager | exits non-zero on invalid value |
| `PORT` | int 1–65535 | always | platform (Quinn) | per-deploy | secret manager | exits non-zero |
| `DATABASE_URL` | postgresql URL with `?schema=tasks_api` | always | Rowan | `90d` or on-incident | secret manager | exits non-zero if missing or wrong schema |
| `CORS_ALLOWED_ORIGINS` | comma-separated origin list | always | Rowan | per-deploy | secret manager | empty → dev defaults |
| `TASKS_API_JSON_LIMIT` | express body size string (e.g. `100kb`) | always | Rowan | `manual` | secret manager | default `100kb` |
| `TASKS_API_RATE_LIMIT_WINDOW_MS` | positive int | always | Rowan | `manual` | secret manager | default `900000` |
| `TASKS_API_RATE_LIMIT_MAX` | positive int | always | Rowan | `manual` | secret manager | default `100` |
| `TASKS_API_APPROVAL_SESSION_TTL_SECONDS` | positive int | always | Rowan | `manual` | secret manager | default `28800` |
| `TASKS_API_APPROVAL_USERS` | JSON array of `{username, actor, passwordHash}` | always (string-shaped) | Tom | on-incident | secret manager | empty → no approval users (intentional) |
| `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` | JSON array of `{token, actor, approvalTypes}` | when service-to-service auth enabled | Rowan | `90d` or on-incident | secret manager | empty → no service callers (intentional) |
| `X_CLIENT` | `real` \| `fake` | always | Rowan | per-deploy | secret manager | default `fake` |
| `X_API_KEY` | X OAuth consumer key | `X_CLIENT=real` | Tom | `90d` or on-incident | secret manager | exits non-zero if `X_CLIENT=real` and missing |
| `X_API_SECRET` | X OAuth consumer secret | `X_CLIENT=real` | Tom | `90d` or on-incident | secret manager | exits non-zero |
| `X_ACCESS_TOKEN` | X OAuth access token | `X_CLIENT=real` | Tom | `90d` or on-incident | secret manager | exits non-zero |
| `X_ACCESS_TOKEN_SECRET` | X OAuth access token secret | `X_CLIENT=real` | Tom | `90d` or on-incident | secret manager | exits non-zero |
| `X_ACTOR_SECRET` | hex string ≥32 chars | `X_CLIENT=real` in cloud deploys | Rowan | `90d` or on-incident | secret manager | route returns 401 if header missing/mismatched; <32 chars → exits non-zero |
| `X_HANDLE` | string | `X_CLIENT=real` | Tom | per-deploy | secret manager | default `sindustries` |
| `CONTENT_SCHEDULER_JOB_ADAPTER` | `in-process` \| `bullmq` | always | Rowan | per-deploy | secret manager | default `in-process`; production must be `bullmq` |
| `CONTENT_SCHEDULER_REDIS_URL` \| `REDIS_URL` | redis URL | `CONTENT_SCHEDULER_JOB_ADAPTER=bullmq` | Rowan | per-deploy | secret manager | exits non-zero if adapter is `bullmq` and both unset |

OTel pass-throughs (`OTEL_SERVICE_NAME`, `OTEL_SERVICE_NAMESPACE`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_ENVIRONMENT`, `OTEL_SDK_DISABLED`) are pass-through env consumed by the `otel-node` package itself; not validated by tasks-api schema. Owner: platform (Quinn).

### `budget-api` — required keys

| Key | Type | Required when | Owner | Rotation | Source of truth | Failure mode |
|---|---|---|---|---|---|---|
| `NODE_ENV` | enum | always | platform (Quinn) | per-deploy | secret manager | exits non-zero |
| `PORT` | int | always | platform (Quinn) | per-deploy | secret manager | exits non-zero |
| `DATABASE_URL` | postgresql URL with `?schema=budget_api` | always | Rowan | `90d` or on-incident | secret manager | exits non-zero |
| `CORS_ALLOWED_ORIGINS` | comma-separated origin list | always | Rowan | per-deploy | secret manager | empty → dev defaults |
| `BUDGET_API_JSON_LIMIT` | express body size string | always | Rowan | `manual` | secret manager | default `100kb` |
| `BUDGET_API_RATE_LIMIT_WINDOW_MS` | positive int | always | Rowan | `manual` | secret manager | default `900000` |
| `BUDGET_API_RATE_LIMIT_MAX` | positive int | always | Rowan | `manual` | secret manager | default `100` |
| `DEV_SESSION_SECRET` | string NOT starting with `dev-` | production | Rowan | `90d` | secret manager | **placeholder `dev-secret-change-me` is rejected in production mode** |
| `AKAHU_CLIENT_ID` | string | always | Rowan | `manual` | secret manager | OAuth routes 5xx |
| `AKAHU_CLIENT_SECRET` | string | always | Rowan | `90d` or on-incident | secret manager | OAuth routes 5xx |
| `AKAHU_REDIRECT_URI` | URL | always | Rowan | per-deploy | secret manager | OAuth routes 5xx |
| `AKAHU_DEV_USER_ACCESS_TOKEN` | Akahu UAT | dev only | Rowan | per-developer | local `.env` only | not set in production |
| `BUDGET_API_TOKEN_KEY` | 64-hex-char AES-256-GCM key | always | Rowan | `90d` or on-incident | secret manager | Akahu token reads/writes fail |
| `EMAIL_FROM` | RFC 5322 sender | email enabled | Rowan | per-deploy | secret manager | empty → email disabled |
| `EMAIL_PROVIDER_API_KEY` | provider key | email enabled | Rowan | `90d` or on-incident | secret manager | email send fails |
| `APNS_KEY_ID` | Apple key id | push enabled | Rowan | per-deploy | secret manager | push disabled |
| `APNS_TEAM_ID` | Apple team id | push enabled | Rowan | per-deploy | secret manager | push disabled |
| `APNS_BUNDLE_ID` | Apple bundle id | push enabled | Rowan | per-deploy | secret manager | push disabled |
| `APNS_PRIVATE_KEY_P8` | Apple push key (P8 PEM) | push enabled | Rowan | `90d` or on-incident | secret manager | push disabled |
| `LLM_PROVIDER` | `openai` \| ... | LLM enabled | Rowan | per-deploy | secret manager | default `openai` |
| `LLM_API_KEY` | provider key | LLM enabled | Rowan | `90d` or on-incident | secret manager | categorization 5xx |

**Critical:** `BUDGET_API_TOKEN_KEY` is the AES-256-GCM key used to encrypt Akahu access tokens at rest in Postgres. Loss of this key means every stored Akahu token is unrecoverable and the operator (Rowan) must re-link every user. Rotate on a schedule AND on any incident where the key may have been exposed.

### `gymtrack-mcp` — required keys

`gymtrack-mcp` is a JavaScript service with a lightweight `src/config.js` loader (no zod schema yet — the contract is documented here and the JSON-string checks are deferred to a follow-up PR). Required keys:

| Key | Type | Required when | Owner | Rotation | Source of truth | Failure mode |
|---|---|---|---|---|---|---|
| `GYMTRACK_MCP_PORT` | int | always | platform (Quinn) | per-deploy | Fly alloc | default `8787` |
| `GYMTRACK_MCP_ISSUER` | URL | always | Rowan | per-deploy | Fly env | default `http://localhost:<port>` |
| `GYMTRACK_APP_URL` | URL | always | Rowan | per-deploy | Fly env | default `http://localhost:5173` |
| `GYMTRACK_WEB_ORIGIN` | URL | always | Rowan | per-deploy | Fly env | derived from `GYMTRACK_APP_URL` |
| `GYMTRACK_MCP_ACCESS_TOKEN_TTL_SECONDS` | positive int | always | Rowan | `manual` | Fly env | default `3600` |
| `GYMTRACK_MCP_REFRESH_TOKEN_TTL_SECONDS` | positive int | always | Rowan | `manual` | Fly env | default `7776000` (90d) |
| `GYMTRACK_MCP_AUTH_CODE_TTL_SECONDS` | positive int | always | Rowan | `manual` | Fly env | default `600` |
| `SUPABASE_URL` | URL | always | Rowan | per-deploy | Fly secrets | Supabase calls fail |
| `SUPABASE_SERVICE_ROLE_KEY` | string ≥32 chars | always | Rowan | `90d` or on-incident | Fly secrets | Supabase calls fail |
| `ANTHROPIC_API_KEY` (or current LLM provider) | provider key | LLM tools enabled | Rowan | `90d` or on-incident | Fly secrets | LLM tools 5xx |

**Open question (tech design §Open questions):** confirm whether `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, and any other LLM-related secrets are already stored in `fly secrets` or are still inline in `services/gymtrack-mcp/fly.toml`. If inline, this PR does not move them; a follow-up PR extracts them. The owner/rotation columns above are the contract regardless.

## How secrets reach the process

The sibling `cloud-deployment-foundation` task (task `b2f62c36-6367-435b-a329-9c55ad62c551`) picks the secret manager and wires the delivery. This task defines the **shape**:

1. Secrets reach the process as environment variables named exactly as in the schema above.
2. Plaintext-on-disk is forbidden — file mounts are acceptable only where the cloud provider does not support env-var injection (e.g. Fly allocates `DATABASE_URL` from a secret via `fly secrets import`).
3. Every secret read is logged once at startup with the key name (not the value) and the requester, giving an audit trail of "who needed this secret and when".

The audit trail lives in the structured logger output and is consumed by the observability stack defined in the sibling `hosted-observability-migration-alerts` task.

## Verification matrix (AC4)

Before declaring a service ready for cloud deploy, confirm every row in the matrix is satisfied:

| AC | Verification |
|---|---|
| AC1 — every production-required value has source, owner, rotation | `services/<svc>/.env.example` has `Owner:` and `Rotation:` annotations for every non-optional line (see `.env.example` files in this PR). Each entry above names an owner and a rotation cadence. |
| AC2 — secrets absent from source control, logs, client-visible responses | (a) `git log --all -- .env` returns empty. (b) `.gitleaks.toml` allowlist excludes `.env.example` empty-value lines; the gitleaks pre-commit hook (installed via `scripts/install-hooks.sh`) and CI step (`.github/workflows/ci.yml` gitleaks job) both pass. (c) Unit test `redact` covers `TASKS_API_SECRET_KEYS` and proves the structured logger cannot leak a configured secret value into a log row. (d) `GET /health` smoke test asserts no `process.env` keys appear in the response. |
| AC3 — missing/invalid config fails safely with actionable operator signal | (a) Boot tasks-api with `X_CLIENT=real` and no `X_API_KEY` — `process.exit(1)` and structured log line `config_validation_failed` with the offending key path. (b) Boot with malformed `DATABASE_URL` (`not-a-url`) — same structured failure. (c) Unit tests in `services/tasks-api/test/config.test.ts` cover each schema branch and cross-field constraint. |
| AC4 — configuration contract documented and verified against each cloud-hosted service | This runbook enumerates every key, owner, rotation, source of truth, and failure mode per service. The CI contract check (script reads this runbook + the `.env.example` files, asserts every required key appears in both) runs as part of the `cloud-readiness` job (see the PR description for the script). |

## Common operator scenarios

### Rotating a secret (generic)

1. Generate the new value locally. For string secrets, prefer `openssl rand -hex 32` (64 hex chars / 256 bits). For provider keys (X, Akahu, APNs, Supabase, Anthropic) follow the provider's rotation flow.
2. Update the secret manager entry for the new value. Keep the old value valid for at least one deploy cycle (the orchestrator should restart the service so the new value lands atomically; concurrent readers during the rollout window should still authenticate against the old value).
3. Redeploy the service. The structured `secret_loaded` audit log line will fire with the new key name; cross-reference against the structured `config_validation_failed` log to confirm the new value parses.
4. Revoke the old value at the provider once the rollout is healthy.
5. Update `Rotation:` in the `.env.example` comment if the rotation cadence has changed (e.g. `90d` → `30d`).

### Responding to `config_validation_failed`

The structured log line looks like:

```json
{"level":"fatal","event":"config_validation_failed","service":"tasks-api","issues":[{"path":"DATABASE_URL","message":"DATABASE_URL must be a postgresql:// URL"},{"path":"X_API_KEY","message":"X_API_KEY is required when X_CLIENT=real"}]}
```

1. Read the `issues` array — each entry names a key path and a human-readable message.
2. Cross-reference against this runbook's per-service tables to confirm what the value should be and who owns it.
3. If the issue is a missing/empty value, follow the rotation procedure above.
4. If the issue is a malformed value (wrong URL scheme, wrong schema), check the orchestrator's secret-manager export — the value may have been mis-pasted. Re-export and redeploy.

### Diagnosing a missing-secret incident

1. Confirm the orchestrator (Fly / k8s / systemd) actually injected the env var. `kubectl describe pod …` or `fly ssh console -C 'env | sort'` is the first stop.
2. Confirm the secret manager still has the value — providers occasionally expire or rotate independently.
3. Confirm the `.env.example` annotation still names the same key — a key rename without a `.env.example` update + a redeploy is the classic regression.
4. If all three are correct, rotate the value (treat as potentially exposed).

## Out of scope

- Cloud provider selection and secret manager provisioning (sibling `cloud-deployment-foundation`).
- Rotating credentials unrelated to cloud deployment.
- Redesigning application authentication (sibling `cloud-readiness-budget-api-require-sessions`).
- Replacing the existing local observability stack (sibling `hosted-observability-migration-alerts`).
- Vite-prefixed public config in `apps/gymtrack` (`VITE_*` values are public-by-design and shipped to the browser; they are documented here for inventory completeness but are not secrets).
