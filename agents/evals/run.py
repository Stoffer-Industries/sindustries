#!/usr/bin/env python3
"""Run the model-eval harness.

    python3 agents/evals/run.py --list
    python3 agents/evals/run.py --model <provider/model> --case <case-id>
    python3 agents/evals/run.py --model <provider/model> --all
    python3 agents/evals/run.py --validate-only

`--validate-only` runs every case's known-good and known-bad control through
its grader and reports whether the grader separates them. It calls no model,
so it is what CI runs: a grader that stops discriminating fails the build
rather than silently reporting every model as excellent.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from case_registry import (  # noqa: E402
    CaseError,
    compose_prompt,
    load_all_cases,
    validate_controls,
)
from graders import GraderError, grade  # noqa: E402
from invoke import ModelInvocationError, invoke_model  # noqa: E402

RESULTS_ROOT = pathlib.Path(__file__).resolve().parent / "results"


def _now() -> str:
    """Timestamp for a run record, so "latest attempt wins" is checkable."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _print_case_header(case) -> None:
    print(f"\n=== {case.id}: {case.title} ===")


def run_case(
    case,
    model: str,
    *,
    transport: str | None,
    agent: str,
    thinking: str | None,
) -> dict:
    """Run one model against one case and return its result record."""
    _print_case_header(case)
    started = time.time()
    effective_transport = transport or case.transport

    validation = validate_controls(case)
    if not validation.ok:
        print("GRADER BROKEN — not scoring this model against a broken grader:")
        for problem in validation.problems:
            print(f"  - {problem}")
        return {
            "case": case.id,
            "model": model,
            "status": "grader_broken",
            "problems": validation.problems,
            "recordedAt": _now(),
        }
    print("controls: known-good passes, known-bad fails — grader discriminates")

    prompt = compose_prompt(case)
    try:
        response, _raw = invoke_model(
            model,
            prompt,
            transport=effective_transport,
            agent=agent,
            thinking=thinking,
        )
    except ModelInvocationError as exc:
        print(f"model invocation failed: {exc}")
        return {
            "case": case.id,
            "model": model,
            "status": "model_error",
            "error": str(exc),
            "recordedAt": _now(),
        }
    elapsed = time.time() - started

    try:
        result = grade(response, case.directory, case.grader_config)
    except GraderError as exc:
        print(f"grader failed: {exc}")
        return {
            "case": case.id,
            "model": model,
            "status": "grader_error",
            "error": str(exc),
            "recordedAt": _now(),
        }

    print(f"score: {result.score:.2f} — {'PASS' if result.passed else 'FAIL'}")
    print(f"detail: {json.dumps(result.detail, indent=2, sort_keys=True)[:1200]}")
    return {
        "case": case.id,
        "model": model,
        "status": "ok",
        "passed": result.passed,
        "score": result.score,
        "detail": result.detail,
        "elapsedSeconds": round(elapsed, 1),
        "responseChars": len(response),
        "recordedAt": _now(),
    }


def persist_record(record: dict, out: str | None = None) -> pathlib.Path:
    """Write a run record. Every attempt is recorded, not only the ones that scored.

    A run that failed to reach the model, or that a broken grader refused to
    score, is still the latest truth about that model and case. Writing only
    the successes leaves the previous score sitting in the scorecard, so it
    claims a pass that did not happen — a green that does not mean anything,
    which is the failure this harness exists to prevent.
    """
    if out:
        path = pathlib.Path(out)
        path.parent.mkdir(parents=True, exist_ok=True)
    else:
        model_slug = record["model"].replace("/", "__")
        directory = RESULTS_ROOT / model_slug
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{record['case']}.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return path


def validate_all() -> int:
    """Check every case's grader against its controls. Returns an exit code."""
    cases = load_all_cases()
    if not cases:
        print("no cases found", file=sys.stderr)
        return 1
    broken = []
    for case in cases:
        _print_case_header(case)
        try:
            validation = validate_controls(case)
        except GraderError as exc:
            print(f"GRADER BROKEN — {exc}")
            broken.append(case.id)
            continue
        if validation.ok:
            print("ok — grader separates the known-good from the known-bad")
            continue
        print("GRADER BROKEN:")
        for problem in validation.problems:
            print(f"  - {problem}")
        broken.append(case.id)
    print(f"\n{len(cases) - len(broken)}/{len(cases)} case graders discriminate")
    if broken:
        print(f"broken: {', '.join(broken)}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", help="provider/model to evaluate, e.g. anthropic/claude-sonnet-5")
    parser.add_argument("--case", action="append", help="case id (repeatable)")
    parser.add_argument("--all", action="store_true", help="run every case")
    parser.add_argument("--list", action="store_true", help="list the cases and exit")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="check every grader against its controls and exit (calls no model)",
    )
    parser.add_argument(
        "--transport",
        choices=("infer", "agent"),
        help="override the transport declared by each case",
    )
    parser.add_argument("--agent", default="quinn", help="agent id for the agent transport")
    parser.add_argument(
        "--thinking",
        default="low",
        help="thinking level for the infer transport (some models require it; '' to omit)",
    )
    parser.add_argument("--out", help="write result JSON here instead of results/")
    args = parser.parse_args(argv)

    try:
        cases = load_all_cases()
    except CaseError as exc:
        print(f"case error: {exc}", file=sys.stderr)
        return 1

    if args.list:
        for case in cases:
            print(f"{case.id:32} {case.title}")
        return 0

    if args.validate_only:
        return validate_all()

    if not args.model:
        parser.error("--model is required (or use --validate-only / --list)")

    selected = cases
    if args.case:
        wanted = set(args.case)
        selected = [c for c in cases if c.id in wanted]
        missing = wanted - {c.id for c in selected}
        if missing:
            print(f"unknown case(s): {', '.join(sorted(missing))}", file=sys.stderr)
            return 1
    elif not args.all:
        parser.error("pass --case, --all, or --validate-only")

    thinking = args.thinking or None
    records = []
    for case in selected:
        record = run_case(
            case,
            args.model,
            transport=args.transport,
            agent=args.agent,
            thinking=thinking,
        )
        records.append(record)
        print(f"wrote {persist_record(record, args.out)}")

    failed = [r for r in records if r.get("status") != "ok" or not r.get("passed")]
    print(f"\n{len(records) - len(failed)}/{len(records)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
