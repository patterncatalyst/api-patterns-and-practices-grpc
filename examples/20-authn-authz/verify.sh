#!/usr/bin/env bash
# examples/20-authn-authz/verify.sh
#
# Ch20 authn-authz — JWT-validating + per-method-authorizing
# ServerInterceptor in front of shipping.routing.v1.RoutingService, on both
# stacks. Six assertions per stack:
#
#   1. Reflection works WITHOUT a token (grpcurl `list`) — the exemption
#      from Chapter 12 carried forward unchanged.
#   2. A VALID token -> GetQuote answers OK with the normal Ch5/Ch12 quote
#      (semantic check on response fields, not just a status code).
#   3. NO token -> UNAUTHENTICATED (lib.sh's grpc_expect_code; calling with
#      no -H IS what "metadata absent" means on the wire).
#   4. A BAD-SIGNATURE token (signed with the wrong secret) -> UNAUTHENTICATED.
#   5. An EXPIRED token (good signature, past exp) -> UNAUTHENTICATED — proves
#      the interceptor checks exp, not just the signature.
#   6. A token with the WRONG SCOPE, called against ListRoutes (the
#      per-method-gated RPC requiring routes:admin) -> PERMISSION_DENIED.
#      This is the authn-succeeds/authz-fails case: the token is perfectly
#      valid, it simply isn't entitled to this method. The interceptor
#      returns PERMISSION_DENIED BEFORE RoutingServiceImpl/
#      RoutingServiceServicer.ListRoutes ever runs — independent of whether
#      ListRoutes itself is implemented (it answers UNIMPLEMENTED on both
#      stacks, but that's a separate, later fact; see README.md).
#
# lib.sh's grpc_call/grpc_expect_code don't pass `-H`, so every header case
# below calls grpcurl directly (same convention as Ch12's verify.sh). Tokens
# are minted at RUNTIME by the bundled python/app/mint_token.py, run via
# `docker compose run --entrypoint python` against the already-built python
# image — no IdP, no network, deterministic `exp` relative to "now".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch20-auth"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

GETQUOTE_METHOD="shipping.routing.v1.RoutingService/GetQuote"
LISTROUTES_METHOD="shipping.routing.v1.RoutingService/ListRoutes"

# Same single-cargo-item request Ch12's verify.sh uses: 1000kg * 2.50 = 2500.00.
GETQUOTE_REQUEST='{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}'
EXPECT_QUOTE_AMOUNT="2500.00"

# --- local helpers (verify.sh-only; lib.sh is shared and not modified) -----

# mint_token <case> — runs the bundled Python token minter from the
# already-built python image (no second image to build); prints ONLY the
# encoded JWT (mint_token.py's own stdout contract).
mint_token() {
  local case="$1"
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps \
    --entrypoint python python -m app.mint_token "$case"
}

# expect_code_with_header <target> <method> <json> <token> <expected_code> <context>
#
# lib.sh's grpc_expect_code can't attach a header; this is its header-aware
# twin, used for every negative case that needs a (bad) token attached. Same
# PascalCase-vs-UPPER_SNAKE code normalization as lib.sh's version.
expect_code_with_header() {
  local target="$1" method="$2" data="$3" token="$4" expected="$5" context="${6:-$method}"
  ensure_grpcurl
  local out rc=0
  out="$(grpcurl -plaintext -H "authorization: Bearer $token" -d "$data" "$target" "$method" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "lib.sh: FAIL — ${context}: expected error code $expected, but the call succeeded" >&2
    return 1
  fi
  local got exp_n got_n
  got="$(grep -oiE "Code:[[:space:]]*[A-Za-z_]+" <<<"$out" | head -1 | sed -E 's/^[Cc]ode:[[:space:]]*//')"
  exp_n="$(printf '%s' "$expected" | tr -d '_ ' | tr '[:upper:]' '[:lower:]')"
  got_n="$(printf '%s' "$got" | tr -d '_ ' | tr '[:upper:]' '[:lower:]')"
  if [[ -n "$got_n" && "$got_n" == "$exp_n" ]]; then
    echo "lib.sh: ok — ${context}: got expected code $expected (grpcurl: ${got})" >&2
    return 0
  fi
  echo "lib.sh: FAIL — ${context}: expected code $expected, got: $out" >&2
  return 1
}

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="
  wait_for_grpc "$target"

  # --- 1. Reflection works WITHOUT a token -----------------------------------
  ensure_grpcurl
  grpcurl -plaintext "$target" list >/dev/null
  echo "lib.sh: ok — $stack reflection 'list' succeeds with no token" >&2

  # --- 2. Valid token -> OK, correct quote ------------------------------------
  local valid_token resp
  valid_token="$(mint_token valid)"
  resp="$(grpcurl -plaintext -H "authorization: Bearer $valid_token" -d "$GETQUOTE_REQUEST" "$target" "$GETQUOTE_METHOD")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack GetQuote valid token: quote.currency"
  assert_eq "$EXPECT_QUOTE_AMOUNT" "$(json_field '.quote.amount' <<<"$resp")" "$stack GetQuote valid token: quote.amount"

  # --- 3. Missing token -> UNAUTHENTICATED ------------------------------------
  grpc_expect_code "$target" "$GETQUOTE_METHOD" "$GETQUOTE_REQUEST" UNAUTHENTICATED \
    "$stack GetQuote missing token"

  # --- 4. Bad signature -> UNAUTHENTICATED ------------------------------------
  local bad_sig_token
  bad_sig_token="$(mint_token bad-sig)"
  expect_code_with_header "$target" "$GETQUOTE_METHOD" "$GETQUOTE_REQUEST" "$bad_sig_token" \
    UNAUTHENTICATED "$stack GetQuote bad-signature token"

  # --- 5. Expired token -> UNAUTHENTICATED ------------------------------------
  local expired_token
  expired_token="$(mint_token expired)"
  expect_code_with_header "$target" "$GETQUOTE_METHOD" "$GETQUOTE_REQUEST" "$expired_token" \
    UNAUTHENTICATED "$stack GetQuote expired token"

  # --- 6. Wrong scope on the per-method-gated call -> PERMISSION_DENIED ------
  local wrong_scope_token
  wrong_scope_token="$(mint_token wrong-scope)"
  expect_code_with_header "$target" "$LISTROUTES_METHOD" '{}' "$wrong_scope_token" \
    PERMISSION_DENIED "$stack ListRoutes wrong-scope token (valid authn, failed authz)"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9200"
run_stack_tests "python" "localhost:9201"

echo
echo "PASS — Ch20 authn-authz: on both stacks, reflection works with no" \
     "token; a valid JWT reaches GetQuote and returns the identical Ch5" \
     "quote; a missing, bad-signature, or expired token is rejected with" \
     "UNAUTHENTICATED before the handler runs; and an authenticated token" \
     "lacking ListRoutes' routes:admin scope is rejected with" \
     "PERMISSION_DENIED — authn and authz are two separate, separately" \
     "testable decisions."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
