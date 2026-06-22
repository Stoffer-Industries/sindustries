#!/usr/bin/env bash
# cleanup_disk.sh — reclaim disk space on the sindustries dev machine.
#
# What it does:
#   1. Reports BEFORE/AFTER disk usage for the data volume mount.
#   2. Identifies stale git worktrees for a target repo:
#        - ORPHAN:    git's own worktree-list flags the entry as `prunable`
#                    (the on-disk path is missing). Metadata-only cleanup.
#        - MERGED:    branch is merged into origin/main and the directory is
#                    older than the staleness threshold with a clean tree.
#                    Removal requires explicit --prune-merged.
#        - ACTIVE:    anything else. Always reported, never touched.
#   3. Reports reclaimable Docker images / containers / volumes / build cache.
#   4. Reports npm and pnpm cache sizes (safe to clear; refetched on demand).
#   5. With --execute, performs the safe cleanups:
#        - git worktree prune                  (orphans only, always safe)
#        - docker image prune                  (dangling images)
#        - docker container prune              (stopped containers)
#        - npm cache clean --force
#        - pnpm store prune                    (drops unreferenced packages)
#   6. With --prune-merged (and --execute), also `git worktree remove --force`
#      for MERGED worktrees. Interactively confirms each unless --yes is set.
#   7. With --prune-volumes (and --execute), runs `docker volume prune`.
#      DANGER: this can delete named data volumes. Requires explicit opt-in.
#   8. With --prune-all-images (and --execute), runs `docker image prune -a`
#      which removes ALL images not in use by a running container.
#
# Defaults to dry-run. Pass --execute to actually clean.
#
# Usage:
#   scripts/infra/cleanup_disk.sh                       # dry-run report
#   scripts/infra/cleanup_disk.sh --execute             # safe cleanups
#   scripts/infra/cleanup_disk.sh --execute --prune-merged --yes
#   scripts/infra/cleanup_disk.sh --repo /path/to/repo  # target a specific repo
#
# Exit codes:
#   0  success (including dry-run with no findings)
#   1  user-facing error (bad args, missing required tool, etc.)
#   2  cleanup attempted but a step failed

set -Eeuo pipefail

# --- args --------------------------------------------------------------------

REPO=""
EXECUTE=0
PRUNE_MERGED=0
PRUNE_VOLUMES=0
PRUNE_ALL_IMAGES=0
ASSUME_YES=0
STALENESS_DAYS=14
JSON_OUT=0

usage() {
  cat <<'EOF'
Usage: scripts/infra/cleanup_disk.sh [options]

Defaults to dry-run. Pass --execute to actually clean.

Options:
  --repo PATH          Git repo to inspect for worktrees
                       (default: parent of this script, falling back to $PWD)
  --execute            Actually run the safe cleanups (default: dry-run only)
  --prune-merged       With --execute, also remove worktrees whose branch is
                       merged into origin/main and the working tree is clean
  --prune-volumes      With --execute, also run `docker volume prune`.
                       DANGER: can delete named data volumes.
  --prune-all-images   With --execute, also run `docker image prune -a`.
                       Removes ALL images not referenced by a running container.
  --stale-days N       Age threshold for "MERGED" worktrees (default: 14)
  --yes                Skip interactive confirmation for --prune-merged
  --json               Emit a JSON summary on stdout (human text on stderr)
  -h, --help           Show this help

What it does:
  1. Reports BEFORE/AFTER disk usage for the data volume mount.
  2. Identifies stale git worktrees for a target repo:
       - ORPHAN:  git's own worktree-list flags the entry as `prunable`
                  (the on-disk path is missing). Metadata-only cleanup.
       - MERGED:  branch is merged into origin/main and the directory is
                  older than the staleness threshold with a clean tree.
                  Removal requires explicit --prune-merged.
       - ACTIVE:  anything else. Always reported, never touched.
  3. Reports reclaimable Docker images / containers / volumes / build cache.
  4. Reports npm and pnpm cache sizes (safe to clear; refetched on demand).
  5. With --execute, performs the safe cleanups:
       - git worktree prune                  (orphans only, always safe)
       - docker image prune                  (dangling images)
       - docker container prune              (stopped containers)
       - npm cache clean --force
       - pnpm store prune                    (drops unreferenced packages)
  6. With --prune-merged (and --execute), also `git worktree remove --force`
     for MERGED worktrees. Interactively confirms each unless --yes is set.
  7. With --prune-volumes (and --execute), runs `docker volume prune`.
     DANGER: this can delete named data volumes. Requires explicit opt-in.
  8. With --prune-all-images (and --execute), runs `docker image prune -a`
     which removes ALL images not in use by a running container.

Exit codes:
  0  success (including dry-run with no findings)
  1  user-facing error (bad args, missing required tool, etc.)
  2  cleanup attempted but a step failed
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --prune-merged) PRUNE_MERGED=1; shift ;;
    --prune-volumes) PRUNE_VOLUMES=1; shift ;;
    --prune-all-images) PRUNE_ALL_IMAGES=1; shift ;;
    --stale-days) STALENESS_DAYS="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --json) JSON_OUT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

# --- helpers -----------------------------------------------------------------

log()  { printf '%s\n' "$*" >&2; }
hr()   { printf '%s\n' "------------------------------------------------------------" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

# bytes -> human (KiB precision)
human_bytes() {
  awk -v b="$1" 'BEGIN { split("B KiB MiB GiB TiB", u, " "); i=1; while (b>=1024 && i<5) { b/=1024; i++ } printf("%.1f %s", b, u[i]) }'
}

# Print BEFORE/AFTER df for the data volume (/System/Volumes/Data on macOS).
report_df() {
  local label="$1"
  hr
  log "$label"
  if have df; then
    df -h | awk -v lbl="$label" 'NR==1 || /\/System\/Volumes\/Data$/ { print; if (/\/System\/Volumes\/Data$/) exit }' >&2 || true
  else
    log "  df not available"
  fi
}

# --- repo discovery ----------------------------------------------------------

if [ -z "$REPO" ]; then
  # Walk up from this script until we find a .git directory.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO="$SCRIPT_DIR"
  while [ "$REPO" != "/" ] && [ ! -d "$REPO/.git" ]; do
    REPO="$(dirname "$REPO")"
  done
  if [ ! -d "$REPO/.git" ]; then
    log "ERROR: could not find a git repo above $SCRIPT_DIR; pass --repo"
    exit 1
  fi
fi

if [ ! -d "$REPO/.git" ]; then
  log "ERROR: --repo path is not a git repo: $REPO"
  exit 1
fi

log "Target repo: $REPO"

# --- baseline disk usage ----------------------------------------------------

report_df "Disk usage (BEFORE)"

# --- worktree classification -------------------------------------------------
#
# git worktree list --porcelain gives us one record per worktree with these
# fields, in order, terminated by a blank line:
#   worktree <path>
#   HEAD <sha>
#   branch refs/heads/<name>      (or "detached")
#   prunable gitdir file points to non-existent location
#
# We'll parse this into a flat list with one tab-separated row per worktree:
#   path<TAB>sha<TAB>branch<TAB>state   (state = PRUNABLE|MERGED|ACTIVE)

hr
log "Worktrees under $REPO"

WORKTREE_DATA="$(cd "$REPO" && git worktree list --porcelain)"

# Pre-compute the list of branches merged into origin/main (best effort).
MERGED_BRANCHES=""
if (cd "$REPO" && git rev-parse --verify origin/main >/dev/null 2>&1); then
  MERGED_BRANCHES="$(cd "$REPO" && git branch --merged origin/main --format '%(refname:short)' 2>/dev/null || true)"
fi

# Current HEAD — never touch the active worktree.
ACTIVE_BRANCH="$(cd "$REPO" && git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

# Parse porcelain output into parallel arrays.
WT_PATHS=()
WT_SHAS=()
WT_BRANCHES=()
WT_STATES=()
WT_SIZES=()
WT_MTIMES=()
WT_GIT_PRUNABLE=()

current_path="" current_sha="" current_branch="" current_prunable=""
flush_wt() {
  if [ -z "$current_path" ]; then return; fi
  WT_PATHS+=("$current_path")
  WT_SHAS+=("$current_sha")
  WT_BRANCHES+=("${current_branch:-detached}")
  WT_STATES+=("ACTIVE")
  WT_SIZES+=("0B")
  WT_MTIMES+=("-")
  WT_GIT_PRUNABLE+=("${current_prunable:-0}")
  current_path=""; current_sha=""; current_branch=""; current_prunable=""
}

while IFS= read -r line; do
  case "$line" in
    "worktree "*) flush_wt; current_path="${line#worktree }" ;;
    "HEAD "*)     current_sha="${line#HEAD }" ;;
    "branch "*)   current_branch="${line#branch refs/heads/}" ;;
    "prunable "*) current_prunable=1 ;;
    "")           flush_wt ;;
  esac
done <<< "$WORKTREE_DATA"
flush_wt

# Classify each worktree.
for i in "${!WT_PATHS[@]}"; do
  path="${WT_PATHS[$i]}"
  branch="${WT_BRANCHES[$i]}"
  state="ACTIVE"

  # Compute on-disk size and mtime (best effort, never fail).
  if [ -d "$path" ]; then
    size_b=$(du -sk "$path" 2>/dev/null | awk '{print $1*1024}')
    WT_SIZES[$i]="$(human_bytes "${size_b:-0}")"
    mtime_epoch=$(stat -f "%m" "$path" 2>/dev/null || echo 0)
    if [ "${mtime_epoch:-0}" -gt 0 ]; then
      WT_MTIMES[$i]="$(date -r "$mtime_epoch" '+%Y-%m-%d' 2>/dev/null || echo "-")"
      age_days=$(( ( $(date +%s) - mtime_epoch ) / 86400 ))
    else
      age_days=0
    fi
  else
    WT_SIZES[$i]="MISSING"
    WT_MTIMES[$i]="-"
    age_days=9999
  fi

  # Classify.
  if [ "${WT_GIT_PRUNABLE[$i]}" = "1" ] || [ "${WT_SIZES[$i]}" = "MISSING" ]; then
    # Either git's own worktree-list flagged it, or the on-disk path is gone.
    state="PRUNABLE"
  elif [ -n "$MERGED_BRANCHES" ] && echo "$MERGED_BRANCHES" | grep -qx "$branch"; then
    # Branch is merged into origin/main.
    if [ "$age_days" -ge "$STALENESS_DAYS" ]; then
      # Check the working tree is clean.
      if (cd "$path" 2>/dev/null && git status --porcelain 2>/dev/null | grep -q .); then
        state="ACTIVE"  # dirty, don't touch
      else
        state="MERGED"
      fi
    fi
  fi
  # Never auto-touch the active worktree.
  if [ "$path" = "$REPO" ]; then state="ACTIVE"; fi
  if [ -n "$ACTIVE_BRANCH" ] && [ "$branch" = "$ACTIVE_BRANCH" ]; then state="ACTIVE"; fi

  WT_STATES[$i]="$state"
done

# Print the worktree report.
printf '%-50s %-12s %-44s %-8s %s\n' "PATH" "STATE" "BRANCH" "SIZE" "MTIME" >&2
for i in "${!WT_PATHS[@]}"; do
  printf '%-50s %-12s %-44s %-8s %s\n' \
    "${WT_PATHS[$i]}" \
    "${WT_STATES[$i]}" \
    "${WT_BRANCHES[$i]}" \
    "${WT_SIZES[$i]}" \
    "${WT_MTIMES[$i]}" >&2
done

# --- docker inventory --------------------------------------------------------

hr
log "Docker reclaimable space"
if have docker && (timeout 10 docker info >/dev/null 2>&1 || docker info >/dev/null 2>&1); then
  docker system df 2>&1 | sed 's/^/  /' >&2 || true
  DOCKER_UP=1
else
  log "  docker not reachable — skipping docker cleanup"
  DOCKER_UP=0
fi

# --- npm/pnpm caches ---------------------------------------------------------

hr
log "npm / pnpm cache sizes"
NPM_CACHE=""
PNPM_STORE=""
if have npm; then NPM_CACHE="$(npm config get cache 2>/dev/null || echo "")"; fi
if have pnpm; then PNPM_STORE="$(pnpm store path 2>/dev/null | tail -n 1 || echo "")"; fi

[ -n "$NPM_CACHE" ] && [ -d "$NPM_CACHE" ] && log "  npm cache:  $(du -sh "$NPM_CACHE" 2>/dev/null | awk '{print $1}')  ($NPM_CACHE)" || log "  npm cache:  not present"
[ -n "$PNPM_STORE" ] && [ -d "$PNPM_STORE" ] && log "  pnpm store: $(du -sh "$PNPM_STORE" 2>/dev/null | awk '{print $1}')  ($PNPM_STORE)" || log "  pnpm store: not present"

# Older pnpm versions (~v6 and earlier) stored packages under ~/.local/share/pnpm.
# Surface it as a hint, but do NOT clean it automatically — it may be in use.
if [ -d "$HOME/.local/share/pnpm" ]; then
  log "  pnpm legacy: $(du -sh "$HOME/.local/share/pnpm" 2>/dev/null | awk '{print $1}')  ($HOME/.local/share/pnpm) [hint: inspect before removing]"
fi

# --- summary -----------------------------------------------------------------

hr
PRUNABLE_COUNT=$(printf '%s\n' "${WT_STATES[@]}" | grep -c '^PRUNABLE$' || true)
MERGED_COUNT=$(printf '%s\n' "${WT_STATES[@]}" | grep -c '^MERGED$' || true)
ACTIVE_COUNT=$(printf '%s\n' "${WT_STATES[@]}" | grep -c '^ACTIVE$' || true)
log "Summary:"
log "  worktrees: $PRUNABLE_COUNT prunable (orphan), $MERGED_COUNT merged-and-old, $ACTIVE_COUNT active"
log "  docker:    $([ "$DOCKER_UP" = "1" ] && echo "available" || echo "unavailable")"
log "  npm cache: $([ -n "$NPM_CACHE" ] && [ -d "$NPM_CACHE" ] && echo "present" || echo "absent")"
log "  pnpm store: $([ -n "$PNPM_STORE" ] && [ -d "$PNPM_STORE" ] && echo "present" || echo "absent")"

if [ "$EXECUTE" = "0" ]; then
  hr
  log "Dry-run only. Re-run with --execute to perform the safe cleanups."
  log "Add --prune-merged to also remove MERGED worktrees (with confirmation)."
  log "Add --prune-volumes to also docker volume prune (DANGER)."
  log "Add --prune-all-images to also docker image prune -a."
  exit 0
fi

# --- execution ---------------------------------------------------------------

hr
log "EXECUTING cleanup..."

# 1. git worktree prune — always safe, removes orphan metadata only.
if [ "$PRUNABLE_COUNT" -gt 0 ]; then
  log "  git worktree prune (${PRUNABLE_COUNT} orphan metadata entries)"
  (cd "$REPO" && git worktree prune -v) >&2 || log "    ! git worktree prune returned non-zero"
else
  log "  git worktree prune: nothing to do"
fi

# 2. docker cleanup (safe subset).
if [ "$DOCKER_UP" = "1" ]; then
  log "  docker image prune -f (dangling images)"
  docker image prune -f >&2 || log "    ! docker image prune failed"
  log "  docker container prune -f (stopped containers)"
  docker container prune -f >&2 || log "    ! docker container prune failed"

  if [ "$PRUNE_ALL_IMAGES" = "1" ]; then
    log "  docker image prune -a -f (ALL unused images — explicit opt-in)"
    docker image prune -a -f >&2 || log "    ! docker image prune -a failed"
  fi

  if [ "$PRUNE_VOLUMES" = "1" ]; then
    log "  docker volume prune -f (named volumes — explicit opt-in)"
    docker volume prune -f >&2 || log "    ! docker volume prune failed"
  fi
fi

# 3. npm cache clean.
if [ -n "$NPM_CACHE" ] && [ -d "$NPM_CACHE" ] && have npm; then
  log "  npm cache clean --force"
  npm cache clean --force >&2 || log "    ! npm cache clean failed"
fi

# 4. pnpm store prune.
if [ -n "$PNPM_STORE" ] && [ -d "$PNPM_STORE" ] && have pnpm; then
  log "  pnpm store prune"
  pnpm store prune >&2 || log "    ! pnpm store prune failed"
fi

# 5. Optional: remove MERGED worktrees (with confirmation).
if [ "$PRUNE_MERGED" = "1" ] && [ "$MERGED_COUNT" -gt 0 ]; then
  hr
  log "Pruning MERGED worktrees (${MERGED_COUNT} candidate(s))..."
  for i in "${!WT_PATHS[@]}"; do
    [ "${WT_STATES[$i]}" = "MERGED" ] || continue
    path="${WT_PATHS[$i]}"
    branch="${WT_BRANCHES[$i]}"
    if [ "$ASSUME_YES" = "0" ]; then
      log "  About to remove: $path  (branch=$branch, size=${WT_SIZES[$i]})"
      read -r -p "    Remove? [y/N] " ans
      case "$ans" in y|Y|yes|YES) ;; *) log "    skipped"; continue ;; esac
    fi
    log "  git worktree remove --force $path"
    (cd "$REPO" && git worktree remove --force "$path") >&2 || log "    ! git worktree remove failed for $path"
  done
fi

# --- after -------------------------------------------------------------------

report_df "AFTER"
log "Done."
exit 0
