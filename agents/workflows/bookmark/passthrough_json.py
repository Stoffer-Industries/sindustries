#!/usr/bin/env python3
from __future__ import annotations

import json
import sys


def main() -> int:
    data = json.load(sys.stdin)
    json.dump(data, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
