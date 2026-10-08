#!/usr/bin/env bash
# Live GymTrack Clerk -> Supabase Third-Party Auth -> PostgREST RLS test.
#
# Unlike the original Slice B harness, this script never synthesizes database
# claims with set_config. It mints real Clerk session JWTs for two existing
# test users, sends them through Supabase's public Data API, and proves each
# principal sees its own fixture but not the other principal's fixture.

set -euo pipefail

SUPABASE_URL="${SUPABASE_URL:-${GYMTRACK_SUPABASE_URL:-}}"
SUPABASE_PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-${GYMTRACK_SUPABASE_PUBLISHABLE_KEY:-}}"
CLERK_TEST_USER_A_ID="${CLERK_TEST_USER_A_ID:-${CLERK_TEST_USER_A_SUB:-}}"
CLERK_TEST_USER_B_ID="${CLERK_TEST_USER_B_ID:-${CLERK_TEST_USER_B_SUB:-}}"

for command_name in curl jq node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: required command is missing: $command_name" >&2
    exit 2
  fi
done

for variable_name in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_PAT CLERK_SECRET_KEY CLERK_TEST_USER_A_ID CLERK_TEST_USER_B_ID; do
  if [ -z "${!variable_name:-}" ]; then
    echo "ERROR: $variable_name must be set" >&2
    exit 2
  fi
done

if ! [[ "$CLERK_TEST_USER_A_ID" =~ ^user_[A-Za-z0-9]+$ ]] ||
   ! [[ "$CLERK_TEST_USER_B_ID" =~ ^user_[A-Za-z0-9]+$ ]]; then
  echo "ERROR: Clerk test user ids must use the expected user_<alphanumeric> shape" >&2
  exit 2
fi

if [ "$CLERK_TEST_USER_A_ID" = "$CLERK_TEST_USER_B_ID" ]; then
  echo "ERROR: the two Clerk test user ids must be different" >&2
  exit 2
fi

PROJECT_REF="$(node -e "console.log(new URL(process.argv[1]).hostname.split('.')[0])" "$SUPABASE_URL")"
RUN_MARKER="slice-b-$(date -u +%Y%m%dT%H%M%SZ)-$$"
SESSION_A_ID=""
SESSION_B_ID=""

management_query() {
  local sql="$1"
  jq -n --arg query "$sql" '{query: $query}' |
    curl --fail --silent --show-error -X POST -H "Authorization: Bearer $SUPABASE_PAT" -H "Content-Type: application/json" --data-binary @- "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query"
}

revoke_session() {
  local session_id="$1"
  if [ -n "$session_id" ]; then
    curl --fail --silent --show-error -X POST -H "Authorization: Bearer $CLERK_SECRET_KEY" "https://api.clerk.com/v1/sessions/$session_id/revoke" >/dev/null || true
  fi
}

cleanup() {
  management_query "
    delete from public.workouts where notes in ('$RUN_MARKER-a', '$RUN_MARKER-b');
    delete from public.profiles
      where clerk_user_id in ('$CLERK_TEST_USER_A_ID', '$CLERK_TEST_USER_B_ID')
        and email like 'slice-b-%@gymtrack-test.local';
  " >/dev/null || true
  revoke_session "$SESSION_A_ID"
  revoke_session "$SESSION_B_ID"
}
trap cleanup EXIT

echo "→ Verifying Supabase Third-Party Auth control-plane configuration"
TPA_JSON="$(
  curl --fail --silent --show-error -H "Authorization: Bearer $SUPABASE_PAT" "https://api.supabase.com/v1/projects/$PROJECT_REF/config/auth/third-party-auth"
)"

CLERK_ISSUER="$(
  jq -er '
    map(select(.type == "clerk" or .type == "custom"))
    | map(select(.oidc_issuer_url != null and ((.resolved_jwks.keys // []) | length) > 0))
    | first
    | .oidc_issuer_url
  ' <<<"$TPA_JSON"
)"

create_clerk_session() {
  local user_id="$1"
  jq -n --arg user_id "$user_id" '{user_id: $user_id}' |
    curl --fail --silent --show-error -X POST -H "Authorization: Bearer $CLERK_SECRET_KEY" -H "Content-Type: application/json" --data-binary @- "https://api.clerk.com/v1/sessions"
}

create_clerk_token() {
  local session_id="$1"
  curl --fail --silent --show-error -X POST -H "Authorization: Bearer $CLERK_SECRET_KEY" "https://api.clerk.com/v1/sessions/$session_id/tokens" |
    jq -er '.jwt'
}

SESSION_A_JSON="$(create_clerk_session "$CLERK_TEST_USER_A_ID")"
SESSION_B_JSON="$(create_clerk_session "$CLERK_TEST_USER_B_ID")"
SESSION_A_ID="$(jq -er '.id' <<<"$SESSION_A_JSON")"
SESSION_B_ID="$(jq -er '.id' <<<"$SESSION_B_JSON")"
TOKEN_A="$(create_clerk_token "$SESSION_A_ID")"
TOKEN_B="$(create_clerk_token "$SESSION_B_ID")"

assert_token_claims() {
  local token="$1"
  local expected_sub="$2"
  local expected_issuer="$3"
  TOKEN_TO_CHECK="$token" EXPECTED_SUB="$expected_sub" EXPECTED_ISSUER="$expected_issuer" node <<'NODE'
const [, payload] = process.env.TOKEN_TO_CHECK.split('.');
const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
const normalize = (value) => value.replace(/\/$/, '');
if (claims.sub !== process.env.EXPECTED_SUB) {
  throw new Error('Clerk token subject does not match the requested test user');
}
if (claims.role !== 'authenticated') {
  throw new Error('Clerk token is missing role=authenticated required by Supabase');
}
if (normalize(claims.iss) !== normalize(process.env.EXPECTED_ISSUER)) {
  throw new Error('Clerk token issuer does not match the Supabase TPA integration');
}
NODE
}

assert_token_claims "$TOKEN_A" "$CLERK_TEST_USER_A_ID" "$CLERK_ISSUER"
assert_token_claims "$TOKEN_B" "$CLERK_TEST_USER_B_ID" "$CLERK_ISSUER"

echo "→ Seeding isolated profiles and workout fixtures through the admin plane"
SEED_RESULT="$(
  management_query "
    insert into public.profiles (clerk_user_id, email, email_verified, signup_source)
    values
      ('$CLERK_TEST_USER_A_ID', '$RUN_MARKER-a@gymtrack-test.local', true, 'clerk_import'),
      ('$CLERK_TEST_USER_B_ID', '$RUN_MARKER-b@gymtrack-test.local', true, 'clerk_import')
    on conflict (clerk_user_id) where clerk_user_id is not null
    do update set email = excluded.email, email_verified = true;

    insert into public.workouts (user_id, notes)
    select id, '$RUN_MARKER-a' from public.profiles
      where clerk_user_id = '$CLERK_TEST_USER_A_ID';
    insert into public.workouts (user_id, notes)
    select id, '$RUN_MARKER-b' from public.profiles
      where clerk_user_id = '$CLERK_TEST_USER_B_ID';

    select clerk_user_id, id
    from public.profiles
    where clerk_user_id in ('$CLERK_TEST_USER_A_ID', '$CLERK_TEST_USER_B_ID')
    order by clerk_user_id;
  "
)"

PROFILE_A_ID="$(jq -er --arg subject "$CLERK_TEST_USER_A_ID" '.[] | select(.clerk_user_id == $subject) | .id' <<<"$SEED_RESULT")"
PROFILE_B_ID="$(jq -er --arg subject "$CLERK_TEST_USER_B_ID" '.[] | select(.clerk_user_id == $subject) | .id' <<<"$SEED_RESULT")"

query_workouts() {
  local token="$1"
  curl --fail --silent --show-error --get -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H "Authorization: Bearer $token" --data-urlencode "select=id,user_id,notes" --data-urlencode "notes=like.$RUN_MARKER-*" "$SUPABASE_URL/rest/v1/workouts"
}

echo "→ Querying Supabase Data API with two real Clerk bearer tokens"
USER_A_ROWS="$(query_workouts "$TOKEN_A")"
USER_B_ROWS="$(query_workouts "$TOKEN_B")"

jq -e --arg owner "$PROFILE_A_ID" --arg notes "$RUN_MARKER-a" '
  length == 1 and .[0].user_id == $owner and .[0].notes == $notes
' <<<"$USER_A_ROWS" >/dev/null

jq -e --arg owner "$PROFILE_B_ID" --arg notes "$RUN_MARKER-b" '
  length == 1 and .[0].user_id == $owner and .[0].notes == $notes
' <<<"$USER_B_ROWS" >/dev/null

echo "PASS: Supabase accepted both Clerk JWTs; each user saw exactly its own fixture"
