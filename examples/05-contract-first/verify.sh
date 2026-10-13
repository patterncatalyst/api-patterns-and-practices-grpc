#!/usr/bin/env bash
# examples/05-contract-first/verify.sh
#
# Ch5 contract-first ANCHOR — the reference both-stack implementation of
# shipping.routing.v1.RoutingService.GetQuote
# (contracts/proto/shipping/routing/v1/routing.proto,
# contracts/proto/shipping/type/v1/types.proto). This is the load-bearing
# correctness step: every GetQuote response from BOTH the Quarkus and the
# Python stack is asserted against RESPONSE FIELD SEMANTICS — not just an OK
# status. See README.md for the quote formula and a documented drift probe.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch05-contract"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

# The exact request from the chapter's "On the wire" box: one cargo item,
# weight 1200.5kg -> 1200.5 * 2.50 = 3001.25.
REQUEST_1='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'

# A second request with TWO cargo items (1000 + 500.5 = 1500.5kg) to prove
# the formula sums every item rather than hardcoding the single-item answer:
# 1500.5 * 2.50 = 3751.25.
REQUEST_2='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1000,"description":"Pallet A","cargoType":"GENERAL"},{"weightKg":500.5,"description":"Pallet B","cargoType":"GENERAL"}]}'

METHOD="shipping.routing.v1.RoutingService/GetQuote"

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  local resp1
  resp1="$(grpc_call "$target" "$METHOD" "$REQUEST_1")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp1")" "$stack quote.currency"
  assert_eq "3001.25" "$(json_field '.quote.amount' <<<"$resp1")" "$stack quote.amount (1 cargo item)"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp1")" "$stack route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp1")" "$stack route.legs.0.carrier"
  assert_eq "3001.25" "$(json_field '.route.price.amount' <<<"$resp1")" "$stack route.price.amount"

  local resp2
  resp2="$(grpc_call "$target" "$METHOD" "$REQUEST_2")"
  assert_eq "3751.25" "$(json_field '.quote.amount' <<<"$resp2")" "$stack quote.amount (2 cargo items, proves the formula)"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9005"
run_stack_tests "python" "localhost:9006"

echo
echo "PASS — Ch5 contract-first anchor: Quarkus and Python both implement" \
     "shipping.routing.v1.RoutingService.GetQuote identically — same quote" \
     "formula (HALF_UP decimal string), same route.id, same single MAERSK" \
     "leg — generated from one proto."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
