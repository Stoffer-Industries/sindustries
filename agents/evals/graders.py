"""Graders for the model-eval harness.

A grader turns a model's response into a score. The rule this module exists
to enforce is simple and was learned the hard way:

    **A grader with no control is a liar.**

Every grader here ships with a *known-good* and a *known-bad* fixture for its
case, and the harness refuses to score a model until the grader has
demonstrated that it separates the two. A grader that passes everything, or
fails everything, is reported as broken rather than used.

Grading is deterministic wherever it can be. The lobster case is graded by
the *production* parser (`feature-task ac-check`), not by a reimplementation
of it — a reimplementation drifts from the parser and then reports failures
the real gate would not, which is how a grader starts lying about the thing
it grades.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import sys
import tempfile
from dataclasses import dataclass, field

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
FEATURE_TASK_MANIFEST = REPO_ROOT / "agents" / "workflows" / "feature-task" / "Cargo.toml"

# The shared bounded-subprocess helper, per the repo convention that agent
# scripts use `safe_run` rather than an unguarded `subprocess.run`.
_LIB = REPO_ROOT / "agents" / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from subprocess_safe import safe_run  # noqa: E402  (path set above)


@dataclass
class GradeResult:
    """The outcome of grading one response."""

    passed: bool
    score: float
    detail: dict = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "score": self.score,
            "detail": self.detail,
            "error": self.error,
        }


class GraderError(RuntimeError):
    """The grader could not run at all."""


def _feature_task_binary(crate: pathlib.Path | None = None) -> pathlib.Path | None:
    """Return a `feature-task` binary that is current with the source tree.

    A binary left over from an older commit is exactly the grader/parser
    drift this harness exists to prevent. Prefer the current debug build
    that CI creates from the checked-out tree; if no candidate is newer than
    the parser sources, return `None` so the caller rebuilds with Cargo.
    """
    crate = crate or FEATURE_TASK_MANIFEST.parent
    sources = list((crate / "src").rglob("*.rs"))
    newest_source = max((path.stat().st_mtime for path in sources), default=0)
    for profile in ("debug", "release"):
        candidate = crate / "target" / profile / "feature-task"
        if candidate.exists() and candidate.stat().st_mtime >= newest_source:
            return candidate
    return None


def _run_ac_check(
    task_description: pathlib.Path,
    pr_body: pathlib.Path,
    pr_files: pathlib.Path | None,
    task_id: str,
) -> dict:
    """Grade a PR body with the production lobster parser.

    Prefers an already-built binary; otherwise shells out to `cargo run`, which
    reuses the build cache after the first invocation.
    """
    binary = _feature_task_binary()
    if binary is not None:
        cmd = [str(binary), "ac-check"]
    else:
        if shutil.which("cargo") is None:
            raise GraderError("cargo is not available to build the feature-task parser")
        cmd = [
            "cargo",
            "run",
            "--quiet",
            "--manifest-path",
            str(FEATURE_TASK_MANIFEST),
            "--",
            "ac-check",
        ]
    cmd += [
        "--task-description",
        str(task_description),
        "--pr-body",
        str(pr_body),
        "--task-id",
        task_id,
        "--pr-url",
        "https://github.com/Stoffer-Industries/sindustries/pull/0",
    ]
    if pr_files is not None:
        cmd += ["--pr-files", str(pr_files)]

    completed = safe_run(
        cmd,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
        cwd=str(REPO_ROOT),
    )
    stdout = completed.stdout or ""
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise GraderError(
            f"ac-check produced non-JSON output (exit {completed.returncode}): "
            f"{exc}. {(completed.stderr or stdout or '')[:500]}"
        ) from exc
    report["exitCode"] = completed.returncode
    return report


def grade_lobster_ac_check(response: str, case_dir: pathlib.Path, config: dict) -> GradeResult:
    """Grade a candidate PR body with the production lobster parser."""
    task_description = case_dir / config["task_description"]
    pr_files = case_dir / config["pr_files"] if config.get("pr_files") else None
    task_id = str(config.get("task_id") or "").strip()
    if not task_id:
        raise GraderError("lobster_ac_check requires grader_config.task_id")
    handle = tempfile.NamedTemporaryFile(
        "w", suffix=".md", delete=False, encoding="utf-8"
    )
    try:
        handle.write(response)
        handle.close()
        report = _run_ac_check(
            task_description, pathlib.Path(handle.name), pr_files, task_id
        )
    finally:
        pathlib.Path(handle.name).unlink(missing_ok=True)

    acs = report.get("acs") or []
    failures = report.get("failures") or []
    total = len(acs)
    # An AC counts as satisfied when the parser found its text verbatim and a
    # recognised evidence annotation. `checked` is false for an AC the PR body
    # left as `- [ ]`.
    satisfied = sum(
        1
        for ac in acs
        if ac.get("checked") and ac.get("evidence") and ac.get("prText") == ac.get("taskText")
    )
    score = (satisfied / total) if total else 0.0
    return GradeResult(
        passed=bool(report.get("ok")) and total > 0,
        score=score,
        detail={
            "acCount": total,
            "acSatisfied": satisfied,
            "failures": failures,
            "acs": acs,
        },
    )


def grade_expected_findings(response: str, case_dir: pathlib.Path, config: dict) -> GradeResult:
    """Grade a review response against expected findings.

    Each expected finding carries `any_of`: a list of keyword alternatives, any
    one of which marks the finding as reported. Keyword anchoring keeps the
    grade deterministic — the same response always scores the same — at the
    cost of accepting a shallow mention. That trade is stated in the case file
    rather than hidden.

    `must_not_mention` entries are false-positive checks: naming one of them
    means the model reported something that is not a defect.
    """
    lowered = response.lower()
    expected = config.get("expected_findings") or []
    forbidden = config.get("must_not_mention") or []

    found, missed = [], []
    for finding in expected:
        anchors = [str(a).lower() for a in finding.get("any_of", [])]
        if any(anchor in lowered for anchor in anchors):
            found.append(finding["id"])
        else:
            missed.append(finding["id"])

    false_positives = []
    for finding in forbidden:
        anchors = [str(a).lower() for a in finding.get("any_of", [])]
        if any(anchor in lowered for anchor in anchors):
            false_positives.append(finding["id"])

    recall = (len(found) / len(expected)) if expected else 0.0
    # A false positive is not a partial credit event; it is a wrong answer.
    score = recall * (1.0 - (len(false_positives) / len(forbidden))) if forbidden else recall
    return GradeResult(
        passed=not missed and not false_positives,
        score=score,
        detail={
            "found": found,
            "missed": missed,
            "falsePositives": false_positives,
            "expectedCount": len(expected),
        },
    )


GRADERS = {
    "lobster_ac_check": grade_lobster_ac_check,
    "expected_findings": grade_expected_findings,
}


def grade(response: str, case_dir: pathlib.Path, config: dict) -> GradeResult:
    """Grade a response using the grader named in the case's `grader` field."""
    name = config.get("grader")
    grader = GRADERS.get(name)
    if grader is None:
        raise GraderError(f"unknown grader: {name!r}")
    try:
        return grader(response, case_dir, config)
    except GraderError:
        raise
    except Exception as exc:  # noqa: BLE001 - a grader crash must not look like a zero score
        raise GraderError(f"{name} grader failed: {exc}") from exc
