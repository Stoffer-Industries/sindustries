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
