#!/usr/bin/env bash
# examples/00-prerequisites/verify.sh
#
# Ch0 prerequisites SKELETON — proves the toolchain, not the domain: both
# the Quarkus and the Python stack build from the SAME proto
# (contracts/proto/shipping/{type,routing}/v1/*.proto), boot under Compose,
# answer server reflection, and return a GetQuote response whose currency
# is the canned "USD" — nothing computed, nothing persisted. The real
# quote formula is Chapter 5's job (examples/05-contract-first/verify.sh
# asserts response field SEMANTICS; this script only proves the plumbing).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch00-prereq"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

METHOD="shipping.routing.v1.RoutingService/GetQuote"

run_stack_check() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  local resp
  resp="$(grpc_call "$target" "$METHOD" '{}')"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack quote.currency (canned)"

  echo "=== $stack: toolchain check passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks answer reflection + GetQuote ==="
run_stack_check "quarkus" "localhost:9000"
run_stack_check "python" "localhost:9001"

echo
echo "PASS — Ch0 prerequisites skeleton: Quarkus and Python both build from" \
     "the same proto, boot under Compose, answer server reflection, and" \
     "return shipping.routing.v1.RoutingService.GetQuote with the canned" \
     "quote.currency == \"USD\" — the toolchain works. The real quote" \
     "formula lands in Chapter 5."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
