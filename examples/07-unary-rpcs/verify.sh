#!/usr/bin/env bash
# examples/07-unary-rpcs/verify.sh
#
# Ch7 unary-rpcs — shipping.routing.v1.RoutingService.GetQuote on both
# stacks (same formula as Ch5), PLUS this chapter's own teaching point:
# channel/stub reuse. Two things get verified:
#
#   1. Response field semantics via grpcurl against both host ports
#      (localhost:9070 Quarkus, localhost:9071 Python) — at least two calls
#      per stack, same correctness bar as Ch5's verify.sh.
#   2. python/app/reuse_client.py, run from the already-built python image
#      against BOTH services' in-network address (container port 9000),
#      proving one channel + one stub survive repeated GetQuote calls.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch07-unary"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

# One cargo item, weight 1200.5kg -> 1200.5 * 2.50 = 3001.25.
REQUEST_1='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'

# A second request with TWO cargo items (1000 + 500.5 = 1500.5kg) to prove
# the formula sums every item: 1500.5 * 2.50 = 3751.25.
REQUEST_2='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1000,"description":"Pallet A","cargoType":"GENERAL"},{"weightKg":500.5,"description":"Pallet B","cargoType":"GENERAL"}]}'

EXPECTED_AMOUNT_1="3001.25"
METHOD="shipping.routing.v1.RoutingService/GetQuote"

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target (grpcurl, host port) ==="

  wait_for_grpc "$target"

  local resp1
  resp1="$(grpc_call "$target" "$METHOD" "$REQUEST_1")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp1")" "$stack quote.currency"
  assert_eq "$EXPECTED_AMOUNT_1" "$(json_field '.quote.amount' <<<"$resp1")" "$stack quote.amount (1 cargo item)"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp1")" "$stack route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp1")" "$stack route.legs.0.carrier"

  local resp2
  resp2="$(grpc_call "$target" "$METHOD" "$REQUEST_2")"
  assert_eq "3751.25" "$(json_field '.quote.amount' <<<"$resp2")" "$stack quote.amount (2 cargo items, proves the formula)"

  echo "=== $stack: grpcurl assertions passed ==="
}

run_reuse_demo() {
  local stack="$1" in_network_target="$2"

  echo
  echo "=== verifying stack '$stack' channel/stub reuse at $in_network_target (in-network) ==="

  # Runs from the already-built python service image (no second image to
  # build); --entrypoint overrides the server ENTRYPOINT to invoke the
  # reuse-demo client instead. 3 calls on one channel/stub, asserted against
  # the known-good amount for REQUEST_1.
  if ! docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps \
        --entrypoint python python -m app.reuse_client "$in_network_target" 3 "$EXPECTED_AMOUNT_1"; then
    echo "lib.sh: FAIL — $stack reuse_client.py against $in_network_target" >&2
    exit 1
  fi

  echo "=== $stack: channel/stub reuse demo passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks via grpcurl ==="
run_stack_tests "quarkus" "localhost:9070"
run_stack_tests "python" "localhost:9071"

echo
echo "=== Step 3: verify channel/stub reuse against both stacks ==="
run_reuse_demo "quarkus" "quarkus:9000"
run_reuse_demo "python" "python:9000"

echo
echo "PASS — Ch7 unary-rpcs: Quarkus and Python both serve" \
     "shipping.routing.v1.RoutingService.GetQuote from one generated stub-to-stub" \
     "path, and reuse_client.py proves one channel + one stub survive repeated" \
     "GetQuote calls against both stacks."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
