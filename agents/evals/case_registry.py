"""Case loading and control validation for the model-eval harness.

A *case* is one eval: a prompt, the fixtures it needs, a grader, and — the
part that makes the grade trustworthy — a known-good and a known-bad
response the grader must separate.

    **A grader with no control is a liar.**

`validate_controls` runs both control fixtures through the grader and requires
that the known-good one passes and the known-bad one fails. If it cannot
separate them, the case is reported as BROKEN and no model is scored against
it. A grader that passes everything would otherwise report every model as
excellent; one that fails everything would report every model as useless.
"""

from __future__ import annotations

import json
import pathlib
import sys
from dataclasses import dataclass

# Importable on its own: a test may import this module without going
# through run.py's sys.path bootstrap.
_HERE = pathlib.Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from graders import GradeResult, GraderError, grade  # noqa: E402  (path set above)

CASES_ROOT = pathlib.Path(__file__).resolve().parent / "cases"

REQUIRED_CASE_FIELDS = (
    "id",
    "title",
    "description",
    "prompt",
    "grader",
    "grader_config",
    "controls",
)

VALID_TRANSPORTS = ("infer", "agent")


class CaseError(RuntimeError):
    """A case file is missing, malformed, or internally inconsistent."""


@dataclass
class Case:
    """One loaded eval case."""

    id: str
    title: str
    description: str
    prompt: str
    prompt_files: list[pathlib.Path]
    grader: str
    grader_config: dict
    controls: dict
    transport: str
    directory: pathlib.Path

    @property
    def control_must_pass(self) -> pathlib.Path:
        return self.directory / self.controls["must_pass"][0]

    @property
    def control_must_fail(self) -> pathlib.Path:
        return self.directory / self.controls["must_fail"][0]


def load_case(directory: pathlib.Path) -> Case:
    """Load and validate one case directory."""
    case_file = directory / "case.json"
    if not case_file.exists():
        raise CaseError(f"no case.json in {directory}")
    try:
        raw = json.loads(case_file.read_text())
    except json.JSONDecodeError as exc:
        raise CaseError(f"{case_file}: invalid JSON: {exc}") from exc

    missing = [field for field in REQUIRED_CASE_FIELDS if field not in raw]
    if missing:
        raise CaseError(f"{case_file}: missing field(s): {', '.join(missing)}")
    # The grader name lives on the case; carry it into the config so the
    # grader itself does not need to be told twice. An explicit
    # grader_config.grader must agree with it.
    grader_config = dict(raw["grader_config"])
    declared = grader_config.get("grader")
    if declared is not None and declared != raw["grader"]:
        raise CaseError(
            f"{case_file}: grader '{raw['grader']}' disagrees with "
            f"grader_config.grader '{declared}'"
        )
    grader_config["grader"] = raw["grader"]
    for key in ("must_pass", "must_fail"):
        if key not in raw["controls"]:
            raise CaseError(f"{case_file}: controls.{key} is required")
        for rel in raw["controls"][key]:
            if not (directory / rel).exists():
                raise CaseError(f"{case_file}: control fixture missing: {rel}")
    for rel in raw.get("prompt_files", []):
        if not (directory / rel).exists():
            raise CaseError(f"{case_file}: prompt fixture missing: {rel}")
    transport = raw.get("transport", "infer")
    if transport not in VALID_TRANSPORTS:
        raise CaseError(
            f"{case_file}: transport must be one of {', '.join(VALID_TRANSPORTS)}, "
            f"not {transport!r}"
        )

    return Case(
        id=raw["id"],
        title=raw["title"],
        description=raw["description"],
        prompt=raw["prompt"],
        prompt_files=[directory / rel for rel in raw.get("prompt_files", [])],
        grader=raw["grader"],
        grader_config=grader_config,
        controls=raw["controls"],
        transport=transport,
        directory=directory,
    )


def load_all_cases(root: pathlib.Path | None = None) -> list[Case]:
    """Load every case under the cases root, sorted by id."""
    base = root or CASES_ROOT
    if not base.exists():
        return []
    cases = []
    for directory in sorted(p for p in base.iterdir() if p.is_dir()):
        if (directory / "case.json").exists():
            cases.append(load_case(directory))
    return sorted(cases, key=lambda c: c.id)


def compose_prompt(case: Case) -> str:
    """Build the prompt a model is shown.

    The `infer` transport is a raw completion with no tools, so fixture
    contents are inlined rather than referenced by path. A model that has to
    guess what a path contains is not being evaluated on the thing under
    test.
    """
    parts = [case.prompt]
    for path in case.prompt_files:
        try:
            body = path.read_text()
        except OSError as exc:
            raise CaseError(f"cannot read prompt fixture {path}: {exc}") from exc
        parts.append(f"\n--- BEGIN FILE: {path.name} ---\n{body}\n--- END FILE: {path.name} ---\n")
    return "\n".join(parts)


@dataclass
class ControlValidation:
    """The outcome of checking a grader against its controls."""

    ok: bool
    must_pass: GradeResult
    must_fail: GradeResult
    problems: list[str]

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "problems": self.problems,
            "mustPass": self.must_pass.to_dict(),
            "mustFail": self.must_fail.to_dict(),
        }


def validate_controls(case: Case) -> ControlValidation:
    """Check that the grader separates the known-good from the known-bad."""
    problems: list[str] = []
    try:
        good = grade(
            case.control_must_pass.read_text(), case.directory, case.grader_config
        )
    except (GraderError, OSError) as exc:
        raise GraderError(f"{case.id}: known-good control could not be graded: {exc}") from exc
    try:
        bad = grade(
            case.control_must_fail.read_text(), case.directory, case.grader_config
        )
    except (GraderError, OSError) as exc:
        raise GraderError(f"{case.id}: known-bad control could not be graded: {exc}") from exc

    if not good.passed:
        problems.append(
            "the known-good control did not pass, so the grader would report a "
            "correct answer as a failure"
        )
    if bad.passed:
        problems.append(
            "the known-bad control passed, so the grader would report a wrong "
            "answer as a success"
        )
    return ControlValidation(
        ok=not problems, must_pass=good, must_fail=bad, problems=problems
    )
