---
status: draft
task_id: 29265d7b-174d-4c70-b79a-bffa641ab83a
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech Design — Resolve a concrete delivery target for heartbeat escalation pages, fall back to Tom's DM, and record the receipt

## Links and scope

- Task: `29265d7b-174d-4c70-b79a-bffa641ab83a` — 💻 Heartbeat escalation pages to Tom report delivery=no-target and are never delivered
- Task type: `code` (`code-task-workflow`)
- Delivery assignee: Lox (unchanged by this design)
- Design author: Quinn (commissioned as position-0 attention owner because the code-task lobster's tech-design gate was unsatisfied and Rowan was at his doing-task limit)
- Repository: `Stoffer-Industries/sindustries` (shared skills and runbooks); the agent-runtime page helper itself lives in the OpenClaw agent runtime, not in this repository
- Originating incident: Lox's 2026-11-12 disk-usage page (#1248) — `delivery=no-target`, never delivered
- Related live failure: Quinn's 2026-11-12 04:59Z `sessions_send` to `agent:lox:main` reported as failed while the message body was verifiably present in the target session (`sessions_search` hit, `role=user`, `messageId ca19e319`) — the announcement leg failed, the content leg succeeded

## Problem statement

The heartbeat escalation path can write a page, record it as attempted, and deliver nothing at all. Nothing in the path distinguishes "the page was handed to a transport" from "the page reached Tom". The incident state therefore asserts that an escalation was raised while Tom never saw it. For a CRITICAL condition (disk at 96% with 8.4GiB free) the entire point of the page is that a human acts on it, so a silent loss converts a detectable outage into an invisible one.

Evidence:

| Page | Path | Receipt | Outcome |
|---|---|---|---|
| #1248 | heartbeat page path (2026-11-12) | `delivery=no-target` | never delivered |
| #1250 | manual message path, same content | `ok:true`, `chatId 6435140143` | delivered |

The two pages used different paths. The manual path worked because it named its target explicitly.

## Root cause

Two independent defects, both in the *delivery* layer, not in the content layer:

1. **No target resolution step.** The heartbeat page path invoked the transport without first resolving a concrete destination (channel + account + target id). The transport accepted the call and returned a `no-target` receipt; the caller treated "the transport returned a receipt" as "the page was sent". The receipt was never checked, so the failure was structurally invisible.
2. **No fallback and no receipt contract.** There is one delivery path. When it cannot deliver, there is no second path, and there is no agreed record of *which* path delivered, *what* the receipt was, and *when* it happened.

A third defect makes the failure worse, and it was already observed on this exact class of transport on 2026-11-12:

3. **Announcement-leg failure is indistinguishable from content-not-received failure.** Quinn's `sessions_send` was reported as failed while the content had in fact arrived in the target session. A naive "retry on failure" rule would have sent a duplicate copy of the escalation; a naive "give up" rule would lose a genuinely undelivered page. The record must say which leg failed.

## Design

### 1. A single target-resolution step, before any send

Every page goes through one helper that resolves a concrete destination tuple — `(channel, account, target)` — from an explicit, checked source of truth before a transport is invoked.

- Resolution fails → the page is **not written and not recorded as sent**. The helper exits non-zero and writes an explicit `delivery: no-target` failure record naming the unresolved field.
- No page is ever "attempted" without a resolved target tuple.
- The resolution result is carried, not re-derived, into the send. A send that cannot show its target tuple is invalid by construction.

The repository already documents the intended chain in `agents/skills/ops/notify-soft-fail/SKILL.md` (cron → `sessions_send` → Lox → Telegram DM to Tom). That chain currently exists as prose with the target id inline; the design makes the target an explicit, checked artifact rather than a convention someone can forget.

### 2. Two-channel delivery ladder with a recorded fallback

| Order | Channel | Path | When it is used |
|---|---|---|---|
| 1 | `session-page` | the heartbeat's own page path (wake/announce into the target session) | always attempted first, after target resolution |
| 2 | `telegram/dm` | direct message to Tom's DM (the path that delivered #1250) | whenever channel 1 does not return a positive receipt, or resolves no target |

Rules:

- A channel is "successful" only on a positive receipt (`ok:true` plus the destination identifier), never on "the transport returned".
- If channel 1 fails, channel 2 is attempted in the same pass. A page is not left "queued for someone else" when a second path exists.
- The channel that delivered is recorded (`channel: session-page|telegram/dm`), never inferred.
- If **both** channels fail, the incident note records `delivery: failed` with both receipts, the page is escalated through the next operational path, and the run exits non-zero. It is never recorded as sent.

### 3. Receipt contract (the record that makes the next heartbeat able to tell)

Every recorded page carries, as data:

```
delivery: ok | no-target | failed
channel:  session-page | telegram/dm
receipt:  <message id>            # required when delivery=ok
chatId:   <destination id>        # required when delivery=ok
target:   <resolved channel/account/target tuple>
attempted_at: <ISO timestamp>
```

- `delivery != ok` may never be written into an incident note in a form that reads as "raised" or "sent". The note must carry the failure state and the receipts that caused it.
- A page recorded as `delivery: ok` without a `receipt` is invalid — the recorder rejects it.

### 4. Leg-level failure classification (do not blindly retry)

Before retrying a transport failure, classify which leg failed:

- **Content leg failed** (the target session does not contain the message body): the page genuinely did not land → retry through the fallback ladder.
- **Announcement leg failed** (the body is verifiably present in the target session, only the return/notification failed): the page landed → do **not** resend the content; record the transport failure as `announce_failed` and move on.

The check is a read of the target session for the exact page body, not an inference. This is the rule Quinn had to apply manually on 2026-11-12; the design makes it mechanical so a future heartbeat does not have to guess.

### 5. Fail loudly

The failure modes above must be observable to a human without reading logs:

- No target resolved → non-zero exit **and** an explicit error record in the incident state.
- Both channels failed → non-zero exit **and** an explicit error record, with both receipts.
- An incident note claiming a page was raised may only be written after a positive receipt exists.

## Acceptance criteria mapping

| AC | Design element | What proves it |
|---|---|---|
| AC1 (resolve a target first; fail loudly instead of recording an unsent page) | §1, §5 | Test: target resolution fails → no page record exists, non-zero exit, explicit error present |
| AC2 (fallback to the direct message channel; record which channel delivered) | §2 | Test: primary path returns a negative/no-target receipt → fallback channel is used and the record names it |
| AC3 (every recorded page carries channel + receipt) | §3 | Test: recorder rejects a page record with `delivery: ok` and no receipt |
| AC4 (a test exercises the no-target path) | §1, §2 | A dedicated test asserts: no page is recorded as sent **and** the fallback channel is used instead |

## Test plan

1. **No-target path (AC4).** Stub the target resolver to resolve nothing. Assert: no page record is written; the run exits non-zero; the fallback channel is invoked; the final record names the fallback channel and its receipt.
2. **Fallback-on-negative-receipt.** Stub the primary path to return `delivery=no-target`. Assert the fallback is used and the recorded channel is the fallback, not the primary.
3. **Receipt required.** Attempt to record a page with `delivery: ok` and no receipt. Assert it is rejected.
4. **Both channels fail.** Assert a non-zero exit, `delivery: failed`, both receipts present, and no "raised"/"sent" wording in the incident note.
5. **Leg classification.** Simulate the 2026-11-12 case — transport reports failure while the target session contains the body. Assert the content is **not** resent and the record says `announce_failed`.
6. **Regression guard.** A test that asserts the heartbeat page path cannot be invoked without a resolved target tuple.

## Scope

In scope:

- The target-resolution step and its failure semantics.
- The two-channel delivery ladder and the receipt contract.
- The leg-level failure classification used before any retry.
- Tests for each of the six cases above.
- Documentation of the machine-readable receipt fields where incidents are written (shared skill/runbook updates in this repository; the runtime helper in the agent runtime).

Out of scope:

- Changing the OpenClaw gateway or the messaging transport's own implementation. This design changes the **calling contract**, not the transport.
- Changing *when* heartbeats escalate (the thresholds and incident policy are unchanged).
- Changing cron scheduling.
- Any content change to pages themselves.

## `.openclaw` boundary notes

- The change touches an OpenClaw runtime delivery path (agent-runtime helper). The normal safety checks apply: the helper only ever sends to the pre-existing, already-published Tom DM target; no new external destination is introduced; no credential is added, moved, or echoed.
- **No secret values in the repository.** The destination identifier used by the existing chain is already present in the public `sindustries` repo (`agents/skills/ops/notify-soft-fail/SKILL.md`); this design adds no new identifiers, no tokens, and no API keys. If a future implementation needs a channel token, it goes to the runtime's secret store and is referenced by name only.
- This design does not change OpenClaw configuration, schedules, or gateway behaviour; it changes what a heartbeat is allowed to call and what it must record.
- Product-behaviour approval: the escalation content and thresholds are unchanged, so no product decision is implied by this design.

## Risks and open questions

1. **Where the helper lives.** The page path is in the agent runtime, not in this repository. The implementation must land in the runtime (or a runtime-owned script), with the shared skill/runbook in this repository updated to document the contract. Risk: a fix that only edits documentation leaves the bug in place. Mitigation: AC4's test must exercise the real call path, not a mock of the helper.
2. **Duplicate-page risk.** The fallback ladder can double-send if a channel actually delivered but reported failure. Mitigation: §4 — the leg check runs before any retry, and the receipt contract distinguishes the two cases.
3. **False "escalated" state.** Incident state is written by several agents. A record written by one agent could claim a page that another agent's failed channel never delivered. Mitigation: only a positive receipt may accompany an "escalated" claim; the recorder is the single choke point.
4. **Open question (implementation-time, non-blocking):** whether the fallback channel should be attempted with the same content verbatim or with a short "(fallback)" prefix. Recommendation: verbatim, because operators dedupe by content.
