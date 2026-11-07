# Model Routing Contract

> Which model runs which kind of work, and how a pass with nothing to do costs nothing.

**Last reviewed:** 2026-11-06
**Owner:** Quinn (chief of staff)
**Audience:** Tom — "which model does X run on?" has exactly one answer, and it is here
**Spec:** `brain/tasks/specs/in-progress/three-tier-model-routing-contract-with-empty-queue-preflight-f73dace927772ddb.md`
**Task:** `d38c6aa5` (Three-Tier Model Routing Contract With Empty-Queue Preflight)
**Code:** `agents/lib/routing_contract.py`, `agents/cron/routing_preflight.py`

---

## Architecture and ownership

The contract has two halves that must agree:

| Half | Where | Owner | What it holds |
| --- | --- | --- | --- |
| Written contract | this document | Quinn | The tier table, the work categories, the rules, the operator surface |
| Machine-readable contract | `agents/lib/routing_contract.py` | Quinn | The same tiers and categories as data, plus the preflight decision and the counters |
| Preflight entry point | `agents/cron/routing_preflight.py` | Quinn | The command a scheduler or an agent runs to get a routing decision |

Nothing else in the stack decides model tiers. Per-call hand-tuning is what this
contract replaces: when a category's tier changes, it changes here, in one
place, and every caller picks it up.

**Why a new document.** `docs/systems/agent-orchestration.md` maps how work
flows *between agents*; `docs/systems/observability.md` covers OTel metrics;
`docs/systems/model-evals.md` covers scoring models. None of them answers
"which tier runs this category of work", and the spec's AC1 requires a single
written routing contract. This document is that contract and stays authoritative
as the tier table changes.

### The three tiers

| Tier | Model class | Models in use | Work that belongs here |
| --- | --- | --- | --- |
| `routine` | cheap-fast | `minimax-portal/MiniMax-M3`, `minimax-portal/MiniMax-M3.1-Flash`, `ollama/<local>` | Scanning, summaries, low-risk review, background cognition, heartbeat passes |
| `mid` | coding-standard | `anthropic/claude-sonnet-5` | Approved coding work, code review, spec drafting, test/verify passes, ops documentation |
| `frontier` | high-judgment | `openai/gpt-5.4`, `openai/gpt-5.6-sol`, `anthropic/claude-opus-*` | Planning, escalation, product decisions, high-judgment review, final acceptance support |

`preflight` is not a model tier. It is the "nothing to do" outcome: a pass that
lands there invokes **no model at all** and pays no tokens.

### Work categories

| Work category | Tier |
| --- | --- |
| `approved-coding` | mid |
| `acceptance` | frontier |
| `background-cognition` | routine |
| `bookmark-triage` | routine |
| `code-review` | mid |
| `daily-brief` | routine |
| `escalation` | frontier |
| `heartbeat-scan` | routine |
| `high-judgment-review` | frontier |
| `low-risk-review` | routine |
| `ops-documentation` | mid |
| `planning` | frontier |
| `product-decision` | frontier |
| `queue-monitor` | routine |
| `routine-summary` | routine |
| `spec-drafting` | mid |
| `test-and-verify` | mid |

A category that is not in this table routes to `frontier` and is flagged
`unclassified`. Unknown work is never silently downgraded to the cheap tier —
that is the specific failure the contract exists to prevent.

---

## Runtime behaviour and operational flow

### The preflight

Every scheduled pass that could cost a model call starts with the preflight:

1. **Fetch the queue.** The shared read-only queue script
   (`agents/skills/ops/tasks-api/scripts/agent_task_queue.py`) returns the
   agent's task and PR work with one deterministic `topCandidate`.
2. **Classify the queue.** Actionable entries mean there is work; a queue with
   only blocked entries counts as empty.
3. **Decide.**
   - Empty queue → decision `skip`, tier `preflight`, `modelInvoked: false`.
     The pass ends here. No model, no tokens.
   - Queued work → decision `proceed`, tier from the work category, and the
     declared tier is recorded before the model runs.
4. **Record.** Every decision lands in the counter state and the event log.

### Running it

As a scheduler command payload — a shell process on the Gateway host with
**no model call**:

```bash
python3 agents/cron/routing_preflight.py --agent Quinn --category heartbeat-scan
```

- Empty queue → stdout is exactly `NO_REPLY`, so the scheduler's silent-token
  suppression posts nothing to chat. The decision JSON goes to stderr and stays
  in the run history, so the skip is observable rather than silent.
- Queued work → one compact line on stdout, e.g.
  `routing: proceed tier=routine model_class=cheap-fast category=heartbeat-scan work=3 agent=Quinn`.

As the first step of an agent heartbeat — same command, plus the queue payload
the agent needs:

```bash
python3 agents/cron/routing_preflight.py --agent Quinn --category heartbeat-scan --mode heartbeat
```

The payload is the usual queue JSON with one extra key, `routingDecision`, so
the agent's discovery step is unchanged.

### Declaration before invocation

The tier is declared **before** the model runs, and the declaration is stored
next to the invocation record. After the run, the actual model is checked
against the declaration:

```bash
python3 agents/cron/routing_preflight.py --record-actual \
  --agent Quinn --category heartbeat-scan \
  --declared-tier routine --actual-model minimax-portal/MiniMax-M3
```

- Matching tier → `routing: match`.
- Different tier → a **routing violation** is counted and listed. A routine
  category that landed on the frontier tier is recorded, not absorbed.
- No observable model → recorded as `unmeasured`, so it cannot hide either.

### Operator surface

Per-category, per-tier counts for any day:

```bash
python3 agents/cron/routing_preflight.py --stats
```

```
model routing counters — 2026-11-06
category                    routine     mid  frontier  preflight  violation
------------------------------------------------------------------------
heartbeat-scan                  12      0         0         14          0
approved-coding                  0      3         0          0          0
------------------------------------------------------------------------
TOTAL                           12      3         0         14          0
```

`frontier` per category per day is the number that makes a cost collapse
observable: routine cron-style work should show a frontier count of zero.

### Rolling out to other agents

Quinn's heartbeat is wired to the preflight first, as the proving ground for
the wiring. The other agents' `agents/definitions/<agent>/HEARTBEAT.md` files
are wired the same way, one agent at a time, once the first window of live
counters has shown that the preflight behaves:

1. Replace that agent's queue command with the preflight in `--mode heartbeat`
   (one fetch, not two — a second fetch could disagree with the first).
2. Add the `routingDecision` reading rules: `skip` ends the pass, `proceed`
   continues, `PREFLIGHT-UNKNOWN` falls back to the plain queue command.
3. Keep the plain queue command reachable as the fallback. A preflight failure
   must never mute a pass.

An agent whose heartbeat has a mandatory check outside the unified queue —
Quinn's open untyped ops-task query is the current example — keeps that check
even when the preflight reports `skip`, because those tasks sit outside the
queue the preflight reads.

---

## Data contracts, API fields, task comments/tags

### Counter state

`$OPENCLAW_STATE_DIR/model-routing-counters.json` (default
`~/.openclaw/state/model-routing-counters.json`):

```json
{
  "version": 1,
  "updatedAt": "2026-11-06T09:00:00+00:00",
  "days": {
    "2026-11-06": {
      "categories": {
        "heartbeat-scan": {
          "routine": 12, "mid": 0, "frontier": 0,
          "preflight": 14, "violation": 0, "unmeasured": 0
        }
      }
    }
  },
  "violations": []
}
```

Buckets: `routine`, `mid`, `frontier` count invocations per tier;
`preflight` counts skipped passes (no model invoked); `violation` and
`unmeasured` count runs that did not match their declaration. The `violations`
list keeps the 50 most recent entries.

### Event log

`$OPENCLAW_STATE_DIR/model-routing-events.jsonl` — one JSON object per line,
one line per decision. Fields: `at`, `decision`, `tier`, `modelClass`,
`category`, `workCount`, `reason`, `agent`, `modelInvoked`, `unclassified`.

### Task comments

This contract adds no new task comments or tags. Routing decisions live in the
counter state and the event log, not in the Tasks API, because a routing
decision is a runtime fact rather than a workflow gate.

---

## Runbook notes and common failure modes

**The preflight must fail open.** If the queue cannot be fetched, the CLI
prints `PREFLIGHT-UNKNOWN` and exits `0`. An unknown result means "carry on
with the normal procedure" — it must never mean "skip", or a broken queue
fetch would silently mute every agent.

**A skip is not a failure.** `NO_REPLY` on stdout means the queue was empty.
Check the counter state and the event log; do not re-run the pass hoping for
different output.

**Unknown categories are loud.** An `unclassified` flag on a decision means the
work category is missing from the contract table. Add the category to
`CATEGORY_TIERS` in `agents/lib/routing_contract.py` (and to the table above)
rather than letting it sit on `frontier` and quietly burn budget.

**Counters are local runtime state.** They are not in the repository and are
not durable memory. Losing them loses history, not function.

**The `preflight` bucket counts skipped passes, not cheap passes.** A skipped
pass is worth more than a routine-tier pass: it cost nothing at all.

---

## Related specs, tasks, and PRs

- **Spec:** `brain/tasks/specs/in-progress/three-tier-model-routing-contract-with-empty-queue-preflight-f73dace927772ddb.md`
- **Task:** `d38c6aa5`
- **Builds on:** `hybrid-runtime-policy-for-cheap-heartbeats-and-escalated-reasoning-b1371cd53c4c685d` (lane policy) and `claude-effort-and-routing-cadence-for-openclaw-ca5eb158c59ece30` (Claude defaults) — this contract extends both with the preflight tier and the per-category table; it does not redefine them.
- **Related systems:** `docs/systems/agent-orchestration.md`, `docs/systems/observability.md`, `docs/systems/model-evals.md`
