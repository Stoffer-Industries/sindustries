# HEARTBEAT.md — Ash

**Scope of this file:** when Ash discovers work and what triggers action. See
`WORKFLOW.md` for execution and routing.

1. Build Ash's unified queue:

   ```bash
   python3 agents/skills/ops/tasks-api/scripts/agent_task_queue.py \
     --assignee Ash --json
   ```

   The queue fetches both `attentionOwner=Ash` and
   `workflowGateOwner=Ash`. Routing precedence is strict:

   - when `attentionOwners` is populated, only position 0 acts; every gate-owner
     fallback and later attention slot is dormant;
   - when `attentionOwners` is empty, Ash may act on an outstanding gate only if
     it is the exact gate for the current stage (`doing → qa_agent` for Ash);
   - stale, approved, and future-stage gates are never actionable.

2. Hydrate the top candidate and re-confirm its attention stack, current status,
   gate type, state, and owner before acting. Preserve duplicate role slots.
3. Take one concrete action through `WORKFLOW.md`.
4. Do not scan comments for routing tags. Comments may supply evidence/history,
   but attention position 0 and the empty-attention current-gate fallback are
   the control state.
5. If neither rule yields an actionable task, return `HEARTBEAT_OK`.
