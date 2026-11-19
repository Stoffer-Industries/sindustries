# Production cloud cutover — execution record

**Task:** `020f423e-a18d-4435-98cb-664b655f675b`
**Window:** <date and window, e.g. 2026-11-22 19:00–21:00 NZDT>
**Run id:** `<run id>`
**Manifest:** `<path to the manifest used>`
**Manifest sha256:** `<digest>`
**Operator:** <name>
**Engineering on call:** <name>
**GO/ABORT authority:** Tom

Copy this template to `docs/infra/production-cloud-cutover-<YYYY-MM-DD>.md` and fill it in as the window runs. The record is the human-facing half of the evidence; the machine evidence is the artifact bundle under `artifacts/cutover/<run-id>/` and the workflow artifact.

Everything in this record is redacted. A token, a DSN or a domain payload must never appear here — the harness redacts on the way in, and this document is pasted into task comments on a public repository.

---

## 1. Prerequisites

| Prerequisite | Met | Evidence |
|---|---|---|
| `2850c5ac` (staging) accepted | ☐ | |
| `4b3d6e9c` (observability) accepted | ☐ | |
| `f2c23e26` (production data) accepted | ☐ | |
| Data-migration handoff confirmed complete | ☐ | |
| Cloud + prodlike on a schema-compatible commit | ☐ | |
| Cloud services / DB / Redis / worker / dashboards green | ☐ | |
| Prodlike fallback healthy **on the canonical cloud data plane** | ☐ | |
| Worker leadership unambiguous (one active fleet) | ☐ | |
| Latest production backup + restore test + recovery point recorded | ☐ | |
| Route inventory matches the manifest; no unrelated drift | ☐ | |
| Auth / CORS / callback URLs / integrations pass pre-cutover checks | ☐ | |
| Synthetic probe credentials present in the secret runner | ☐ | |
| Operators, channel, observation duration and thresholds set | ☐ | |
| No deploy / migration / secret rotation / competing cutover in flight | ☐ | |
| **Fresh passing rollback rehearsal** | ☐ | |

Preflight result: <path to `preflight*.json`>
Preflight verdict: <PASS / FAIL>

---

## 2. Decision

| | |
|---|---|
| Tom's GO | <timestamp, channel> |
| Window opened at | |
| Window closed at | |
| Outcome | <completed / rolled back / aborted> |

---

## 3. Route states

| Phase | Binding | Route version (before → after) | Samples | Failures | Verdict | Evidence |
|---|---|---|---|---|---|---|
| baseline | prodlike | | | | | |
| canary | production | | | | | |
| partial | production | | | | | |
| majority | production | | | | | |
| cloud_active | production | | | | | |
| observing | production | | | | | |
| acceptance_pending | production | | | | | |

**Prodlike read-back before:** <which in-scope surfaces targeted prodlike>
**Prodlike read-back after:** <which in-scope surfaces still target prodlike — must be only the declared `rollbackSurface` surfaces>

---

## 4. Observation period (AC3)

| Signal | Threshold | Observed | Verdict |
|---|---|---|---|
| Probe failure count | | | |
| Error rate | | | |
| p95 latency | | | |
| Active alerts | | | |
| Database / replica lag | | | |
| Redis / queue health | | | |
| Worker leadership | | | |

Unplanned interruption observed: <none, or what>
Authentic Tasks / Content Scheduler / Budget transactions: <verdict>

---

## 5. Rollback (if any)

| | |
|---|---|
| Triggered at | |
| Reason | |
| Mode | <runtime rollback / data-layer recovery / pre-write abort> |
| Route version before → after | |
| Recovery confirmed at | |
| Cloud deployment left intact for diagnosis | ☐ |

Data-layer recovery required: <yes / no — if yes, the recovery point and the second go/no-go>

---

## 6. Local fallback (AC5)

| | |
|---|---|
| Prodlike deployment still warm and healthy | ☐ |
| Prodlike on the canonical cloud data plane | ☐ |
| Immutable build/config references retained | ☐ |
| Isolated restore-from-backup boot proven | ☐ |
| Evidence path | |

**Prodlike is NOT decommissioned by this window.** It remains the rollback source until Tom records acceptance of the observation period.

---

## 7. Blockers and deviations

<Anything that did not go to plan, every deviation from the runbook, and how it was resolved.>

---

## 8. Acceptance

| | |
|---|---|
| Observation period accepted by Tom | <timestamp / pending> |
| Acceptance recorded against the task | |
| Prodlike decommissioning | **not performed** — a later, explicit operation with its own approval |
| Historical evidence and rollback record preserved | ☐ |
