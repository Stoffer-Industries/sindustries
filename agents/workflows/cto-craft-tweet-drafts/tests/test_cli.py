from __future__ import annotations

import json

import cto_craft_workflow.cli as cli


def test_run_exception_still_emits_failed_envelope(monkeypatch, capsys) -> None:
    def fail(_args):
        raise RuntimeError("database details must stay out of the envelope")

    monkeypatch.setattr(cli, "cmd_run", fail)

    assert cli.main(["run", "--json"]) == 2

    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["outcome"] == "failed"
    assert payload["errors"] == [
        "cli: UNHANDLED_EXCEPTION: workflow terminated before a final state was available"
    ]


def test_failure_envelope_exposes_reason_and_attempts(capsys) -> None:
    attempts = [
        {
            "request": 1,
            "transport": "httpx",
            "code": "HTTP_ERROR",
            "status": 502,
            "delay_ms": 1000,
        },
        {
            "request": 2,
            "transport": "curl",
            "code": "HTTP_ERROR",
            "status": 502,
            "delay_ms": 0,
        },
    ]
    final = {
        "outcome": "failed",
        "outcome_reason": "source archive fetch failed: HTTP 502",
        "fetch_attempts": attempts,
        "diagnostics": [
            {
                "node": "discover_latest_issue",
                "code": "HTTP_ERROR",
                "message": "HTTP 502",
            }
        ],
    }

    exit_code = cli._print_envelope_from_outcome(
        outcome="failed",
        final_state=final,
        import_result={},
        started_at="2026-11-15T00:00:00Z",
    )
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 2
    assert payload["outcomeReason"] == "source archive fetch failed: HTTP 502"
    assert payload["fetchAttempts"] == attempts
