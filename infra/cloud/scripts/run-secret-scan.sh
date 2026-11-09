#!/usr/bin/env bash
# Shared secret-scan entrypoint.
#
# One script serves every surface so the detection policy and the failure
# behaviour cannot drift apart:
#   - CI: the `gitleaks` job in .github/workflows/ci.yml
#   - the scheduled repository-history scan in
#     .github/workflows/secret-scan-history.yml
#   - the contract test infra/cloud/scripts/tests/secret-scan-enforcement.test.sh
#   - the local pre-commit hook installed by scripts/install-hooks.sh
#
# Scopes:
#   --staged   staged changes only (the local pre-commit hook)
#   --history  every commit reachable from local and remote refs
#   --tree     tracked files only (the committed/indexed tree)
#   default    the change since the resolved base commit
#
# The tree scope is exported from the Git index before it is scanned. That
# keeps gitignored local files (`.env.local`, `.vercel/`, and similar) out of
# the result without maintaining a second list of tracked paths. The history
# scope uses `--all`, so published remote branches are included when the
# checkout has fetched them.
#
# Usage:
#   run-secret-scan.sh [--staged | --history | --tree]
#                       [--config <path>] [--base <sha>] [--report <path>] [<root>]
#
# Exit codes:
#   0  clean
#   1  gitleaks found secrets (gitleaks' own exit code)
#   2  gitleaks binary not found on PATH
#   3  gitleaks config file not found
#   4  scan scope resolved to zero commits or zero tracked files
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
#
# `--report <path>` writes a redacted JSON summary containing only rule,
# path, line and commit metadata. Secret values, matches, entropy and
# fingerprints are deliberately omitted: a hash of a low-entropy secret is
# still disclosure.

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
usage: run-secret-scan.sh [--staged | --history | --tree]
                           [--config <path>] [--base <sha>]
                           [--report <path>] [<root>]

  --staged            scan staged changes (the local pre-commit hook's mode)
  --history           scan every commit reachable from local and remote refs
  --tree              scan tracked files only (gitignored files are excluded)
  --config <path>     gitleaks config (default: <root>/.gitleaks.toml)
  --base <sha>        base commit for the change scan (default: resolved
                      from the repository's base branch)
  --report <path>     write a redacted JSON findings summary to this path
  <root>              repository or directory to scan (default: .)
EOF
}

STAGED=0
HISTORY=0
TREE=0
CONFIG=""
BASE=""
REPORT_PATH=""
ROOT="."

while [ "$#" -gt 0 ]; do
  case "$1" in
    --staged)
      STAGED=1
      shift
      ;;
    --history)
      HISTORY=1
      shift
      ;;
    --tree)
      TREE=1
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
    --report)
      if [ "$#" -lt 2 ]; then
        annotate_error "--report requires a path"
        usage >&2
        exit 5
      fi
      REPORT_PATH="$2"
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

mode_count=$((STAGED + HISTORY + TREE))
if [ "$mode_count" -gt 1 ]; then
  annotate_error "--staged, --history and --tree are mutually exclusive"
  usage >&2
  exit 5
fi
if [ "$mode_count" -eq 1 ] && [ -n "$BASE" ]; then
  annotate_error "--base applies only to the change scan"
  usage >&2
  exit 5
fi

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

if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  annotate_error "scan root is not a git repository: $ROOT"
  exit 5
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sindustries-secret-scan.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

RAW_REPORT="$TMP_DIR/gitleaks-report.json"

# Return the finding count and, when requested, write a sanitized report.
# The sanitizer deliberately keeps metadata only. In particular it omits the
# Secret, Match, Entropy and Fingerprint fields: even a fingerprint can
# disclose a low-entropy value through an offline guess.
summarize_report() {
  local raw_path="$1"
  local safe_path="$2"
  local path_prefix="$3"

  python3 - "$raw_path" "$safe_path" "$path_prefix" <<'PY'
import json
import os
import pathlib
import sys

raw_path = pathlib.Path(sys.argv[1])
safe_path = pathlib.Path(sys.argv[2])
path_prefix = sys.argv[3]

if raw_path.exists():
    raw = json.loads(raw_path.read_text())
    if not isinstance(raw, list):
        raise SystemExit("gitleaks report is not a JSON array")
else:
    raw = []

safe = []
for finding in raw:
    file_name = str(finding.get("File", ""))
    if path_prefix and file_name.startswith(path_prefix):
        file_name = os.path.relpath(file_name, path_prefix)
    safe.append(
        {
            "RuleID": finding.get("RuleID"),
            "Description": finding.get("Description"),
            "File": file_name,
            "StartLine": finding.get("StartLine"),
            "EndLine": finding.get("EndLine"),
            "Commit": finding.get("Commit"),
        }
    )

safe_path.parent.mkdir(parents=True, exist_ok=True)
safe_path.write_text(json.dumps(safe, indent=2, sort_keys=True) + "\n")
print(len(safe))
PY
}

report_count() {
  local path_prefix="${1:-}"
  local safe_path=""

  if [ -n "$REPORT_PATH" ]; then
    safe_path="$REPORT_PATH"
  else
    safe_path="$TMP_DIR/safe-report.json"
  fi

  local count
  if ! count="$(summarize_report "$RAW_REPORT" "$safe_path" "$path_prefix")"; then
    annotate_error "could not summarize the gitleaks report"
    exit 4
  fi
  printf '%s\n' "$count"
}

# The local pre-commit hook's mode: scan what is staged, nothing else.
if [ "$STAGED" -eq 1 ]; then
  status=0
  gitleaks protect --staged --verbose --redact=100 --no-banner \
    --config "$CONFIG" --source "$ROOT" \
    --report-format json --report-path "$RAW_REPORT" || status=$?
  finding_count="$(report_count)"
  if [ "$status" -ne 0 ]; then
    annotate_error "secret scan failed on staged changes (finding count: $finding_count)"
    exit "$status"
  fi
  echo "secret scan: no secrets found in staged changes (finding count: 0, config: $CONFIG)"
  exit 0
fi

# Repository history: every commit reachable from local and remote refs.
# The caller is responsible for fetching all published refs (the scheduled
# workflow does so explicitly before calling this mode).
if [ "$HISTORY" -eq 1 ]; then
  commit_count=0
  if ! commit_count="$(git -C "$ROOT" rev-list --count --all 2>/dev/null)"; then
    commit_count=0
  fi
  if [ "$commit_count" -lt 1 ]; then
    annotate_error "secret scan scope resolved to zero commits (all refs)"
    exit 4
  fi
  echo "secret scan: history scope resolved to $commit_count commit(s) across all local and remote refs"
  status=0
  gitleaks git --verbose --redact=100 --no-banner --config "$CONFIG" \
    --log-opts "--all" \
    --report-format json --report-path "$RAW_REPORT" "$ROOT" || status=$?
  finding_count="$(report_count)"
  if [ "$status" -ne 0 ]; then
    annotate_error "secret scan failed on repository history (finding count: $finding_count)"
    exit "$status"
  fi
  echo "secret scan: no secrets found in $commit_count commit(s) (all refs, finding count: 0, config: $CONFIG)"
  exit 0
fi

# Tracked tree: export the committed HEAD tree into a temporary directory.
# This keeps untracked, gitignored and uncommitted local files out of the
# scan while covering every file committed at the named commit. The printed
# scope therefore identifies exactly what was scanned.
if [ "$TREE" -eq 1 ]; then
  head_sha=""
  if ! head_sha="$(git -C "$ROOT" rev-parse --verify "HEAD^{commit}" 2>/dev/null)"; then
    annotate_error "secret scan scope resolved to zero commits (no HEAD commit)"
    exit 4
  fi
  tree_sha=""
  if ! tree_sha="$(git -C "$ROOT" rev-parse --verify "HEAD^{tree}" 2>/dev/null)"; then
    annotate_error "could not resolve the HEAD tree"
    exit 4
  fi
  # Count blobs only. A submodule entry is a gitlink, not a blob: the
  # export does not produce a file for it, so counting it here would
  # make the export check below fail for a repository that is otherwise
  # scannable.
  tracked_count=0
  if ! tracked_count="$(git -C "$ROOT" ls-tree -r HEAD | grep -c ' blob ' | tr -d '[:space:]')"; then
    tracked_count=0
  fi
  if [ "$tracked_count" -lt 1 ]; then
    annotate_error "secret scan scope resolved to zero tracked files"
    exit 4
  fi

  tree_dir="$TMP_DIR/tree"
  mkdir -p "$tree_dir"
  if ! git -C "$ROOT" archive --format=tar HEAD | tar --extract --file - --directory "$tree_dir"; then
    annotate_error "could not export the committed tracked tree"
    exit 4
  fi
  exported_count="$(find "$tree_dir" -mindepth 1 \( -type f -o -type l \) -print | wc -l | tr -d '[:space:]')"
  if [ "$exported_count" != "$tracked_count" ]; then
    annotate_error "tracked-tree export count mismatch (tree: $tracked_count, exported: $exported_count)"
    exit 4
  fi

  echo "secret scan: tree scope resolved to $tracked_count tracked file(s) at $head_sha (tree $tree_sha)"
  status=0
  gitleaks dir --verbose --redact=100 --no-banner --config "$CONFIG" \
    --report-format json --report-path "$RAW_REPORT" "$tree_dir" || status=$?
  finding_count="$(report_count "$tree_dir")"
  if [ "$status" -ne 0 ]; then
    annotate_error "secret scan failed on the tracked tree (finding count: $finding_count)"
    exit "$status"
  fi
  echo "secret scan: no secrets found in $tracked_count tracked file(s) (at $head_sha, finding count: 0, config: $CONFIG)"
  exit 0
fi

# Resolve the base of the change scan. An explicitly requested base that
# cannot be resolved is a fallback to a tracked-tree scan, not a silent
# no-op; a base that resolves to zero commits is a hard failure.
base=""
if [ -n "$BASE" ]; then
  if git -C "$ROOT" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
    base="$BASE"
  else
    annotate_warning "base commit '$BASE' could not be resolved in $ROOT; falling back to a tracked-tree scan"
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
  echo "secret scan: change scope resolved to $commit_count commit(s) (${base}..HEAD)"
  status=0
  gitleaks git --verbose --redact=100 --no-banner --config "$CONFIG" \
    --log-opts "${base}..HEAD" \
    --report-format json --report-path "$RAW_REPORT" "$ROOT" || status=$?
  finding_count="$(report_count)"
  if [ "$status" -ne 0 ]; then
    annotate_error "secret scan failed on ${base}..HEAD (finding count: $finding_count)"
    exit "$status"
  fi
  echo "secret scan: no secrets found in $commit_count commit(s) (${base}..HEAD, finding count: 0, config: $CONFIG)"
  exit 0
fi

annotate_warning "no base commit could be resolved in $ROOT; scanning the tracked tree instead"
if [ -n "$REPORT_PATH" ]; then
  exec bash "$0" --tree --config "$CONFIG" --report "$REPORT_PATH" "$ROOT"
fi
exec bash "$0" --tree --config "$CONFIG" "$ROOT"
