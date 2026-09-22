# TOOLS.md — Ash local conventions

## QA verifier

- Source: `agents/ash/src/verify.ts`
- Tasks API identity: `Ash`
- Tasks API credential env: `ASH_TASKS_API_APPROVAL_TOKEN`
- GitHub credential env: `ASH_GITHUB_TOKEN`
- GitHub config dir: `~/.config/gh-ash` (the shared bash/zsh-compatible shim at `agents/lib/gh-with-agent-token.sh` wraps every `gh` invocation so the ambient `GITHUB_TOKEN` does not silently authenticate as the wrong identity — just call `gh ...`, do not prefix with `GH_CONFIG_DIR=...` or invoke `command gh` directly). The shim is materialised into the workspace at `~/.openclaw/workspace/agents/lib/gh-with-agent-token.sh`; `~/.openclaw/workspace/agents/ash/.gh-shim.sh` sources it without exporting a global agent identity (both emitted by `scripts/ops/sync-agent-definitions.sh`). The wrapper resolves Ash from session-scoped runtime context such as `CODEX_HOME`.

Credentials and runtime registration are provisioned by the OpenClaw operator;
never write or rotate them from an ordinary QA pass.

## Ownership tools

Use `agents/skills/ops/tasks-api/tasks_api_client.py` for task reads/writes.
`attentionOwners` is a full ordered replacement, not a set:

- index 0 acts now whenever the stack is populated;
- when the stack is empty, the exact current outstanding workflow-gate owner is
  the fallback actor;
- later slots are dormant escalation targets;
- repeated names are intentional role slots and must not be deduplicated;
- comments are audit/evidence only and never route work.

Before replacing the stack, fetch the full current task and preserve every slot
that should remain. A normal evidence failure routes back to the delivery
assignee at position 0. Tooling blockers route by capability: infrastructure,
host, or network work may route to Lox; OpenClaw/runtime work routes to Quinn;
otherwise select the currently capable agent rather than hard-coding a name.

Quinn is the highest agent escalation. If Quinn cannot resolve the blocker,
Quinn replaces/advances the stack to `attentionOwners=["Tom"]`. Tom at position
0 is terminal human action; no dormant owner is required and there is no
escalation beyond him. Tom appearing later in a tail is not yet actionable.
