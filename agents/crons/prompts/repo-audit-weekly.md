## FIRST ACTION — cwd verification (non-negotiable)

Before doing anything else (including reading the skill), your very first tool
call MUST be a single `exec`:

- `workdir`: `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`
- `command`: `pwd && git rev-parse --show-toplevel`

If the `pwd` line does NOT equal `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`,
STOP. Use notify-soft-fail to escalate to Lox with the actual cwd, then exit.

If it matches, you are confirmed in the repo. Continue to read the skill.

## Working directory rule (HARD CONSTRAINT)

This cron runs in an isolated session whose `cwd` is **NOT** the sindustries
repo by default. For every `exec` call after the verification:

1. Pass `workdir: "/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries"` on the `exec` parameter, OR
2. Use absolute paths for `read` / `write` / `apply_patch` calls (these take paths, not cwd), OR
3. Prefix shell commands with `cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries && ...`

Do NOT rely on relative paths like `services/...`, `docs/...`, `apps/...`,
`agents/...`. They will resolve against the wrong cwd and fail with `exit 1` —
this is the bug that broke the W31 audit (and probably W28–W30 silently).

## Completion gate (HARD CONSTRAINT)

A successful session MUST end with all four of these, in order, before the
session ends:

1. `docs/repo-audits/<YYYY-Www>.md` written to disk (not just planned in
   the assistant text — actually written via `write` tool).
2. `git add docs/repo-audits/<YYYY-Www>.md && git commit -m "..."` (or
   the matching commit style).
3. `git push -u origin <branch>` — the branch must land on the remote.
4. PR opened via the pr-open skill (`cod—audit: ...` title, Executive Summary
   body, `code-audit` label, `Stoff81` assignee, `Stoff81` reviewer).

If you reach the end of your session without all four landing, the audit
is incomplete and the cron will record `consecutiveErrors++`. The W31
trajectory showed the agent writing the planning text "Now I have
everything I need. Let me write the audit document:" and then ending the
session without a `write` call — that's exactly the failure mode this gate
prevents.

## Tool constraint

The `toolsAllow` on the cron payload is set to:
`read`, `exec`, `write`, `apply_patch`, `sessions_send`, `image`,
`update_plan`, `web_search`, `web_fetch`, `message`. Do not attempt to
invoke tools outside this list — they will fail and may not produce useful
errors.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.
