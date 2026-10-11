#!/usr/bin/env bash
set -euo pipefail

# All repository-owned `gh` subprocesses must enter through this wrapper.
# Keep proxy and ambient-token policy here so Python, Rust, and shell callers
# cannot drift apart again.

explicit_token="${OPENCLAW_GH_TOKEN:-}"
unset OPENCLAW_GH_TOKEN
unset GITHUB_TOKEN GH_TOKEN
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

if [[ -n "${explicit_token}" ]]; then
  export GH_TOKEN="${explicit_token}"
fi

exec gh "$@"
