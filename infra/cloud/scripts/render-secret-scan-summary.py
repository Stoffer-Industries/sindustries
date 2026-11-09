#!/usr/bin/env python3
"""Render a redacted secret-scan summary for a GitHub Actions step summary.

The secret-scan entrypoint writes a JSON findings summary that carries
metadata only: rule id, path, line and commit. No secret value, no
match text, no entropy and no fingerprint — a fingerprint of a
low-entropy secret is still disclosure, so the sanitizer omits it.

This turns those two reports (the published-history scope and the
tracked-tree scope) into one markdown table for the run summary, so a
finding is visible without opening the artifact.

Usage:
  render-secret-scan-summary.py --history <path> --tree <path> [--out <path>]

A missing report is reported as an unknown scope rather than silently
treated as "no findings": a summary that reads "clean" because the
report was never written is the failure mode this task exists to close.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

SCOPES = ("history", "tree")


def load_report(path: pathlib.Path) -> tuple[list[dict], str | None]:
    """The findings in one report, plus a note if the report is unusable."""
    if not path.exists():
        return [], f"report not found: {path}"
    try:
        raw = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as error:
        return [], f"report unreadable: {error}"
    if not isinstance(raw, list):
        return [], "report is not a JSON array"
    return raw, None


def escape(text: object) -> str:
    """Markdown-safe cell text."""
    if text is None:
        return ""
    return str(text).replace("|", "\\|").replace("\n", " ")


def render(findings_by_scope: dict[str, list[dict]], notes: dict[str, str]) -> str:
    total = sum(len(findings) for findings in findings_by_scope.values())
    lines = [
        "## Secret scan (repository-wide)",
        "",
        f"**{total} finding(s)** across the scanned scopes.",
        "",
        "| Scope | Rule | Path | Line | Commit |",
        "| --- | --- | --- | --- | --- |",
    ]

    for scope in SCOPES:
        findings = findings_by_scope.get(scope, [])
        note = notes.get(scope)
        if not findings:
            suffix = f" ({note})" if note else ""
            lines.append(f"| {scope} | — | no findings{suffix} | — | — |")
            continue
        for finding in findings:
            commit = escape(finding.get("Commit"))
            if commit:
                commit = commit[:12]
            lines.append(
                "| {scope} | {rule} | {path} | {line} | {commit} |".format(
                    scope=scope,
                    rule=escape(finding.get("RuleID")),
                    path=escape(finding.get("File")),
                    line=escape(finding.get("StartLine")),
                    commit=commit,
                )
            )

    lines.extend(
        [
            "",
            "Findings are redacted: rule, path, line and commit only. The "
            "triage ledger records the same fields — "
            "`docs/runbooks/secret-scan-triage.md`.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", required=True, help="history-scope report path")
    parser.add_argument("--tree", required=True, help="tree-scope report path")
    parser.add_argument("--out", help="write the markdown here as well as to stdout")
    args = parser.parse_args()

    findings_by_scope: dict[str, list[dict]] = {}
    notes: dict[str, str] = {}
    for scope, raw_path in (("history", args.history), ("tree", args.tree)):
        findings, note = load_report(pathlib.Path(raw_path))
        findings_by_scope[scope] = findings
        if note:
            notes[scope] = note

    markdown = render(findings_by_scope, notes)
    if args.out:
        out_path = pathlib.Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(markdown)
    sys.stdout.write(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
