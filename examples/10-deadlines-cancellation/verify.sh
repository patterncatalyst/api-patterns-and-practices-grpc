#!/usr/bin/env bash
# examples/10-deadlines-cancellation/verify.sh
#
# Ch10 deadline-propagation ANCHOR — both the Quarkus and the Python stack
# implement shipping.routing.v1.RoutingService.GetQuote by calling DOWNSTREAM
# shipping.quote.v1.QuoteService.GetQuote (contracts/proto/shipping/quote/v1/quote.proto)
# over a loopback gRPC channel. QuoteService is artificially slow (~2s). This
# is the load-bearing step the chapter exists to teach: the SAME request,
# sent with a TIGHT client deadline, fails with DEADLINE_EXCEEDED because the
# remaining budget can't cover the downstream call; sent with a GENEROUS
# deadline, it succeeds with the normal quote. See README.md for the full
# story and the quote formula.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch10-deadline"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

METHOD="shipping.routing.v1.RoutingService/GetQuote"

# A valid request: one cargo item, weight 1000kg -> 1000 * 2.50 = 2500.00.
REQUEST='{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}'

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  # --- TIGHT deadline (1s) < QuoteService's ~2s artificial delay -----------
  # grpc_expect_code normalizes grpcurl's PascalCase rendering ("DeadlineExceeded")
  # against the canonical UPPER_SNAKE_CASE code ("DEADLINE_EXCEEDED") — either
  # spelling passed here matches.
  GRPCURL_OPTS="-plaintext -max-time 1" grpc_expect_code "$target" "$METHOD" "$REQUEST" \
    "DEADLINE_EXCEEDED" "$stack tight deadline (1s) exceeds QuoteService's ~2s delay"

  # --- GENEROUS deadline (10s) > QuoteService's ~2s artificial delay -------
  local resp
  resp="$(GRPCURL_OPTS="-plaintext -max-time 10" grpc_call "$target" "$METHOD" "$REQUEST")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack generous deadline quote.currency"
  assert_eq "2500.00" "$(json_field '.quote.amount' <<<"$resp")" "$stack generous deadline quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack generous deadline route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack generous deadline route.legs.0.carrier"
  assert_eq "2500.00" "$(json_field '.route.price.amount' <<<"$resp")" "$stack generous deadline route.price.amount"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9100"
run_stack_tests "python" "localhost:9101"

echo
echo "PASS — Ch10 deadline-propagation anchor: on BOTH the Quarkus and the" \
     "Python stack, the SAME RoutingService.GetQuote request sent with a 1s" \
     "client deadline fails DEADLINE_EXCEEDED (QuoteService's ~2s downstream" \
     "delay can't fit in the remaining budget) and sent with a 10s deadline" \
     "succeeds with the normal quote — the downstream call genuinely crosses" \
     "a loopback gRPC hop on each stack, and the deadline genuinely" \
     "propagates across it."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
