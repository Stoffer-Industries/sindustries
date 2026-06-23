#!/usr/bin/env python3
"""Publish the weekly SIndustries repository audit."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
from pathlib import Path


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[4]
SOURCE_BOOKMARK = (
    "/Users/quinnstoffer/.openclaw/workspace/brain/bookmarks/x/"
    "got-your-hands-on-claude-fable-5.md"
)
AUDIT_DIR = Path("docs/repo-audits")
PR_TITLE_PREFIX = "cod—audit: sindustries weekly review"
LABEL = "code-audit"
ASSIGNEE = "Stoff81"

FOUR_PHASE_PROMPT = """Repo Audit & Improvement Plan:

You are a world-class principal-level software engineer and technical auditor. Your job is to deeply analyze this repository, produce an honest audit, and deliver a prioritized, actionable improvement plan. Work in the four phases below, in order. Do not skip ahead.

Ground every claim in actual files: cite file paths and line numbers. If you can't verify something, say so explicitly rather than guessing.

Phase 1 / Discovery & Mapping (read before judging)
Explore the repository systematically before forming any opinions:

Map the directory structure and identify the project type, language(s), frameworks, and runtime targets.
Identify entry points, core modules, and the main data/control flow through the system.

Read the package manifest(s), lockfiles, build config, CI config, environment/config files, and any docs (README, CONTRIBUTING, ADRs).

Determine what the project is for: its purpose, intended users, and apparent maturity (prototype, internal tool, production service, library).

Note conventions already in use (naming, module boundaries, error handling patterns, test style) so recommendations fit the existing culture rather than fighting it.

Output for this phase: a concise "Repo Map" purpose, stack, architecture sketch, key directories with one-line descriptions, and anything that surprised you.

Phase 2 / Audit (evidence-based, severity-rated)

Audit each dimension below.

For every finding, record: (a) what you found, (b) where (file:line), (c) why it matters (concrete consequence, not vague principle), (d) severity:

Critical / High / Medium / Low.

- Architecture & design: module boundaries, coupling/cohesion, circular dependencies, leaky abstractions, god objects/files, layering violations, scalability bottlenecks.
- Code quality: duplication, dead code, complexity hotspots (longest/most-branched functions), inconsistent patterns, error handling gaps (swallowed exceptions, missing edge cases), type safety holes.
- Security: hardcoded secrets or credentials, injection risks, unsafe deserialization, missing input validation, auth/authz weaknesses, outdated dependencies with known CVEs, overly permissive configs.
- Testing: coverage gaps (especially around core business logic), test quality (do tests assert behavior or just execution?), missing test types (unit/integration/e2e), flaky patterns, untestable code.
- Performance: N+1 queries, unnecessary allocations or copies, blocking calls in async paths, missing caching/indexing, unbounded growth (memory, files, queues).
- Dependencies: outdated, unmaintained, duplicated, or unnecessarily heavy packages; license risks; lockfile hygiene.
- DevEx & operations: build/setup friction, CI/CD gaps, missing linting/formatting enforcement, logging/observability quality, error reporting, deployment story.
- Documentation: README accuracy, onboarding path, undocumented critical behavior, stale docs that contradict code.

Rules for this phase:

Prefer 15 high-confidence findings over 50 speculative ones.

Distinguish facts ("this function has no error handling: src/api/client.ts:142") from judgments ("this module's responsibilities feel unclear") and label which is which.

Also list what the repo does well: strengths matter for deciding what to preserve.

Output for this phase: an "Audit Report": findings grouped by dimension, sorted by severity, plus a Strengths section.

Don't forget to mention all the ugly parts that need utmost priority.

Phase 3 / Improvement Strategy

Synthesize the audit into a strategy:

Identify the 3-5 themes that explain most of the findings (e.g., "no enforced boundaries between layers," "error handling is ad hoc").

For each theme, propose a target state and the principle behind it.

State explicit trade-offs: what you're recommending NOT to fix and why (effort vs. payoff, risk, project maturity).

Define what "done" looks like: measurable signals (e.g., "CI fails on lint errors," "core module test coverage >= 80%," "zero Critical findings").

Phase 4 / Detailed Task Plan
Convert the strategy into an execution plan:

Break work into discrete tasks. Each task must include: Title and one-paragraph description; files/areas affected; acceptance criteria; effort estimate (S = <2h, M = half-day, L = 1-2 days, XL = needs breakdown); risk of the change itself; dependencies on other tasks.

Order tasks into milestones:

Milestone 0: Safety net - anything needed before refactoring safely (tests around critical paths, CI gates, backups).
Milestone 1: Critical fixes - security and correctness issues.
Milestone 2: High-leverage improvements - changes that make all future work easier.
Milestone 3: Quality & polish - remaining medium/low items worth doing.

Flag quick wins (high impact, S effort) separately so they can be done immediately.

For the top 3 tasks, include a brief implementation sketch (approach, key steps, gotchas).

Final Deliverable Format
Produce a single document with these sections:
- Executive Summary (<=10 sentences: overall health grade A-F with justification, top 3 risks, top 3 opportunities)
- Repo Map
- Audit Report
- Improvement Strategy
- Task Plan (milestones + task table + quick wins)
- Open Questions: anything you need from a human to decide (product intent, deprecation candidates, performance targets)

Constraints
Do NOT modify any code during this audit. Analysis only.

Do not pad the report. If a dimension is healthy, say so in one sentence and move on.

Calibrate to the project's maturity. Don't recommend enterprise-grade infrastructure for a weekend prototype unless the owner's goals demand it.

Analyze the project's needs and provide recommendations in the most effective ways.

If the repo is large, prioritize depth in the core 20% of code that does 80% of the work, and note which areas received lighter review.
"""


def run(args: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, check=check, text=True, capture_output=True)


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], cwd, check=check)


def gh(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    token = github_token()
    if token and not env.get("GITHUB_TOKEN"):
        env["GITHUB_TOKEN"] = token
    return subprocess.run(["gh", *args], cwd=cwd, env=env, check=check, text=True, capture_output=True)


def github_token() -> str | None:
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"]
    if os.environ.get("QUINN_GITHUB_TOKEN"):
        return os.environ["QUINN_GITHUB_TOKEN"]
    env_path = Path.home() / ".openclaw" / ".env"
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export ") :]
        if not line.startswith("QUINN_GITHUB_TOKEN="):
            continue
        value = line.split("=", 1)[1].strip().strip('"').strip("'")
        return value or None
    return None


def iso_week(today: dt.date | None = None) -> str:
    year, week, _ = (today or dt.date.today()).isocalendar()
    return f"{year}-W{week:02d}"


def repo_root(path: Path) -> Path:
    result = git(path, "rev-parse", "--show-toplevel")
    return Path(result.stdout.strip())


def ensure_clean_for_audit(repo: Path, output_rel: Path) -> None:
    status = git(repo, "status", "--porcelain").stdout.splitlines()
    allowed = {output_rel.as_posix()}
    dirty = []
    for line in status:
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        if path not in allowed:
            dirty.append(line)
    if dirty:
        raise SystemExit(
            "Refusing to publish audit because the repo has unrelated changes:\n"
            + "\n".join(dirty)
        )


def prepare_branch(repo: Path, week: str, output_rel: Path) -> str:
    branch = f"code-garden/sindustries/{week}"
    git(repo, "fetch", "origin", "main")
    ensure_clean_for_audit(repo, output_rel)
    git(repo, "switch", "-C", branch, "origin/main")
    return branch


def write_audit(repo: Path, audit_file: Path, week: str) -> Path:
    output_rel = AUDIT_DIR / f"{week}.md"
    output_path = repo / output_rel
    output_path.parent.mkdir(parents=True, exist_ok=True)
    content = audit_file.read_text(encoding="utf-8").strip() + "\n"
    output_path.write_text(content, encoding="utf-8")
    return output_rel


def changed_paths(repo: Path) -> list[str]:
    return [line[3:].strip() for line in git(repo, "status", "--porcelain").stdout.splitlines()]


def commit_and_push(repo: Path, branch: str, output_rel: Path, week: str) -> bool:
    paths = changed_paths(repo)
    if not paths:
        push_branch(repo, branch)
        return False
    output = output_rel.as_posix()
    unexpected = []
    for path in paths:
        untracked_parent = path.endswith("/") and output.startswith(path)
        if path != output and not untracked_parent:
            unexpected.append(path)
    if unexpected:
        raise SystemExit("Audit publish changed unexpected files:\n" + "\n".join(unexpected))
    git(repo, "add", output_rel.as_posix())
    staged = git(repo, "diff", "--cached", "--name-only").stdout.splitlines()
    if staged != [output_rel.as_posix()]:
        raise SystemExit("Audit publish staged unexpected files:\n" + "\n".join(staged))
    git(
        repo,
        "-c",
        "user.name=rowanstoffer",
        "-c",
        "user.email=rowanstoffer@gmail.com",
        "commit",
        "-m",
        f"docs: add repo audit {week}",
    )
    push_branch(repo, branch)
    return True


def push_branch(repo: Path, branch: str) -> None:
    git(repo, "push", "-u", "origin", branch, "--force-with-lease")


def executive_summary(markdown: str) -> str:
    lines = markdown.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip().lower() == "## executive summary":
            start = index
            break
    if start is None:
        return "## Executive Summary\n\nThe audit document did not include an Executive Summary heading."
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return "\n".join(lines[start:end]).strip()


def pr_body(audit_markdown: str, output_rel: Path) -> str:
    return (
        f"{executive_summary(audit_markdown)}\n\n"
        f"Full audit: [{output_rel.as_posix()}]({output_rel.as_posix()})\n"
    )


def open_or_update_pr(repo: Path, branch: str, week: str, output_rel: Path) -> dict[str, str | int]:
    title = f"{PR_TITLE_PREFIX} {week}"
    body = pr_body((repo / output_rel).read_text(encoding="utf-8"), output_rel)
    existing = gh(
        repo,
        "pr",
        "list",
        "--head",
        branch,
        "--base",
        "main",
        "--state",
        "open",
        "--json",
        "number,url",
    ).stdout
    prs = json.loads(existing)
    if prs:
        number = str(prs[0]["number"])
        gh(repo, "pr", "edit", number, "--title", title, "--body", body)
        url = prs[0]["url"]
    else:
        created = gh(repo, "pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body)
        url = created.stdout.strip().splitlines()[-1]
        number = url.rstrip("/").split("/")[-1]

    gh(repo, "label", "create", LABEL, "--color", "5319E7", "--description", "Weekly code audit", check=False)
    gh(repo, "pr", "edit", number, "--add-label", LABEL)
    gh(repo, "pr", "edit", number, "--add-assignee", ASSIGNEE)
    return {"number": int(number), "url": url, "title": title}


def print_prompt(target_repo: Path) -> None:
    print(FOUR_PHASE_PROMPT)
    print("\nAdditional SIndustries publishing constraints:")
    print(f"- Target repository: {target_repo}")
    print("- Produce exactly one markdown audit document.")
    print("- Include file:line citations for audit claims.")
    print("- Do not modify repository files while auditing.")
    print("- Do not mention Tasks API tasks, code-garden tags, Resolved lines, or Closes lines.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target_repo", nargs="?", default=str(DEFAULT_REPO_ROOT))
    parser.add_argument("--print-prompt", action="store_true", help="Print the vendored audit prompt and exit.")
    parser.add_argument("--audit-file", type=Path, help="Markdown audit file to publish.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target_repo = repo_root(Path(args.target_repo).expanduser().resolve())

    if args.print_prompt:
        print_prompt(target_repo)
        return 0
    if not args.audit_file:
        raise SystemExit("Provide --audit-file after generating the audit markdown.")

    week = iso_week()
    output_rel = AUDIT_DIR / f"{week}.md"
    branch = prepare_branch(target_repo, week, output_rel)
    written_rel = write_audit(target_repo, args.audit_file, week)
    committed = commit_and_push(target_repo, branch, written_rel, week)
    pr = open_or_update_pr(target_repo, branch, week, written_rel)
    print(
        json.dumps(
            {
                "week": week,
                "branch": branch,
                "audit": written_rel.as_posix(),
                "committed": committed,
                "pr": pr,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
