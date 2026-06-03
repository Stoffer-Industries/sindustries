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
    extract_ivy_pr_urls,
    extract_pr_urls_from_text,
    gh_pr_body,
    gh_pr_ci_checks,
    gh_pr_ci_state,
    is_at,
    is_past,
    move_task,
    owner_heading_block_url_failures,
    patch_task,
    read_first_json_value,
    refresh_task,
    status,
    task_acceptance_criteria,
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
        end = heading_indices[idx + 1][0] if idx + 1 < len(heading_indices) else len(description)
        sections.append((description[start:end], idx))
    return sections


def acs_for_heading(block_text: str) -> list[str]:
    """Extract unchecked AC checkbox texts from a section block."""
    return [
        m.group(1)
        for m in CHECKBOX_RE.finditer(block_text)
        if m.group(0).strip().startswith("-[ ]") or m.group(0).strip().startswith("* [ ]")
    ]


def checked_pr_acceptance_criteria(pr_body: str) -> set[str]:
    checked: set[str] = set()
    for match in re.finditer(r"^\s*-\s*\[[xX]\]\s+(.+\S)\s*$", pr_body or "", re.M):
        checked.add(normalize_ac_text(match.group(1)))
    return checked


def checked_pr_ac_signatures(pr_body: str) -> set[str]:
    """Extract AC slugs from checked PR acceptance criteria."""
    checked: set[str] = set()
    for match in re.finditer(r"^\s*-\s*\[[xX]\]\s+(.+\S)\s*$", pr_body or "", re.M):
        checked.add(ac_signature(match.group(1)))
    return checked


def pr_heading_urls(task: dict) -> list[str]:
    return extract_pr_urls_from_text(task.get("description") or "")


def url_to_heading_index(url: str, pr_urls: list[str]) -> int | None:
    """Map a PR URL to its position in the ordered pr_urls list (0=first heading, 1=second heading).

    Ivy's [ivy-prs] comment order is: tom: #N (first), quinn: #M (second).
    Heading order is: Quinn (index 0), Tom (index 1).
    So reversed index: pr_urls[0] (Tom's) → heading 1, pr_urls[1] (Quinn's) → heading 0.
    """
    if not url or url not in pr_urls:
        return None
    pos = pr_urls.index(url)
    return 1 - pos  # 0→1, 1→0


def inject_pr_urls_into_description(description: str, pr_urls: list[str]) -> str:
    """Inject PR URLs as markdown links into owner heading blocks in order.

    pr_urls order: [Tom's PR URL, Quinn's PR URL] (from Ivy's [ivy-prs] comment).
    Heading order: ## Quinn can execute (idx 0), ## Needs Tom approval (idx 1).
    So the first URL (Tom's) goes to heading idx 1, second URL (Quinn's) goes to heading idx 0.
    We walk h_idx in reverse to find the first empty heading from the end.
    """
    if not pr_urls or not description:
        return description
    result = description
    # Do NOT reverse pr_urls — order is already [Tom's, Quinn's].
    # Walking h_idx in reverse (1→0) assigns first URL to Tom heading, second to Quinn heading.
    owner_matches = list(OWNER_HEADING_RE.finditer(result))
    for url in pr_urls:
        if url in result:
            continue
        pr_num_match = re.search(r"pull/(\d+)", url or "")
        pr_label = f"PR #{pr_num_match.group(1)}" if pr_num_match else url
        # Walk h_idx in reverse: h_idx=1 (Tom heading) first, then h_idx=0 (Quinn heading).
        heading_idx = None
        for h_idx in range(len(owner_matches) - 1, -1, -1):
            match = owner_matches[h_idx]
            start = match.end()
            end = owner_matches[h_idx + 1].start() if h_idx + 1 < len(owner_matches) else len(result)
            block = result[start:end]
            if not extract_pr_urls_from_text(match.group(0) + "\n" + block):
                heading_idx = h_idx
                break
        if heading_idx is not None:
            match = owner_matches[heading_idx]
            start = match.end()
            result = result[:start] + f"\n[{pr_label}]({url})" + result[start:]
            owner_matches = list(OWNER_HEADING_RE.finditer(result))
        else:
            result = result.rstrip() + f"\n\n[{pr_label}]({url})\n"
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

    missing = [sig for sig in section_signatures if sig not in checked_sigs]
    checked_normalized = checked_pr_acceptance_criteria(gh_pr_body(url))

    details = {
        "url": url,
        "headingIndex": heading_idx,
        "sectionACs": section_acs,
        "sectionSignatures": sorted(section_signatures),
        "checkedSignatures": sorted(checked_sigs),
        "missingSignatures": missing,
        "checkedAcceptanceCriteria": sorted(checked_normalized),
    }
    return [f"{url} PR is missing AC: {sig}" for sig in missing], details


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
    pr_heading_failures = owner_heading_block_url_failures(description)
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
                heading_idx = url_to_heading_index(url, pr_urls)
                if heading_idx is None:
                    failures.append(f"{url} has no mapped owner heading — cannot determine which ACs to validate.")
                    pr_ac_details.append({"url": url, "error": "no heading index"})
                else:
                    ac_fails, ac_details = ac_failures_for_pr(url, heading_idx, task_acs, description)
                    pr_ac_details.append(ac_details)
                    failures.extend(ac_fails)
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
