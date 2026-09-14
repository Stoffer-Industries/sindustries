#!/usr/bin/env python3
"""Fail unless every required GitHub Actions predecessor succeeded or skipped."""

from __future__ import annotations

import json
import os
import sys


ALLOWED_RESULTS = frozenset({'success', 'skipped'})


def rejected_results(needs: dict[str, dict[str, object]]) -> dict[str, object]:
    return {
        name: data.get('result')
        for name, data in needs.items()
        if data.get('result') not in ALLOWED_RESULTS
    }


def main() -> int:
    raw = os.environ.get('REQUIRED_RESULTS', '')
    if not raw:
        print('::error::REQUIRED_RESULTS was not provided to the merge gate.', file=sys.stderr)
        return 1

    try:
        needs = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f'::error::REQUIRED_RESULTS is invalid JSON: {error}', file=sys.stderr)
        return 1

    if not isinstance(needs, dict) or not needs:
        print('::error::REQUIRED_RESULTS must contain at least one required job.', file=sys.stderr)
        return 1

    rejected = rejected_results(needs)
    if rejected:
        for name, result in sorted(rejected.items()):
            print(f'::error::{name} finished with {result}', file=sys.stderr)
        return 1

    print(f'All {len(needs)} required CI jobs succeeded or were intentionally skipped.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
