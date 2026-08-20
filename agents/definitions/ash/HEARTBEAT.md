# HEARTBEAT.md — Ash

**Scope of this file:** when Ash discovers work and what triggers action. See
`WORKFLOW.md` for execution and routing.

1. Query active tasks where Ash is the **top** attention owner:

   ```bash
   python3 agents/skills/ops/tasks-api/tasks_api_client.py list \
     --attention-owner Ash \
     --status ready --status doing --status acceptance
   ```

   The API filter is position-0-only. Do not act merely because Ash owns an
   outstanding `qa_agent` gate; that gate is eligibility/context, not routing.

2. Hydrate each result and confirm `attentionOwners[0] == "Ash"`
   case-insensitively. Later Ash slots are dormant. Preserve duplicate slots.
3. Take one concrete action on the highest-priority actionable task through
   `WORKFLOW.md`. Future-stage gates remain dormant; only the exact gate for the
   task's current status may be evaluated.
4. Do not scan comments for routing tags. Comments may supply evidence/history,
   but the attention stack is authoritative.
5. If no task has Ash at position 0, return `HEARTBEAT_OK`.
