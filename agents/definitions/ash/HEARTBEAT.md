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
3. When Ash is the current actor for a `qa_agent` gate, reason over the
   task via the agent's own tool calls (no CLI invocation):

   1. Fetch the full task via the Tasks API.
   2. Fetch the linked merged PR's body, file list, and raw patch via
      `gh api` (Ash's `ASH_GITHUB_TOKEN` is in her agent env).
   3. Import `extractAcLines` + `stripTrailingEvidence` from
      `agents/ash/src/verify.ts` to get the bare AC descriptions —
      these are imports, not invocations; Ash runs them inside her own
      reasoning context.
   4. For each AC, reason over the AC's bare description + the PR
      patch + the cited test results + the cited files (read via the
      agent's `read` / `exec` tools). Reach a verdict: `verified` /
      `blocked` / `deferred`.
      Before `deferred`, run an execution preflight: execute any cited
      repository command or script that is available, use green CI where it
      is authoritative, and run a bounded live probe when the local service
      can be started or the endpoint is reachable. A manual or inconvenient
      check is not a capability gap; do not defer it without attempting it.
   5. On `verified` for all ACs: post the structured `qa_agent`
      approval via the Tasks API (Ash's `ASH_TASKS_API_APPROVAL_TOKEN`
      is in her agent env). A `[qa-agent-verified]` comment records the
      per-AC reasoning summary.
   6. On any `blocked` AC: post `[qa-agent-blocked] AC<N>: <reason>`
      listing each blocked AC's reason. Do **not** post the structured
      approval.
   7. On a `deferred` AC caused by a missing Ash/codebase capability: post
      `[qa-agent-deferred] AC<N>: <reason>` and a matching
      `[qa-agent-capability-request] domain=<domain> AC<N>: need <capability>
      to perform <check>; attempted <command/tool>; requested action <next
      step>` entry. Continue the loop for the rest, but do **not** post the
      structured `qa_agent` approval. Route the task to Quinn at
      `attentionOwners[0]` until Quinn approves and creates a capability-
      extension task. Then the original task must depend on that new task; the
      capability task must have no dependency back to the original. Once that
      task completes, Ash reruns the original task and approves or blocks it
      from fresh evidence. Do not classify a capability gap as a delivery
      failure merely to route it back to Rowan.
   8. If the same capability gap has been deferred across two distinct
      tasks (the two-strike rule), propose a follow-up feature task
      (create via Tasks API) describing the capability spec and link
      it from both deferred reports. Do not auto-create on the first
      deferral — transient gaps are noise; only recurring gaps become
      work items.
4. Take one concrete action through `WORKFLOW.md`.
5. Do not scan comments for routing tags. Comments may supply evidence/history,
   but attention position 0 and the empty-attention current-gate fallback are
   the control state.
6. If neither rule yields an actionable task, return `HEARTBEAT_OK`.
