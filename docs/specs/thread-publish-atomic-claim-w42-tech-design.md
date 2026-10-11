---
status: draft
task_id: 39667e62-3d23-41d6-87d8-20511ff07091
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Atomic thread publishing claim and attempt

## Intent and scope

Task: **Make thread publish claim and journal creation atomic**. Source: `docs/repo-audits/2026-W42.md`, F2. A failure creating the attempt must not leave the item claimed as `publishing` with no journal. This is a bounded database-correctness repair, not approval to change public publishing behavior or recover existing ambiguous posts automatically.

Repository: `Stoffer-Industries/sindustries`. Draft branch: `code-garden/sindustries/2026-W42`; audit worktree: `/Volumes/WD1/worktrees/quinn/repo-audit-2026-W42`. Implementation must use a separate task branch/worktree. This audit supplies the draft design only.

## Ownership and boundaries

Natural source of truth: Content Scheduler's database-backed item/attempt state. Its existing Prisma models own both records; a local database transaction is the durable solution and costs less than a compensating repair job. Tasks API, browser state and worker-local locks must not become alternative owners. No `.openclaw`, cron, skill, external credential, cross-service API or schema migration changes are proposed.

## Proposed implementation

1. Modify `claimItem` in `services/content-scheduler-api/src/routes/contentSchedulerThreadPublish.ts` to run `updateMany(where: {id, status: 'approved'})` and `contentSchedulerPublishAttempt.create` on one Prisma interactive transaction client.
2. A zero-row conditional update returns the existing losing-claim result without creating an attempt. Attempt creation failure rejects the transaction and rolls back the item update.
3. Return the attempt ID only after successful commit. Keep the complete X publish loop and all network calls outside the transaction.
4. Preserve current published/idempotent, in-progress and cleanup-required responses. If additional handling of the rejected transaction is needed at the HTTP boundary, retain the existing sanitized error contract; do not pretend a failure was a successful publish.
5. Adapt injected Prisma test doubles to represent transactions, but verify rollback and competing updates against an isolated real PostgreSQL database as well. Update the existing content-publishing system reference to state the local claim/journal invariant.

No field or public API shape changes. This closes only the avoidable **pre-X** local failure window. A process crash after claim commit, or after X accepts a tweet before journal persistence, remains a separate recovery design problem. Do not claim exactly-once external delivery or add automatic resets of `publishing` rows.

## Verification matrix

| Task criterion | Planned evidence |
| --- | --- |
| AC1: attempt insertion failure rolls back to approved and makes zero X calls | Inject attempt failure inside the transaction, assert item state and zero attempt rows after rollback; assert fake X client was not invoked. Include a real-DB rollback case. |
| AC2: concurrent claims commit exactly one attempt/winner | Two independent transactions/clients target the same approved item; assert one result wins, one receives existing in-progress handling, one attempt persists. |
| AC3: DB coverage and preserved compensation/retry | Dedicated isolated Postgres suite plus existing thread-publish compensation, retry and normal successful-publish tests. |

Browser E2E cannot reliably induce this DB timing window; transaction integration is the required verification layer. External X is always mocked; no live publishing or deletion during tests. Never use shared prodlike fixtures or destructive resets against a shared database.

## Risks, rollback and review

Review transaction isolation and concurrent conditional-update behavior with real Postgres rather than assuming mock behavior proves it. Keep the transaction short and network-free. Existing mocks may need a transaction-client adapter. No migration means implementation rollback is a normal code revert. Existing stranded rows require separate evidence-based operator recovery; this task does not authorize touching them. Obtain normal technical review before implementation; this draft is not a structured approval.
