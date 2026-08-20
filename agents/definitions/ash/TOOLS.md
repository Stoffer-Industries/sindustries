# TOOLS.md — Ash local conventions

## QA verifier

- Source: `agents/ash/src/verify.ts`
- Tasks API identity: `Ash`
- Tasks API credential env: `ASH_TASKS_API_APPROVAL_TOKEN`
- GitHub credential env: `ASH_GITHUB_TOKEN`
- GitHub config dir: `~/.config/gh-ash`

Credentials and runtime registration are provisioned by the OpenClaw operator;
never write or rotate them from an ordinary QA pass.

## Ownership tools

Use `agents/skills/ops/tasks-api/tasks_api_client.py` for task reads/writes.
`attentionOwners` is a full ordered replacement, not a set:

- index 0 acts now;
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
