Run the daily retro action pass for SIndustries.

Read and execute:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/retro-daily-fix/SKILL.md`

This is a workflow-pattern action pass, not an incident-monitoring pass.

Boundary rules:
- Read only yesterday's `brain/ops/retro-notes/YYYY-MM-DD.md`; do not treat incident-state entries as retro findings.
- Task gates and task blockers remain owned by the Tasks API and its `attentionOwners` plane. If the selected finding is a legitimate task-level fix, use only the Tasks API path explicitly allowed by the skill; never create or update a per-task incident for it.
- If the Tasks API is unavailable or the live re-check is stale/inconclusive, do not mutate task state from cached data. Route the outage as one `tasks-api-unavailable` soft failure and stop.
- For code or documentation fixes, open a reviewable PR and do not merge or self-approve.
- Action at most one finding per run. Do not manufacture work when yesterday's file has no safe actionable finding.

Return the skill's concise report. If there is no safe action, say so and stop.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.
