#!/usr/bin/env python3
"""Validate a prospect-finder shortlist artifact against the skill's contract.

The prospect finder skill writes a dated Markdown shortlist for a human to
review. The deterministic parts of that artifact -- required sections, the
per-prospect field set, the score/reason pairing, the total, the ordering, and
the review-queue/state agreement -- are checked here so a malformed artifact
fails loudly instead of reaching Tom.

Usage:
    python3 validate_prospect_artifact.py <artifact.md> [<artifact.md> ...]

Exit codes:
    0 -- every artifact conforms
    1 -- at least one artifact violates the contract
    2 -- usage error (no readable artifact)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REQUIRED_SECTIONS = (
    "Run metadata",
    "ICP hypothesis",
    "Coverage note",
    "Prospect shortlist",
    "Review queue",
    "Market-research handoff",
    "Approval boundary",
)

RUN_METADATA_FIELDS = ("Date", "Initiative", "Input", "Search scope", "Sources checked")
ICP_FIELDS = ("Buyer", "Buying context", "Likely venues", "Exclusions", "Confidence")
COVERAGE_FIELDS = ("Venues searched", "Inaccessible", "Signal coverage")
HANDOFF_FIELDS = ("Question answered", "Key implications", "Links")

PROSPECT_FIELDS = (
    "Source",
    "Signal",
    "Fit",
    "Timing",
    "Reachability",
    "Total",
    "Opener",
    "Confidence",
    "Caveats",
    "Review state",
)

SCORE_FIELDS = ("Fit", "Timing", "Reachability")
REVIEW_STATES = ("proposed", "keep", "drop", "needs-more-evidence")
CONFIDENCE_VALUES = ("high", "medium", "low")
SCORE_MIN = 0
SCORE_MAX = 5

NO_SEND_PHRASE = "no outreach was sent or scheduled"

# A labelled field: "- **Label:** value"
FIELD_RE = re.compile(r"^-\s+\*\*(?P<label>[^*]+?):\*\*\s*(?P<value>.*?)\s*$")

# A score field: "4 - reason" or "4 — reason" (em dash or hyphen separator).
SCORE_RE = re.compile(r"^(?P<score>\d{1,2})\s*(?:-|—)\s*(?P<reason>.+)$")

SECTION_RE = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)
SUBSECTION_RE = re.compile(r"^###\s+(?P<title>.+?)\s*$", re.MULTILINE)


def _parse_fields(block: str) -> dict[str, str]:
    """Collect the labelled `- **Label:** value` bullets from a block."""
    fields: dict[str, str] = {}
    for line in block.splitlines():
        match = FIELD_RE.match(line.strip())
        if match:
            fields[match.group("label").strip()] = match.group("value").strip()
    return fields


def _split_sections(text: str) -> dict[str, str]:
    """Split the document into `##`-level sections keyed by heading title."""
    sections: dict[str, str] = {}
    matches = list(SECTION_RE.finditer(text))
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[match.group("title").strip()] = text[start:end]
    return sections


def _prospect_blocks(shortlist_body: str) -> list[tuple[str, str]]:
    """Split the shortlist section into (heading, body) per prospect."""
    blocks: list[tuple[str, str]] = []
    matches = list(SUBSECTION_RE.finditer(shortlist_body))
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(shortlist_body)
        blocks.append((match.group("title").strip(), shortlist_body[start:end]))
    return blocks


def _missing(fields: dict[str, str], required: tuple[str, ...]) -> list[str]:
    return [name for name in required if name not in fields]


def validate_artifact(text: str) -> list[str]:
    """Return the list of contract violations in `text` (empty means valid)."""
    problems: list[str] = []

    sections = _split_sections(text)
    for title in REQUIRED_SECTIONS:
        if title not in sections:
            problems.append(f"missing required section: ## {title}")

    if problems:
        # Without the section skeleton there is nothing meaningful left to
        # check -- reporting every downstream failure would just be noise.
        return problems

    run_metadata = _parse_fields(sections["Run metadata"])
    for name in _missing(run_metadata, RUN_METADATA_FIELDS):
        problems.append(f"Run metadata: missing field '{name}'")

    icp = _parse_fields(sections["ICP hypothesis"])
    for name in _missing(icp, ICP_FIELDS):
        problems.append(f"ICP hypothesis: missing field '{name}'")

    coverage = _parse_fields(sections["Coverage note"])
    for name in _missing(coverage, COVERAGE_FIELDS):
        problems.append(f"Coverage note: missing field '{name}'")

    signal_coverage = coverage.get("Signal coverage", "").strip().lower()
    if signal_coverage == "thin" and "Confidence note" not in coverage:
        problems.append(
            "Coverage note: signal coverage is 'thin' but no 'Confidence note' field is present"
        )
    if signal_coverage and signal_coverage not in ("broad", "partial", "thin"):
        problems.append(
            f"Coverage note: Signal coverage must be one of broad/partial/thin, got '{signal_coverage}'"
        )

    handoff = _parse_fields(sections["Market-research handoff"])
    for name in _missing(handoff, HANDOFF_FIELDS):
        problems.append(f"Market-research handoff: missing field '{name}'")

    approval = sections["Approval boundary"].strip()
    if NO_SEND_PHRASE not in approval.lower():
        problems.append(
            f"Approval boundary: must state that '{NO_SEND_PHRASE}'"
        )

    blocks = _prospect_blocks(sections["Prospect shortlist"])
    if not blocks:
        problems.append("Prospect shortlist: no prospect blocks found")

    totals: list[int] = []
    prospect_names: list[str] = []
    prospect_states: dict[str, str] = {}
    openers: dict[str, str] = {}

    for heading, body in blocks:
        fields = _parse_fields(body)
        label = heading.split("—")[0].strip() or heading
        prospect_names.append(label)

        for name in _missing(fields, PROSPECT_FIELDS):
            problems.append(f"{label}: missing field '{name}'")
        for name in PROSPECT_FIELDS:
            if name in fields and not fields[name].strip():
                problems.append(f"{label}: field '{name}' is empty")

        source = fields.get("Source", "")
        if source and not re.match(r"^https?://\S+$", source):
            problems.append(f"{label}: Source must be an absolute http(s) URL, got '{source}'")

        score_total = 0
        for name in SCORE_FIELDS:
            raw = fields.get(name)
            if raw is None:
                continue
            match = SCORE_RE.match(raw)
            if not match:
                problems.append(
                    f"{label}: {name} must be '<0-{SCORE_MAX}> - <one-line reason>', got '{raw}'"
                )
                continue
            score = int(match.group("score"))
            if not SCORE_MIN <= score <= SCORE_MAX:
                problems.append(f"{label}: {name} score {score} is outside 0-{SCORE_MAX}")
            if not match.group("reason").strip():
                problems.append(f"{label}: {name} has no reason")
            score_total += score

        raw_total = fields.get("Total")
        if raw_total is not None:
            if not raw_total.strip().isdigit():
                problems.append(f"{label}: Total must be an integer, got '{raw_total}'")
            else:
                declared = int(raw_total.strip())
                if declared != score_total:
                    problems.append(
                        f"{label}: Total {declared} does not equal the sum of the scores ({score_total})"
                    )
                totals.append(declared)

        confidence = fields.get("Confidence", "").strip().lower()
        if confidence and confidence not in CONFIDENCE_VALUES:
            problems.append(
                f"{label}: Confidence must be one of {'/'.join(CONFIDENCE_VALUES)}, got '{confidence}'"
            )

        state = fields.get("Review state", "").strip().lower()
        if state and state not in REVIEW_STATES:
            problems.append(
                f"{label}: Review state must be one of {'/'.join(REVIEW_STATES)}, got '{state}'"
            )
        if state:
            prospect_states[label] = state

        opener = fields.get("Opener", "")
        if opener:
            openers[label] = opener

    # An opener reused verbatim across prospects is a generic pitch, not a
    # personalised one -- the whole point of the field (AC4).
    seen_openers: dict[str, str] = {}
    for label, opener in openers.items():
        key = opener.strip().lower()
        if key in seen_openers:
            problems.append(
                f"{label}: Opener is identical to '{seen_openers[key]}' -- openers must be personalised per prospect"
            )
        else:
            seen_openers[key] = label

    if totals != sorted(totals, reverse=True):
        problems.append(
            "Prospect shortlist: prospects must be ordered by Total, descending"
        )

    review_queue = sections["Review queue"]
    queue_states: dict[str, str] = {}
    for line in review_queue.splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        content = stripped.lstrip("-").strip()
        if "—" not in content:
            continue
        name, _, state = content.partition("—")
        queue_states[name.strip()] = state.strip().lower()

    for name in prospect_names:
        if not name:
            continue
        if name not in queue_states:
            problems.append(f"Review queue: no entry for '{name}'")
            continue
        queued = queue_states[name]
        declared = prospect_states.get(name)
        if queued not in REVIEW_STATES:
            problems.append(
                f"Review queue: '{name}' state must be one of {'/'.join(REVIEW_STATES)}, got '{queued}'"
            )
        elif declared and queued != declared:
            problems.append(
                f"Review queue: '{name}' is '{queued}' but the prospect's Review state is '{declared}'"
            )

    return problems


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    failed = False
    for raw_path in argv[1:]:
        path = Path(raw_path)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            print(f"{path}: cannot read artifact: {error}", file=sys.stderr)
            failed = True
            continue

        problems = validate_artifact(text)
        if problems:
            failed = True
            print(f"{path}: {len(problems)} contract violation(s):")
            for problem in problems:
                print(f"  - {problem}")
        else:
            print(f"{path}: OK")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
