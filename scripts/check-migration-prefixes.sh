#!/usr/bin/env bash
# check-migration-prefixes.sh
#
# Fails if any two Prisma migration directories under **/prisma/migrations/
# share the same first 14 characters (the YYYYMMDDHHMMSS timestamp prefix).
# Prisma applies migrations in lexical order, so two directories with the
# same prefix leave the apply order at the mercy of the suffix and the
# filesystem sort — silent schema drift between dev and CI.
#
# Usage:
#   ./scripts/check-migration-prefixes.sh [ROOT]
#   (defaults to the repository root resolved relative to this script)
#
# Exit codes:
#   0 — all prefixes unique (or no migrations found)
#   1 — duplicate prefixes detected; report printed to stderr

set -euo pipefail

# Resolve repo root from this script's location (scripts/ at repo root).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${1:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"

# Find every prisma migrations directory and collect child directories whose
# names start with 14 digits followed by "_". We ignore non-migration files
# such as migration_lock.toml.
TMP="$(mktemp -t migration-prefixes.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

while IFS= read -r -d '' dir; do
    for entry in "$dir"/*; do
        [ -d "$entry" ] || continue
        name="$(basename -- "$entry")"
        if [[ "$name" =~ ^([0-9]{14})_[^/]+$ ]]; then
            printf '%s\t%s\n' "${BASH_REMATCH[1]}" "$entry" >> "$TMP"
        fi
    done
done < <(find "$ROOT_DIR" \
            -type d \
            -path '*/prisma/migrations' \
            -not -path '*/node_modules/*' \
            -not -path '*/.git/*' \
            -print0 2>/dev/null)

if [ ! -s "$TMP" ]; then
    echo "check-migration-prefixes: no migrations found under $ROOT_DIR — OK."
    exit 0
fi

# Group by prefix; any prefix that appears more than once is a violation.
DUPES="$(awk -F'\t' '{print $1}' "$TMP" | sort | uniq -d)"

if [ -n "$DUPES" ]; then
    echo "check-migration-prefixes: FAIL — duplicate 14-char migration prefixes detected:" >&2
    echo "" >&2
    while IFS= read -r prefix; do
        [ -z "$prefix" ] && continue
        echo "  prefix: $prefix" >&2
        awk -F'\t' -v p="$prefix" '$1 == p {print "    - " $2}' "$TMP" >&2
    done <<< "$DUPES"
    echo "" >&2
    echo "  Fix: rename one of the directories so its first 14 chars" >&2
    echo "  (the YYYYMMDDHHMMSS timestamp) are unique. If the migration" >&2
    echo "  is already applied on any environment, also update its row in" >&2
    echo "  the _prisma_migrations table — see services/tasks-api/README.md" >&2
    echo "  for the rename rollout steps." >&2
    exit 1
fi

COUNT="$(wc -l < "$TMP" | tr -d ' ')"
echo "check-migration-prefixes: OK — $COUNT migrations, all prefixes unique."
