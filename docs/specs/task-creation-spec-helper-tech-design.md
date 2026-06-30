---
status: draft
task_id: 8ec03996-77ec-4d48-92e3-ef98a60b1127
product_spec: brain/bookmarks/specs/feature-factory-v2-2026-06-04.md
shipped_pr: null
shipped_date: null
---

# Task Creation Spec Helper — Tech Design

## Links

- Task: `8ec03996-77ec-4d48-92e3-ef98a60b1127` (`🔧 🐛 Task creation skips **Spec:** and **Workstreams** fields in description`)
- Task API detail: `http://localhost:4001/api/v1/tasks/8ec03996-77ec-4d48-92e3-ef98a60b1127`

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-8ec03996-task-creation-spec`
- Worktree: `~/workspaces/rowan/sindustries`
- Primary code surfaces:
  - `agents/skills/ops/tasks-api/tasks_api_client.py` — extend `cmd_create` with `--spec` and `--workstreams` flags, plus a stderr warning when the description lacks a Spec line
  - `agents/skills/product/feature-task-create/SKILL.md` — update Step 4 example to use the new flags

No `.openclaw` runtime change. No Tasks API change. The fix is purely client-side UX.

## Investigation findings

Rowan investigated during the 2026-06-30 session (before this design was written) and confirmed three things:

1. **`tasks_api_client.py cmd_create`** takes `--description` as a free-form string and POSTs whatever the caller provides. There's no template generation and no validation that required lobster fields (`**Spec:**`, `**Workstreams**`) are present.

2. **`agents/skills/product/feature-task-create/SKILL.md`** documents the exact description format in Step 3 — `**Spec:**`, ACs, `**Workstreams**` — and Step 4 shows a hand-composed `urllib` POST. The skill is correct as documentation but it doesn't enforce or simplify the boilerplate. Quinn's task creations from today (`44f5ed65`, `2cee0bcd`, plus earlier ones) frequently omitted these fields because the format requires hand-typing the markdown.

3. **The lobster** hard-blocks at `ready_checks` with `[feature-task-blocked] Task description must include a **Spec:** line` when the field is absent. So the bug is invisible until the task enters the workflow, which is why it surfaces only after creation.

## Fix proposal

Add two flags to `cmd_create` so the description is composable from structured inputs:

- `--spec <path>` — prepends `**Spec:** <path>\n\n` to the body if not already present. If the body already contains a `**Spec:**` line, the flag is ignored (so the caller's explicit description wins).
- `--workstreams <yaml-file>` — reads the file at the given path and appends a `**Workstreams**` section built from the YAML. (This avoids escaping issues with inline workstream YAML on the command line; the same `--workstreams-yaml` style is what Quinn would already write into a temp file.)

Plus a stderr warning when `--spec` is omitted AND the resulting description lacks a `**Spec:**` line. The warning is non-fatal — it lets existing flows keep working but flags the gap so Quinn sees it in heartbeat output.

### Why a warning, not a hard block

Hard-blocking task creation on a missing Spec would break bug-only tasks that genuinely don't need a Spec (e.g. a one-line typo fix). The lobster only requires Spec for `feature` tasks. So the warning fires on every create, but downstream gates (the lobster) handle the per-task-type enforcement.

### Why not a template engine

Jinja, Mustache, etc. would be overkill. The structure of a feature-task description is fixed; two flags cover the boilerplate. If Quinn later wants templating for non-feature tasks, that's a separate concern.

## Implementation Plan

### 1. Extend `cmd_create` in `agents/skills/ops/tasks-api/tasks_api_client.py`

Add the new flags to the `create` subparser:

```python
c.add_argument("--spec", help="Prepend a '**Spec:** <path>' line to the description if missing")
c.add_argument("--workstreams", help="Path to a YAML file whose contents become the **Workstreams** section")
```

Update `cmd_create`:

```python
def cmd_create(args):
    base = get_base_url()
    payload = {
        "title": args.title,
        "priority": args.priority,
        "status": args.status,
    }
    description = args.description or ""
    spec_path = getattr(args, "spec", None)
    workstreams_path = getattr(args, "workstreams", None)

    # If a Spec is provided and the description doesn't already have one, prepend.
    if spec_path and "**Spec:**" not in description:
        description = f"**Spec:** {spec_path}\n\n{description}"

    # If a Workstreams YAML is provided and the description doesn't already
    # have a Workstreams section, append it.
    if workstreams_path:
        ws_text = pathlib.Path(workstreams_path).read_text().rstrip()
        if "**Workstreams**" not in description:
            if description and not description.endswith("\n\n"):
                description = description.rstrip() + "\n\n"
            description = f"{description}**Workstreams**\n\n{ws_text}\n"

    # Non-fatal warning if the description still has no Spec line.
    if "**Spec:**" not in description:
        print(
            "warning: task description has no '**Spec:**' line; lobster will block "
            "ready_checks until you add one (use --spec to set it automatically).",
            file=sys.stderr,
        )

    if description:
        payload["description"] = description
    if args.tags:
        payload["tags"] = args.tags
    if getattr(args, "type", None) is not None:
        payload["taskType"] = args.type
    print(json.dumps(api_request("POST", base, "/tasks", payload), indent=2))
```

Add `import sys` and `import pathlib` at the top of the file if not already present.

### 2. Update `agents/skills/product/feature-task-create/SKILL.md`

Replace the Step 4 `urllib` example with a `tasks_api_client.py create` invocation that uses the new flags. Keep the `urllib` fallback only as a footnote (in case the CLI is unavailable).

### 3. Tests

Add to `agents/skills/ops/tasks-api/tests/test_tasks_api_client.py`:

- `test_create_with_spec_prepends_spec_line` — `--spec S.md --description "body"` produces a description starting with `**Spec:** S.md\n\nbody`.
- `test_create_with_spec_does_not_double_prepend` — `--spec S.md --description "**Spec:** S.md\nbody"` produces the description unchanged.
- `test_create_without_spec_warns_to_stderr` — no `--spec`, description lacks Spec line, the test captures stderr and asserts the warning text.
- `test_create_without_spec_no_warning_when_present` — no `--spec`, description has `**Spec:**`, no stderr warning.
- `test_create_with_workstreams_appends_section` — `--workstreams ws.yaml --description "body"` reads the YAML and appends a `**Workstreams**` block.
- `test_create_with_workstreams_idempotent` — already has `**Workstreams**`, not appended twice.

## Test Plan

- `PYTHONPATH=agents/skills/tasks-api-ops python3 -m unittest discover -s agents/skills/ops/tasks-api/tests -p 'test_*.py'` — all existing tests pass + new tests pass.
- Manual smoke:
  - `tasks_api_client.py create --title T --spec brain/bookmarks/specs/feature-factory-v2-2026-06-04.md --description "Body."` — task created with description starting `**Spec:** brain/...`.
  - `tasks_api_client.py create --title T --description "Body."` — task created; stderr shows the missing-Spec warning.

## Open Questions and Risks

- None blocking. The change is additive — existing callers that pass a fully-composed `--description` keep working unchanged. The warning is informational.
- Workstreams parsing stays as raw text from a file; structured YAML parsing is out of scope for this task.