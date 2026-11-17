#!/usr/bin/env bash
# scripts/cloud/database/manifest.sh
#
# Builds the evidence manifest for one transfer run: the SHA256 and size
# of every artefact the run produced, plus a roll-up verdict.
#
# The manifest is the AC1 evidence anchor. It answers, from one file:
#   - which artefacts did this run produce;
#   - what was each artefact's digest at the moment the run finished;
#   - did the reconciliation pass.
#
# The manifest covers ONLY files that already exist in the artefact
# directory. It never reads a database, never touches a DSN, and never
# writes anything outside the artefact directory. A run that failed
# half-way still produces a manifest — that is the point: the evidence
# of a failed run is the failed run's artefacts.
#
# Output:
#   ${CLOUD_DB_ARTIFACT_DIR}/manifest-<run-id>.json

set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

usage() {
  cat <<'USAGE'
Usage: manifest.sh [--artifact-dir <path>] [--output <path>] [--run-id <id>]

Optional:
  --artifact-dir <path>     Directory holding the run's artefacts.
                            Defaults to the environment's artifact directory
                            (./artifacts/cloud-staging,
                            ./artifacts/cloud-production).
  --output <path>           Manifest path. Defaults to
                            <artifact-dir>/manifest-<run-id>.json.
  --environment <staging|production>
                            Environment label. Defaults to the ENVIRONMENT
                            environment variable, then "staging".
  --run-id <id>             Run id recorded in the manifest. Defaults to
                            CLOUD_DB_RUN_ID, then a freshly assigned one.
  --help                    Show this help.
USAGE
}

ARTIFACT_DIR=""
OUTPUT_PATH=""
ENVIRONMENT="${ENVIRONMENT:-staging}"
RUN_ID="${CLOUD_DB_RUN_ID:-}"

while (( $# > 0 )); do
  case "$1" in
    --artifact-dir) ARTIFACT_DIR="$2"; shift 2;;
    --output)       OUTPUT_PATH="$2"; shift 2;;
    --environment)  ENVIRONMENT="$2"; shift 2;;
    --run-id)       RUN_ID="$2"; shift 2;;
    --help|-h)      usage; exit 0;;
    *)              cloud_db_die "unknown argument: $1";;
  esac
done

cloud_db_set_environment "$ENVIRONMENT"

if [[ -z "$RUN_ID" ]]; then
  cloud_db_assign_run_id
  RUN_ID="$CLOUD_DB_RUN_ID"
fi

ARTIFACT_DIR="${ARTIFACT_DIR:-$CLOUD_DB_ARTIFACT_DIR}"

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  cloud_db_die "artifact directory '$ARTIFACT_DIR' does not exist"
fi

OUTPUT_PATH="${OUTPUT_PATH:-${ARTIFACT_DIR}/manifest-${RUN_ID}.json}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

# ---------------------------------------------------------------------------
# Digest every artefact in the run directory.
#
# The manifest itself is excluded: it cannot contain its own digest. The
# archive files (.dump) are included — the backup digest is the evidence
# AC3 turns on.
# ---------------------------------------------------------------------------

FILES_JSON="$(
  python3 - "$ARTIFACT_DIR" "$OUTPUT_PATH" <<'PY'
import hashlib, json, os, pathlib, sys

artifact_dir = pathlib.Path(sys.argv[1])
output_path = pathlib.Path(sys.argv[2]).resolve()

entries = []
for path in sorted(artifact_dir.iterdir()):
    if not path.is_file():
        continue
    if path.resolve() == output_path:
        continue
    if path.name.startswith("manifest-") and path.suffix == ".json":
        # A manifest from an earlier run in the same directory is not
        # part of THIS run's evidence set.
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    entries.append({
        "name": path.name,
        "sizeBytes": path.stat().st_size,
        "sha256": digest,
    })

print(json.dumps(entries, sort_keys=True))
PY
)"

# ---------------------------------------------------------------------------
# Roll up the verdicts the run produced. A missing verdict is recorded
# as missing rather than as a pass: silence is not evidence.
# ---------------------------------------------------------------------------

VERDICTS_JSON="$(
  python3 - "$ARTIFACT_DIR" <<'PY'
import json, pathlib, sys

artifact_dir = pathlib.Path(sys.argv[1])
verdicts = {}

for path in sorted(artifact_dir.glob("*.json")):
    if path.name.startswith("manifest-"):
        continue
    try:
        payload = json.loads(path.read_text())
    except (ValueError, OSError):
        continue
    if not isinstance(payload, dict):
        continue
    verdict = payload.get("verdict")
    if isinstance(verdict, str):
        verdicts[path.name] = verdict

print(json.dumps(verdicts, sort_keys=True))
PY
)"

python3 - "$OUTPUT_PATH" "$RUN_ID" "$ENVIRONMENT" "$CLOUD_DB_KIND_PREFIX" \
        "$FILES_JSON" "$VERDICTS_JSON" <<'PY'
import datetime, json, sys

out_path, run_id, environment, kind_prefix, files_json, verdicts_json = sys.argv[1:]

files = json.loads(files_json)
verdicts = json.loads(verdicts_json)

envelope = {
  "schemaVersion": 1,
  "kind": f"{kind_prefix}-manifest",
  "environment": environment,
  "runId": run_id,
  "generatedAt": datetime.datetime.now(datetime.timezone.utc)
                 .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
  "artifactCount": len(files),
  "files": files,
  "verdicts": verdicts,
  "reconcileVerdict": next(
      (v for name, v in sorted(verdicts.items()) if name.startswith("reconcile-") and "recovery" not in name),
      None,
  ),
}
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(envelope, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY

cloud_db_info "manifest written to ${OUTPUT_PATH} (${ARTIFACT_DIR})"
printf '%s\n' "$OUTPUT_PATH"
