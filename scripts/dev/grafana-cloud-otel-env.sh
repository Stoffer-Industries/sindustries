#!/usr/bin/env bash
#
# grafana-cloud-otel-env.sh — derive the local OTel collector's Grafana Cloud
# export environment from the existing credential file.
#
# The collector forwards every local OTLP span and metric to Grafana Cloud. It
# needs two things: the OTLP gateway endpoint, and a real `Authorization` header
# value. Both already exist in `infra/cloud/observability/.env.local`; this
# helper reads them, normalizes them, and exports them into the process
# environment that starts the stack. It never writes a second secret file and
# never prints the credential.
#
# Why the header parsing exists: `GRAFANA_CLOUD_OTLP_HEADERS` is an OTLP
# exporter header *string* (`Authorization=Basic <base64>`), not a bare
# Authorization value. Interpolating it straight into a collector header would
# emit `Authorization: Authorization=Basic <base64>`, and the tenant answers 401.
# The rules here mirror `apps/gymtrack/api/telemetry.js::parseOtlpHeaderString()`
# exactly, so the two consumers cannot silently diverge.
#
# Why the endpoint is normalized: Grafana Cloud's OTLP gateway serves traces at
# `/otlp/v1/traces`; the same payload at `/v1/traces` is a 404. The credential
# file carries the bare gateway host, so the `/otlp` prefix is added here
# instead of being left to each call site.
#
# Usage:
#   source scripts/dev/grafana-cloud-otel-env.sh   # exports the two variables
#   scripts/dev/grafana-cloud-otel-env.sh [env-file]   # validate, print a summary
#
# Shell compatibility: bash 3.2 (the macOS system bash) is supported — no
# associative arrays.

# This file uses bash-only constructs (BASH_SOURCE, `local -a`, `printf -v`).
# Sourcing it from another shell would resolve the repository root to the wrong
# directory rather than fail loudly, so refuse non-bash shells outright.
if [ -z "${BASH_VERSION:-}" ]; then
  printf 'ERROR: grafana-cloud-otel-env: must be sourced from bash (this shell has no BASH_VERSION).\n' >&2
  exit 1
fi

# The header-name character class from RFC 7230 token, as used by the GymTrack
# parser. It is what decides whether a `=` starts a name/value pair or is just
# base64 padding.
GCOE_HEADER_NAME_RE='^[A-Za-z0-9!#$%&'"'"'*+.^_`|~-]+$'

# Set by gcoe_parse_headers: the parsed Authorization value, and how many
# headers the string carried.
GCOE_PARSED_AUTHORIZATION=""
GCOE_PARSED_COUNT=0

# Set by gcoe_normalize_endpoint.
GCOE_NORMALIZED_ENDPOINT=""

gcoe_fail() {
  printf 'ERROR: grafana-cloud-otel-env: %s\n' "$1" >&2
  exit 1
}

gcoe_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Percent-decode a header value. A value that is not valid percent-encoding is
# used as written, matching `decodeURIComponent`'s catch branch in the GymTrack
# parser.
gcoe_url_decode() {
  local s="$1" out="" hex ch
  while [[ -n "$s" ]]; do
    if [[ "$s" == "%"??* ]]; then
      hex="${s:1:2}"
      if [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
        printf -v ch "\\x$hex"
        out+="$ch"
        s="${s:3}"
        continue
      fi
    fi
    out+="${s:0:1}"
    s="${s:1}"
  done
  printf '%s' "$out"
}

# Parse an OTLP header string into its Authorization value.
#
# Mirrors the GymTrack parser: the string is a comma-separated list of
# `name=value` pairs; a segment whose first `=` is not preceded by a valid
# header name is treated as a bare Authorization value (that is how base64
# padding survives the split); a segment with no `=` at all is a bare
# Authorization value too; and a value is percent-decoded when it can be.
#
# Sets GCOE_PARSED_AUTHORIZATION and GCOE_PARSED_COUNT. Called directly (not in
# a command substitution) so the globals reach the caller.
gcoe_parse_headers() {
  local raw="$1"
  local trimmed part name value eq_index
  local -a segments

  GCOE_PARSED_AUTHORIZATION=""
  GCOE_PARSED_COUNT=0

  trimmed="$(gcoe_trim "$raw")"
  [[ -z "$trimmed" ]] && return 0

  IFS=',' read -r -a segments <<<"$trimmed"

  for segment in "${segments[@]}"; do
    part="$(gcoe_trim "$segment")"
    [[ -z "$part" ]] && continue

    if [[ "$part" != *=* ]]; then
      # No `=` at all — a bare Authorization value.
      GCOE_PARSED_AUTHORIZATION="$part"
      GCOE_PARSED_COUNT=$((GCOE_PARSED_COUNT + 1))
      continue
    fi

    eq_index="${part%%=*}"
    name="$(gcoe_trim "$eq_index")"

    if [[ ! "$name" =~ $GCOE_HEADER_NAME_RE ]]; then
      # Not a header pair. The `=` belongs to base64 padding, so the whole
      # segment is a bare Authorization value instead of being split on it.
      GCOE_PARSED_AUTHORIZATION="$part"
      GCOE_PARSED_COUNT=$((GCOE_PARSED_COUNT + 1))
      continue
    fi

    value="$(gcoe_url_decode "${part#*=}")"
    value="$(gcoe_trim "$value")"

    if [[ "$name" == "Authorization" ]]; then
      GCOE_PARSED_AUTHORIZATION="$value"
    fi
    GCOE_PARSED_COUNT=$((GCOE_PARSED_COUNT + 1))
  done

  return 0
}

# Normalize the OTLP gateway endpoint so the collector's `otlphttp` exporter
# posts to `/otlp/v1/traces`. An endpoint whose path is already `/otlp` is kept
# as-is; an empty path gains the prefix; any other path is refused, because
# posting to `/v1/traces` is a 404 on the tenant.
#
# Sets GCOE_NORMALIZED_ENDPOINT. Must be called directly, never in a command
# substitution: a failure exits the shell, and an exit inside a substitution
# would only end the subshell and let the caller carry on with an empty
# endpoint.
gcoe_normalize_endpoint() {
  local endpoint="$1"
  local scheme host path

  GCOE_NORMALIZED_ENDPOINT=""

  [[ -z "$endpoint" ]] && gcoe_fail "GRAFANA_CLOUD_OTLP_ENDPOINT is empty in the credential file."

  scheme="${endpoint%%://*}"
  if [[ "$scheme" != "https" && "$scheme" != "http" ]]; then
    gcoe_fail "GRAFANA_CLOUD_OTLP_ENDPOINT must start with http:// or https:// (got a '${scheme}://' scheme)."
  fi

  local rest="${endpoint#*://}"
  [[ "$rest" == "$endpoint" ]] && gcoe_fail "GRAFANA_CLOUD_OTLP_ENDPOINT is not a URL."
  host="${rest%%/*}"
  [[ -z "$host" ]] && gcoe_fail "GRAFANA_CLOUD_OTLP_ENDPOINT has no host."

  if [[ "$rest" == */* ]]; then
    path="/${rest#*/}"
    path="${path%%\?*}"
    path="${path%%#*}"
    path="${path%/}"
  else
    path=""
  fi

  case "$path" in
    "" | /otlp)
      GCOE_NORMALIZED_ENDPOINT="${scheme}://${host}/otlp"
      ;;
    /otlp/*)
      GCOE_NORMALIZED_ENDPOINT="${scheme}://${host}${path}"
      ;;
    *)
      gcoe_fail "GRAFANA_CLOUD_OTLP_ENDPOINT path '${path}' would post to '/v1/traces', which the Grafana Cloud OTLP gateway answers with 404. Use the '/otlp' prefixed gateway path (for example 'https://<gateway-host>/otlp')."
      ;;
  esac

  return 0
}

# Load the credential file and export the collector's export environment.
gcoe_load() {
  local env_file="${1:-}"
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

  if [[ -z "$env_file" ]]; then
    env_file="${GRAFANA_CLOUD_OTEL_ENV_FILE:-$repo_root/infra/cloud/observability/.env.local}"
    if [[ ! -f "$env_file" ]]; then
      # The credential file is excluded from git, so it exists only in the
      # canonical checkout. A git worktree shares the repository's common git
      # directory, which points back at that checkout — so this is the same
      # single file, not a second copy of the credential.
      local common_dir canonical_root
      common_dir="$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null || true)"
      if [[ -n "$common_dir" ]]; then
        canonical_root="$(cd "$(dirname "$common_dir")" 2>/dev/null && pwd || true)"
        if [[ -n "$canonical_root" && -f "$canonical_root/infra/cloud/observability/.env.local" ]]; then
          env_file="$canonical_root/infra/cloud/observability/.env.local"
        fi
      fi
    fi
  fi

  [[ -f "$env_file" ]] || gcoe_fail "credential file not found: $env_file"

  local endpoint="" headers_raw="" line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue
    key="$(gcoe_trim "${line%%=*}")"
    value="${line#*=}"
    # Strip surrounding quotes; the credential file is shell-sourceable.
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    case "$key" in
      GRAFANA_CLOUD_OTLP_ENDPOINT) endpoint="$value" ;;
      GRAFANA_CLOUD_OTLP_HEADERS) headers_raw="$value" ;;
    esac
  done <"$env_file"

  [[ -z "$endpoint" ]] && gcoe_fail "GRAFANA_CLOUD_OTLP_ENDPOINT is not set in $env_file."

  gcoe_parse_headers "$headers_raw"

  [[ "$GCOE_PARSED_COUNT" -eq 0 ]] && gcoe_fail "GRAFANA_CLOUD_OTLP_HEADERS is missing or empty in $env_file. The collector cannot authenticate to Grafana Cloud without it."
  [[ -z "$GCOE_PARSED_AUTHORIZATION" ]] && gcoe_fail "GRAFANA_CLOUD_OTLP_HEADERS in $env_file parsed to no Authorization header. The collector would send an unauthenticated request."

  gcoe_normalize_endpoint "$endpoint"

  GRAFANA_CLOUD_OTLP_ENDPOINT="$GCOE_NORMALIZED_ENDPOINT"
  GRAFANA_CLOUD_OTLP_AUTHORIZATION="$GCOE_PARSED_AUTHORIZATION"

  export GRAFANA_CLOUD_OTLP_ENDPOINT GRAFANA_CLOUD_OTLP_AUTHORIZATION
}

# Sourced: export the variables into the caller's shell.
# Executed: validate the credential file and print a secret-free summary.
#
# The sourced branch must not read "$1": when this file is sourced, "$1" is the
# *caller's* first argument, not this script's.
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  gcoe_load
else
  gcoe_load "${1:-}"
  printf 'grafana-cloud-otel-env: ok\n'
  printf '  endpoint (normalized): %s\n' "$GRAFANA_CLOUD_OTLP_ENDPOINT"
  printf '  authorization: parsed, %s chars, not shown\n' "${#GRAFANA_CLOUD_OTLP_AUTHORIZATION}"
fi
