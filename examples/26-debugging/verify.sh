#!/usr/bin/env bash
# examples/26-debugging/verify.sh
#
# Ch26 debugging — shipping.routing.v1.RoutingService.GetQuote on both
# stacks, reused as the anchor for four real failure-mode repros PLUS a
# three-tool diagnosis pass. Every repro below is reproduced and asserted on
# BOTH stacks except channelz (Python-only — quarkus-grpc 3.40.x has no
# channelz support; see README.md).
#
#   1. UNIMPLEMENTED   — FindOptimalRoute, declared in the contract and
#                         never implemented (same as every prior chapter).
#   2. DEADLINE_EXCEEDED — GetQuote carries an artificial QUOTE_DELAY_MS
#                         (2000ms); a 1s client deadline can't cover it, a
#                         5s deadline can.
#   3. UNAVAILABLE     — a one-shot python client calls each service's OWN
#                         in-network address at port 9999, a port neither
#                         container ever listens on (deterministic, not a
#                         race against a starting server), and asserts the
#                         call fails with grpc.StatusCode.UNAVAILABLE.
#                         grpcurl can't make this same assertion: against a
#                         closed port it reports a raw dial failure with no
#                         status "Code:" line at all (see
#                         unavailable_probe.py for why).
#   4. TLS handshake failure — grpcurl without -plaintext defaults to TLS;
#                         both servers are plaintext-only, so the handshake
#                         itself fails. Asserted with a local
#                         assert_tls_rejected, the same pattern Ch19 uses
#                         for the same shape of failure.
#
# Diagnosis (mixed gate):
#   - reflection: `grpcurl list`/`describe`, asserted on both stacks.
#   - channelz:   `grpc.channelz.v1.Channelz/GetServers`, Python only.
#   - GRPC_TRACE/GRPC_VERBOSITY: set on a one-shot grpc-python client call,
#     asserted non-empty only (illustrative, env/version-dependent) —
#     grpcurl (grpc-go) does not honor either variable at all.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch26-debugging"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

METHOD="shipping.routing.v1.RoutingService/GetQuote"
FIND_OPTIMAL_METHOD="shipping.routing.v1.RoutingService/FindOptimalRoute"

# One cargo item, weight 1200.5kg -> 1200.5 * 2.50 = 3001.25. Same request
# used throughout this book's unary chapters.
REQUEST='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'
EXPECT_AMOUNT="3001.25"

FIND_OPTIMAL_REQUEST='{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"preferSpeed":false}'

# --- local helpers (verify.sh-only; lib.sh is shared and not modified) -----

# assert_tls_rejected <combined-output> <context> — copied from Ch19's
# verify.sh (same pattern, not shared via lib.sh): the call must already be
# confirmed non-zero-exit by the caller; this only checks the error text
# names a transport/handshake failure rather than a clean application-level
# gRPC status. grpcurl prefixes all shapes of this failure with "Failed to
# dial target host", which itself only ever appears when a call fails
# before a gRPC status was ever negotiated.
assert_tls_rejected() {
  local out="$1" context="${2:-tls-rejected}"
  if ! grep -qiE 'failed to dial|tls|handshake|certificate|unavailable|eof|deadline exceeded' <<<"$out"; then
    echo "lib.sh: FAIL — ${context}: error text doesn't name a transport/TLS failure: $out" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: rejected at the transport/handshake layer" >&2
}

# assert_nonempty <value> <context> — for the GRPC_TRACE/GRPC_VERBOSITY
# demonstration, which is illustrative (exact log lines vary by grpcio
# release) and so is asserted only for non-empty output, not specific text.
assert_nonempty() {
  local value="$1" context="${2:-non-empty}"
  if [[ -z "$value" ]]; then
    echo "lib.sh: FAIL — ${context}: expected non-empty output, got none" >&2
    return 1
  fi
  local lines
  lines="$(wc -l <<<"$value" | tr -d '[:space:]')"
  echo "lib.sh: ok — ${context}: ${lines} line(s) of output" >&2
}

# assert_quote <response-json> <stack> <phase>
assert_quote() {
  local resp="$1" stack="$2" phase="$3"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack $phase quote.currency"
  assert_eq "$EXPECT_AMOUNT" "$(json_field '.quote.amount' <<<"$resp")" "$stack $phase quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack $phase route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack $phase route.legs.0.carrier"
}

# --- Step groups -------------------------------------------------------

run_baseline() {
  local stack="$1" target="$2"

  echo
  echo "=== $stack: baseline — GetQuote still works (generous deadline) ==="
  wait_for_grpc "$target"
  local resp
  resp="$(GRPCURL_OPTS="-plaintext -max-time 5" grpc_call "$target" "$METHOD" "$REQUEST")"
  assert_quote "$resp" "$stack" "baseline"
}

run_unimplemented() {
  local stack="$1" target="$2"

  echo
  echo "=== $stack: 1. UNIMPLEMENTED (FindOptimalRoute, never implemented) ==="
  GRPCURL_OPTS="-plaintext" grpc_expect_code "$target" "$FIND_OPTIMAL_METHOD" "$FIND_OPTIMAL_REQUEST" \
    "UNIMPLEMENTED" "$stack FindOptimalRoute is declared but never implemented"
}

run_deadline_exceeded() {
  local stack="$1" target="$2"

  echo
  echo "=== $stack: 2. DEADLINE_EXCEEDED (1s deadline < 2000ms artificial delay) ==="
  GRPCURL_OPTS="-plaintext -max-time 1" grpc_expect_code "$target" "$METHOD" "$REQUEST" \
    "DEADLINE_EXCEEDED" "$stack tight deadline (1s) exceeds the QUOTE_DELAY_MS artificial delay"
}

run_unavailable() {
  local stack="$1" in_network_closed_target="$2"

  echo
  echo "=== $stack: 3. UNAVAILABLE on a cold/closed channel ($in_network_closed_target) ==="
  if ! docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps \
        --entrypoint python python -m app.unavailable_probe "$in_network_closed_target"; then
    echo "lib.sh: FAIL — $stack unavailable_probe.py against $in_network_closed_target" >&2
    exit 1
  fi
}

run_tls_handshake_failure() {
  local stack="$1" target="$2"

  echo
  echo "=== $stack: 4. TLS handshake failure (grpcurl defaults to TLS; server is plaintext) ==="
  ensure_grpcurl
  local out rc=0
  out="$(grpcurl -d "$REQUEST" "$target" "$METHOD" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "lib.sh: FAIL — $stack: TLS-defaulting grpcurl call unexpectedly succeeded against a plaintext server" >&2
    exit 1
  fi
  assert_tls_rejected "$out" "$stack TLS-handshake-failure (grpcurl defaults to TLS; server is plaintext)"
}

run_reflection_diagnosis() {
  local stack="$1" target="$2"

  echo
  echo "=== $stack: diagnosis — reflection (list/describe) ==="
  ensure_grpcurl
  local list_out
  list_out="$(grpcurl -plaintext "$target" list 2>&1)"
  assert_contains "shipping.routing.v1.RoutingService" "$list_out" "$stack reflection list"
  # Service-level describe, not method-level: grpc-java's reflection
  # (Quarkus) resolves a method full name directly
  # ("describe Service.Method" succeeds), but grpcio-reflection (Python)
  # only resolves service and message symbols — "describe Service.Method"
  # against the Python stack fails with "Symbol not found", confirmed
  # against both stacks while authoring this chapter (see README.md). The
  # service-level form below works identically on both, so it is what
  # verify.sh asserts.
  local describe_out
  describe_out="$(grpcurl -plaintext "$target" describe shipping.routing.v1.RoutingService 2>&1)"
  assert_contains "rpc GetQuote" "$describe_out" "$stack reflection describe RoutingService"
}

run_channelz_diagnosis() {
  local target="$1"

  echo
  echo "=== python: diagnosis — channelz GetServers (Python-only; quarkus-grpc has no channelz) ==="
  local resp
  resp="$(GRPCURL_OPTS="-plaintext" grpc_call "$target" "grpc.channelz.v1.Channelz/GetServers" '{}')"
  local servers
  servers="$(json_field '.server' <<<"$resp")"
  if [[ -z "$servers" || "$servers" == "[]" ]]; then
    echo "lib.sh: FAIL — python channelz GetServers returned no server data: $resp" >&2
    exit 1
  fi
  echo "lib.sh: ok — python channelz GetServers returned server data: $servers" >&2
}

run_trace_diagnosis() {
  local stack="$1" in_network_target="$2"

  echo
  echo "=== $stack: diagnosis — GRPC_TRACE/GRPC_VERBOSITY (illustrative; grpc-python/C-core only) ==="
  local out
  out="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps \
        -e GRPC_TRACE=api,call_error,connectivity_state -e GRPC_VERBOSITY=DEBUG \
        --entrypoint python python -m app.trace_probe "$in_network_target" 2>&1)"
  assert_nonempty "$out" "$stack GRPC_TRACE/GRPC_VERBOSITY output ($in_network_target)"
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: baseline correctness on both stacks ==="
run_baseline "quarkus" "localhost:9260"
run_baseline "python" "localhost:9261"

echo
echo "=== Step 3: the four failure modes, on both stacks ==="
run_unimplemented "quarkus" "localhost:9260"
run_unimplemented "python" "localhost:9261"

run_deadline_exceeded "quarkus" "localhost:9260"
run_deadline_exceeded "python" "localhost:9261"

run_unavailable "quarkus" "quarkus:9999"
run_unavailable "python" "python:9999"

run_tls_handshake_failure "quarkus" "localhost:9260"
run_tls_handshake_failure "python" "localhost:9261"

echo
echo "=== Step 4: diagnosis toolbox ==="
run_reflection_diagnosis "quarkus" "localhost:9260"
run_reflection_diagnosis "python" "localhost:9261"

run_channelz_diagnosis "localhost:9261"

run_trace_diagnosis "quarkus" "quarkus:9000"
run_trace_diagnosis "python" "python:9000"

echo
echo "PASS — Ch26 debugging: on BOTH the Quarkus and the Python stack," \
     "FindOptimalRoute fails UNIMPLEMENTED, a 1s deadline against the" \
     "artificially-delayed GetQuote fails DEADLINE_EXCEEDED, a call against" \
     "each stack's own closed port 9999 fails grpc.StatusCode.UNAVAILABLE," \
     "and a TLS-defaulting grpcurl call against the plaintext server is" \
     "rejected at the handshake layer; reflection answers list/describe on" \
     "both stacks; channelz answers GetServers on the Python stack (no" \
     "quarkus-grpc equivalent); and GRPC_TRACE/GRPC_VERBOSITY produce" \
     "non-empty C-core trace output from a grpc-python caller against both."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
