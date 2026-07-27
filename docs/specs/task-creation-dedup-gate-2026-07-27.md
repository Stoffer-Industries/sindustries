# Spec — Task Creation Dedup Gate

## Source
- **Reference:** Telegram 2026-07-27 22:42 (Tom, conversation `app-tasks`)
- **Topic:** `app-tasks`
- **Spec Type:** `infra workflow`
- **Systems:** `agents/skills/ops/tasks-create/SKILL.md`, `agents/skills/product/feature-task-create/SKILL.md`, bookmark pipeline, spec-from-conversation workflow
- **Previous revision:** _none_
- **Created:** 2026-07-27

**Status:** Draft
- [ ] **Approved by Tom**

---

## Outcome

Before any task is created — by any path (Quinn's `tasks-create`, Rowan's `feature-task-create`, the bookmark pipeline, the spec-from-conversation workflow) — a similarity check runs against existing open and recently-closed tasks. If a candidate match is found, the creator is shown the candidate and must choose one of: link to the existing task, mark the new request as a duplicate of the existing, or proceed with a new task anyway. The choice is recorded so the dedup decision is auditable.

## Why

Two tasks covering the same outcome were created within 24 hours of each other (6a5783a7 on 2026-07-19 morning and f170e344 on 2026-07-20 afternoon) from two different spec-creation paths that both surfaced the same post-merge analytics need. Result: Rowan worked two parallel tasks for ~a week, the narrower 3-AC spec got shipped first into `doing`, and the broader 5-AC spec got shipped second into `acceptance`. The backlog now shows two near-duplicate tasks with overlapping scope and no record of who decided to keep both. The bottleneck is the task-creation step having no dedup gate — the agent producing a new task has no way to see "a similar task already exists, do you want to merge?"

## Acceptance Criteria

- [ ] AC1: Before any task is created (all paths), a similarity check runs against existing open tasks and tasks closed within the last 14 days. The check surfaces candidate matches with a similarity score and a one-line reason per match (e.g., "title overlap 0.82", "same spec topic", "same tags").
- [ ] AC2: When zero candidates are found, the task is created as today — no behavior change, no extra prompt.
- [ ] AC3: When one or more candidates are found, the creator must explicitly choose one of: (a) link to an existing task and skip creation, (b) mark the new request as a duplicate and skip creation, or (c) proceed with creating a new task anyway. The choice is recorded as a task comment on the affected task(s) so the decision is auditable.
- [ ] AC4: The dedup check is shared across all task-creation paths (Quinn's `tasks-create`, Rowan's `feature-task-create`, bookmark pipeline, spec-from-conversation) — adding a dedup gate to one path does not silently bypass a parallel task being created from another path.
- [ ] AC5: A one-off backfill run reports the known duplicate pair (6a5783a7 and f170e344) as already-duplicate, identifies the narrower task as the keep target, and proposes closing the broader task with a reference comment. The proposal is surfaced to Tom for one-time approval rather than auto-applied.
- [ ] AC6: The dedup check is observable: the number of times it fires per week, the percentage of creations that had a candidate match, and the percentage where the creator proceeded-with-new-anyway are surfaced on the flow dashboard.

## Non-Goals

- Auto-merge or auto-close of duplicates without explicit creator approval — the check surfaces candidates, the human decides.
- Cross-type dedup (e.g., flagging a feature task as a duplicate of a code task). Dedup is same-type only.
- Re-running the dedup check retroactively across all historical closed tasks — only the most recent is surfaced in the backfill (AC5).
- Real-time fuzzy matching against tasks being created in parallel in the same heartbeat — the check is a pre-creation gate, not a transactional lock.

## Notes

The two currently-duplicate tasks (6a5783a7 narrow, f170e344 broad) are the canonical example: the narrow one is the keep target because it shipped first and its scope is a subset of the broad one. The dedup gate should not be designed to *prevent* this kind of superset-vs-subset work — superset work is legitimate when the subset is already in place. The gate's job is to make the creator aware that the work exists and require an explicit decision to proceed.
