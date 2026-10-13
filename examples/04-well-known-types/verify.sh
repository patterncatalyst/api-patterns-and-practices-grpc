#!/usr/bin/env bash
# examples/04-well-known-types/verify.sh
#
# Ch4 well-known-types ANCHOR — the reference both-stack implementation of
# shipping.routing.v1.RoutingService.FindOptimalRoute
# (contracts/proto/shipping/routing/v1/routing.proto,
# contracts/proto/shipping/type/v1/types.proto). This is the load-bearing
# JSON-mapping proof: both the Quarkus and the Python stack render the SAME
# google.protobuf.Timestamp as the same RFC 3339 string and the SAME Money
# as the same decimal string. See README.md for the fixed Route shape.
#
# NOTE on grpcurl's output casing: the request below uses proto3 JSON's
# default lowerCamelCase ("unLocode"), which grpcurl ACCEPTS; grpcurl's
# PRINTED response uses each message's original snake_case field names
# ("departs_at", not "departsAt") — same value, same mapping, two different
# renderings depending on direction. The json_field paths below match what
# grpcurl actually prints.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch04-wkt"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

REQUEST='{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}'
METHOD="shipping.routing.v1.RoutingService/FindOptimalRoute"

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  local resp
  resp="$(grpc_call "$target" "$METHOD" "$REQUEST")"

  # carrier: a plain string field, no WKT involved — the control case.
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack route.legs.0.carrier"

  # google.protobuf.Timestamp -> RFC 3339 string. This is the chapter's
  # spine claim: the SAME proto3 JSON mapping on both stacks, independent
  # of which library built the Timestamp.
  assert_eq "2026-02-01T10:00:00Z" "$(json_field '.route.legs.0.departs_at' <<<"$resp")" "$stack route.legs.0.departs_at (Timestamp -> RFC 3339)"
  assert_eq "2026-02-18T06:00:00Z" "$(json_field '.route.legs.0.arrives_at' <<<"$resp")" "$stack route.legs.0.arrives_at (Timestamp -> RFC 3339)"

  # Money.amount -> decimal STRING, never a JSON number, on both stacks.
  assert_eq "USD" "$(json_field '.route.price.currency' <<<"$resp")" "$stack route.price.currency"
  assert_eq "4200.00" "$(json_field '.route.price.amount' <<<"$resp")" "$stack route.price.amount (Money -> decimal string)"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9007"
run_stack_tests "python" "localhost:9008"

echo
echo "PASS — Ch4 well-known-types anchor: Quarkus and Python both render the" \
     "same google.protobuf.Timestamp as the same RFC 3339 string and the" \
     "same Money as the same decimal string — one proto3 JSON mapping," \
     "two independently-generated implementations."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
