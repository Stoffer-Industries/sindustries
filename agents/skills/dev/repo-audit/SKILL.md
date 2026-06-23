---
name: repo-audit
description: Run the weekly evidence-backed SIndustries repository audit and open the audit PR.
---

# Repo Audit

Run the bookmarked four-phase repository audit prompt against the SIndustries repo and publish exactly one audit document for the current ISO week.

## Source of truth

The audit shape comes from:

`/Users/quinnstoffer/.openclaw/workspace/brain/bookmarks/x/got-your-hands-on-claude-fable-5.md`

The runner vendors that four-phase prompt as `FOUR_PHASE_PROMPT`; do not improvise a different audit structure.

## Audit Shape

The audit must produce one markdown document with these sections:

1. `## Executive Summary` - 10 sentences or fewer, including an A-F health grade, top 3 risks, and top 3 opportunities.
2. `## Repo Map` - purpose, stack, architecture sketch, key directories, and surprises from discovery.
3. `## Audit Report` - findings grouped by dimension and sorted by severity.
4. `## Improvement Strategy` - 3-5 themes, target states, trade-offs, and measurable done signals.
5. `## Task Plan` - milestone-based task plan, task table, quick wins, and implementation sketches for the top 3 tasks.
6. `## Open Questions` - decisions needed from a human.

Required audit discipline:

- Work in four phases: Discovery & Mapping, Audit, Improvement Strategy, Detailed Task Plan.
- Ground every claim in actual files with `path:line` citations.
- Use severity grades: `Critical`, `High`, `Medium`, `Low`.
- Prefer high-confidence findings over speculative volume.
- Distinguish facts from judgments when a finding depends on interpretation.
- Include a `Strengths` section in the Audit Report.
- Do not modify source files while auditing.
- Do not create Tasks API tasks, code-garden tags, follow-up annotations, `Resolved: #...`, or `Closes: #...` lines.

## Runbook

Default target repo:

`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries`

1. Print the vendored audit prompt:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/repo-audit/repo_audit.py --print-prompt /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries
```

2. Use that prompt to audit the target repo with read-only inspection. Produce a single markdown document matching the required sections.

3. Save the audit markdown to a temporary file.

4. Publish the audit:

```bash
source ~/.openclaw/.env
GITHUB_TOKEN="$QUINN_GITHUB_TOKEN" python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/repo-audit/repo_audit.py /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries --audit-file /tmp/sindustries-repo-audit.md
```

The runner writes `docs/repo-audits/<YYYY-Www>.md`, updates or creates the branch `code-garden/sindustries/<YYYY-Www>`, pushes it, and opens or updates one PR titled `cod—audit: sindustries weekly review <YYYY-Www>` against `main`.

The PR must be labelled `code-audit` and assigned to `Stoff81`. The PR body is only the audit document's Executive Summary plus a link to the full audit file.
