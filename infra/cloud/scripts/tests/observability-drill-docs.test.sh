#!/usr/bin/env bash
# observability-drill-docs.test.sh — the operator-facing docs must not
# prescribe a failure drill that now refuses (task 219fb673, PR #936).
#
# WHAT THIS GUARDS
# -----------------
# `infra/cloud/observability/failure-inject.sh` refuses the
# service-scoped scenarios (`tasks-api-down/up`, `budget-api-down/up`).
# A refusal is correct — staging is ONE app, so scaling a per-service app
# is impossible and scaling the consolidated platform would be a
# full-platform outage wearing a service-scoped label.
#
# But a refusal in the SCRIPT with no matching refusal in the DOCS is a
# trap for the operator: `docs/runbooks/hosted-observability-ops.md` is
# the on-call procedure, and it told the on-call engineer to run
# `failure-inject.sh tasks-api-down`, which now exits 1 without doing
# anything. The engineer is left mid-procedure with no indication that
# the step is impossible.
#
# WHY A STATIC CHECK AND NOT A REVIEW
# -----------------------------------
# The refusal set is derived FROM THE SCRIPT, not hard-coded here, so the
# check cannot drift from the implementation: if a scenario starts
# refusing, this test starts requiring the docs to say so.
#
# The check is: every mention of a refused scenario in an operator-facing
# document must carry a refusal marker within a few lines. The marker
# vocabulary is deliberately broad — the point is that a reader meets an
# explanation, not that they meet one specific word.
#
# The same test also asserts the docs point at a SUPPORTED replacement,
# so the fix cannot degenerate into "there is no drill available" — and
# that the `deploy-failed` pair is not offered as one, because its alert
# file was removed (task 2c782afb AC3) so no live alert matches it.
#
# This is an offline test — no Fly or Grafana access required.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

FAILURE_INJECT="infra/cloud/observability/failure-inject.sh"

# The operator-facing documents that name failure-inject scenarios.
DOCS=(
  "docs/runbooks/hosted-observability-ops.md"
  "docs/systems/observability.md"
  "infra/cloud/observability/README.md"
)

# The scenarios that can still be run to induce a failure.
SUPPORTED_SCENARIOS=(redis-down db-down)

failures=0
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }
ok()   { echo "ok: $1"; }

# ---------- derive the refused scenarios FROM the script ------------------
#
# A scenario refuses when its function body calls
# refuse_service_scoped_target. Reading the call sites (rather than a
# hard-coded list) means the check follows the implementation.

scenario_functions() {
  grep -oE '^scenario_[a-z0-9_]+\(\)' "${REPO_ROOT}/${FAILURE_INJECT}" \
    | sed 's/()$//' \
    | sort -u
}

# The CLI scenario name for a scenario function: scenario_tasks_api_down
# -> tasks-api-down.
scenario_cli_name() {
  printf '%s\n' "${1#scenario_}" | tr '_' '-'
}

# A scenario refuses when its body calls refuse_service_scoped_target.
scenario_refuses() {
  local fn="$1" body
  body="$(awk -v fn="$fn" '
    $0 ~ "^"fn"\\(\\) \\{" { inside=1; next }
    inside && /^}/ { exit }
    inside { print }
  ' "${REPO_ROOT}/${FAILURE_INJECT}")"
  [[ -n "$body" ]] && grep -q "refuse_service_scoped_target" <<<"${body}"
}

ALL_SCENARIO_FUNCTIONS=()
while IFS= read -r fn; do
  [[ -n "$fn" ]] && ALL_SCENARIO_FUNCTIONS+=("$fn")
done < <(scenario_functions)

if [[ "${#ALL_SCENARIO_FUNCTIONS[@]}" -eq 0 ]]; then
  fail "could not derive the scenario functions from ${FAILURE_INJECT}"
else
  ok "derived ${#ALL_SCENARIO_FUNCTIONS[@]} scenario functions from ${FAILURE_INJECT}"
fi

refused_scenarios=()
for fn in "${ALL_SCENARIO_FUNCTIONS[@]}"; do
  if scenario_refuses "$fn"; then
    refused_scenarios+=("$(scenario_cli_name "$fn")")
  fi
done

if [[ "${#refused_scenarios[@]}" -eq 0 ]]; then
  fail "no scenario refuses a service-scoped target; the refusal contract is gone"
else
  ok "refused scenarios (derived from the script): ${refused_scenarios[*]}"
fi

# ---------- every mention must carry a refusal marker --------------------
#
# Marker vocabulary: a reader must meet an explanation of WHY the
# scenario is unavailable (or that it is no longer usable) within a few
# lines of the mention.

REFUSAL_MARKERS='refus|REFUSED|not implemented|unavailable|no longer|removed|not a usable'

# A mention of a refused scenario is EXEMPT when it is a reference to the
# ALERT rather than to the drill:
#
#   `sindustries-tasks-api-down`  — the alert UID (the alert is LIVE)
#   `tasks-api-down.json`         — the alert rule file (still committed)
#   | `tasks-api-down` | page |    — a row of the alert-ownership table
#
# The drill is gone; the alert is not. An operator reading the alerts
# table must find a live alert there, so those mentions are correct and
# must not be forced to carry a refusal marker.
is_alert_reference() {
  local line="$1"
  # An alert UID: the scenario name prefixed with the alert namespace.
  grep -qE "sindustries-[a-z0-9-]*${SCENARIO_IN_PROGRESS}" <<<"$line" && return 0
  # An alert rule file.
  grep -qE "${SCENARIO_IN_PROGRESS}\.json" <<<"$line" && return 0
  # A row of the alert-ownership table (it carries a severity column).
  grep -qE "\|[[:space:]]*(page|warn)[[:space:]]*\|" <<<"$line" && return 0
  return 1
}

check_doc_mentions() {
  local doc="$1"
  local path="$REPO_ROOT/$doc"
  if [[ ! -f "$path" ]]; then
    fail "$doc is missing"
    return 0
  fi

  local scenario lineno content context found_unmarked=0
  for scenario in "${refused_scenarios[@]}"; do
    SCENARIO_IN_PROGRESS="$scenario"
    # Every line that mentions the scenario name. `grep -n` prefixes the
    # line NUMBER, so the number and the content are read separately.
    while IFS=: read -r lineno content; do
      [[ -n "$lineno" ]] || continue
      # Alert references are exempt (see is_alert_reference).
      if is_alert_reference "$content"; then
        continue
      fi
      # The refusal marker may sit on the mention line or within three
      # lines either side of it.
      local from=$((lineno - 3))
      [[ "$from" -lt 1 ]] && from=1
      context="$(sed -n "${from},$((lineno + 3))p" "$path" 2>/dev/null || true)"
      if ! grep -qiE "$REFUSAL_MARKERS" <<<"${context}"; then
        fail "$doc:${lineno} mentions the refused scenario '${scenario}' with no refusal marker within three lines"
        found_unmarked=1
      fi
    done < <(grep -nE "${scenario}" "$path" || true)
  done

  if [[ "$found_unmarked" -eq 0 ]]; then
    ok "$doc: every mention of a refused scenario carries a refusal marker"
  fi
}

# ---------- a doc that names a refused drill must say so -------------------
#
# The failure this guards is an operator being HANDED A COMMAND THAT
# EXITS 1. That is sharper than "the scenario name is mentioned", so it
# gets its own check: every invocation of a refused scenario must be
# accompanied by the refusal.

check_doc_invocations() {
  local doc="$1"
  local path="$REPO_ROOT/$doc"
  [[ -f "$path" ]] || return 0

  local scenario lineno content context found_unmarked=0
  for scenario in "${refused_scenarios[@]}"; do
    while IFS=: read -r lineno content; do
      [[ -n "$lineno" ]] || continue
      local from=$((lineno - 3))
      [[ "$from" -lt 1 ]] && from=1
      context="$(sed -n "${from},$((lineno + 3))p" "$path" 2>/dev/null || true)"
      if ! grep -qiE "$REFUSAL_MARKERS" <<<"${context}"; then
        fail "$doc:${lineno} hands the operator a '${scenario}' command with no refusal marker within three lines"
        found_unmarked=1
      fi
    done < <(grep -nE "failure-inject\.sh[[:space:]]+[^[:space:]]*${scenario}" "$path" || true)
  done

  if [[ "$found_unmarked" -eq 0 ]]; then
    ok "$doc: no refused drill is handed to the operator as a command"
  fi
}

for doc in "${DOCS[@]}"; do
  check_doc_mentions "$doc"
  check_doc_invocations "$doc"
done

# ---------- the docs must point at a SUPPORTED replacement ----------------

for doc in "${DOCS[@]}"; do
  path="$REPO_ROOT/$doc"
  [[ -f "$path" ]] || continue
  missing=()
  for scenario in "${SUPPORTED_SCENARIOS[@]}"; do
    grep -qE "${scenario}" "$path" || missing+=("${scenario}")
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    fail "$doc does not name the supported replacement scenario(s): ${missing[*]}"
  else
    ok "$doc names the supported replacement scenarios (${SUPPORTED_SCENARIOS[*]})"
  fi
done

# ---------- deploy-failed must not be offered as a usable drill ----------
#
# Its alert file was removed (task 2c782afb AC3), so no live alert
# matches it. A doc may still MENTION it, but only to say it is removed
# or not usable.

for doc in "${DOCS[@]}"; do
  path="$REPO_ROOT/$doc"
  [[ -f "$path" ]] || continue
  while IFS=: read -r lineno content; do
    [[ -n "$lineno" ]] || continue
    from=$((lineno - 3))
    [[ "$from" -lt 1 ]] && from=1
    context="$(sed -n "${from},$((lineno + 3))p" "$path" 2>/dev/null || true)"
    if ! grep -qiE 'removed|no live alert|not a usable|disabled' <<<"${context}"; then
      fail "$doc:${lineno} mentions deploy-failed without saying its alert was removed"
    fi
  done < <(grep -nE 'deploy-failed' "$path" || true)
done
ok "deploy-failed is never offered as a usable drill"

# ---------- the script's own --help must mark the refusals ----------------
#
# The operator reads `--help` FIRST. The refusal was only in the body,
# so the help text still described scaling a per-service Fly app. The
# contract test `observability-bootstrap.test.sh` asserts all ten
# scenario names still appear in --help, so the fix is to ANNOTATE the
# refused ones, not to remove them.

help_out="$(bash "${REPO_ROOT}/${FAILURE_INJECT}" --help 2>&1)" || {
  fail "${FAILURE_INJECT} --help exited non-zero"
  help_out=""
}

for scenario in "${refused_scenarios[@]}"; do
  if ! grep -qE "(^| )${scenario}( |$)" <<<"${help_out}"; then
    fail "${FAILURE_INJECT} --help no longer lists the scenario '${scenario}'"
  fi
done
ok "${FAILURE_INJECT} --help still lists every scenario"

for scenario in "${refused_scenarios[@]}"; do
  # The scenario's own help block must say it is refused. Look at the
  # scenario's line and the lines that follow it, up to the next
  # scenario's line.
  block="$(awk -v s="${scenario}" '
    $0 ~ "^  "s" " { inside=1 }
    inside && /^  [a-z0-9-]+ +[A-Z]/ && $0 !~ "^  "s" " { exit }
    inside { print }
  ' <<<"${help_out}")"
  if ! grep -qiE 'REFUSED' <<<"${block}"; then
    fail "${FAILURE_INJECT} --help does not mark '${scenario}' as REFUSED"
  fi
done
ok "${FAILURE_INJECT} --help marks every refused scenario as REFUSED"

# ---------- the live alerts must be described as LIVE ---------------------
#
# The synthetic DRILL is gone; the ALERT is not. `sindustries-tasks-api-down`
# and `sindustries-budget-api-down` are still committed rules and must
# still fire on a real outage. A doc that leaves the reader thinking the
# alert is gone would leave a real outage unhandled.
#
# This is a POSITIVE assertion rather than a negative one: a doc that
# names the live alert must also say the alert is still live. (A negative
# check for "the alert is gone" would be satisfied by silence, which is
# the failure mode this guards.)

for doc in "${DOCS[@]}"; do
  path="$REPO_ROOT/$doc"
  [[ -f "$path" ]] || continue
  mentioned=0
  while IFS=: read -r lineno content; do
    [[ -n "$lineno" ]] || continue
    mentioned=1
    from=$((lineno - 8))
    [[ "$from" -lt 1 ]] && from=1
    context="$(sed -n "${from},$((lineno + 8))p" "$path" 2>/dev/null || true)"
    if ! grep -qiE 'still live|still fire|still fires|must still' <<<"${context}"; then
      fail "$doc:${lineno} names the live tasks-api-down/budget-api-down ALERT without saying it is still live; the drill is gone, the alert is not"
    fi
  done < <(grep -nE 'sindustries-(tasks-api|budget-api)-down' "$path" || true)
  if [[ "$mentioned" -eq 0 ]]; then
    ok "$doc does not mention the tasks-api-down/budget-api-down alerts at all"
  fi
done
ok "every doc that names a live down-alert says the alert is still live"

if [[ "$failures" -gt 0 ]]; then
  echo "observability-drill-docs: $failures failure(s)" >&2
  exit 1
fi

echo "observability-drill-docs: ok (${#DOCS[@]} docs, ${#refused_scenarios[@]} refused scenarios)"
