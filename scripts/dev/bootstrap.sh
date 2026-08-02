#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

echo "🔧 Bootstrapping local dev dependencies for sindustries..."

if ! need_cmd brew; then
  echo "❌ Homebrew is required. Install from https://brew.sh and re-run."
  exit 1
fi

if ! need_cmd colima; then
  echo "➡️  Installing colima..."
  brew install colima
else
  echo "✅ colima already installed"
fi

if ! need_cmd docker; then
  echo "➡️  Installing docker CLI..."
  brew install docker
else
  echo "✅ docker already installed"
fi

if docker compose version >/dev/null 2>&1; then
  echo "✅ docker compose plugin already available"
elif ! need_cmd docker-compose; then
  echo "➡️  Installing docker-compose..."
  brew install docker-compose
else
  echo "✅ docker-compose already installed"
fi

if ! need_cmd psql; then
  echo "➡️  Installing PostgreSQL client tools (psql)..."
  brew install libpq
  brew link --force libpq || true
else
  echo "✅ psql already installed"
fi

if ! need_cmd tilt; then
  echo "➡️  Installing tilt..."
  brew install tilt-dev/tap/tilt
  tilt get github.com/tilt-dev/tilt-extensions/docker_compose
else
  echo "✅ tilt already installed"
fi

if ! need_cmd node; then
  echo "➡️  Installing node..."
  brew install node
else
  echo "✅ node already installed"
fi

echo "📦 Installing npm dependencies..."
(cd "$ROOT_DIR/apps/tasks" && rm -rf .vite node_modules/.vite)
(cd "$ROOT_DIR/services/tasks-api" && npm install)
(cd "$ROOT_DIR/apps/tasks" && npm install)

echo "🪝 Installing repo git hooks..."
"$ROOT_DIR/scripts/git-hooks/install.sh"

echo "✅ Bootstrap complete."
echo "Next:"
echo "  make up"
echo "  make reset-db"
