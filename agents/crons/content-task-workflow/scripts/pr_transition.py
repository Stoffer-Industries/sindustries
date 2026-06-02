#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys

from common import (
    add_comment,
    dump_json,
    extract_ivy_pr_urls,
    hours_since,
    is_at,
    is_past,
    move_task,
    now_iso,
    read_first_json_value,
    refresh_task,
    status,
    transition_result,
    write_lobster_state,
)


def maybe_nudge(task: dict, state: dict, nudge_after_hours: int) -> tuple[dict, str | None]:
    elapsed = hours_since(state.get("lastNudgedAt"))
    if elapsed is not None and elapsed < nudge_after_hours:
        return state, None
    state = dict(state)
    state["lastNudgedAt"] = now_iso()
    add_comment(
        str(task["id"]),
        "[lobster-nudge] Ivy PRs are not detected yet. Add a task comment tagged `[ivy-prs]` with the GitHub PR URL when implementation PRs are ready.",
    )
    write_lobster_state(str(task["id"]), state, note="Recorded content task workflow nudge.")
    return state, "nudged_for_pr"


def main() -> int:
    parser = argparse.ArgumentParser(description="Doing -> Acceptance transition for Ivy PR detection")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--nudge-after-hours", type=int, default=24)
    parser.add_argument("--dry-run", default="false")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.base_url:
        os.environ["TASKS_API_BASE_URL"] = args.base_url

    data = read_first_json_value(sys.stdin)
    task = data["task"]
    state = dict(data.get("lobster_state") or {})

    detected = extract_ivy_pr_urls(task)
    existing = [url for url in state.get("prUrls") or [] if isinstance(url, str)]
    pr_urls = existing[:]
    for url in detected:
        if url not in pr_urls:
            pr_urls.append(url)
    state["prUrls"] = pr_urls

    criteria_met = bool(pr_urls)
    failures = [] if criteria_met else ["No `[ivy-prs]` task comment with a GitHub PR URL has been detected."]
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
        state, nudge_action = (state, None) if str(args.dry_run).lower() == "true" else maybe_nudge(task, state, max(1, args.nudge_after_hours))
        if nudge_action:
            task = refresh_task(str(task["id"]))
            action = nudge_action
        else:
            action = "criteria_not_met"
    elif criteria_met and already_past:
        action = action if action != "none" else "already_past"
    elif criteria_met:
        action = action if action != "none" else "criteria_met"
    else:
        action = action if action != "none" else "criteria_not_met"

    dump_json(transition_result(criteria_met, already_past, action, task, lobster_state=state, failures=failures, prUrls=pr_urls, current_status=status(task)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
