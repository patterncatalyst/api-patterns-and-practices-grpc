#!/usr/bin/env bash
# examples/11-error-handling/verify.sh
#
# Ch11 error-handling ANCHOR — both the Quarkus and the Python stack
# implement shipping.routing.v1.RoutingService.GetQuote to return
# DETERMINISTIC rich errors by input (contracts/proto/shipping/routing/v1/routing.proto,
# contracts/proto/shipping/type/v1/types.proto). This asserts not just the
# canonical status CODE but the rich google.rpc.Status DETAIL carried in the
# trailers (BadRequest / ErrorInfo / RetryInfo) — the load-bearing step this
# chapter exists to teach. See README.md for the full input -> status/detail
# table.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch11-errors"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

METHOD="shipping.routing.v1.RoutingService/GetQuote"

# Missing origin entirely (destination present) -> INVALID_ARGUMENT + BadRequest
# naming the "origin.un_locode" field.
REQ_BAD_INPUT='{"destination":{"unLocode":"NLRTM","name":"Rotterdam"}}'

# Sentinel unroutable origin -> NOT_FOUND + ErrorInfo.
REQ_UNROUTABLE='{"origin":{"unLocode":"ZZZZZ","name":"Nowhere"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"}}'

# Sentinel origin that always reports transient unavailability -> UNAVAILABLE + RetryInfo.
REQ_RETRY='{"origin":{"unLocode":"RETRY","name":"Transient"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"}}'

# A valid request -> OK, same quote formula as Ch5: 1200.5kg * 2.50 = 3001.25.
REQ_VALID='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  # --- bad input: empty/missing origin -> INVALID_ARGUMENT + BadRequest ---
  # grpc_expect_code matches grpcurl's own rendering of the code (PascalCase,
  # e.g. "InvalidArgument"), not the canonical UPPER_SNAKE_CASE enum name.
  grpc_expect_code "$target" "$METHOD" "$REQ_BAD_INPUT" "InvalidArgument" \
    "$stack GetQuote missing origin"

  local bad_out
  bad_out="$(grpc_error_output "$target" "$METHOD" "$REQ_BAD_INPUT")"
  assert_contains "BadRequest" "$bad_out" "$stack missing-origin error names BadRequest"
  assert_contains "origin" "$bad_out" "$stack missing-origin error names the origin field"

  # --- unroutable origin -> NOT_FOUND + ErrorInfo ---
  grpc_expect_code "$target" "$METHOD" "$REQ_UNROUTABLE" "NotFound" \
    "$stack GetQuote unroutable origin (ZZZZZ)"

  local unroutable_out
  unroutable_out="$(grpc_error_output "$target" "$METHOD" "$REQ_UNROUTABLE")"
  assert_contains "ErrorInfo" "$unroutable_out" "$stack unroutable-origin error names ErrorInfo"
  assert_contains "ORIGIN_UNROUTABLE" "$unroutable_out" "$stack unroutable-origin error carries the ErrorInfo reason"

  # --- sentinel retry origin -> UNAVAILABLE + RetryInfo ---
  grpc_expect_code "$target" "$METHOD" "$REQ_RETRY" "Unavailable" \
    "$stack GetQuote transient origin (RETRY)"

  local retry_out
  retry_out="$(grpc_error_output "$target" "$METHOD" "$REQ_RETRY")"
  assert_contains "RetryInfo" "$retry_out" "$stack transient-origin error names RetryInfo"

  # --- valid request -> OK, normal quote ---
  local resp
  resp="$(grpc_call "$target" "$METHOD" "$REQ_VALID")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack quote.currency"
  assert_eq "3001.25" "$(json_field '.quote.amount' <<<"$resp")" "$stack quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack route.id"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9110"
run_stack_tests "python" "localhost:9111"

echo
echo "PASS — Ch11 error-handling anchor: Quarkus and Python both map" \
     "GetQuote's inputs to the same canonical status codes (INVALID_ARGUMENT," \
     "NOT_FOUND, UNAVAILABLE, OK) AND carry the same rich google.rpc.Status" \
     "detail type (BadRequest, ErrorInfo, RetryInfo) in the trailers for" \
     "each failure — generated from one proto, built from one runtime" \
     "error-details library on each stack."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
