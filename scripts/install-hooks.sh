#!/usr/bin/env bash
# Install local pre-commit hooks for secret scanning.
#
# Cloud-readiness AC2 source-control guard. The hook runs `gitleaks protect`
# against the staged diff before each commit; a non-zero exit blocks the
# commit with the secret name + file path in the gitleaks output. CI runs
# the same scan as a separate job (see .github/workflows/ci.yml gitleaks job).
#
# Install: ./scripts/install-hooks.sh
# Uninstall: rm .git/hooks/pre-commit
#
# Requirements: gitleaks >= 8.18 on PATH. The script does NOT install
# gitleaks — install it yourself (brew install gitleaks, scoop install
# gitleaks, or grab a release from https://github.com/gitleaks/gitleaks).
# The script fails fast if gitleaks is not on PATH.

set -euo pipefail

HOOK_PATH=".git/hooks/pre-commit"
CONFIG_PATH=".gitleaks.toml"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "install-hooks.sh: gitleaks not found on PATH" >&2
  echo "  brew install gitleaks        # macOS" >&2
  echo "  scoop install gitleaks       # Windows" >&2
  echo "  https://github.com/gitleaks/gitleaks/releases" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "install-hooks.sh: git not found on PATH" >&2
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "install-hooks.sh: missing $CONFIG_PATH — refusing to install a hook without a config" >&2
  exit 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "install-hooks.sh: not inside a git worktree (.git not found)" >&2
  exit 1
fi

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Pre-commit secret scan — installed by scripts/install-hooks.sh.
# Do not edit by hand; rerun the installer to update.

set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "pre-commit: gitleaks not on PATH; skipping secret scan" >&2
  echo "  install with brew/scoop, then rerun scripts/install-hooks.sh" >&2
  exit 1
fi

gitleaks protect --staged --redact --no-banner \
  --config .gitleaks.toml \
  --verbose
HOOK

chmod +x "$HOOK_PATH"

echo "install-hooks.sh: pre-commit hook installed at $HOOK_PATH"
echo "  config:        $CONFIG_PATH"
echo "  gitleaks:      $(command -v gitleaks) ($(gitleaks version 2>/dev/null | head -1 || echo unknown))"
echo "  to uninstall:  rm $HOOK_PATH"
