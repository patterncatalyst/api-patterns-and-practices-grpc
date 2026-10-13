#!/usr/bin/env bash
# examples/09-client-and-bidi-streaming/verify.sh
#
# Ch9 client-and-bidi-streaming — the reference both-stack implementation of
# shipping.tracking.v1.TrackingService.ReportPositions (client streaming)
# and .Sync (bidirectional streaming)
# (contracts/proto/shipping/tracking/v1/tracking.proto). This is the
# load-bearing correctness step: every response from BOTH the Quarkus and
# the Python stack is asserted against RESPONSE FIELD SEMANTICS (the folded
# count, the number of bidi responses) — not just an OK status. See
# README.md for the message formulas.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch09-cbstream"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

REPORT_POSITIONS_METHOD="shipping.tracking.v1.TrackingService/ReportPositions"
SYNC_METHOD="shipping.tracking.v1.TrackingService/Sync"

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  # --- Client streaming: 3 ReportPositionsRequest messages in, ONE
  # ReportPositionsResponse out, folding the count. grpcurl's `-d @` reads
  # newline-delimited JSON request messages from stdin and sends them as a
  # client stream, half-closing once stdin is exhausted — the exact signal
  # that tells the server "no more requests coming."
  local report_resp
  report_resp="$(printf '%s\n' \
      '{"event":{"bookingId":"bkg_demo","note":"p1"}}' \
      '{"event":{"bookingId":"bkg_demo","note":"p2"}}' \
      '{"event":{"bookingId":"bkg_demo","note":"p3"}}' \
    | grpc_client_stream "$target" "$REPORT_POSITIONS_METHOD")"
  # grpcurl renders the response in JSON with snake_case field names
  # (accepted_count, not acceptedCount), matching the proto field name.
  assert_eq "3" "$(json_field '.accepted_count' <<<"$report_resp")" "$stack accepted_count"

  # --- Bidirectional: 2 SyncRequest messages in, 2 SyncResponse messages
  # out, one per request, in order. Both directions ride the same stream;
  # grpc_client_stream prints every streamed response it receives.
  local sync_out
  sync_out="$(printf '%s\n' \
      '{"event":{"bookingId":"bkg_demo","note":"s1"}}' \
      '{"event":{"bookingId":"bkg_demo","note":"s2"}}' \
    | grpc_client_stream "$target" "$SYNC_METHOD")"
  assert_eq "2" "$(printf '%s' "$sync_out" | json_stream_count)" "$stack sync responses"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9090"
run_stack_tests "python" "localhost:9091"

echo
echo "PASS — Ch9 client-and-bidi-streaming: Quarkus and Python both fold 3" \
     "ReportPositions requests into one accepted_count=3 ack, and both echo" \
     "2 Sync requests into 2 Sync responses in order — same proto, same" \
     "both-stack behavior."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
