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

**Record semantics on a resolution failure (stated once, so AC1 and AC4 cannot disagree):**

- No page/incident record **claiming an escalation was raised or sent** is written. Nothing in the incident state may read as delivered, attempted-as-sent, or raised.
- A **failure receipt** *is* written: `delivery: no-target`, naming the unresolved field (`target`, `channel`, `account`, or the config file itself), plus the page `page_id` and the timestamp. A failure receipt is a record of a failed send, not a record of an escalation.
- The helper exits non-zero in both cases, so a run that could not resolve a target never looks like a clean run.
- No page is ever "attempted" without a resolved target tuple.
- The resolution result is carried, not re-derived, into the send. A send that cannot show its target tuple is invalid by construction.

The repository already documents the intended chain in `agents/skills/ops/notify-soft-fail/SKILL.md` (cron → `sessions_send` → Lox → Telegram DM to Tom). That chain currently exists as prose with the target id inline; the design makes the target an explicit, checked artifact rather than a convention someone can forget.

### 1a. The source of truth for the target tuple

The tuple is resolved from **one runtime-owned artifact**, not from prose and not from a constant in the helper's code.

**Artifact** — `~/.openclaw/agents/<agent>/agent/page-targets.json`, one file per agent (for Lox: `~/.openclaw/agents/lox/agent/page-targets.json`):

```json
{
  "version": 1,
  "pages": {
    "default": {
      "channel": "telegram",
      "account": "lox",
      "target": "6435140143"
    }
  }
}
```

- **Format:** JSON, with a `version` and a `pages` map keyed by page name. Each entry carries exactly the three fields `channel`, `account`, `target`.
- **Who edits it:** the agent's owner (Quinn, as chief of staff), by hand, in response to a verified config change or an instruction from Tom. The runtime never writes it at send time and no automated process edits it.
- **Where it lives:** outside the repository, mode `0600`. The `target` value is not a secret — it is already published in this repository (`agents/skills/ops/notify-soft-fail/SKILL.md`, `agents/definitions/lox/HEARTBEAT.md`) — but the file is the machine-readable single source of truth and the repo-side prose is its human-readable mirror.
- **How the helper reads it:** the helper loads the file at call time, selects the requested page entry (`default` unless a caller names another), and validates that `channel`, `account` and `target` are present and non-empty. A missing file, a missing entry or an empty field is a **resolution failure**, reported as `delivery: no-target` naming the unresolved field (`file`, `entry`, `channel`, `account`, `target`).
- **No hardcoded fallback in the helper.** If the helper carried its own copy of the target, a missing or broken file would resolve anyway and the whole resolution step would be decorative. The helper fails closed instead.
- **Drift guard:** the helper's dry-run mode compares the runtime file against the tuple documented in `agents/skills/ops/notify-soft-fail/SKILL.md` and fails closed when they disagree. The two must not drift.

### 2. Two-channel delivery ladder with a recorded fallback

| Order | Channel | Path | When it is used |
|---|---|---|---|
| 1 | `session-page` | the heartbeat's own page path (wake/announce into the target session) | always attempted first, after target resolution |
| 2 | `telegram/dm` | direct message to Tom's DM (the path that delivered #1250) | whenever channel 1 does not return a positive receipt, or resolves no target |

Rules:

- A channel is "successful" only on a positive receipt (`ok:true` plus the destination identifier), never on "the transport returned".
- If channel 1 fails, channel 2 is attempted in the same pass. A page is not left "queued for someone else" when a second path exists.
- The channel that delivered is recorded (`channel: session-page|telegram/dm`), never inferred.
- If **both** channels fail, the incident note records `delivery: failed` with both receipts and the run exits non-zero. It is never recorded as sent, and the escalation is handed to the **next operational path** below, which does not depend on the messaging transport that just failed.

**The next operational path (named, not "escalated through the next operational path").** When both channels fail, the page-raising agent escalates through the **Tasks API attention-owner route**: a reason-bearing reconcile that sets `attentionOwners: ["Tom"]` on the task the page belongs to, per `agents/skills/ops/attention-owner-routing/SKILL.md`. The reason states the concrete blocker (both channels failed, with both receipts), the next action (Tom reads the incident and decides) and why Tom is needed now (a page that reached neither channel is an escalation nobody has seen). The page `page_id` and both receipts are recorded as a task comment alongside it.

- **Owner:** the agent that raised the page performs the escalation — it is the only actor holding the receipts and the `page_id`.
- **Why this route:** it is durable and does not travel over the Telegram or session transports that just failed, and it surfaces in Tom's task queue.
- **No task in scope:** the same content (`page_id`, both receipts, the concrete ask) is written to the raising agent's incident-state file with `needsTom: true` and `escalatedAt` set, so the incident queue surfaces it.
- Tom is added to `attentionOwners` here **only** because a specific action of his is required now — reading an escalation that reached no channel. It is not added because "the gate is complete".

### 3. Receipt contract (the record that makes the next heartbeat able to tell)

Every recorded page carries, as data:

```
delivery: ok | no-target | failed
channel:  session-page | telegram/dm
receipt:  <message id>            # required when delivery=ok
chatId:   <destination id>        # required when delivery=ok
target:   <resolved channel/account/target tuple>
page_id:  <unique id for this page>   # required on every record
attempted_at: <ISO timestamp>
```

- `delivery != ok` may never be written into an incident note in a form that reads as "raised" or "sent". The note must carry the failure state and the receipts that caused it.
- A page recorded as `delivery: ok` without a `receipt` is invalid — the recorder rejects it.
- Every page carries a `page_id` — a unique id for that page (for example `pg-<UTC timestamp>-<short random suffix>`) — embedded in the page body as well as in the record. It is what makes the leg-level check in §4 unambiguous.

### 4. Leg-level failure classification (do not blindly retry)

Before retrying a transport failure, classify which leg failed:

- **Content leg failed** (the target session does not contain the message body): the page genuinely did not land → retry through the fallback ladder.
- **Announcement leg failed** (the body is verifiably present in the target session, only the return/notification failed): the page landed → do **not** resend the content; record the transport failure as `announce_failed` and move on.

The check is a read of the target session, not an inference — and it is **unambiguous**, which requires two rules:

1. **Match on the page id, not on body text.** The session is searched for the page's unique `page_id` (§3), not for the body string. Two pages with identical wording (the same condition, the same threshold text, a retried escalation) are then distinguishable.
2. **Scope the match to this attempt.** Only messages **newer than this send attempt's `attempted_at`** count as evidence. A match on an older page — same wording, different `page_id` — is not evidence that this attempt landed and must not suppress the resend. If the search returns a match whose `page_id` is not this page's, the content leg is treated as **failed** and the ladder continues.

A leg check that can match an older page is worse than no leg check: it converts a lost escalation into a recorded success. That is the failure class this design exists to remove, so the uniqueness rule is part of the contract, not a refinement of it.

This is the rule Quinn had to apply manually on 2026-11-12; the design makes it mechanical so a future heartbeat does not have to guess.

### 5. Fail loudly

The failure modes above must be observable to a human without reading logs:

- No target resolved → non-zero exit **and** an explicit error record in the incident state.
- Both channels failed → non-zero exit **and** an explicit error record with both receipts **and** the next operational path taken (§2).
- An incident note claiming a page was raised may only be written after a positive receipt exists.

## Acceptance criteria mapping

| AC | Design element | What proves it |
|---|---|---|
| AC1 (resolve a target first; fail loudly instead of recording an unsent page) | §1, §1a, §5 | Test: target resolution fails → **no record claiming the page was raised or sent exists**, a `delivery: no-target` failure receipt naming the unresolved field exists, and the run exits non-zero |
| AC2 (fallback to the direct message channel; record which channel delivered) | §2 | Test: primary path returns a negative/no-target receipt → fallback channel is used and the record names it |
| AC3 (every recorded page carries channel + receipt) | §3 | Test: recorder rejects a page record with `delivery: ok` and no receipt |
| AC4 (a test exercises the no-target path) | §1, §1a, §2 | A dedicated test asserts: no page is recorded as sent **and** the fallback channel is used instead. The same test asserts the failure receipt names the unresolved field, and that a helper with a missing or empty target file resolves nothing rather than falling back to a hardcoded target |

## Test plan

1. **No-target path (AC4).** Point the helper at a target file whose `target` field is empty. Assert: no record claiming the page was raised or sent is written; a `delivery: no-target` failure receipt naming `target` is written; the run exits non-zero; the fallback channel is invoked; the final record names the fallback channel and its receipt.
2. **Fallback-on-negative-receipt.** Stub the primary path to return `delivery=no-target`. Assert the fallback is used and the recorded channel is the fallback, not the primary.
3. **Receipt required.** Attempt to record a page with `delivery: ok` and no receipt. Assert it is rejected.
4. **Both channels fail.** Assert a non-zero exit, `delivery: failed`, both receipts present, and no "raised"/"sent" wording in the incident note.
5. **Leg classification.** Simulate the 2026-11-12 case — transport reports failure while the target session contains the body. Assert the content is **not** resent and the record says `announce_failed`.
6. **Leg check uniqueness.** Two pages with byte-identical bodies, the first delivered earlier. Simulate the second attempt reporting failure. Assert the leg check matches on `page_id` and on messages newer than the second attempt's `attempted_at`, does **not** match the first page, and therefore resends — the older page must not be able to suppress a needed resend.
7. **Both-channels-failed path.** Assert the next operational path is taken: a reason-bearing Tasks API attention-owner reconcile to `["Tom"]` with the `page_id` and both receipts recorded, and no "raised"/"sent" wording anywhere in the incident record.
8. **No hardcoded target.** Delete the target file and assert the helper resolves nothing (no built-in fallback) and fails closed.
9. **Regression guard.** A test that asserts the heartbeat page path cannot be invoked without a resolved target tuple.

## Scope

In scope:

- The target-resolution step and its failure semantics.
- The two-channel delivery ladder and the receipt contract.
- The leg-level failure classification used before any retry.
- Tests for each of the nine cases above.
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
