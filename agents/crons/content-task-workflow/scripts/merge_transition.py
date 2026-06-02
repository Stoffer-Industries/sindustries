#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

from common import add_comment, dump_json, gh_pr_review_comments, gh_pr_review_decision, gh_pr_view, is_at, is_past, move_task, read_first_json_value, status, transition_result, write_lobster_state


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


def review_comment_summary(comment: dict) -> dict:
    return {
        "id": comment.get("id"),
        "url": comment.get("html_url") or comment.get("url"),
        "path": comment.get("path"),
        "line": comment.get("line") or comment.get("original_line"),
        "side": comment.get("side"),
        "user": (comment.get("user") or {}).get("login") if isinstance(comment.get("user"), dict) else None,
        "body": comment.get("body") if isinstance(comment.get("body"), str) else "",
    }


def check_review_routing(pr_urls: list[str], pr_details: list[dict]) -> tuple[bool, list[str], list[dict]]:
    failures: list[str] = []
    details: list[dict] = []
    merged_by_url = {detail.get("url"): bool(detail.get("mergedAt")) for detail in pr_details}
    for url in pr_urls:
        try:
            decision = gh_pr_review_decision(url)
            comments = [review_comment_summary(comment) for comment in gh_pr_review_comments(url)]
        except Exception as exc:
            failures.append(f"Could not inspect review comments for {url}: {exc}")
            details.append({"url": url, "error": str(exc)})
            continue
        requires_revision = not merged_by_url.get(url) and (decision in {"CHANGES_REQUESTED", "REVIEW_REQUIRED"} or bool(comments))
        detail = {"url": url, "reviewDecision": decision, "reviewComments": comments, "requiresRevision": requires_revision}
        details.append(detail)
        if requires_revision:
            if decision in {"CHANGES_REQUESTED", "REVIEW_REQUIRED"}:
                failures.append(f"{url} review decision is {decision}.")
            if comments:
                failures.append(f"{url} has {len(comments)} inline review comment(s) for Ivy.")
    return bool(failures), failures, details


def review_route_key(review_details: list[dict]) -> str:
    payload = json.dumps(review_details, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def format_review_route_comment(review_details: list[dict]) -> str:
    lines = ["[lobster-review-routing] Ivy, review feedback needs revision before this content task can move to done."]
    for detail in review_details:
        if not detail.get("requiresRevision"):
            continue
        lines.append("")
        lines.append(f"PR: {detail['url']}")
        decision = detail.get("reviewDecision")
        if decision and decision != "UNKNOWN":
            lines.append(f"Review decision: {decision}")
        comments = detail.get("reviewComments") or []
        if not comments:
            lines.append("No inline comments were returned; review decision still requires attention.")
            continue
        for comment in comments:
            location = comment.get("path") or "unknown path"
            line = comment.get("line")
            if line:
                location = f"{location}:{line}"
            body = (comment.get("body") or "").strip().replace("\n", " ")
            if len(body) > 300:
                body = body[:297] + "..."
            comment_url = comment.get("url")
            suffix = f" ({comment_url})" if comment_url else ""
            lines.append(f"- {location}: {body}{suffix}")
    return "\n".join(lines)


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
    merge_met, failures, pr_details = check_prs(pr_urls)
    review_needed, review_failures, review_details = check_review_routing(pr_urls, pr_details) if pr_urls else (False, [], [])
    failures.extend(review_failures)
    criteria_met = merge_met and not review_needed
    already_past = is_past(task, "acceptance")
    action = "none"

    state["prStatuses"] = pr_details
    state["prReviewStatuses"] = review_details
    if criteria_met and is_at(task, "acceptance"):
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_acceptance_to_done"
        else:
            task = move_task(task, "done", "All recorded Ivy PRs are merged.", state)
            action = "moved_acceptance_to_done"
    elif review_needed and is_at(task, "acceptance"):
        route_key = review_route_key(review_details)
        state["lastReviewRouteKey"] = route_key
        if str(args.dry_run).lower() == "true":
            action = "dry_run_route_review_comments_to_ivy"
        elif state.get("lastReviewRoutedKey") == route_key:
            action = "review_comments_already_routed_to_ivy"
        else:
            state["lastReviewRoutedKey"] = route_key
            write_lobster_state(str(task["id"]), state, note="Content task workflow routed PR review feedback to Ivy.")
            add_comment(str(task["id"]), format_review_route_comment(review_details))
            action = "routed_review_comments_to_ivy"
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

    dump_json(transition_result(criteria_met, already_past, action, task, lobster_state=state, failures=failures, prStatuses=pr_details, prReviewStatuses=review_details, current_status=status(task)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
