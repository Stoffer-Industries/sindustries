---
status: draft
task_id: 206927ed-d851-47af-8864-0056487e0c4e
product_spec: brain/tasks/specs/open/production-runtime-configuration.md
shipped_pr: null
shipped_date: null
---

# Cloud readiness: define and secure production runtime configuration

## Links

- Product spec: `brain/tasks/specs/open/production-runtime-configuration.md`
- Parent migration doc: `brain/tasks/specs/open/sindustries-cloud-migration.md` (workstream 2 of 7)
- Tech design: `docs/specs/cloud-readiness-production-runtime-configuration-tech-design.md`
- Task: `206927ed-d851-47af-8864-0056487e0c4e`
- Tasks API record: `http://localhost:4001/api/v1/tasks/206927ed-d851-47af-8864-0056487e0c4e`
- Sibling cloud-readiness tech designs:
  - `docs/specs/cloud-readiness-akahu-token-encryption-tech-design.md` (BUDGET_API_TOKEN_KEY precedent — reuse the secret-loading shape)
  - `docs/specs/cloud-readiness-budget-api-require-sessions-tech-design.md` (auth-boundary precedent)

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-206927ed-production-runtime-configuration`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: update `docs/specs/` cross-reference table in the `sindustries-cloud-migration` parent index.

## Scope

Every cloud-hosted SIndustries service must boot with an explicit, validated, secret-safe runtime configuration. This task establishes the **contract** and the **loading/validation mechanism** across all production-deployed services. It does not pick the cloud provider, does not provision the secret store, and does not change any business logic.

The three services that ship to the cloud are:

| Service | Path | Today | Required secret inventory |
|---|---|---|---|
| `tasks-api` | `services/tasks-api` | `.env.example` exists; X OAuth + actor secret + BullMQ Redis URL + approval auth credentials | X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, X_ACTOR_SECRET, BUDGET_API_TOKEN_KEY (used by future ciphertext migration), TASKS_API_APPROVAL_USERS, TASKS_API_APPROVAL_SERVICE_CREDENTIALS, DATABASE_URL, CONTENT_SCHEDULER_REDIS_URL |
| `budget-api` | `services/budget-api` | `.env.example` exists; AKAHU OAuth + APNs + LLM + email | AKAHU_CLIENT_ID, AKAHU_CLIENT_SECRET, AKAHU_REDIRECT_URI, BUDGET_API_TOKEN_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRIVATE_KEY_P8, EMAIL_PROVIDER_API_KEY, LLM_API_KEY, DATABASE_URL, DEV_SESSION_SECRET (must be replaced — see risk) |
| `gymtrack-mcp` | `services/gymtrack-mcp` | No `.env.example` exists today; relies on `fly.toml` env block + process env | SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, Anthropic API key (or whatever the current LLM provider is), Fly-allocated PORT |
| `apps/gymtrack` (web) | `apps/gymtrack` | `.env.example` exists; VITE_-prefixed values are public-by-design | VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_GYMTRACK_MCP_BASE_URL |

Note: this task covers `services/*` because those run server-side and own secret-bearing config. The Vite-side `VITE_*` values are public-by-design and out of scope for secret management — they are an AC4 documentation concern, not an AC2 secret concern.

## Ownership boundary

- **Where the contract lives:** `services/<svc>/src/config.ts` (one per service). The contract is the single source of truth for "what does this service need at runtime?"
- **Where secrets live at rest:** the cloud provider's secret manager (AWS Secrets Manager / GCP Secret Manager / Fly secrets — to be picked in the sibling `cloud-deployment-foundation` task). This task defines the **shape** of the contract; the sibling task wires the delivery.
- **Where validation happens:** process startup. Every service refuses to boot when the contract is incomplete or malformed, with a structured error message naming the missing key, the owner, and how to remediate.
- **What we are NOT doing here:** rotating secrets unrelated to cloud deployment, redesigning application authentication, picking a cloud provider, building a secret-management UI.

## Approach

Three layers, applied per service:

### 1. `services/<svc>/src/config.ts` — typed schema + fail-safe validation

Each service gets a single `config.ts` module that:

- Parses `process.env` once at module load time (ESM top-level await / sync parse is fine — Node caches it).
- Validates against a `zod` schema (zod is already used in some services; where it is not, add it as a dependency with a one-line justification in the PR).
- On failure, throws a structured error (`ConfigValidationError`) that includes:
  - Missing/invalid key names
  - The owner (string — see AC1 source-of-truth)
  - A pointer to the runbook section for that service
- On success, exports a frozen `config` object with the parsed values. Subsequent `process.env` reads inside the service are not allowed (lint rule + code review).

```ts
// services/tasks-api/src/config.ts (sketch)
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: z.string().url().refine(
    (u) => new URL(u).protocol === 'postgresql:',
    'DATABASE_URL must be a postgresql:// URL'
  ),
  CORS_ALLOWED_ORIGINS: z.string().default('').transform((s) =>
    s.split(',').map((o) => o.trim()).filter(Boolean)
  ),
  // X OAuth — required when X_CLIENT=real
  X_CLIENT: z.enum(['fake', 'real']).default('fake'),
  X_API_KEY: z.string().min(1).optional(),
  X_API_SECRET: z.string().min(1).optional(),
  X_ACCESS_TOKEN: z.string().min(1).optional(),
  X_ACCESS_TOKEN_SECRET: z.string().min(1).optional(),
  X_ACTOR_SECRET: z.string().min(32).optional(),
  X_HANDLE: z.string().default('sindustries'),
  // Content scheduler / BullMQ
  CONTENT_SCHEDULER_JOB_ADAPTER: z.enum(['in-process', 'bullmq']).default('in-process'),
  CONTENT_SCHEDULER_REDIS_URL: z.string().url().optional(),
  // Approval auth
  TASKS_API_APPROVAL_USERS: z.string().default('[]').transform((s, ctx) => {
    try { return JSON.parse(s); } catch { ctx.addIssue({ code: 'custom', message: 'invalid JSON' }); return z.NEVER; }
  }),
  TASKS_API_APPROVAL_SERVICE_CREDENTIALS: z.string().default('[]').transform((s, ctx) => {
    try { return JSON.parse(s); } catch { ctx.addIssue({ code: 'custom', message: 'invalid JSON' }); return z.NEVER; }
  }),
  TASKS_API_APPROVAL_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28800),
  // HTTP hardening
  TASKS_API_JSON_LIMIT: z.string().default('100kb'),
  TASKS_API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  TASKS_API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
}).superRefine((cfg, ctx) => {
  if (cfg.X_CLIENT === 'real') {
    for (const key of ['X_API_KEY','X_API_SECRET','X_ACCESS_TOKEN','X_ACCESS_TOKEN_SECRET','X_ACTOR_SECRET']) {
      if (!cfg[key as keyof typeof cfg]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when X_CLIENT=real` });
      }
    }
  }
  if (cfg.CONTENT_SCHEDULER_JOB_ADAPTER === 'bullmq' && !cfg.CONTENT_SCHEDULER_REDIS_URL) {
    ctx.addIssue({ code: 'custom', path: ['CONTENT_SCHEDULER_REDIS_URL'], message: 'required when CONTENT_SCHEDULER_JOB_ADAPTER=bullmq' });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Structured log + non-zero exit. NEVER print secret values.
  const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  console.error(JSON.stringify({ level: 'fatal', event: 'config_validation_failed', service: 'tasks-api', issues }));
  process.exit(1);
}
export const config = Object.freeze(parsed.data);
```

The same shape repeats for `budget-api` and `gymtrack-mcp`. Per-service `config.ts` is the AC3 fail-safe gate.

### 2. `.env.example` becomes a contract, not a wish list

Every `services/<svc>/.env.example` is annotated with:

- A comment line `# Required in production` or `# Optional`
- An `# Owner: <name>` line for each non-public value
- A `# Rotation: <cadence>` line — e.g. `90d`, `on-incident`, `manual`
- The `# Required when X=Y` cross-reference where it exists (already partially done in `tasks-api/.env.example`)

This is the AC1 source-of-truth record. The `.env.example` is committed; secrets themselves are not.

### 3. `docs/runbooks/production-runtime-config.md` — operator-facing contract

A new runbook entry enumerates every required key for each cloud-deployed service, with:

- Service name
- Key name (exact, case-sensitive)
- Type / format
- Owner
- Rotation expectation
- Source (env var vs file mount vs secret-store ref)
- Failure mode if missing or invalid (which `ConfigValidationError` code is thrown)

This is the AC4 verification surface — every cloud-deployed service is checked against this table before deploy, and the deploy fails if a required entry is missing.

### 4. Logging and response-surface guards

- **Logging:** structured logger in each service is configured to redact known secret names. The redaction list is sourced from the `config.ts` schema, not hard-coded. A lint rule + a unit test asserts that `JSON.stringify(row)` of any logger-formatted object cannot contain the literal value of `X_API_KEY`, `BUDGET_API_TOKEN_KEY`, etc., even when those fields appear in error paths.
- **Response surface:** HTTP error handlers continue to use `error.toJSON()` shape (no env leakage). Add a smoke test that asserts `GET /health` (and any error response) does not contain env-derived secret values.
- **Source control:** `services/*/.env` and `apps/*/.env` are already `.gitignore`'d (verified). Add a `git secrets` (or `gitleaks`) pre-commit hook that fails on known secret-name patterns (X_API_KEY=..., AKAHU_CLIENT_SECRET=..., BUDGET_API_TOKEN_KEY=... not empty, etc.). The hook is local-only (does not require CI changes) and lives in `.git/hooks/pre-commit` via a documented `scripts/install-hooks.sh`.

### 5. Secret delivery — shape only, not implementation

The sibling `cloud-deployment-foundation` task picks the secret manager. This task defines:

- **Contract:** secrets reach the process as environment variables named exactly as in the `config.ts` schema.
- **Source-of-truth:** the secret value lives in the cloud provider's secret store; the runtime never sees plaintext-on-disk. File mounts are acceptable only for the case where the cloud provider does not support env-var injection (e.g., Fly allocates `DATABASE_URL` from a secret via `fly secrets import`).
- **Audit:** every secret read is logged once at startup with the key name (not the value) and the requester. This gives an audit trail of "who needed this secret and when".

## Data model / API contract

- No database schema changes.
- No API contract changes for end users.
- Internal contract: the new `config.ts` module is the only sanctioned way for service code to read configuration. A lint rule (`no-restricted-syntax` for `process.env.X` outside `config.ts`) enforces this.

## Workflow / cron / skill changes

- None directly. The sibling `cloud-deployment-foundation` task will add the deploy-time secret wiring; this task only sets the contract.
- The `scripts/install-hooks.sh` (or equivalent) is added in this PR but only installs a local pre-commit `gitleaks` hook. CI already runs `gitleaks` (verify in `.github/workflows/`); if not, add a step in this PR.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — every production-required value has source, owner, rotation expectation | `services/*/.env.example` has `Owner:` and `Rotation:` comments for every non-optional line. `docs/runbooks/production-runtime-config.md` enumerates each. PR diff shows the additions; a unit test (`test/config.contract.test.ts`) reads each `.env.example` and asserts every non-optional line has both annotations. |
| AC2 — secrets are absent from source control, logs, client-visible responses | (a) `git log --all -- .env` returns empty. (b) `gitleaks` pre-commit hook is installed; CI `gitleaks` step passes. (c) A test that boots the service with a known-bad log line containing `X_API_KEY=secret` and asserts the structured logger output does NOT contain the substring `secret`. (d) `GET /health` test asserts no `process.env` keys appear in the response. |
| AC3 — missing/invalid config fails safely with actionable operator signal | (a) Boot the service with `X_CLIENT=real` but no `X_API_KEY` — assert `process.exit(1)` and structured log line `config_validation_failed` with the missing key path. (b) Boot with malformed `DATABASE_URL` (`not-a-url`) — same structured failure. (c) Unit tests cover each schema branch (the `.superRefine` cross-field rules). |
| AC4 — configuration contract documented and verified against each cloud-hosted service | `docs/runbooks/production-runtime-config.md` exists and is linked from `docs/systems/<svc>.md` for each service. The runbook includes the AC verification matrix above. A CI check (lightweight — script reads the runbook and the `.env.example` files, asserts every required key appears in both) runs as part of the `cloud-readiness` job. |

## Out of scope

- Cloud provider selection (sibling `cloud-deployment-foundation`).
- Secret manager provisioning (sibling).
- Rotating credentials unrelated to cloud deployment.
- Redesigning application authentication (sibling `cloud-readiness-budget-api-require-sessions`).
- Replacing the existing local observability stack (sibling `hosted-observability-migration-alerts`).
- VITE_*-prefixed public config in `apps/gymtrack` (handled in the docs/runbooks entry as an AC4 note, not as a secret-management concern).

## Risks

- **`DEV_SESSION_SECRET=dev-secret-change-me`** in `services/budget-api/.env.example` is a placeholder that must NOT be the production value. The new `config.ts` will reject any value matching `^dev-` in production mode. This is a breaking change for any environment that has been running with the dev placeholder; the runbook documents the rotate-and-redeploy.
- **`gymtrack-mcp` has no `.env.example` today.** The first runbook iteration will be the source of truth; subsequent PRs may split it out into a file once the contract stabilizes. Not a blocker for this task.
- **gitleaks false positives** on the `BUDGET_API_TOKEN_KEY=` line in `.env.example` (empty value is fine; the line itself trips the default regex). Solution: a `.gitleaks.toml` allowlist entry for `.env.example` lines that match `^[A-Z_]+=$` (empty value).
- **Lint-rule false positives** on `process.env` reads inside `config.ts` itself. Solution: the lint rule allows `process.env` reads inside the same directory as `config.ts` (file-level scope), not just the file itself.

## Open questions

1. **Do we need a shared `services/_shared/config.ts`** or is per-service duplication cleaner? Default: per-service, because the schemas are service-specific and a shared helper would still need per-service shape. Flag for Quinn if she prefers DRY.
2. **Should the `config.ts` schema be auto-generated from `.env.example`** or hand-written? Default: hand-written. Auto-gen saves typing but loses the cross-field `.superRefine` rules.
3. **`gymtrack-mcp` secrets in `fly.toml`** — are these already in Fly secrets or are they inline in `fly.toml`? Need to verify before this PR lands (the runbook can't document an "owner" if the value is checked into `fly.toml`).