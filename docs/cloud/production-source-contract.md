# Production source contract — consolidated platform

**Status:** contract for the production environment (task `fb1240c0`, Slice B).
**Source of truth:** [`infra/cloud/platform/platform-environments.mjs`](../infra/cloud/platform/platform-environments.mjs) (the environment manifest).
**Local operator path:** [`infra/cloud/scripts/bootstrap-production.sh`](../infra/cloud/scripts/bootstrap-production.sh) → `infra/cloud/scripts/bootstrap-platform.sh --environment production`.
**CI path:** the production deploy workflow (Slice C) reads the same source names from the GitHub `production` Environment.

This document lists **names, owners and rotation** only. No secret value appears here, and none ever may: this file is committed to a public repository.

---

## 1. The shape of the contract

There are three names for every credential, and confusing them is how a production app ends up running on staging data:

| Name | Where it lives | Owner |
|---|---|---|
| **Local key** | `infra/cloud/.env.production.local` (gitignored, operator-local) | Quinn |
| **Source name** | the GitHub `production` Environment, and the manifest | Quinn |
| **Destination name** | the app-level `PLATFORM_*` Fly secret on `sindustries-platform-production` | the provisioner |

The **source name** is the contract. The provisioner ([`platform-provision-secrets.mjs`](../infra/cloud/platform/platform-provision-secrets.mjs)) owns the source → destination mapping, and both the local bootstrap and the CI deploy path go through it, so a local bootstrap and a CI deploy cannot register different secrets on the same app.

The local keys are the operator-facing convenience documented in [`infra/cloud/env/bootstrap-production.env.example`](../infra/cloud/env/bootstrap-production.env.example).

---

## 2. Sources

| Source name (manifest) | Local key | Destination (`PLATFORM_*`) | Required | Owner | Rotation |
|---|---|---|---|---|---|
| `PRODUCTION_TASKS_API_DATABASE_URL` | `TASKS_API_DATABASE_URL` | `PLATFORM_TASKS_API_DATABASE_URL` (schema `tasks_api`) | yes | Quinn (Neon production) | 90d or on-incident |
| `PRODUCTION_BUDGET_API_DATABASE_URL` | `BUDGET_API_DATABASE_URL` | `PLATFORM_BUDGET_API_DATABASE_URL` (schema `budget_api`) | yes | Quinn (Neon production) | 90d or on-incident |
| `PRODUCTION_CONTENT_SCHEDULER_API_DATABASE_URL` | `AUTO_POST_WORKER_DATABASE_URL` | `PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL` (schema `content_scheduler`) | no — derived from the tasks-api DSN when absent | Quinn (Neon production) | with the database |
| `PRODUCTION_HEALTH_PROBE_REDIS` | `HEALTH_PROBE_REDIS` (or `TASKS_API_CONTENT_SCHEDULER_REDIS_URL`) | `PLATFORM_CONTENT_SCHEDULER_REDIS_URL`, `PLATFORM_AUTO_POST_WORKER_REDIS_URL`, `PLATFORM_HEALTH_PROBE_REDIS_URL` | yes | Quinn (Upstash production, TLS) | per-deploy |
| `PRODUCTION_TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | `TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | `PLATFORM_TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | yes | Quinn | per-deploy |
| `PRODUCTION_CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | `PLATFORM_CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` | yes | Quinn | per-deploy |

The three `PLATFORM_*_CORS_ALLOWED_ORIGINS` destinations are **not** sources: they are environment facts, owned by the manifest's `corsAllowedOrigins`, and rendered into the Fly config by the overlay ([`infra/cloud/fly/platform.production.overlay.toml`](../infra/cloud/fly/platform.production.overlay.toml)).

The manifest is the source of truth for every name in this table. If a name here disagrees with the manifest, the manifest wins and this table is the bug — [`infra/cloud/platform/tests/platform-environments.test.mjs`](../infra/cloud/platform/tests/platform-environments.test.mjs) and [`infra/cloud/platform/tests/render-fly-config.test.mjs`](../infra/cloud/platform/tests/render-fly-config.test.mjs) bind the two surfaces together.

---

## 3. Format, and what is refused

Every production value is scanned before anything is registered. The provisioner refuses the **whole payload** — no partial registration — when a value carries:

- a staging or dev hostname (`staging.sindustries.co.nz`, `.staging.`, `sindustries-platform-staging`, `sindustries-health-probe-staging`, the retired per-service staging app names, `sindustries.dev`);
- a provider endpoint whose host carries a non-production environment label (`ep-dev-…neon.tech`, `eu1-dev-redis.upstash.io`, `staging-db.neon.tech`, `staging.upstash.io`);
- a placeholder (`REPLACE_ME`) or a loopback address (`localhost`, `127.0.0.1`).

Formats:

```
postgresql://<user>:***@<neon-host>/<db>?schema=<schema>&sslmode=require
redis://:<password>@<upstash-host>:6379
<opaque token>
```

**Redis caveat:** the Redis source must be the **live** production instance. A URL pointing at a deleted instance still parses as a `redis://` URL, so the shape check passes; only the supervisor's first queue operation would fail. Verify the instance answers before bootstrapping.

---

## 4. Rotation

1. Write the new value into the GitHub `production` Environment under the **source name** in the table above. Never into a `PLATFORM_*` name — those are the provisioner's destinations.
2. For the local path, update `infra/cloud/.env.production.local` too (it is operator-local and gitignored).
3. Re-run the bootstrap (it is idempotent: `fly secrets set` replaces the app-level values) or let the deploy workflow re-provision.
4. Read the registered **names** back (`fly secrets list --app sindustries-platform-production`) — never the values.

A rotation that changes a database credential must also update the Neon role that carries it; the DSN and the role are the same secret to the platform.

---

## 5. The approval actor

The production approval actor is `production-cloud-validate`. It is deliberately **not** in the Tasks API `ACTOR_PERMISSIONS` map: it can use the ordinary authenticated mutation routes, while every approval-row route fails closed with `403 APPROVAL_ACTOR_FORBIDDEN`. Giving it approval-row authority is a separate, security-reviewed change to `services/tasks-api/src/middleware/approvalAuth.ts`.

---

## 6. Deploy gates

Production has **three** gates, and each one guards a different mutation. The gate names are derived from the environment id, so they cannot drift from the environment they belong to; [`infra/cloud/scripts/tests/bootstrap-platform.test.sh`](../infra/cloud/scripts/tests/bootstrap-platform.test.sh) asserts that the staging workflow and the derivation still agree.

| Mutation | Gate | What it guards |
|---|---|---|
| Provision (create the app, register the secrets) | `PRODUCTION_PLATFORM_PROVISION_ENABLED=true` | A secret write restarts the app's Machines, so provisioning is a production mutation and not a no-op. The CI workflow evaluates this gate BEFORE the provisioning step. |
| Deploy (serve traffic) | `PRODUCTION_PLATFORM_DEPLOY_ENABLED=true` **and** the provisioning gate | The deploy also requires the provisioning gate: an app deployed without its secrets registered cannot reach its database. |
| Migrations (change the schema) | `PRODUCTION_PLATFORM_MIGRATIONS_ENABLED=true` | Migrations change the DATABASE, not the app, so `--migrate` alone is not consent to run them. |

The local operator path takes the same gates: `--deploy` **and** `PRODUCTION_PLATFORM_DEPLOY_ENABLED=true`, `--migrate` **and** `PRODUCTION_PLATFORM_MIGRATIONS_ENABLED=true`. Those values may be exported in the operator's shell or placed in the local env file.

The production Fly org is **required**, not defaulted: `PRODUCTION_FLY_ORG` expands to the empty string when it is unset, and an empty `--org` makes flyctl act on its CLI's default org — which may not own the production app. The CI workflow fails before any Fly call when it is unset.

### The local env file cannot choose the environment

The local env file is **parsed with an allow-list**, never sourced into the bootstrap's shell. It contributes the source keys, the Fly org and values for the exact deploy and migration gate names selected by the manifest. The environment, target app, gate names and environment facts are the manifest's, and those control variables are `readonly` in the script. A copy of the staging env file therefore cannot point the production bootstrap at staging or satisfy a production gate with a staging gate variable.

The live provisioning order (create the Neon branch, create the app, populate the Environment, register the secrets, set the spend limit, then publish DNS) is in the approved tech design: [`docs/specs/production-environment-provisioning-tech-design.md`](../specs/production-environment-provisioning-tech-design.md), Slice D.
