---
status: shipped
task_id: 83edc146-4144-445b-9f5c-f865ef2ec750
product_spec: n/a
shipped_pr: 924
shipped_date: 2026-11-07
---

# Fix GymTrack MCP lockfile verification argv overflow

## Product intent

Restore the GymTrack MCP production deployment gate without weakening lockfile-fidelity checks. The image's potentially large `npm ls --json` payload must cross the shell/Node boundary through a size-safe channel, and version mismatches must still fail with specific diagnostics.

## Delivery metadata

- Task: `83edc146-4144-445b-9f5c-f865ef2ec750` — Fix gymtrack-mcp production lockfile verification argv overflow
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-83edc146-gymtrack-argv`
- Worktree: a local git worktree of the implementation branch (operator-specific path, intentionally not recorded here)
- Product spec: n/a; the task description is the accepted behavioural contract

## Ownership boundary

This is a GitHub Actions container-verification contract. The workflow owns the check, while `package-lock.json` remains the dependency-version source of truth and the built image remains the observed runtime graph. No application, API, database, or shared-package state is introduced.

The durable solution is to stream or file-transfer JSON into one verifier instead of passing an unbounded document in argv. That keeps one comparison implementation and removes the operating-system argument-size dependency rather than increasing shell limits or truncating evidence.

## `.openclaw` boundary

The repository fix covers the verifier. `FLY_API_TOKEN` is an external GitHub `production` environment secret and cannot be supplied by repository code. Tom must configure that secret; the workflow's existing fail-fast credential check remains the verification surface and no secret value will be logged or committed.

## Current failure

The workflow captures the full image `npm ls --omit=dev --depth=0 --json` output, then passes it as `process.argv[1]` to multiple `node -e` invocations. The dependency graph is large enough to exceed the runner's exec argv limit, so Node never starts and the fidelity assertions never run.

## Implementation plan

1. Extract the dependency comparison into a small repository script under the existing cloud/deployment test tooling boundary, or use a checked-in script colocated with GymTrack MCP deployment verification.
2. Pipe the image's `npm ls` JSON to the verifier over stdin or write it to a temporary file; never place the full JSON in an argv element or environment variable.
3. Have the verifier read expected direct versions from the root `package-lock.json`, validate the observed graph, and emit the existing specific failure classes: invalid graph, missing dependency, and version mismatch.
4. Preserve the Dockerfile `npm install` lint and production deploy/smoke sequence.
5. Add deterministic tests with a payload larger than typical argv limits plus invalid, missing, matching, and mismatched dependency fixtures.
6. Leave the production-secret requirement explicit in the task evidence; live AC3/AC4 completion requires Tom to configure `FLY_API_TOKEN` and a subsequent main run.

## Data model and API contracts

No application data model or HTTP API changes. The internal verifier input is JSON from `npm ls`; expected versions come directly from `package-lock.json`. Its process contract is exit code 0 on an exact match and non-zero with a specific diagnostic on invalid, missing, or mismatched dependencies.

## Workflow, cron, and skill changes

- GitHub Actions: replace argv-based JSON parsing in `.github/workflows/gymtrack-mcp-deploy.yml` with the size-safe verifier invocation.
- Repository test tooling: add unit/static coverage for the verifier and workflow invocation.
- Cron and skills: none.

## Verification plan

| Acceptance criterion | Verification |
| --- | --- |
| AC1: JSON does not cross argv | Static workflow test asserts stdin/file transport; unit test feeds a synthetic payload larger than normal argv limits and observes successful parsing. |
| AC2: mismatch checks retain their teeth | Unit tests cover valid match, malformed/invalid graph, missing `express`, missing `@supabase/supabase-js`, and version mismatch with specific non-zero diagnostics. |
| AC3: production deploy completes | Run workflow/unit checks in PR; final proof is a main run touching the GymTrack MCP path after the production secret is present. |
| AC4: production `FLY_API_TOKEN` configured | External operator step by Tom; verify through the existing `Require Fly deployment credential` step and successful Fly validation/deploy. |

Browser E2E is not applicable: this is a machine-facing deployment gate. Unit tests plus a workflow static check cover repository behaviour; the existing production health and OAuth smoke checks provide live integration evidence.

## Risks and mitigations

- Shell pipelines can mask producer failures. Keep `set -euo pipefail` and ensure the verifier consumes stdin without swallowing `docker run` failures.
- `npm ls` may exit non-zero while still emitting useful JSON. Preserve explicit invalid-graph diagnostics and choose a transport that retains both output and exit status.
- A temporary file may leak build metadata if not cleaned. Prefer stdin; if a file is needed, use the runner temp directory with a cleanup trap.
- AC3 remains externally blocked until AC4 is complete. Record that dependency explicitly rather than weakening or bypassing the credential check.

## Open questions

None for the repository change. Tom's GitHub environment-secret action is already identified and independently tracked as the external completion step.
