#!/usr/bin/env bash
# Guardian Cloud — dev-only helper.
# Logs in a test user against Supabase Auth and prints the access_token (JWT).
#
# Usage:
#   export SUPABASE_URL="https://xxxx.supabase.co"
#   export SUPABASE_ANON_KEY="eyJhbGci..."
#   export TEST_EMAIL="test@example.com"
#   export TEST_PASSWORD="..."
#   TOKEN=$(./scripts/get-token.sh)
#
# NOT for production. The test user must have "Auto Confirm" enabled in the
# Supabase dashboard, otherwise email confirmation blocks the login.

set -euo pipefail

: "${SUPABASE_URL:?SUPABASE_URL not set}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY not set (Dashboard → Settings → API → anon public)}"
: "${TEST_EMAIL:?TEST_EMAIL not set}"
: "${TEST_PASSWORD:?TEST_PASSWORD not set}"

RESPONSE=$(curl -sS -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

TOKEN=$(printf '%s' "$RESPONSE" | jq -r '.access_token // empty')

if [[ -z "$TOKEN" ]]; then
  echo "Auth failed. Response:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

printf '%s' "$TOKEN"
