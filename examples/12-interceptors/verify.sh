#!/usr/bin/env bash
# examples/12-interceptors/verify.sh
#
# Ch12 interceptors ANCHOR — proves the interceptor runs BEFORE the handler,
# on both stacks, for the same RPC Chapter 5 anchors:
# shipping.routing.v1.RoutingService.GetQuote
# (contracts/proto/shipping/routing/v1/routing.proto,
# contracts/proto/shipping/type/v1/types.proto).
#
# Two assertions per stack:
#   1. NO `authorization` metadata -> UNAUTHENTICATED. grpc_expect_code (via
#      lib.sh) can't attach a header, which is exactly the point: calling it
#      with no `-H` flag is what "metadata absent" means on the wire, and the
#      interceptor rejects it before RoutingServiceImpl/RoutingServiceServicer
#      ever runs.
#   2. WITH `authorization: Bearer demo-token` -> the call reaches GetQuote
#      and returns the normal Ch5 quote. grpc_call doesn't pass through `-H`,
#      so this half calls grpcurl directly with the header.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch12-intercept"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

METHOD="shipping.routing.v1.RoutingService/GetQuote"
REQUEST='{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}'

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  # 1. No authorization metadata: the auth hook rejects before GetQuote runs.
  grpc_expect_code "$target" "$METHOD" "$REQUEST" UNAUTHENTICATED \
    "$stack GetQuote without 'authorization' metadata"

  # 2. With authorization metadata: grpcurl -H directly (grpc_call has no
  # header passthrough), and the call reaches the real handler.
  local resp
  resp="$(grpcurl -plaintext -H 'authorization: Bearer demo-token' -d "$REQUEST" "$target" "$METHOD")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack GetQuote with 'authorization' metadata: quote.currency"
  assert_eq "2500.00" "$(json_field '.quote.amount' <<<"$resp")" "$stack GetQuote with 'authorization' metadata: quote.amount"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
# ensure_grpcurl ran inside wait_for_grpc already; grpcurl is on PATH for the
# direct -H call below on both stacks.
run_stack_tests "quarkus" "localhost:9120"
run_stack_tests "python" "localhost:9121"

echo
echo "PASS — Ch12 interceptors anchor: on both stacks, a single server" \
     "interceptor logs+times every call and rejects any call missing" \
     "'authorization' metadata with UNAUTHENTICATED before GetQuote runs;" \
     "with the header present, the identical Ch5 quote formula answers."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
