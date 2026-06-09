#!/usr/bin/env python3
from __future__ import annotations

import json
import sys


def main() -> int:
    data = json.load(sys.stdin)
    candidates = data.get("candidates", [])
    payload = {
        "ok": True,
        "count": len(candidates),
        "empty": len(candidates) == 0,
        "candidates": candidates,
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
