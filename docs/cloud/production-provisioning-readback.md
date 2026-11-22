# Production provisioning read-backs — task fb1240c0 (Slice D)

**Operator:** Quinn · **Dates:** 2026-11-16 to 2026-11-18 (NZDT) · **Environment:** production

Every item below was observed live against the production control planes.
No credential value appears in this file or in the artifact it feeds — only
names, hostnames, counts and pointers.

---

## 1. Neon separation denial proof (AC2, operator slot `neonSeparationDenialProof`)

The production branch is `br-long-haze-a7wrd3ci` in Neon project
`sindustries` (org `org-dry-grass-92330972`, plan `free`). Its endpoint is
`ep-solitary-poetry-a70bp93w.ap-southeast-2.aws.neon.tech`.

Two refused connection attempts were made against that endpoint, each with
a credential that belongs to a different environment:

| Credential kind | Attempted against | Result |
| --- | --- | --- |
| staging | production branch endpoint | `ERROR: password authentication failed for user "npg_RzT25UpmXtVr"` |
| dev | production branch endpoint | `ERROR: password authentication failed for user "devprobe"` |

The staging credential is the role the staging platform actually uses
(`npg_RzT25UpmXtVr`, present on the staging branch only). The dev
credential is the owner role of the separate `sindustries-staging-dr`
project's `main` branch. Neither exists on the production branch, so
neither can authenticate to it.

The production branch's own three service roles were then confirmed to
work in their own schema — each was connected with its own password and
wrote to its own schema:

| Role | Schema | Result |
| --- | --- | --- |
| `sindustries_tasks_api` | `tasks_api` | login OK, CREATE/INSERT/SELECT/DROP OK |
| `sindustries_budget_api` | `budget_api` | login OK, CREATE/INSERT/SELECT/DROP OK |
| `sindustries_content_scheduler` | `content_scheduler` | login OK, CREATE/INSERT/SELECT/DROP OK |

**The cross-schema access is a recorded, accepted deviation.** The
read-back above was recorded on 2026-11-16, before the cutover work
established the full role model. The later read-back (Quinn,
2026-11-22) found that both `sindustries_tasks_api` and
`sindustries_content_scheduler` are DIRECT members of `neon_superuser`,
which carries `pg_read_all_data` and `pg_write_all_data` — so each role
holds USAGE, and read and write, on EVERY schema in the database, and no
explicit GRANT can withdraw it, because no explicit grant was the source.
Per-schema confinement is therefore not enforceable in this role model.
Tom accepted that shared access on 2026-11-23 07:25 NZDT (recorded by
Quinn, task `f2c23e26`, option (b)) rather than revoking the membership.
The acceptance covers exactly the pair
`sindustries_tasks_api` / `sindustries_content_scheduler`, is declared in
the environment manifest (`databaseServiceRoleSharedAccess`), and is
recorded in the `neon.service-role-scope` proof's `acceptedSharedAccess`
block; the provisioning gate refuses when the two disagree.

**Connectivity control:** Neon on the Free plan cannot express an IP
allowlist (`allowed_ips.ips` is empty, `protected=false`,
`block_public_connections=false`). Tom decided on 2026-11-18 to remain on
Free and accept **schema-scoped service roles** as AC2's connectivity
control: one write-capable, per-schema role for each production schema,
plus the refused staging/dev connections recorded above. The repository
does not claim that an IP allowlist exists; §7 records the accepted
replacement and the cleanup note for the abandoned allowlist path.

**Read-back artifact:** this file (`docs/cloud/production-provisioning-readback.md`).

---

## 2. One successful production probe interval (AC6, slot `productionProbeInterval`)

The production health-probe app `sindustries-health-probe-production` was
deployed with the production cadence and observed reporting live targets:

```
sindustries_db_up{app="tasks_api",service="health-probe"} 1
sindustries_db_up{app="budget_api",service="health-probe"} 1
sindustries_db_up{app="content_scheduler",service="health-probe"} 1
sindustries_redis_up{app="content-scheduler",service="health-probe"} 1
```

Read from `https://health-probe.sindustries.co.nz/metrics` at
2026-11-16T22:1x NZDT. The probe's boot line confirms the production
cadence:

```
health-probe listening on :9090 (interval=30s, fly-interval=120s, db-interval=3600s)
```

Every configured target reported `up=1`: all three production Neon
schemas and the production Redis instance.

The deployed probe now also publishes value-free target identity metrics
(`sindustries_health_probe_target_info`). The provisioning capture compares
those fingerprints with the Fly, Neon and Redis control-plane fingerprints;
Fly's Machines API is not used for secret values because it exposes only
plain `[env]` entries, not Fly secret values.

**Read-back artifact:** this file.

---

## 3. Production API health responses (AC4, slot `productionApiHealthResponses`)

Black-box HTTPS responses from the three production API hostnames, over
direct egress (the local egress proxy blocks these upstream hosts, which
is a known local-network artefact, not a deployment fault):

| Hostname | Route | Status | Body |
| --- | --- | --- | --- |
| tasks-api.sindustries.co.nz | `/health` | 200 | `{"status":"ok","service":"tasks-api","version":null}` |
| budget-api.sindustries.co.nz | `/health` | 200 | `{"status":"ok","service":"budget-api","version":null}` |
| content-scheduler-api.sindustries.co.nz | `/health` | 200 | `{"status":"ok","service":"content-scheduler-api","version":null}` |

**Read-back artifact:** this file.

---

## 4. Production DNS resolution and TLS read-back (AC3, slot `dnsResolutionAndTlsReadback`)

Resolution was read from two independent public resolvers
(`1.1.1.1` and `8.8.8.8`), both agreeing:

| Hostname | 1.1.1.1 | 8.8.8.8 |
| --- | --- | --- |
| tasks-api.sindustries.co.nz | 66.241.124.207 | 66.241.124.207 |
| budget-api.sindustries.co.nz | 66.241.124.207 | 66.241.124.207 |
| content-scheduler-api.sindustries.co.nz | 66.241.124.207 | 66.241.124.207 |
| health-probe.sindustries.co.nz | 66.241.124.140 | 66.241.124.140 |

The first three resolve to the consolidated production platform app's
shared IPv4; the fourth resolves to the production health-probe app's
shared IPv4. The CNAME targets were read back from Cloudflare and match
the hostname matrix (`sindustries-platform-production.fly.dev` and
`sindustries-health-probe-production.fly.dev`).

TLS: each hostname presents a Let's Encrypt certificate whose CN is the
hostname itself, valid 2026-11-16 → 2027-02-14.

| Hostname | Subject | Issuer |
| --- | --- | --- |
| tasks-api.sindustries.co.nz | CN=tasks-api.sindustries.co.nz | Let's Encrypt YE2 |
| budget-api.sindustries.co.nz | CN=budget-api.sindustries.co.nz | Let's Encrypt YE2 |
| content-scheduler-api.sindustries.co.nz | CN=content-scheduler-api.sindustries.co.nz | Let's Encrypt YE1 |
| health-probe.sindustries.co.nz | CN=health-probe.sindustries.co.nz | Let's Encrypt YE2 |

**Read-back artifact:** this file.

---

## 5. Redis topology decision and read-back

Tom decided on 2026-11-17 that both environments use separate Fly-managed
Upstash databases on Pay-as-you-go. `fly redis list --org personal` showed:

| Environment | Fly-managed database | Plan | Primary region |
| --- | --- | --- | --- |
| staging | `sindustries-staging` | Pay-as-you-go | `syd` |
| production | `sindustries-production` | Pay-as-you-go | `syd` |

Staging was repointed to `sindustries-staging`; all three API health routes,
the health probe and the worker readiness check passed afterward. The retired
direct-Upstash staging database was deleted. Production was already using
`sindustries-production`.

The databases must remain separate. The BullMQ queue name is
`content-scheduler-auto-post` without an environment suffix, so a shared Redis
database would let staging and production workers consume each other's jobs.

The repository source of truth is each environment's `redisAddon` entry in
`infra/cloud/platform/platform-environments.mjs`. The provisioning capture
reads the add-on through Fly GraphQL; direct Upstash account inventory is not
part of the evidence path because Fly-managed add-ons do not appear there.

---

## 6. Production spend bound (AC5, slot `flySpendLimit`) — RECORDED

**The read-back and Tom's ordering-deviation acceptance are both recorded below.**

Fly.io exposes no programmatic spend-limit surface: no GraphQL field,
input or mutation whose name contains spend/limit/budget/cap/threshold;
no REST endpoint under `/v1/` for org- or app-scoped billing/limits (all
probed paths return 404 while a control path returns 200); and no
`flyctl` command or flag. Fly's own cost-management documentation states
that free allowances do not cap the bill and that billing alerts are not
supported. The only enforced stop available on this account is prepaid
credit exhaustion (minimum $25), which suspends the account rather than
capping spend.

**The approved control.** Tom decided on 2026-11-17 (16:54 NZDT) that the
production spend bound is a **prepaid/capped billing method** on the Fly
production billing account, because Fly has no native spend-limit control
to set. The slot therefore records WHICH control was read back, and the
contract allows exactly two:

| `control` | What it means |
| --- | --- |
| `fly-native-spend-limit` | a native Fly organisation/app spend limit, read back from the Fly billing surface — no such control exists on this account |
| `prepaid-capped-billing-method` | a prepaid or capped billing method on the Fly production billing account, read back from the billing surface — **the approved control** |

A recorded spend slot that names no control, or names a control outside
this list, is refused: a read-back that does not say what bounded the
spend cannot be checked against what was actually set.

**Operator read-back (2026-11-17 20:38 NZDT).** Tom confirmed that the
Fly production billing method is now a limited card capped at NZ$30/month.
This is the approved `prepaid-capped-billing-method` control for the
production app scope. The artifact records `readBackAt` as
`2026-11-17T07:38:00.000Z` and points `evidenceRef` at this file.

Artifact record:

```json
{
  "recorded": true,
  "readBackAt": "2026-11-17T07:38:00.000Z",
  "scope": "production app scope",
  "control": "prepaid-capped-billing-method",
  "evidenceRef": "docs/cloud/production-provisioning-readback.md",
  "targets": ["sindustries-platform-production"]
}
```

This records the operator read-back without storing card details or any
credential value.

Note on ordering — and what the repository now checks. The approved
design makes the spend bound a hard gate BEFORE any public exposure. The
production DNS records were published at **2026-11-16T10:12:23Z**
(`tasks-api`, the first of the four; the others follow within two
seconds) and the production health-probe app's current release was created
at **2026-11-16T20:32:20Z**, under Tom's explicit approval of the Fly-app
and DNS work on 2026-11-16 21:36. The spend bound cannot be read back
until the card is active, so **the bound will be established AFTER the
exposure**.

Until 2026-11-17 the checker's ordering gate proved only that a
spend-bound read-back was RECORDED while production was exposed — it did
not compare times, because the artifact carried no exposure time at all.
That made the order assertable in prose but not checkable in code: once
the card is read back, the gate would have reported "met" and its reason
would have read as though the bound preceded the cutover.

The capture now records the exposure times (the Cloudflare record's
creation time, the consolidated production platform app's release
creation time and the probe app's release creation time) and the checker
decides a second gate, `fly.spend-bound-ordering`:

- the bound read back **before** the exposure → the order holds;
- the bound read back **after** the exposure → the order was not met, and
  the gate fails until the deviation is accepted;
- an exposure with no readable time → the order cannot be proven, and the
  gate fails against the capture.

Because the order cannot be un-violated, the closure path is a recorded
acceptance: the `flySpendOrderingDeviation` operator slot carries the
same value-free shape as every other read-back (a boolean, a time, a
pointer to the acceptance and the exposed surfaces it covers — every
production hostname, the production health-probe app and the consolidated
production platform app, which serves all three production API hostnames
and is publicly reachable before any DNS record exists). **Tom accepted
the deviation on 2026-11-18; §8 records the acceptance.** The repository
does not record a human decision on anyone's behalf before it is made.

**Read-back artifact:** `docs/cloud/production-provisioning-readback.md`
(this section; `readBackAt=2026-11-17T07:38:00.000Z`). The exposure
timestamps above were read live from Cloudflare and Fly on 2026-11-17
(06:30Z).

---

## 7. Neon Free-tier connectivity-control acceptance (AC2, slot `neonFreeTierIsolationAcceptance`) — RECORDED

Tom decided on **2026-11-18 at 07:28 NZDT** (`2026-11-17T18:28:00Z`) to
keep the Neon organisation on the **Free** plan. IP Allow is a paid-plan
feature on this provider, so no honest evidence can claim a non-empty
allowlist on this account. The accepted replacement control is named
`schema-scoped-service-roles`:

- the production branch has exactly one write-capable login role for each
  production schema;
- each role is confined to its own schema and has no cross-schema grants;
- the staging and dev credentials are both refused against the production
  branch; and
- the production branch, all three production schemas, and both refused
  credential kinds are named by the acceptance record.

The facts are not inferred from the decision. The role inventory and
schema scoping are live provider/read-back evidence; the staging/dev
refusals are in §1; and Tom's decision selects that mechanism as AC2's
control. The provisioning checker therefore decides
`neon.connectivity-restriction` from all three facts:

- one service role per production schema is present;
- the staging/dev denial proof is recorded against every required surface;
- the acceptance is recorded with the exact `schema-scoped-service-roles`
  control and every required surface.

On Neon Free, `neon.ip-allowlist`, `neon.ip-allowlist-source` and
`neon.ip-allowlist-match` are then reported **not applicable**. That is
not a green claim that an allowlist exists: it says the abandoned IP
mechanism is not the selected control. A Free-plan artifact without the
complete acceptance still fails closed.

Quinn allocated an app-scoped Fly egress pair for each production app on
2026-11-18 (operator read-back recorded in the task thread, before the plan
decision was settled). Those addresses are no longer needed
for AC2's allowlist path. If neither app uses app-scoped static egress for
another purpose, they are a cleanup candidate; this follow-up does not
deallocate them without an explicit operator decision.

**Acceptance artifact:**

```json
{
  "recorded": true,
  "readBackAt": "2026-11-17T18:28:00.000Z",
  "scope": "Tom decision to remain on Neon Free and accept schema-scoped service-role isolation as the AC2 connectivity control",
  "control": "schema-scoped-service-roles",
  "evidenceRef": "docs/cloud/production-provisioning-readback.md",
  "targets": [
    "production",
    "tasks_api",
    "budget_api",
    "content_scheduler",
    "staging",
    "dev"
  ]
}
```

---

## 8. Retroactive spend-bound ordering acceptance (AC5, slot `flySpendOrderingDeviation`) — RECORDED

Tom explicitly accepted the ordering deviation on **2026-11-18 at 07:28
NZDT** (`2026-11-17T18:28:00Z`): the capped Fly billing card was read back
after production became publicly exposed, and no rollback is requested.
The dedicated capped card is the external financial control that replaces
the unavailable Fly-native spend-limit API.

The acceptance covers every exposed surface:

- `tasks-api.sindustries.co.nz`;
- `budget-api.sindustries.co.nz`;
- `content-scheduler-api.sindustries.co.nz`;
- `health-probe.sindustries.co.nz`;
- `sindustries-health-probe-production`; and
- `sindustries-platform-production` (the consolidated app that serves all
  three production API hostnames and is publicly reachable before DNS is
  published).

The checker does not rewrite the chronology. It continues to report that
the bound was read back **after** exposure; the recorded acceptance is the
closure path for that irreversible ordering deviation. The artifact is
value-free and points here for inspection.

**Acceptance artifact:**

```json
{
  "recorded": true,
  "readBackAt": "2026-11-17T18:28:00.000Z",
  "scope": "Tom acceptance of the retroactive spend-bound ordering using a dedicated capped card as the external financial control",
  "evidenceRef": "docs/cloud/production-provisioning-readback.md",
  "targets": [
    "tasks-api.sindustries.co.nz",
    "budget-api.sindustries.co.nz",
    "content-scheduler-api.sindustries.co.nz",
    "health-probe.sindustries.co.nz",
    "sindustries-health-probe-production",
    "sindustries-platform-production"
  ]
}
```

---

## 9. Recording the read-backs in the artifact

The read-backs above are this file's content. The **checker** does not
read this file directly: it reads the `operatorEvidence` section of the
captured artifact, and it compares a recorded slot against the production
surfaces that slot must cover. The committed record at
`infra/cloud/evidence/production-operator-evidence.json` now carries the
four read-backs in §1–§4, the spend-bound read-back in §6, and Tom's two
decision records in §7–§8, so a normal capture closes those obligations
without a manual flag.

The `readBackAt` time for those four slots is
**2026-11-16T10:31:58.000Z** — the author time of Quinn's operator-record
commit `9c2c2e8d`, when the read-back was written down. It is
deliberately the recording time, not a reconstructed observation time;
the observations themselves are the text above. The spend slot in §6
carries its own later read-back time.

The repository owns the shape of that record, so nobody has to guess it:

```bash
# 1. print the blank record, with every slot's surfaces pre-filled
node infra/cloud/scripts/print-operator-evidence-template.mjs --out operator-evidence.json

# 2. fill in each slot: readBackAt (ISO-8601), scope, evidenceRef
#    (a POINTER to the read-back, never its value) and recorded: true.
#    The pointer must be a repository-relative path to a file that EXISTS
#    in the repository — a path that names nothing is refused.
#    The targets are already correct — do not edit them.

# 3. merge the record into the artifact
#    (the committed infra/cloud/evidence/production-operator-evidence.json
#    is loaded automatically; use --operator-evidence only for a one-off
#    capture against a different record)
node infra/cloud/scripts/capture-production-provisioning-state.mjs \
  --out production-provisioning-state.json

# 4. decide the gates
node tests/cloud/scripts/check-production-provisioning-state.mjs production-provisioning-state.json
```

Where each read-back lives, and what to record:

Every pointer below names this file, which is where the read-back lives.
The pointer is resolved against the repository checkout, so a path that
names no existing file is refused rather than accepted as an attestation
nobody could inspect.

| Slot | Read-back | `evidenceRef` |
| --- | --- | --- |
| `neonSeparationDenialProof` | §1 | `docs/cloud/production-provisioning-readback.md` |
| `productionProbeInterval` | §2 | `docs/cloud/production-provisioning-readback.md` |
| `productionApiHealthResponses` | §3 | `docs/cloud/production-provisioning-readback.md` |
| `dnsResolutionAndTlsReadback` | §4 | `docs/cloud/production-provisioning-readback.md` |
| `flySpendLimit` | §6 — capped card confirmed 2026-11-17 20:38 NZDT | `docs/cloud/production-provisioning-readback.md` |
| `neonFreeTierIsolationAcceptance` | §7 — Tom's Free-tier control decision, 2026-11-18 07:28 NZDT | `docs/cloud/production-provisioning-readback.md` |
| `flySpendOrderingDeviation` | §8 — Tom's spend-order deviation acceptance, 2026-11-18 07:28 NZDT | `docs/cloud/production-provisioning-readback.md` |

All six slots above are recorded in the committed operator-evidence file.
The two decision slots name the exact control or exposed surfaces they
cover, so the repository can distinguish Tom's accepted deviation from a
claim that the original ordering held.

The spend-bound record carries the approved `control`, the production app
scope target, and the repository-relative pointer to this read-back. The
Neon record carries the `schema-scoped-service-roles` control and the
production branch, every production schema, and both refused credential
kinds.
