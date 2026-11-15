# Production Neon contract — consolidated platform

**Status:** **approved repository contract; live provisioning is blocked on the Neon account plan** (task `fb1240c0`, Slice D preparation). Nothing here is provisioned; nothing here is live.
**Scope:** the production Neon database — its branch, its three schemas, the service roles that carry the DSNs, and the connectivity restriction.
**Why this file exists:** AC2 asks for a production Neon branch that is "separated from staging/dev data, with connectivity restricted to production services", and the approved design's Slice D step 2 asks the operator to "prove staging/dev roles cannot connect to production". Until this pass, the repository owned the schema *names* (the environment manifest) and the secret *names* (the source contract) but owned **neither the roles nor the restriction**. Slice D steps 1–2 therefore had no reviewable shape: the operator would improvise, and the reviewer would read prose.

**Ownership:** per the approved design §6.3, Rowan owns repository contracts, checks, tests and durable docs; Quinn owns operator execution with the Neon credentials. This file is the contract; the operator acts against it.

---

## 1. Topology

One Neon production database, three schemas — the same shape staging proved on task `219fb673`, and the topology the production environment manifest already records:

| Schema | Carries | Manifest source |
|---|---|---|
| `tasks_api` | the tasks API | `schemas.tasks` |
| `budget_api` | the budget API | `schemas.budget` |
| `content_scheduler` | the content-scheduler API and the auto-post worker (they share the schema) | `schemas.contentScheduler` |

The schema names live in [`infra/cloud/platform/platform-environments.mjs`](../infra/cloud/platform/platform-environments.mjs) and nowhere else. The evidence gate reads them from there, so an evidence artifact cannot prove a shape production does not use.

> **Open question (Quinn):** the design allows production to split into per-service Neon projects instead. If production is to be split, the manifest's `schemas` block and this contract change together, and the split is recorded here rather than assumed.

---

## 2. Role contract

One login role per schema, named after the schema it owns:

| Schema | Proposed role name | Capability | Why |
|---|---|---|---|
| `tasks_api` | `sindustries_tasks_api` | login, write | the platform runs `prisma migrate deploy` against this schema, so a read-only role cannot satisfy the contract |
| `budget_api` | `sindustries_budget_api` | login, write | same |
| `content_scheduler` | `sindustries_content_scheduler` | login, write | same |

Rules:

1. **Exactly one role per schema.** A second role for the same schema is an unowned credential; the evidence gate rejects it.
2. **Each role is scoped to its own schema.** No role may hold privileges on another schema; the health probe, the drill and the deploy all use the schema's own credential.
3. **Every role is write-capable.** `docs/systems/cloud-platform.md` records why: the platform's release command runs migrations and the services write normally, so a read-only role fails at the first deploy. The database-drill read-only DSNs are **never** mapped onto the live platform.
4. **The DSN and the role are the same secret.** Rotating a database credential rotates the role password with it (the source contract says the same).
5. **The role name is not a secret and not a value.** It appears in this file, in the manifest and in the evidence artifact; the password never appears in any of them.

> **Assumption flagged for Quinn:** the `<project>_<schema>` naming convention is a proposal. The evidence gate deliberately does **not** hard-code role names — it checks that a role exists per schema and can log in and write — so renaming a role is a one-line change in this file and the fixture, not a checker change.

---

## 3. Connectivity restriction

AC2's "connectivity restricted to production services" is two obligations:

1. **The branch's IP allowlist is configured and non-empty.** A production branch with an empty allowlist accepts connections from anywhere, and the live read-back on 2026-11-14 found exactly that: the allowlist was empty and public connections were not blocked.
2. **Staging and dev credentials cannot reach production.** A staging role that can connect to the production branch is the separation failure AC2 names, so the evidence must include a *denied* connection attempt from a staging credential and from a dev credential — not merely the absence of an allowlist.

### Provider capability gate — observed 2026-11-16

The repository contract cannot be executed on the current Neon account plan:

- The Neon organization `Stoffer Industries` is on the **Free** plan. Neon currently makes **IP Allow a Scale-plan feature**; Free projects cannot carry the non-empty allowlist AC2 requires.
- **Protected branches are a paid-plan feature**. A protected-branches-only allowlist would require both a paid plan and a protected production branch. The live production branch currently reports `protected=false`.
- The live project still reports `allowed_ips.ips=[]`, `protected_branches_only=false`, and `block_public_connections=false`.

This is a hard preflight failure, not a value to work around: the AC2 evidence gate remains red until the organization has a plan that supports the selected mechanism, the production branch is protected if the allowlist is scoped that way, and the allowlist is populated. The repository does not authorize a paid-plan change; the account owner must make that spend decision.

### Fly source addresses

Fly's shared egress ranges are not a fixed set of addresses, so an allowlist built from "the current shared ranges" drifts. Fly now supports **app-scoped static egress IPs**:

```bash
fly ips allocate-egress --app sindustries-platform-production --region syd
fly ips allocate-egress --app sindustries-health-probe-production --region syd
```

Each allocation persists across Machine replacement and supplies a paired IPv4/IPv6 address. The IPv4 address is currently priced at **$3.60/month**; each pair supports up to 64 Machines. Both production apps connect to Neon, so each needs its own app-scoped pair and every resulting address belongs in the Neon allowlist. The operator records the count and the owning Fly app, not a guessed shared range.

> **Decision still open:** the Neon account is Free, while the selected IP Allow mechanism requires Scale. Quinn/Tom must approve the plan change (or an explicitly re-specified AC2 mechanism) before this contract can be executed. The contract itself stays fail-closed.

---

## 4. Evidence obligation

The operator captures a **redacted** artifact — names, flags and counts only, never a value — and the gate decides whether it proves the treatment:

```json
{
  "environment": "production",
  "capturedAt": "2026-11-15T00:00:00Z",
  "database": { "project": "sindustries", "branch": "production", "schemas": ["tasks_api", "budget_api", "content_scheduler"] },
  "roles": [
    { "name": "sindustries_tasks_api", "schema": "tasks_api", "canLogin": true, "canWrite": true },
    { "name": "sindustries_budget_api", "schema": "budget_api", "canLogin": true, "canWrite": true },
    { "name": "sindustries_content_scheduler", "schema": "content_scheduler", "canLogin": true, "canWrite": true }
  ],
  "connectivity": {
    "ipAllowlistConfigured": true,
    "ipAllowlistEntryCount": 2,
    "stagingRoleConnectDenied": true,
    "devRoleConnectDenied": true
  },
  "redaction": { "containsSecretValues": false }
}
```

A working example lives at [`tests/cloud/fixtures/production-neon-evidence.example.json`](../../tests/cloud/fixtures/production-neon-evidence.example.json).

Run the gate:

```bash
node tests/cloud/scripts/check-production-neon-evidence.mjs <evidence-file>
```

It fails closed, with a named reason for each violation: a missing schema, a schema production does not define, a schema with no role or with two roles, a read-only or non-login role, an unconfigured or empty IP allowlist, a staging or dev credential that could still connect, a non-production branch name, a missing timestamp, an artifact that carries a credential-shaped value, and an artifact that does not declare its own redaction.

The gate is the AC2 evidence path for the reviewer's and QA's use as well as the operator's: a reviewer reads a checker exit code, not a paragraph of prose.

---

## 5. Where this sits in the operator order

Slice D step 1 (branch and service roles) and step 2 (connectivity restriction and the denial proof) are the two steps this contract covers. Step 3 onward — the Fly apps, the Environment secrets, the migrations, the spend limit, the health probe, DNS — are unchanged by this file and remain gated in the approved order, with the spend limit still required **before** any public exposure.

The evidence artifact is captured at step 2 and attached to the task as AC2 evidence.

---

## 6. What this contract does not contain

- No credential, DSN, password or token — this repository is public.
- No Fly app, spend limit, DNS record or health-probe configuration. Those belong to the other Slice D steps.
- No production resource. Re-read live from the provider on 2026-11-16: the organization is on the Free plan; the production branch exists (`current_state=ready`) but carries only the `auth` and `public` schemas — no `tasks_api`, `budget_api` or `content_scheduler` — its only roles are Neon's four defaults (`neondb_owner`, `authenticator`, `anonymous`, `authenticated`), the branch is not protected, and the project restriction is unset (`allowed_ips.ips` empty, `protected_branches_only` false, `block_public_connections` false).
