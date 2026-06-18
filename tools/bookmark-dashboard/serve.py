#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = 8765
DASHBOARD_ROOT = Path(__file__).resolve().parent
BRAIN_ROOT = Path(os.getenv("BOOKMARK_DASHBOARD_BRAIN_ROOT") or DASHBOARD_ROOT.parents[3])
STATE_ROOT = BRAIN_ROOT / "state"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DASHBOARD_ROOT), **kwargs)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            state_path = STATE_ROOT / "bookmark-review-state.json"
            payload = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {"version": 1, "items": {}}
            return self._send_json(payload)
        if path == "/api/transitions":
            rows = []
            log_path = STATE_ROOT / "bookmark-transitions.jsonl"
            if log_path.exists():
                rows = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            return self._send_json(rows)
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Bookmark pipeline dashboard: http://{HOST}:{PORT}/")
    print(f"State root: {STATE_ROOT}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
