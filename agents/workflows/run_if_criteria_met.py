#!/usr/bin/env python3
"""Run a workflow stage only when the previous JSON envelope permits it.

The installed Lobster workflow runner supports conditions for approval and
skipped state, but not JSON-property predicates such as
``$stage.json.criteriaMet``. Keep the gate in this adapter so workflow files
remain compatible with the current runner and older installations.
"""

from __future__ import annotations

import json
import subprocess
import sys


def main(argv: list[str]) -> int:
    try:
        separator = argv.index("--")
    except ValueError:
        print("run_if_criteria_met.py requires a command after --", file=sys.stderr)
        return 2

    command = argv[separator + 1 :]
    if not command:
        print("run_if_criteria_met.py requires a command after --", file=sys.stderr)
        return 2

    input_text = sys.stdin.read()
    try:
        envelope = json.loads(input_text)
    except json.JSONDecodeError as error:
        print(f"previous stage did not emit JSON: {error}", file=sys.stderr)
        return 2

    criteria_met = envelope.get("criteriaMet", envelope.get("criteria_met"))
    if not isinstance(criteria_met, bool):
        print("previous stage JSON is missing boolean criteriaMet", file=sys.stderr)
        return 2

    if not criteria_met:
        sys.stdout.write(input_text)
        return 0

    result = subprocess.run(command, input=input_text, text=True, check=False)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
