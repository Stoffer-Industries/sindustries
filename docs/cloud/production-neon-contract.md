# Production Neon contract — consolidated platform

**Status:** **approved repository contract; production is live and AC2 uses the accepted Neon Free-tier control** (task `fb1240c0`, Slice D). The production branch, schemas and service roles exist; the connectivity control is schema-scoped service-role isolation with denied staging/dev access, not an IP allowlist.
**Scope:** the production Neon database — its branch, its three schemas, the service roles that carry the DSNs, and the accepted connectivity control.
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

> **Resolved topology (Quinn, 2026-11-10):** production uses one Neon project and branch with the three schemas above. A future per-service split changes the manifest's `schemas` block and this contract together; it is not assumed by either.

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

## 3. Connectivity control — Neon Free, schema-scoped service roles

AC2's "connectivity restricted to production services" was first specified
as an IP allowlist plus denied staging/dev connections. Neon gates IP Allow
behind a paid plan, and the production organisation deliberately remains on
the **Free** plan. Tom's 2026-11-18 decision therefore re-specifies the
repository-owned evidence around the control Neon Free can actually
enforce:

1. **One login role per production schema.** The role owns that schema and
   no other; the production branch carries no second service role for the
   same schema.
2. **The role is schema-scoped.** The live read-back proved that each
   service role could create, write, select and drop in its own schema and
   had no cross-schema access.
3. **Staging and dev credentials cannot reach production.** The evidence
   must include a *denied* connection attempt from a staging credential
   and from a dev credential — not merely role names.
4. **The accepted control is named in the record.** The operator record
   uses `schema-scoped-service-roles` and covers the production branch,
   every production schema, and both refused credential kinds.

The checker decides `neon.connectivity-restriction` from those facts. On
Neon Free, the three IP-allowlist gates are reported **not applicable**:
the selected control does not use an allowlist, and the repository does
not claim that one exists. A Free-plan artifact that is missing the roles,
the denial proof or Tom's exact acceptance remains red.

### The abandoned IP-allowlist path

The IP-allowlist implementation remains in the checker for a paid-plan
account, but it is not the production control on this account. Its inputs
were:

- a Neon plan that can express an allowlist;
- app-scoped Fly static egress addresses for both production apps; and
- a Neon allowlist naming exactly those addresses.

Quinn allocated a Fly egress pair for each production app before the plan
decision was settled. Those addresses are no longer needed for AC2. If
neither app uses app-scoped static egress for another purpose, they are a
cleanup candidate; deallocation is a separate operator action and is not
performed by this contract.

### Honest reporting

A Free-plan artifact never reports an IP allowlist as met. The distinction
is deliberate:

- `neon.connectivity-restriction` — **met** only when the schema-scoped
  roles, denial proof and accepted control are all present;
- `neon.ip-allowlist`, `neon.ip-allowlist-source`,
  `neon.ip-allowlist-match` — **not applicable** when the accepted Free
  control is complete;
- the same IP gates — **unmet** when the Free-plan artifact does not carry
  the complete accepted replacement control.

---

## 4. Evidence obligation

The operator captures a **redacted** artifact — names, flags and counts only, never a value — and the gate decides whether it proves the treatment:

```json
{
  "environment": "production",
  "capturedAt": "2026-11-15T00:00:00Z",
  "database": {
    "project": "sindustries",
    "branch": "production",
    "plan": "free",
    "schemas": ["tasks_api", "budget_api", "content_scheduler"]
  },
  "roles": [
    { "name": "sindustries_tasks_api", "schema": "tasks_api", "canLogin": true, "canWrite": true, "scopedToSchema": true },
    { "name": "sindustries_budget_api", "schema": "budget_api", "canLogin": true, "canWrite": true, "scopedToSchema": true },
    { "name": "sindustries_content_scheduler", "schema": "content_scheduler", "canLogin": true, "canWrite": true, "scopedToSchema": true }
  ],
  "connectivity": {
    "control": "schema-scoped-service-roles",
    "ipAllowlistConfigured": false,
    "ipAllowlistEntryCount": 0,
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

It fails closed, with a named reason for each violation: a missing schema, a schema production does not define, a schema with no role or with two roles, a read-only, non-login or cross-schema role, an unknown connectivity control, a Free-tier record that falsely claims an IP allowlist, a Free-tier control attached to a non-Free plan, an unconfigured or empty IP allowlist on the paid-plan path, a staging or dev credential that could still connect, a non-production branch name, a missing timestamp, an artifact that carries a credential-shaped value, and an artifact that does not declare its own redaction.

The gate is the AC2 evidence path for the reviewer's and QA's use as well as the operator's: a reviewer reads a checker exit code, not a paragraph of prose.

---

## 5. Where this sits in the operator order

Slice D step 1 (branch and service roles) and step 2 (the accepted connectivity control and the denial proof) are the two steps this contract covers. The production resources are live; the contract now describes the evidence that closes AC2 on the selected Neon Free mechanism.

The production spend bound was read back after public exposure. Tom explicitly accepted that ordering deviation on 2026-11-18 and selected a dedicated capped card as the external financial control; the deviation is recorded in `docs/cloud/production-provisioning-readback.md` §8 rather than pretending the original order held. No other slice's live evidence changes here.

The AC2 evidence artifact is captured from the live branch and attached to the task; the provisioning-state checker consumes the same value-free operator record.

---

## 6. What this contract does not contain

- No credential, DSN, password or token — this repository is public.
- No Fly app, spend-limit, DNS-record or health-probe configuration. Those belong to the other Slice D steps and their live read-backs.
- No claim of network-layer IP restriction. The live provider state is explicit: the organization is on Free, the project allowlist is empty, public connections are not blocked, and the branch is not protected. AC2's accepted control is the schema-scoped service-role isolation plus the denied staging/dev connections, not an allowlist.
- No deallocation of the app-scoped Fly egress addresses allocated for the abandoned allowlist path. They are a cleanup candidate only after an operator confirms neither app needs them elsewhere.
