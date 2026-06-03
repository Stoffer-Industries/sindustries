#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys

from common import (
    PR_HEADING_RE,
    dump_json,
    extract_ivy_pr_urls,
    extract_pr_urls_from_text,
    gh_pr_body,
    gh_pr_ci_checks,
    gh_pr_ci_state,
    is_at,
    is_past,
    move_task,
    patch_task,
    pr_heading_block_url_failures,
    read_first_json_value,
    refresh_task,
    status,
    task_acceptance_criteria,
    transition_result,
    write_lobster_state,
)


def normalize_ac_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip().lower()


def checked_pr_acceptance_criteria(pr_body: str) -> set[str]:
    checked: set[str] = set()
    for match in re.finditer(r"^\s*-\s*\[[xX]\]\s+(.+\S)\s*$", pr_body or "", re.M):
        checked.add(normalize_ac_text(match.group(1)))
    return checked


def pr_heading_urls(task: dict) -> list[str]:
    return extract_pr_urls_from_text(task.get("description") or "")


def inject_pr_urls_into_description(description: str, pr_urls: list[str]) -> str:
    """Append any missing PR URLs to the first PR heading block that lacks a URL."""
    if not pr_urls or not description:
        return description
    result = description
    for url in pr_urls:
        if url in result:
            continue
        # Find the first PR heading block that has no GitHub URL yet
        matches = list(PR_HEADING_RE.finditer(result))
        injected = False
        for idx, match in enumerate(matches):
            start = match.end()
            end = matches[idx + 1].start() if idx + 1 < len(matches) else len(result)
            block = result[start:end]
            if not extract_pr_urls_from_text(match.group(0) + "\n" + block):
                # Insert URL on the line immediately after the heading
                result = result[:start] + f"\n{url}" + result[start:]
                injected = True
                break
        if not injected:
            # No suitable heading found — append to end
            result = result.rstrip() + f"\n\n{url}\n"
    return result


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


def ac_failures_for_pr(url: str, task_acs: list[str]) -> tuple[list[str], dict]:
    body = gh_pr_body(url)
    checked = checked_pr_acceptance_criteria(body)
    missing = [ac for ac in task_acs if normalize_ac_text(ac) not in checked]
    details = {"url": url, "checkedAcceptanceCriteria": sorted(checked), "missingAcceptanceCriteria": missing}
    return [f"{url} PR description has unchecked/missing AC: {ac}" for ac in missing], details


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

    detected = extract_ivy_pr_urls(task)
    existing = [url for url in state.get("prUrls") or [] if isinstance(url, str)]
    pr_urls = existing[:]
    for url in detected:
        if url not in pr_urls:
            pr_urls.append(url)
    state["prUrls"] = pr_urls

    # Inject Ivy's PR URLs into the task description heading blocks if missing
    updated_description = inject_pr_urls_into_description(description, pr_urls)
    if updated_description != description and str(args.dry_run).lower() != "true":
        patch_task(str(task["id"]), {"description": updated_description})
        task = refresh_task(str(task["id"]))
        description = updated_description

    failures: list[str] = []
    pr_heading_failures = pr_heading_block_url_failures(description)
    if pr_heading_failures:
        failures.extend(pr_heading_failures)

    heading_urls = pr_heading_urls(task)
    for url in pr_urls:
        if url not in heading_urls:
            failures.append(f"{url} is recorded in Lobster state but missing from the task description PR heading blocks.")

    if not pr_urls:
        failures.append("No `[ivy-prs]` task comment with a GitHub PR URL has been detected.")

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
                ac_failures, ac_details = ac_failures_for_pr(url, task_acs)
                pr_ac_details.append(ac_details)
                failures.extend(ac_failures)
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
