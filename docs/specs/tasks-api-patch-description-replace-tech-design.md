---
status: draft
task_id: 2cee0bcd-1976-4569-86d1-907f05515c6f
product_spec: brain/bookmarks/specs/feature-factory-v2-2026-06-04.md
shipped_pr: null
shipped_date: null
---

# Tasks API Patch Description Replace — Tech Design

## Links

- Task: `2cee0bcd-1976-4569-86d1-907f05515c6f` (`🔧 🐛 tasks_api_client.py patch --description appends instead of replacing`)
- Task API detail: `http://localhost:4001/api/v1/tasks/2cee0bcd-1976-4569-86d1-907f05515c6f`

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-2cee0bcd-patch-description-replace`
- Worktree: `~/workspaces/rowan/sindustries`
- Primary code surface: `agents/skills/ops/tasks-api/tasks_api_client.py` (single function: `cmd_patch`)

No `.openclaw` runtime change. No API change. No data migration. The Tasks API already does partial-PATCH correctly; the bug is purely in the client wrapper.

## Product Summary

`tasks_api_client.py patch --description "..."` currently reads the existing task, then sends `{existing}\n\n{new}` as the description — three successive patches tripled the description, as observed on task `44f5ed65` this morning. The Tasks API itself does a partial-PATCH and stores whatever description string it receives (`updates.description = description || null` in `services/tasks-api/src/routes/tasks.ts`), so the API behaviour is correct. The fix is to drop the append branch in the client and pass the value through directly.

This makes the client consistent with how every other field (`title`, `priority`, `status`, `assignee`, `tags`, `blocked`, `ready`) already behaves — replace, not concatenate.

## Implementation Plan

### 1. Drop the description-append branch in `cmd_patch`

Replace the current block:

```python
# Handle description: append to existing instead of replacing
if args.description is not None:
    try:
        current = get_task(args.id, base_url=base)
        existing = (current.get("description") or "") if current else ""
        if existing:
            payload["description"] = f"{existing}\n\n{args.description}"
        else:
            payload["description"] = args.description
    except Exception:
        payload["description"] = args.description
```

with:

```python
if args.description is not None:
    payload["description"] = args.description
```

The Tasks API already handles partial-PATCH (it only updates fields whose keys are present in the request body), so no other change is required.

### 2. Tests

Add tests in `agents/skills/ops/tasks-api/tests/test_tasks_api_client.py` (or a new test file if that file is for a different concern):

- `patch_description_replaces_existing` — mock the API client; assert a single `patch --description "new"` call sets `payload["description"] = "new"` (no fetch of current description, no concatenation).
- `patch_description_called_twice_stores_only_second` — mock API state across two calls; assert the second value is what's stored (covered by replacing behaviour plus the API's partial-PATCH).
- `patch_other_fields_unaffected_by_description_change` — call `patch --status foo --priority bar`; assert no `description` key is added to the payload.

The existing test suite uses `urllib` mocks — follow the same pattern.

## Test Plan

- `PYTHONPATH=agents/skills/tasks-api-ops python3 -m unittest discover -s agents/skills/ops/tasks-api/tests -p 'test_*.py'` — all existing tests pass + new tests pass.
- Manual smoke:
  - create a task with description `"a"`
  - `tasks_api_client.py patch --id <id> --description "b"` → stored value is `"b"` (not `"a\n\nb"`)
  - `tasks_api_client.py patch --id <id> --description "c"` → stored value is `"c"` (not `"a\n\nb\n\nc"`)

## Open Questions and Risks

- None blocking. The change is a behavioural correction that aligns `--description` with every other field's semantics. The Tasks API already expects and stores whatever description string it receives.
- A side-effect of the fix: anyone who was relying on the append behaviour (likely nobody, given the bug reports) will need to switch to explicit fetch-then-patch workflows. No such callers were observed in the workspace.