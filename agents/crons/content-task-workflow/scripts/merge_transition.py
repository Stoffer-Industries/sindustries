#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys

from common import add_comment, dump_json, gh_pr_view, is_at, is_past, move_task, read_first_json_value, status, transition_result, write_lobster_state


def check_prs(pr_urls: list[str]) -> tuple[bool, list[str], list[dict]]:
    failures: list[str] = []
    details: list[dict] = []
    if not pr_urls:
        return False, ["No PR URLs have been recorded in Lobster state."], []
    for url in pr_urls:
        try:
            pr = gh_pr_view(url, ["url", "state", "mergedAt", "closed", "baseRefName"])
        except Exception as exc:
            failures.append(f"Could not inspect {url}: {exc}")
            details.append({"url": url, "error": str(exc)})
            continue
        state = (pr.get("state") or "").upper()
        merged_at = pr.get("mergedAt")
        closed = bool(pr.get("closed"))
        base = pr.get("baseRefName")
        details.append({"url": url, "state": state, "mergedAt": merged_at, "closed": closed, "baseRefName": base})
        if not merged_at:
            if closed or state == "CLOSED":
                failures.append(f"{url} is closed without being merged.")
            else:
                failures.append(f"{url} is not merged yet.")
        if merged_at and base and base != "main":
            failures.append(f"{url} was merged to `{base}`, not `main`.")
    return not failures, failures, details


def main() -> int:
    parser = argparse.ArgumentParser(description="Acceptance -> Done transition for merged PRs")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--repo", default="")
    parser.add_argument("--dry-run", default="false")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.base_url:
        os.environ["TASKS_API_BASE_URL"] = args.base_url

    data = read_first_json_value(sys.stdin)
    task = data["task"]
    state = dict(data.get("lobster_state") or {})
    pr_urls = [url for url in state.get("prUrls") or [] if isinstance(url, str)]
    criteria_met, failures, pr_details = check_prs(pr_urls)
    already_past = is_past(task, "acceptance")
    action = "none"

    state["prStatuses"] = pr_details
    if criteria_met and is_at(task, "acceptance"):
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_acceptance_to_done"
        else:
            task = move_task(task, "done", "All recorded Ivy PRs are merged.", state)
            action = "moved_acceptance_to_done"
    elif not criteria_met and already_past:
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_back_to_acceptance"
        else:
            task = move_task(task, "acceptance", "Merge criteria are no longer met: " + "; ".join(failures), state)
            action = "moved_back_to_acceptance"
    elif not criteria_met and any("closed without being merged" in failure for failure in failures):
        if str(args.dry_run).lower() != "true":
            write_lobster_state(str(task["id"]), state, note="Content task workflow is blocked: " + "; ".join(failures))
            add_comment(str(task["id"]), "[lobster-blocked] Recorded PR is closed without merge; update `[ivy-prs]` with a replacement PR or reopen/merge the existing PR.")
        action = "blocked_closed_unmerged_pr"
    elif criteria_met and already_past:
        action = "already_past"
    elif criteria_met:
        action = "criteria_met"
    else:
        action = "criteria_not_met"

    dump_json(transition_result(criteria_met, already_past, action, task, lobster_state=state, failures=failures, prStatuses=pr_details, current_status=status(task)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
