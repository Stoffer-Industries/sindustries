# Telegram button flows for Tasks API ops

This helper keeps the Telegram UX close to the local workspace task layer instead of OpenClaw transport internals.

## Helper

Use:

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
python3 /Users/quinnstoffer/.openclaw/workspace/scripts/tasks_telegram_buttons.py entry
```

The script returns JSON with:
- `text` — prompt to send to the user
- `buttons` — Telegram inline keyboard rows
- `fallbackText` — typed command alternatives when buttons are unavailable or expired

## Supported flows

### 1. Entry actions

```bash
python3 scripts/tasks_telegram_buttons.py entry
```

Buttons:
- Create
- List
- Patch

### 2. List filters

```bash
python3 scripts/tasks_telegram_buttons.py list-filters
```

Buttons included in v1:
- status: todo, doing
- blocked
- ready
- priority: high, medium
- assignee: Tom, Quinn, Rowan, Lox
- all tasks

### 3. Patch flow

Pick task:

```bash
python3 scripts/tasks_telegram_buttons.py patch-tasks --limit 8
```

Pick field:

```bash
python3 scripts/tasks_telegram_buttons.py patch-fields --id <task-id>
```

Pick value:

```bash
python3 scripts/tasks_telegram_buttons.py patch-values --id <task-id> --field status
```

Supported patch fields in v1:
- status
- priority
- blocked
- ready
- assignee (Tom, Quinn, Rowan, Lox, or unassigned)

## Safe degradation

Every response includes `fallbackText` with the equivalent typed commands so the assistant can gracefully continue if:
- the channel does not support buttons
- Telegram buttons expire
- callback payload handling fails

## Example interaction flow

1. User opens Tasks with no params
2. Assistant sends entry payload from `entry`
3. User taps **List**
4. Assistant sends list filter payload from `list-filters`
5. User taps **Blocked**
6. Assistant runs `/tasks list --blocked true`

Patch flow example:

1. User opens Tasks and taps **Patch**
2. Assistant sends payload from `patch-tasks`
3. User taps a task
4. Assistant sends payload from `patch-fields --id <task-id>`
5. User taps **Status**
6. Assistant sends payload from `patch-values --id <task-id> --field status`
7. User taps **Doing**
8. Assistant runs `/tasks patch --id <task-id> --status doing`
