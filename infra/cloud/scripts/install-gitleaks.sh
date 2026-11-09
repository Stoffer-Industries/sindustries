#!/usr/bin/env bash
# Install the pinned gitleaks CLI.
#
# One install path serves every surface that needs the binary, so the pin
# cannot drift between them:
#   - the `gitleaks` job in .github/workflows/ci.yml (the merge gate)
#   - the scheduled repository-history scan in
#     .github/workflows/secret-scan-history.yml
#   - a developer running the contract test locally
#
# The pin lives here, in this script, rather than in each workflow: the
# workflows read the pin from this script (`--print-pin`) to key their
# cache, so a version or checksum is stated in exactly one place.
#
# The CLI is MIT-licensed and needs no credential, so it can run on an
# organisation repository without a `GITLEAKS_LICENSE` secret.
# `gitleaks/gitleaks-action` cannot: it refuses to start without that
# paid secret, and `continue-on-error: true` on its step turned the
# refusal into a green `success` — a required merge-gate input that had
# never scanned a commit.
#
# The binary is pinned by version AND SHA256, so a tampered, truncated or
# substituted download fails the caller instead of failing open.
#
# Usage:
#   install-gitleaks.sh [--print-pin] [--install-dir <dir>]
#
#   --print-pin        print the resolved pin (version, archive, sha256) as
#                      `key=value` lines and exit without downloading
#   --install-dir <d>  directory to install the binary into
#                      (default: $RUNNER_TEMP/bin under GitHub Actions,
#                      $HOME/.local/bin otherwise)
#
# Environment:
#   GITLEAKS_CACHE_DIR override the archive cache directory
#                      (default: $HOME/.cache/sindustries-gitleaks)
#
# Exit codes:
#   0  the binary is installed (or the pin was printed)
#   1  the platform has no pinned archive
#   2  the download failed
#   3  the checksum did not match the pin
#   4  the archive could not be unpacked
#
# There is no fail-open path here: a missing platform, a failed download,
# a mismatched checksum and a broken archive are all explicit failures
# with their own exit code.

set -euo pipefail

# The version and every platform checksum below are one pin. There is no
# environment override for either value: the cache key, the downloaded
# archive and the verified SHA256 therefore cannot describe different bytes.
VERSION="8.30.1"
CACHE_DIR="${GITLEAKS_CACHE_DIR:-$HOME/.cache/sindustries-gitleaks}"

# The pin. One entry per supported platform, each with the upstream
# SHA256 for that release asset. The linux_x64 entry is the one the
# merge gate runs on.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"
    SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
    ;;
  Linux/aarch64 | Linux/arm64)
    ARCHIVE="gitleaks_${VERSION}_linux_arm64.tar.gz"
    SHA256="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
    ;;
  Darwin/arm64)
    ARCHIVE="gitleaks_${VERSION}_darwin_arm64.tar.gz"
    SHA256="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
    ;;
  Darwin/x86_64)
    ARCHIVE="gitleaks_${VERSION}_darwin_x64.tar.gz"
    SHA256="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"
    ;;
  *)
    echo "::error::no pinned gitleaks archive for platform $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac

PRINT_PIN=0
INSTALL_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print-pin)
      PRINT_PIN=1
      shift
      ;;
    --install-dir)
      if [ "$#" -lt 2 ]; then
        echo "::error::--install-dir requires a path" >&2
        exit 1
      fi
      INSTALL_DIR="$2"
      shift 2
      ;;
    *)
      echo "::error::unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$PRINT_PIN" -eq 1 ]; then
  # A workflow consumes the pin through $GITHUB_OUTPUT; a local shell
  # reads it from stdout. Do not write both: echoing the pin into the
  # workflow log adds no value and broadens where the value is exposed.
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "version=$VERSION"
      echo "archive=$ARCHIVE"
      echo "sha256=$SHA256"
    } > "$GITHUB_OUTPUT"
  else
    echo "version=$VERSION"
    echo "archive=$ARCHIVE"
    echo "sha256=$SHA256"
  fi
  exit 0
fi

if [ -z "$INSTALL_DIR" ]; then
  if [ -n "${RUNNER_TEMP:-}" ]; then
    INSTALL_DIR="$RUNNER_TEMP/bin"
  else
    INSTALL_DIR="$HOME/.local/bin"
  fi
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sindustries-gitleaks.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

ARCHIVE_PATH="$WORK_DIR/$ARCHIVE"
mkdir -p "$INSTALL_DIR" "$CACHE_DIR"

# The release-asset CDN intermittently answers 504 for this asset, so the
# download falls back to the API's asset endpoint — a different CDN route
# to the same bytes. The SHA256 check is what guarantees the content
# either way.
fetch() {
  local url="$1"
  shift
  curl --fail --location --silent --show-error \
    --retry 3 --retry-all-errors --retry-delay 5 \
    --connect-timeout 30 --max-time 300 \
    "$@" --output "$ARCHIVE_PATH" "$url"
}

# macOS ships `shasum` rather than `sha256sum`, so the checksum goes
# through whichever is present. Both read the same `sha256sum --check`
# format.
if command -v sha256sum >/dev/null 2>&1; then
  verify_sha256() {
    echo "$SHA256  $1" | sha256sum --check --strict - >/dev/null 2>&1
  }
elif command -v shasum >/dev/null 2>&1; then
  verify_sha256() {
    echo "$SHA256  $1" | shasum -a 256 --check --status - >/dev/null 2>&1
  }
else
  echo "::error::no SHA256 tool found (need sha256sum or shasum)" >&2
  exit 3
fi

cached=0
if [ -f "$CACHE_DIR/$ARCHIVE" ]; then
  # A cached archive from an older pin is not a usable cache hit: it
  # would fail the checksum below. Drop it and download the pinned bytes
  # instead of failing the caller over a stale cache entry.
  if verify_sha256 "$CACHE_DIR/$ARCHIVE"; then
    cp "$CACHE_DIR/$ARCHIVE" "$ARCHIVE_PATH"
    cached=1
  else
    echo "::warning::the cached gitleaks archive does not match the pin; re-downloading"
    rm -f "$CACHE_DIR/$ARCHIVE"
  fi
fi

if [ "$cached" -eq 0 ]; then
  release_url="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ARCHIVE}"
  if ! fetch "$release_url"; then
    echo "::warning::the release download URL failed; retrying via the GitHub API asset endpoint"
    asset_id="$(curl --fail --location --silent --show-error \
      --retry 3 --retry-all-errors --retry-delay 5 \
      "https://api.github.com/repos/gitleaks/gitleaks/releases/tags/v${VERSION}" \
      | python3 -c 'import json,sys; data=json.load(sys.stdin); print(next(a["id"] for a in data["assets"] if a["name"]==sys.argv[1]))' "$ARCHIVE")"
    if ! fetch "https://api.github.com/repos/gitleaks/gitleaks/releases/assets/${asset_id}" \
      -H "Accept: application/octet-stream"; then
      echo "::error::could not download the pinned gitleaks archive: $ARCHIVE" >&2
      exit 2
    fi
  fi
fi

# The checksum is the guarantee: a truncated, tampered or substituted
# download fails here, and therefore fails the caller.
if ! verify_sha256 "$ARCHIVE_PATH"; then
  echo "::error::the gitleaks archive does not match the pinned SHA256" >&2
  exit 3
fi

if [ "$cached" -eq 0 ]; then
  cp "$ARCHIVE_PATH" "$CACHE_DIR/$ARCHIVE"
fi

if ! tar --extract --gzip --file "$ARCHIVE_PATH" --directory "$WORK_DIR" gitleaks; then
  echo "::error::could not unpack the gitleaks archive" >&2
  exit 4
fi
install -m 0755 "$WORK_DIR/gitleaks" "$INSTALL_DIR/gitleaks"

echo "installed gitleaks $VERSION ($ARCHIVE) into $INSTALL_DIR"
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$INSTALL_DIR" >> "$GITHUB_PATH"
else
  echo "add $INSTALL_DIR to your PATH to use it"
fi
