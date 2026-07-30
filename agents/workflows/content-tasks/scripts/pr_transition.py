#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys

from common import (
    CHECKBOX_RE,
    OWNER_HEADING_RE,
    dump_json,
    extract_pr_urls_from_text,
    gh_pr_body,
    gh_pr_assignees,
    gh_pr_ci_checks,
    gh_pr_ci_state,
    gh_pr_reviewers,
    has_ivy_tweets_queued,
    heading_level,
    is_at,
    is_past,
    latest_ivy_pr_comment,
    move_task,
    next_heading_pos,
    owner_heading_block_url_failures,
    parse_ivy_pr_routes,
    patch_task,
    read_first_json_value,
    refresh_task,
    status,
    task_acceptance_criteria,
    task_is_weekly_content,
    transition_result,
    write_lobster_state,
)


def normalize_ac_text(value: str) -> str:
    # Lowercase, collapse whitespace, strip straight quotes and double quotes.
    # Only touch dashes that are surrounded by spaces (em-dash / word-boundary hyphens).
    v = re.sub(r"\s+", " ", value or "").strip().lower()
    v = re.sub(r"['\"]+", "", v)  # strip quote chars
    # Normalise em-dash and spaced hyphens: "foo — bar" or "foo - bar" → "foo - bar"
    v = re.sub(r"\s+[-—]\s+", " - ", v)
    # Collapse any remaining multiple spaces
    return re.sub(r"\s+", " ", v).strip()


def ac_signature(ac_text: str) -> str:
    """Extract the ACTION SLUG (action + resource path) from an AC string.

    Both task-format (UPPERCASE) and PR-format (lowercase) are handled.
    Examples:
      'ADD story/content-review-pipeline — add first-person narrative...'
      → 'add story/content-review-pipeline'
      'add system/content-ops-pipeline — publish a new operating system...'
      → 'add system/content-ops-pipeline'
      'EDIT system/openclaw — update proof: ...'
      → 'edit system/openclaw'
    """
    m = re.match(r"^([A-Za-z]+\s+[\w/.-]+)", ac_text.strip())
    if m:
        return m.group(1).lower()
    return normalize_ac_text(ac_text)


def owner_sections(description: str) -> list[tuple[str, int]]:
    """Return (owner_heading_block, heading_index) for each owner heading found.

    Blocks are ordered as they appear in the description (Quinn first, Tom second).
    """
    sections: list[tuple[str, int]] = []
    heading_indices: list[tuple[int, re.Match]] = [
        (m.start(), m) for m in OWNER_HEADING_RE.finditer(description)
    ]
    for idx, (start, match) in enumerate(heading_indices):
        end = heading_indices[idx + 1][0] if idx + 1 < len(heading_indices) else next_heading_pos(
            description, match.end(), heading_level(match.group(0))
        )
        sections.append((description[start:end], idx))
    return sections


def acs_for_heading(block_text: str) -> list[str]:
    """Extract unchecked AC checkbox texts from a section block."""
    return [
        m.group(2)
        for m in CHECKBOX_RE.finditer(block_text)
        if m.group(1) == " "
    ]


def checked_pr_acceptance_criteria(pr_body: str) -> set[str]:
    checked: set[str] = set()
    for match in re.finditer(r"^\s*-\s*\[[xX]\]\s+(.+\S)\s*$", pr_body or "", re.M):
        checked.add(normalize_ac_text(match.group(1)))
    return checked


def checked_pr_ac_signatures(pr_body: str) -> set[str]:
    """Extract AC slugs from checked PR acceptance criteria."""
    acceptance_heading = re.search(
        r"^\s{0,3}#{1,6}\s+acceptance criteria\s*$", pr_body or "", re.I | re.M
    )
    if not acceptance_heading:
        return set()
    end = next_heading_pos(pr_body, acceptance_heading.end(), heading_level(acceptance_heading.group(0)))
    acceptance_body = pr_body[acceptance_heading.end():end]
    checked: set[str] = set()
    for match in re.finditer(r"^\s*-\s*\[[xX]\]\s+(.+\S)\s*$", acceptance_body, re.M):
        checked.add(ac_signature(match.group(1)))
    return checked


def pr_heading_urls(task: dict) -> list[str]:
    return extract_pr_urls_from_text(task.get("description") or "")


IVY_LOGINS = {"ivystoffer"}


def owner_heading_index(description: str, owner: str) -> int | None:
    """Return the actual owner-heading index for an explicit route label."""
    owner = owner.lower()
    for idx, (block, _) in enumerate(owner_sections(description)):
        heading = block.splitlines()[0].lower() if block.splitlines() else ""
        if owner in heading:
            return idx
    return None


def url_to_heading_index(
    url: str,
    pr_urls: list[str],
    description: str = "",
    routes: dict[str, str] | None = None,
) -> int | None:
    """Map a PR URL to its owner heading index.

    Explicit `tom:` / `quinn:` routing is authoritative. There is no
    positional fallback: an unlabeled PR is unsafe to match to an AC set.
    """
    if not url or url not in pr_urls:
        return None
    if routes:
        for owner, routed_url in routes.items():
            if routed_url == url:
                return owner_heading_index(description, owner)
    if description:
        for idx, (block_text, _) in enumerate(owner_sections(description)):
            if url in block_text:
                return idx
    return None


def inject_pr_urls_into_description(description: str, routes: dict[str, str]) -> str:
    """Inject PR URLs as markdown links into the correct owner heading blocks.

    Explicit route labels are authoritative. Existing PR links are rewritten
    so a previous positional guess cannot remain attached to the wrong ACs.
    """
    if not routes or not description:
        return description
    owner_matches = list(OWNER_HEADING_RE.finditer(description))
    if not owner_matches:
        return description

    pieces: list[str] = []
    cursor = 0
    for idx, match in enumerate(owner_matches):
        start = match.end()
        end = owner_matches[idx + 1].start() if idx + 1 < len(owner_matches) else next_heading_pos(
            description, start, heading_level(match.group(0))
        )
        pieces.append(description[cursor:start])
        block = description[start:end]
        cleaned = re.sub(
            r"(?m)^[ \t]*\[[^\n\]]+\]\(https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+\)[ \t]*\n?",
            "",
            block,
        )
        owner = "quinn" if "quinn" in match.group(0).lower() else "tom"
        url = routes.get(owner)
        if url:
            pr_num_match = re.search(r"pull/(\d+)", url)
            pr_label = f"PR #{pr_num_match.group(1)}" if pr_num_match else url
            cleaned = f"\n[{pr_label}]({url})\n" + cleaned.lstrip("\n")
        pieces.append(cleaned)
        cursor = end
    pieces.append(description[cursor:])
    return "".join(pieces)


def ci_failures_for_pr(url: str) -> tuple[list[str], list[dict[str, str]]]:
    ci_state = gh_pr_ci_state(url)
    checks = gh_pr_ci_checks(url)
    if ci_state == "SUCCESS":
        return [], checks
    if not checks:
        return [f"{url} has no CI status checks or CI status is unknown."], checks
    failures = []
    for check in checks:
        state = check.get("state") or "UNKNOWN"
        if state != "SUCCESS":
            failures.append(f"{url} CI check `{check.get('name') or 'unnamed check'}` is {state}.")
    if not failures:
        failures.append(f"{url} CI status is {ci_state}.")
    return failures, checks


def ac_failures_for_pr(url: str, heading_idx: int, task_acs: list[str], description: str) -> tuple[list[str], dict]:
    """Check ACs for one PR, scoped to the owner heading section.

    - heading_idx 0 (Quinn): check slugs from task ACs that appear in the Quinn section.
    - heading_idx 1 (Tom): check slugs from task ACs that appear in the Tom section.
    Only ACs belonging to the PR's owner section are validated against the PR.
    """
    sections = owner_sections(description)
    if heading_idx >= len(sections):
        return [f"{url} has no corresponding owner heading in task description."], {}

    block_text = sections[heading_idx][0]
    section_acs = acs_for_heading(block_text)

    if not section_acs:
        return [], {"url": url, "headingIndex": heading_idx, "checkedSignatures": [], "missingSignatures": []}

    section_signatures = {ac_signature(ac) for ac in section_acs}
    checked_sigs = checked_pr_ac_signatures(gh_pr_body(url))

    missing = sorted(sig for sig in section_signatures if sig not in checked_sigs)
    unexpected = sorted(sig for sig in checked_sigs if sig not in section_signatures)
    checked_normalized = checked_pr_acceptance_criteria(gh_pr_body(url))

    details = {
        "url": url,
        "headingIndex": heading_idx,
        "sectionACs": section_acs,
        "sectionSignatures": sorted(section_signatures),
        "checkedSignatures": sorted(checked_sigs),
        "missingSignatures": missing,
        "unexpectedSignatures": unexpected,
        "checkedAcceptanceCriteria": sorted(checked_normalized),
    }
    failures = [f"{url} PR is missing AC: {sig}" for sig in missing]
    failures.extend(f"{url} PR contains AC for the wrong owner section: {sig}" for sig in unexpected)
    return failures, details


def main() -> int:
    parser = argparse.ArgumentParser(description="Doing -> Acceptance transition for Ivy PR detection")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--dry-run", default="false")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.base_url:
        os.environ["TASKS_API_BASE_URL"] = args.base_url

    data = read_first_json_value(sys.stdin)
    task = data["task"]
    state = dict(data.get("lobster_state") or {})
    description = task.get("description") or ""

    routes, route_failures = parse_ivy_pr_routes(latest_ivy_pr_comment(task))
    existing = [url for url in state.get("prUrls") or [] if isinstance(url, str)]
    # The latest labelled handoff is authoritative. Never merge it with the
    # prior state or infer missing labels from URL order.
    pr_urls = list(dict.fromkeys(routes.values()))
    state["prUrls"] = pr_urls

    failures: list[str] = list(route_failures)

    # Inject Ivy's explicitly routed PR URLs into the task description heading
    # blocks. The route map, not URL position or PR assignee, decides placement.
    updated_description = inject_pr_urls_into_description(description, routes)
    if updated_description != description and str(args.dry_run).lower() != "true":
        patch_task(str(task["id"]), {"description": updated_description})
        task = refresh_task(str(task["id"]))
        description = updated_description

    pr_heading_failures = owner_heading_block_url_failures(description)
    if pr_heading_failures:
        failures.extend(pr_heading_failures)

    heading_urls = pr_heading_urls(task)
    for url in pr_urls:
        if url not in heading_urls:
            failures.append(f"{url} is recorded in Lobster state but missing from the task description PR heading blocks.")

    if not pr_urls:
        failures.append("No `[ivy-prs]` task comment with a GitHub PR URL has been detected.")

    if task_is_weekly_content(task) and not has_ivy_tweets_queued(task):
        failures.append(
            "Weekly-content task requires a `[ivy-tweets-queued]` comment before advancing to acceptance. "
            "Run the `schedule-tweets` skill to queue the week's tweets into the Content Scheduler."
        )

    task_acs = task_acceptance_criteria(description)
    pr_ci: list[dict] = []
    pr_ac_details: list[dict] = []
    if not task_acs:
        failures.append("Task body has no acceptance criteria checkboxes to verify against PR descriptions.")

    for url in pr_urls:
        try:
            ci_failures, checks = ci_failures_for_pr(url)
            pr_ci.append({"url": url, "checks": checks})
            failures.extend(ci_failures)
        except Exception as exc:
            failures.append(f"Could not inspect CI for {url}: {exc}")
            pr_ci.append({"url": url, "error": str(exc)})
        if task_acs:
            try:
                heading_idx = url_to_heading_index(url, pr_urls, description, routes)
                if heading_idx is None:
                    failures.append(f"{url} has no mapped owner heading — cannot determine which ACs to validate.")
                    pr_ac_details.append({"url": url, "error": "no heading index"})
                else:
                    ac_fails, ac_details = ac_failures_for_pr(url, heading_idx, task_acs, description)
                    pr_ac_details.append(ac_details)
                    failures.extend(ac_fails)
                    assignees = gh_pr_assignees(url)
                    assignee_logins = {login.lower() for login in assignees if login}
                    if assignee_logins != IVY_LOGINS:
                        failures.append(
                            f"{url} must be assigned only to Ivy (`ivystoffer`), not to an approver; "
                            f"actual assignees: {sorted(assignee_logins) or 'none'}."
                        )
                    expected_reviewer = "quinnstoffer" if heading_idx == 0 else "stoff81"
                    reviewer_logins = {login.lower() for login in gh_pr_reviewers(url) if login}
                    if expected_reviewer not in reviewer_logins:
                        failures.append(
                            f"{url} is routed to the {('Quinn' if heading_idx == 0 else 'Tom')} section but has no "
                            f"matching reviewer (`{expected_reviewer}`)."
                        )
            except Exception as exc:
                failures.append(f"Could not inspect PR description for {url}: {exc}")
                pr_ac_details.append({"url": url, "error": str(exc)})

    criteria_met = not failures
    already_past = is_past(task, "doing")
    action = "none"

    if pr_urls != existing:
        if str(args.dry_run).lower() != "true":
            write_lobster_state(str(task["id"]), state, note="Detected Ivy PR URL(s): " + ", ".join(pr_urls))
            task = refresh_task(str(task["id"]))
        action = "recorded_pr_urls"

    if criteria_met and is_at(task, "doing"):
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_doing_to_acceptance"
        else:
            task = move_task(task, "acceptance", "Ivy PR URL criteria are met.", state)
            action = "moved_doing_to_acceptance"
    elif not criteria_met and already_past:
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_back_to_doing"
        else:
            task = move_task(task, "doing", "Ivy PR criteria are no longer met: " + "; ".join(failures), state)
            action = "moved_back_to_doing"
    elif not criteria_met and is_at(task, "doing"):
        action = "criteria_not_met"
    elif criteria_met and already_past:
        action = action if action != "none" else "already_past"
    elif criteria_met:
        action = action if action != "none" else "criteria_met"
    else:
        action = action if action != "none" else "criteria_not_met"

    dump_json(
        transition_result(
            criteria_met,
            already_past,
            action,
            task,
            lobster_state=state,
            failures=failures,
            prUrls=pr_urls,
            prHeadingUrls=heading_urls,
            acceptanceCriteria=task_acs,
            prCi=pr_ci,
            prAcceptanceCriteria=pr_ac_details,
            current_status=status(task),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
