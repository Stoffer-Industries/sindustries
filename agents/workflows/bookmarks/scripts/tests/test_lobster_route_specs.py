#!/usr/bin/env python3
"""Smoke tests for the lobster_route_specs.py wrapper (task 536e04fc).

Exercises the wrapper end-to-end via subprocess so we catch any regression
in how it wires Phases 0/1/2/4 + triage-queue append + compact preview
shape. The wrapper is the AC3 reliability surface — these tests run a
code/research-only batch and confirm `directCreateItems` lights up
without ever requesting approval (Quinn's 2026-09-08 handoff: the YAML
`approval: required` flag halted the prior combined step in --mode tool
and prevented direct tasks from ever being created).

Approach: `common.py` reads `OPENCLAW_WORKSPACE` at import time to
compute `STATE_PATH`. Pointing that env var at a tempdir makes the
wrapper write to / read from <tempdir>/brain/state/* — clean isolation
from the live workspace state. `--no-triage-append` keeps
bookmark-triage-queue.json out of the workspace entirely.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_DIR = _SCRIPT_DIR.parent
SCRIPT_PATH = _SCRIPTS_DIR / "lobster_route_specs.py"


def _workspace_for_tmpdir(tmpdir: Path) -> Path:
    """Create the <tmpdir>/brain/state layout that common.py expects."""
    state_dir = tmpdir / "brain" / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    specs_dir = tmpdir / "brain" / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)
    return tmpdir


def _touch_specs(tmpdir: Path, paths: list[str]) -> None:
    """Create empty spec files so the wrapper's disk-existence check passes."""
    specs_dir = tmpdir / "brain" / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)
    for p in paths:
        full = tmpdir / p
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text("# stub\n")


def _write_state(tmpdir: Path, items: dict) -> Path:
    state_path = tmpdir / "brain" / "state" / "bookmark-review-state.json"
    state_path.write_text(json.dumps({"items": items}))
    return state_path


def _run_route_specs(
    tmpdir: Path,
    state_items: dict,
    implement_payload: list[dict],
    reviewed_payload: list[dict] | None = None,
    monitoring_payload: list[dict] | None = None,
) -> dict:
    """Drive lobster_route_specs.py with the given inputs and return parsed JSON."""
    _workspace_for_tmpdir(tmpdir)
    state_path = _write_state(tmpdir, state_items)

    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--no-triage-append",
            "--json",
        ],
        input=json.dumps({
            "implement": implement_payload,
            "reviewed": reviewed_payload or [],
            "monitoring": monitoring_payload or [],
        }),
        capture_output=True,
        text=True,
        cwd=str(tmpdir),
        env={
            **os.environ,
            "OPENCLAW_WORKSPACE": str(tmpdir),
        },
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"lobster_route_specs.py failed: rc={proc.returncode}\n"
            f"stdout={proc.stdout[:500]}\nstderr={proc.stderr[:500]}"
        )
    # dump_json pretty-prints; the JSON payload might span multiple lines.
    # Pick the suffix of stdout starting at the first '{' and parse it.
    out = proc.stdout.strip()
    start = out.find("{")
    if start < 0:
        raise AssertionError(f"No JSON object in output: {proc.stdout[:500]}")
    return json.loads(out[start:])


class LobsterRouteSpecsSmoke(unittest.TestCase):

    def test_code_only_batch_produces_direct_no_approval(self):
        """AC3 reliability case: code/research-only batch lights up
        `directCreateItems` and produces no readyPackages."""
        with tempfile.TemporaryDirectory() as d:
            tmpdir = Path(d)
            _touch_specs(tmpdir, ["brain/specs/x.md"])
            state_items = {
                "k1": {"classifications": [
                    {"specDoc": "brain/specs/x.md", "classification": "code",
                     "classification_rationale": "lib refactor"},
                ]},
            }
            implement = [
                {"bookmarkKey": "k1", "title": "k1 title", "topic": "infra",
                 "specDocs": ["brain/specs/x.md"],
                 "specProposals": [{"title": "X spec", "specDoc": "brain/specs/x.md"}]},
            ]
            out = _run_route_specs(tmpdir, state_items, implement)
            assert out["readyPackages"] == [], "code-only batch must have no readyPackages"
            assert len(out["directCreateItems"]) == 1
            assert out["directCreateItems"][0]["bookmarkKey"] == "k1"
            assert len(out["directCreateItems"][0]["tasks"]) == 1
            assert out["directCreateItems"][0]["tasks"][0]["type"] == "code"
            assert out["triageEvents"] == []

    def test_feature_only_batch_produces_ready_no_direct(self):
        with tempfile.TemporaryDirectory() as d:
            tmpdir = Path(d)
            _touch_specs(tmpdir, ["brain/specs/a.md"])
            state_items = {
                "k1": {"classifications": [
                    {"specDoc": "brain/specs/a.md", "classification": "feature",
                     "classification_rationale": "touches product"},
                ]},
            }
            implement = [
                {"bookmarkKey": "k1", "title": "K1 Title", "topic": "general",
                 "specDocs": ["brain/specs/a.md"]},
            ]
            out = _run_route_specs(tmpdir, state_items, implement)
            assert out["readyPackages"] != []
            assert out["directCreateItems"] == []
            assert out["triageEvents"] == []

    def test_ambiguous_batch_emits_triage_no_direct_no_ready(self):
        with tempfile.TemporaryDirectory() as d:
            tmpdir = Path(d)
            _touch_specs(tmpdir, ["brain/specs/x.md"])
            state_items = {
                "k1": {"classifications": [
                    {"specDoc": "brain/specs/x.md", "classification": "ambiguous",
                     "classification_rationale": "could be feature or code"},
                ]},
            }
            implement = [
                {"bookmarkKey": "k1", "title": "K1 Title", "topic": "infra",
                 "specDocs": ["brain/specs/x.md"]},
            ]
            out = _run_route_specs(tmpdir, state_items, implement)
            assert out["readyPackages"] == []
            assert out["directCreateItems"] == []
            assert len(out["triageEvents"]) == 1

    def test_mixed_batch_feature_wins_per_item(self):
        with tempfile.TemporaryDirectory() as d:
            tmpdir = Path(d)
            _touch_specs(tmpdir, ["a.md", "b.md"])
            state_items = {
                "feature-item": {"classifications": [
                    {"specDoc": "a.md", "classification": "feature"},
                ]},
                "code-item": {"classifications": [
                    {"specDoc": "b.md", "classification": "code",
                     "classification_rationale": "lib"},
                ]},
            }
            implement = [
                {"bookmarkKey": "feature-item", "title": "F", "topic": "general",
                 "specDocs": ["a.md"]},
                {"bookmarkKey": "code-item", "title": "C", "topic": "infra",
                 "specDocs": ["b.md"],
                 "specProposals": [{"title": "B", "specDoc": "b.md"}]},
            ]
            out = _run_route_specs(tmpdir, state_items, implement)
            assert {p["items"][0]["bookmarkKey"] for p in out["readyPackages"]} == {"feature-item"}
            assert {d["bookmarkKey"] for d in out["directCreateItems"]} == {"code-item"}
            assert out["triageEvents"] == []

    def test_pre_ws3_state_falls_back_to_feature(self):
        with tempfile.TemporaryDirectory() as d:
            tmpdir = Path(d)
            _touch_specs(tmpdir, ["brain/specs/a.md"])
            state_items = {"k1": {}}
            implement = [
                {"bookmarkKey": "k1", "title": "K1 Title", "topic": "general",
                 "specDocs": ["brain/specs/a.md"]},
            ]
            out = _run_route_specs(tmpdir, state_items, implement)
            assert out["readyPackages"] != []
            assert out["directCreateItems"] == []
            assert out["triageEvents"] == []
