#!/usr/bin/env bash
# examples/08-server-streaming/verify.sh
#
# Ch8 server-streaming example — the reference both-stack implementation of
# shipping.tracking.v1.TrackingService.WatchShipment
# (contracts/proto/shipping/tracking/v1/tracking.proto,
# contracts/proto/shipping/type/v1/types.proto). Both the Quarkus and the
# Python stack must emit the IDENTICAL, DETERMINISTIC 4-event stream for
# {"bookingId":"bkg_demo"} — asserted on EVENT COUNT, PER-EVENT FIELD
# SEMANTICS, and ORDER, not just a gRPC OK status. See README.md for the
# full event sequence.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch08-sstream"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

REQUEST='{"bookingId":"bkg_demo"}'
METHOD="shipping.tracking.v1.TrackingService/WatchShipment"

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  local out
  out="$(grpc_call "$target" "$METHOD" "$REQUEST")"

  assert_eq "4" "$(printf '%s' "$out" | json_stream_count)" "$stack event count"

  # First event: PENDING, at USNYC, for the requested booking. grpcurl's
  # protojson rendering prints an enum by its NAME, and (this grpcurl build's
  # default) field names come back as the proto's own snake_case names, not
  # the lowerCamelCase JSON name used on the way IN (the request above).
  assert_eq "BOOKING_STATE_PENDING" \
    "$(printf '%s' "$out" | json_stream_field 0 .event.state)" "$stack event[0].state"
  assert_eq "bkg_demo" \
    "$(printf '%s' "$out" | json_stream_field 0 .event.booking_id)" "$stack event[0].booking_id"
  assert_eq "USNYC" \
    "$(printf '%s' "$out" | json_stream_field 0 .event.location.un_locode)" "$stack event[0].location"

  # Middle two events prove the state machine progresses in order, not just
  # that the first and last events are right.
  assert_eq "BOOKING_STATE_CONFIRMED" \
    "$(printf '%s' "$out" | json_stream_field 1 .event.state)" "$stack event[1].state"
  assert_eq "BOOKING_STATE_IN_TRANSIT" \
    "$(printf '%s' "$out" | json_stream_field 2 .event.state)" "$stack event[2].state"
  assert_eq "NLRTM" \
    "$(printf '%s' "$out" | json_stream_field 2 .event.location.un_locode)" "$stack event[2].location"

  # Last event: DELIVERED, at NLRTM, same booking — the stream's half-close
  # (this is the 4th and final event, not an arbitrary cutoff).
  assert_eq "BOOKING_STATE_DELIVERED" \
    "$(printf '%s' "$out" | json_stream_field 3 .event.state)" "$stack event[3].state"
  assert_eq "bkg_demo" \
    "$(printf '%s' "$out" | json_stream_field 3 .event.booking_id)" "$stack event[3].booking_id"

  # The other two TrackingService RPCs are declared in the proto for
  # Chapter 9 and must answer UNIMPLEMENTED here, not silently succeed.
  grpc_expect_code "$target" "shipping.tracking.v1.TrackingService/ReportPositions" '{}' \
    "UNIMPLEMENTED" "$stack ReportPositions"
  grpc_expect_code "$target" "shipping.tracking.v1.TrackingService/Sync" '{}' \
    "UNIMPLEMENTED" "$stack Sync"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9080"
run_stack_tests "python" "localhost:9081"

echo
echo "PASS — Ch8 server-streaming: Quarkus and Python both implement" \
     "shipping.tracking.v1.TrackingService.WatchShipment identically — the" \
     "same 4-event, strictly-ordered PENDING -> CONFIRMED -> IN_TRANSIT ->" \
     "DELIVERED sequence for bkg_demo, generated from one proto."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
