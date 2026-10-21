---
status: draft
task_id: f3909b89-a4a9-416e-b865-b0ff517ac54c
product_spec: brain/tasks/specs/open/bootstrap-observability-validate-resolves-endpoints.md
shipped_pr: null
shipped_date: null
---

# Make `bootstrap-observability.sh validate` resolve endpoints, not just collect them

## Links and delivery metadata

- Task: `f3909b89-a4a9-416e-b865-b0ff517ac54c`
- Task title: `💻 Make bootstrap-observability.sh validate resolve endpoints, not just collect them`
- Task type: `code` (`code-task-workflow`)
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-f3909b89-bootstrap-observability-validate-resolves-endpoints`
- Tech design: `docs/specs/bootstrap-observability-validate-resolves-endpoints-tech-design.md`
- Source of truth for the motivating defects: PR #836's AC4 live-verification probes (task `e89db27f`)
- Retro source: `brain/ops/retro-notes/2026-10-21.md` — quinn, bad, `config-presence-checks-never-resolve-endpoints`

## Clarification and assumptions

No clarification is needed before design approval: the task body already fixes the status taxonomy as the oracle, names every endpoint to probe, and states the exit-code semantics. Every assumption below is either verifiable in the current script or explicitly fenced as a stop condition.

Assumptions:

1. **The script's current presence-only behaviour is correct and must not regress.** `step_validate` (`infra/cloud/observability/bootstrap-observability.sh:271-304`) checks presence of `REQUIRED_VARS` and clamps its exit code to 125 so a single missing var stays scriptable. AC3 requires that path be byte-for-byte unchanged in behaviour. Probing is *additive*, layered after the presence loop, and must not alter how missing vars are counted or reported.
2. **Probes are unauthenticated by default.** The design sends no credential on the probe request. This is what makes 401/302 *informative* rather than *masked* — the taxonomy in AC2 is defined over the unauthenticated response. Authenticated probing is deliberately excluded: it would require loading `GRAFANA_CLOUD_PROVISIONING_AUTH` into the probe path, which widens the secret-handling surface AC4 exists to constrain.
3. **`GRAFANA_CLOUD_LOKI_ENDPOINT` is the motivating gap.** AC6 names it as the var whose absence from every doc made the original AC4 sequence ambiguous. It is optional (the relay derives a Loki push URL from `GRAFANA_CLOUD_OTLP_ENDPOINT` when unset), so it is probed only when set — presence semantics, not a new `REQUIRED_VARS` entry.
4. **Fly API reachability is probed unauthenticated** against `https://api.fly.io/`. A 401 there is the expected healthy answer and must not fail pre-flight.
5. **Implementation must stop** if the current `step_validate` on `origin/main` differs materially from the line references above, or if `infra/cloud/scripts/tests/observability-bootstrap.test.sh` has no harness capable of stubbing `curl` (AC5 depends on that harness existing).

## The problem, stated precisely

`validate` answers "are the variables populated?" and nothing else. During PR #836's AC4 probe, five defects surfaced *by hand* at exactly the moment an operator was about to run the step live:

- OTLP vs Loki path shape confusion (`/otlp/v1/logs` vs `/loki/api/v1/push`) — the same host serves both;
- a wrong host/path pairing that returned 404 rather than an obvious misconfiguration;
- an instance URL that redirected (302) to an auth wall;
- a gateway-origin failure (530) that read as "telemetry is broken" hours later;
- `GRAFANA_CLOUD_LOKI_ENDPOINT` existing in code but documented nowhere.

Each was invisible to a green pre-flight. This design makes `validate` resolve the endpoints so a wrong shape fails fast with a nameable cause.

## Scope

In scope:

- A single shared endpoint table in `bootstrap-observability.sh` driving both the `validate` probes and the generated documentation fragment (AC6).
- `step_probe_endpoints`: read-only reachability probe per endpoint, one status line each (AC1).
- Status → taxonomy classification naming the specific env var to fix (AC2).
- Exit-code semantics: non-zero on path-absent / gateway-origin-failure only; auth-required and instance-auth-wall are reported but non-blocking (AC3).
- Secret-hygiene guards in every probe output path, including error paths (AC4).
- Test coverage in `infra/cloud/scripts/tests/observability-bootstrap.test.sh`, mutation-verified non-vacuous (AC5).
- Documented endpoint shapes in `infra/cloud/observability/env/.env.example` and `docs/systems/observability.md`, generated from the shared table (AC6).

Out of scope:

- **Fixing any of the five original defects.** This task makes them *detectable*; it does not change any Grafana, Fly, or telemetry configuration.
- Authenticated probing, or using probe success as a credential-correctness check. Out of scope by assumption 2.
- Any change to the `dashboards`, `alerts`, `smoke`, or `secrets` steps.
- Any change to `apps/gymtrack/api/telemetry.js` or any telemetry code path. This belongs to the script, not the telemetry path.
- Quinn's retro suggested-action (2). Per the task body it is in scope only "if it stays cheap once AC1–AC5 land"; it is not cheap and is explicitly deferred.

## Design

### 1. Single shared endpoint table (AC6)

The crux. A flat `REQUIRED_VARS` array cannot drive docs, so it is *not* extended. A parallel table is introduced as the single source of truth:

```bash
# Shared endpoint table: var|env-var|URL template|role
# Drives step_validate's probes AND the generated docs fragment.
# Adding an endpoint here must not require a second edit in docs — see
# render_endpoint_docs(). Fields are pipe-delimited; no field may contain '|'.
ENDPOINT_SPECS=(
  "GRAFANA_CLOUD_OTLP_ENDPOINT|${GRAFANA_CLOUD_OTLP_ENDPOINT}|otlp-endpoint"
  "GRAFANA_CLOUD_LOKI_ENDPOINT|${GRAFANA_CLOUD_LOKI_ENDPOINT}|loki-push-endpoint"
  "GRAFANA_CLOUD_INSTANCE_URL|${GRAFANA_CLOUD_INSTANCE_URL}|grafana-instance"
  "FLY_API|https://api.fly.io/|fly-api"
)
```

Design decisions:

- **Pipe-delimited fields, not associative arrays.** A `declare -A` table reads better but is unavailable under the script's `sh`-compatible constraints in some CI shells; the existing script already uses plain indexed arrays (`REQUIRED_VARS`, line 152). Consistency with the surrounding code wins, and the delimiter rule is stated in a comment.
- **URL template is evaluated at probe time, not declaration time**, because the table is built after `source_env_local` (line 279) has populated the environment. This is why the table is declared inside the step, not at file scope.
- **`GRAFANA_CLOUD_LOKI_ENDPOINT` is marked optional** (assumption 3). Its row is skipped when the var is unset — unlike the `REQUIRED_VARS` loop, which must still report it as absent if it were required. Optionality is a property of the row, not an inference from emptiness.
- **`render_endpoint_docs()`** emits the endpoint table into the docs fragment consumed by AC6, so the documented set and the probed set cannot drift. The generation runs under `--dry-run` and is diffed in CI by the existing `infra/cloud bootstrap + fly.toml` test job.

### 2. Probe mechanics (AC1, AC4)

Reuses the status-probe idiom already proven twice in this script (`ensure_grafana_folder` at :197, `upsert_grafana_alert_rule` at :225):

```bash
probe_status() {
  local url="$1" status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time "${PROBE_TIMEOUT:-10}" \
    --connect-timeout 5 \
    "$url")" || status="000"
  printf '%s' "${status}"
}
```

Decisions:

- **No `--fail`.** The existing probes use `--fail` because they *want* a nonzero exit on non-2xx. Here the opposite: the status code *is* the signal. Using `--fail` would collapse every distinct taxonomy code into exit 22 and destroy AC2's oracle.
- **`--output /dev/null`** — response bodies are never captured, so a misconfigured endpoint cannot spill content into operator scrollback. This is AC4's main enforcement point.
- **`--max-time` / `--connect-timeout`** are bounded so a black-holed host cannot hang pre-flight. Default 10s/5s, overridable via `PROBE_TIMEOUT` for slow CI.
- **curl failure → `000`**, distinguished from a genuine status so a DNS failure is not reported as "endpoint returned 000" without explanation.

**Known subtlety — method mismatch on the Loki push path.** `GET /loki/api/v1/push` returns **405 Method Not Allowed** on a correctly-configured Grafana Cloud instance, because that path only accepts `POST`. A naive 2xx-only reachability check would report a healthy endpoint as broken — the mirror image of the original bug. The classifier therefore treats **405 as proof the path exists**, alongside 401/302. This is called out here because it is the single most likely way a first implementation gets AC1 wrong.

### 3. Classification (AC2)

| Status | Meaning | Classification | Blocks pre-flight? |
|---|---|---|---|
| `000` | no response (DNS/TLS/timeout) | `unreachable` | **yes** |
| 2xx | reachable, no auth required | `ok` | no |
| 401 | host + path both exist, auth required | `auth-required` | no |
| 302 / 303 | instance auth wall | `instance-auth-wall` | no |
| 404 | path absent — **endpoint shape is wrong** | `path-absent` | **yes** |
| 405 | path exists, wrong method (expected on Loki push) | `method-not-allowed` | no |
| 530 | gateway origin failure | `gateway-origin-failure` | **yes** |
| 5xx other | origin error | `origin-error` | **yes** |

Each line prints the classification, the observed status, the endpoint's **host + path** (never query, never a header), and — for blocking classes — the specific env var to fix:

```
[FAIL] path-absent       404  otlp-gateway-prod-au-southeast-1.grafana.net/loki/api/v1/push
       → fix GRAFANA_CLOUD_LOKI_ENDPOINT (path absent on host; expected /loki/api/v1/push)
[OK]   auth-required     401  sindustries.grafana.net/api/health
[OK]   method-not-allowed 405  logs-prod-au-southeast-1.grafana.net/loki/api/v1/push
```

### 4. Exit-code semantics (AC3)

- Presence failures keep the existing clamp-and-return path untouched (assumption 1) — probe results never *replace* it.
- Probe failures increment a **separate** counter. On return, `probe_failures` is clamped to the same 125 ceiling and **added** to the presence-failure count only when presence was already clean. This preserves "a single missing var stays scriptable" while not letting 8 endpoint failures return an un-clamped code.
- Rationale for 401/302/405 being non-blocking: an operator whose Grafana Cloud requires auth has a *correctly configured* endpoint. Failing pre-flight there would make the check useless in the real world — it would be red on every correctly-provisioned instance.

### 5. Test coverage (AC5)

Added to `infra/cloud/scripts/tests/observability-bootstrap.test.sh`, stubbing `curl` on `PATH` with a dispatcher that returns a scripted status per URL:

| Case | Scripted status | Asserts |
|---|---|---|
| path-absent | 404 | `validate` exits non-zero; output names `GRAFANA_CLOUD_LOKI_ENDPOINT` |
| auth-required | 401 | exits zero; output says `auth-required`, **not** `path-absent` |
| healthy | 200 | exits zero; output says `ok` |
| method-not-allowed | 405 | exits zero; output says `method-not-allowed` |
| gateway-origin | 530 | exits non-zero |
| unreachable | curl exits non-zero | status reported `000`, exits non-zero |
| presence regression | n/a | a missing var still returns its clamped presence exit code |
| secret hygiene | 401 + real-looking values in env | `GRAFANA_CLOUD_OTLP_HEADERS` / `PROVISIONING_AUTH` values appear **nowhere** in output |
| doc parity | n/a | every `ENDPOINT_SPECS` var appears in the generated docs fragment |

**Non-vacuity is a required test property** (AC5), not an assertion in the suite. Verification procedure: neuter `step_probe_endpoints` to a no-op, re-run the suite, and confirm the 404/530/000 cases fail. A passing suite against a neutered probe is a failed suite. The existing suite already uses this mutation-verification idiom for the redaction assertions on #836, so it is an established convention in this repo rather than a new burden.

### 6. Documentation (AC6)

`infra/cloud/observability/env/.env.example` and `docs/systems/observability.md` gain the endpoint table with a required **shape** note per endpoint (e.g. `GRAFANA_CLOUD_LOKI_ENDPOINT` must end in `/loki/api/v1/push`, not `/otlp/v1/logs`) — the exact confusion that cost the AC4 probe sequence its afternoon. Both are generated from `ENDPOINT_SPECS` via `render_endpoint_docs()`, so AC6's "a var that exists in code cannot be missing from every doc" is enforced structurally rather than by review discipline.

## Risks and tradeoffs

1. **Probes make `validate` network-dependent.** A previously offline-safe command now needs egress. Mitigation: probes are skipped when the endpoint var is unset, `PROBE_SKIP_NETWORK=1` disables them for air-gapped CI, and curl is already a declared requirement for other steps — no new dependency.
2. **Rate-limiting / flakiness against real Grafana Cloud.** `validate` will fire ~4 unauthenticated requests. Acceptable, but `render_endpoint_docs` and the test harness must not run probes against production in CI — the test stubs `curl`, so it cannot.
3. **The 405-tolerant rule could mask a genuinely wrong method config.** Accepted: for this script's purpose (does the path exist and is the shape right), 405 is strictly better evidence than a false 404-shaped failure. Documented at the classifier so the next reader does not "fix" it back to 2xx-only.
4. **`ENDPOINT_SPECS` as a third array next to `REQUIRED_VARS` risks the very drift AC6 targets.** Mitigation: `render_endpoint_docs()` plus the doc-parity test make drift a test failure rather than a review catch. Accepted residual risk is the reverse case — an endpoint probed but deliberately undocumented — which the table's explicit `role` field forces a decision about.
5. **Exit-code addition could surprise existing callers.** Mitigation: no call site changes (`validate` is invoked at :497 alongside other steps); presence-path behaviour is unchanged by construction; the clamp bounds the new code.

## Alternatives considered

- **Rewrite the whole script as a POSIX `sh` program with a proper HTTP helper.** Rejected as disproportionate. The ACs are about one step's observability; a rewrite multiplies review surface and regression risk across `dashboards`/`alerts`/`smoke`/`secrets`, none of which are in scope.
- **Have the relay self-report endpoint health instead of the script probing.** Rejected: it inverts the dependency (the relay needs the endpoint to work before it can report on it) and would not catch a bad path at pre-flight time, which is the entire point.
- **Authenticated probes to distinguish 401-as-correct from 401-as-wrong-credentials.** Rejected per assumption 2: it widens secret handling for a distinction AC2 does not require — the taxonomy treats 401 as a single informative class.

## Verification

1. `bash infra/cloud/scripts/tests/observability-bootstrap.test.sh` — all cases pass.
2. Mutation check: neuter `step_probe_endpoints`, re-run, confirm 404/530/000 cases fail (AC5 non-vacuity).
3. `bash infra/cloud/observability/bootstrap-observability.sh validate --dry-run` — prints one line per endpoint, no secret values (AC1, AC4).
4. Doc parity: `bash bootstrap-observability.sh validate --dry-run | grep -A40 'endpoint table'` matches the committed docs fragment (AC6).
5. Existing CI job `infra/cloud bootstrap + fly.toml + no-pnpm-pin tests` stays green.