#!/usr/bin/env bash
set -euo pipefail

# Verify the GitHub identity that will own a newly-created PR. This must run
# immediately before `gh pr create`; commit authorship and task assignee do not
# affect GitHub's PR owner.

expected_login="${1:-}"
if [[ -z "${expected_login}" ]]; then
  printf 'usage: %s <expected-github-login>\n' "$0" >&2
  exit 64
fi

actual_login="$(gh api user --jq '.login')"
if [[ "${actual_login,,}" != "${expected_login,,}" ]]; then
  printf 'refusing PR creation: expected GitHub login %s, authenticated as %s\n' \
    "${expected_login}" "${actual_login}" >&2
  printf 'Fix the agent GitHub environment; do not retry with another agent token.\n' >&2
  exit 1
fi

printf 'GitHub opener identity verified: %s\n' "${actual_login}"
