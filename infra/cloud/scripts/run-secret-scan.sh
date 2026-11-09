#!/usr/bin/env bash
# Shared secret-scan entrypoint.
#
# One script serves all three surfaces so the detection policy and the
# failure behaviour cannot drift apart:
#   - CI: the `gitleaks` job in .github/workflows/ci.yml
#   - the contract test infra/cloud/scripts/tests/secret-scan-enforcement.test.sh
#   - the local pre-commit hook installed by scripts/install-hooks.sh
#
# Scope is the change, not the whole history: `base..HEAD` for a pull
# request, `before..sha` for a push to main. A repository-wide sweep needs
# its own triage of historic findings and is tracked separately (the M2
# follow-up of task 2b3962b1); until that baseline exists, a history-wide
# scan on every run would redden main on an unrelated historic finding and
# the tempting fix — a broad allowlist — would weaken this gate.
#
# Usage:
#   run-secret-scan.sh [--staged] [--config <path>] [--base <sha>] [<root>]
#
# Exit codes:
#   0  clean
#   1  gitleaks found secrets (gitleaks' own exit code)
#   2  gitleaks binary not found on PATH
#   3  gitleaks config file not found
#   4  scan scope resolved to zero commits
#   5  invalid usage, or the scan root is not a git repository
#
# There is no fail-open path here on purpose: no `|| true`, no
# `continue-on-error`, no `set +e` around the scan. A scanner outage, a
# missing binary, a missing config and an empty scope are all explicit
# failures with their own exit code, so a green check can never mean
# "scanned nothing".
#
# `--verbose` makes a failing scan name the rule, the file and the line it
# found, so a CI log says what was detected rather than only that
# something was. `--redact=100` keeps the value itself out of the log:
# this repository is public and so are its CI logs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
if resolved_root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="$resolved_root"
fi

annotate_error() {
  printf '::error::%s\n' "$1"
}

annotate_warning() {
  printf '::warning::%s\n' "$1"
}

usage() {
  cat <<'EOF'
usage: run-secret-scan.sh [--staged] [--config <path>] [--base <sha>] [<root>]

  --staged            scan staged changes (the local pre-commit hook's mode)
  --config <path>     gitleaks config (default: <root>/.gitleaks.toml)
  --base <sha>        base commit for the change scan (default: resolved
                      from the repository's base branch)
  <root>              repository or directory to scan (default: .)
EOF
}

STAGED=0
CONFIG=""
BASE=""
ROOT="."

while [ "$#" -gt 0 ]; do
  case "$1" in
    --staged)
      STAGED=1
      shift
      ;;
    --config)
      if [ "$#" -lt 2 ]; then
        annotate_error "--config requires a path"
        usage >&2
        exit 5
      fi
      CONFIG="$2"
      shift 2
      ;;
    --base)
      if [ "$#" -lt 2 ]; then
        annotate_error "--base requires a commit"
        usage >&2
        exit 5
      fi
      BASE="$2"
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      annotate_error "unknown option: $1"
      usage >&2
      exit 5
      ;;
    *)
      ROOT="$1"
      shift
      ;;
  esac
done

if ! command -v gitleaks >/dev/null 2>&1; then
  annotate_error "gitleaks binary not found on PATH"
  exit 2
fi

if [ -z "$CONFIG" ]; then
  if [ -f "$ROOT/.gitleaks.toml" ]; then
    CONFIG="$ROOT/.gitleaks.toml"
  elif [ -f "$REPO_ROOT/.gitleaks.toml" ]; then
    CONFIG="$REPO_ROOT/.gitleaks.toml"
  fi
else
  if [ ! -f "$CONFIG" ]; then
    annotate_error "gitleaks config not found: $CONFIG"
    exit 3
  fi
fi

if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
  annotate_error "gitleaks config not found: ${CONFIG:-<root>/.gitleaks.toml}"
  exit 3
fi

# The local pre-commit hook's mode: scan what is staged, nothing else.
if [ "$STAGED" -eq 1 ]; then
  status=0
  gitleaks protect --staged --verbose --redact=100 --no-banner \
    --config "$CONFIG" --source "$ROOT" || status=$?
  if [ "$status" -ne 0 ]; then
    annotate_error "secret scan failed on staged changes"
    exit "$status"
  fi
  echo "secret scan: no secrets found in staged changes (config: $CONFIG)"
  exit 0
fi

if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  annotate_error "scan root is not a git repository: $ROOT"
  exit 5
fi

# Resolve the base of the change scan. An explicitly requested base that
# cannot be resolved is a fallback to a working-tree scan, not a silent
# no-op; a base that resolves to zero commits is a hard failure.
base=""
if [ -n "$BASE" ]; then
  if git -C "$ROOT" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
    base="$BASE"
  else
    annotate_warning "base commit '$BASE' could not be resolved in $ROOT; falling back to a working-tree scan"
  fi
else
  for candidate in origin/main origin/master main master; do
    if ! git -C "$ROOT" rev-parse --verify --quiet "${candidate}^{commit}" >/dev/null 2>&1; then
      continue
    fi
    merge_base=""
    if ! merge_base="$(git -C "$ROOT" merge-base HEAD "$candidate" 2>/dev/null)"; then
      merge_base=""
    fi
    if [ -n "$merge_base" ]; then
      base="$merge_base"
      break
    fi
  done
  if [ -z "$base" ] && git -C "$ROOT" rev-parse --verify --quiet "HEAD~1^{commit}" >/dev/null 2>&1; then
    base="HEAD~1"
  fi
fi

if [ -n "$base" ]; then
  commit_count=0
  if ! commit_count="$(git -C "$ROOT" rev-list --count "${base}..HEAD" 2>/dev/null)"; then
    commit_count=0
  fi
  if [ "$commit_count" -lt 1 ]; then
    annotate_error "secret scan scope resolved to zero commits (${base}..HEAD)"
    exit 4
  fi
  status=0
  gitleaks git --verbose --redact=100 --no-banner --config "$CONFIG" \
    --log-opts "${base}..HEAD" "$ROOT" || status=$?
  if [ "$status" -ne 0 ]; then
    annotate_error "secret scan failed on ${base}..HEAD"
    exit "$status"
  fi
  echo "secret scan: no secrets found in $commit_count commit(s) (${base}..HEAD, config: $CONFIG)"
  exit 0
fi

annotate_warning "no base commit could be resolved in $ROOT; scanning the working tree instead"
status=0
gitleaks dir --verbose --redact=100 --no-banner --config "$CONFIG" "$ROOT" || status=$?
if [ "$status" -ne 0 ]; then
  annotate_error "secret scan failed on the working tree"
  exit "$status"
fi
echo "secret scan: no secrets found in the working tree (config: $CONFIG)"
exit 0
