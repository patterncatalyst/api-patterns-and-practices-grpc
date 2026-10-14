#!/usr/bin/env bash
# examples/25-testing-and-cli/verify.sh
#
# Ch25 testing-and-cli — shipping.routing.v1.RoutingService.GetQuote on both
# stacks, with the chapter's actual subject gated at image-build time. Four
# things get verified, on BOTH stacks:
#
#   1. Correctness: GetQuote field values via grpcurl (the shared anchor —
#      weight 1200.5kg -> amount 3001.25).
#   2. Reflection probe (the grpcui/Insomnia/Yaak stand-in): `grpcurl list`
#      names RoutingService; `grpcurl describe
#      shipping.routing.v1.RoutingService.GetQuote` names the method and its
#      request/response message types. Every CLI and every GUI in this
#      chapter rides the SAME reflection service — this is the deterministic,
#      headless half of that story.
#   3. The in-process test suites, visibly green: a one-shot
#      `docker compose run` re-runs `mvn test` (Quarkus, @QuarkusTest +
#      @GrpcClient) / `pytest` (Python, a real in-process grpc.aio server
#      fixture) and asserts a zero exit code plus a pass marker in the
#      output. The HARD gate already fired once, inside each image's build
#      stage (`mvn verify` / `pytest tests -q`, unconditional — see each
#      Containerfile) — a red assertion there means `quarkus`/`python` above
#      never finish building, so step 1 would already have failed. This step
#      re-runs the same suites to put their own pass/fail output in THIS
#      log, not buried in a `docker build` log.
#   4. ghz: a real load-test run against GetQuote on each stack, through the
#      pinned `ghz` compose service, fed contracts/proto directly (ghz has
#      no server-reflection support). Asserts LOOSE/RELATIVE bounds only —
#      zero errors, a generous p99 ceiling, a low rps floor — same pattern
#      Ch18 established.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch25-testing"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

GETQUOTE_METHOD="shipping.routing.v1.RoutingService/GetQuote"
# NOTE: `describe` targets the SERVICE symbol, not
# `RoutingService.GetQuote`. grpc-java's reflection (Quarkus) resolves a
# "Service.Method" symbol directly; Python's grpcio-reflection only indexes
# top-level symbols (services, messages, enums) and returns "Symbol not
# found" for a method sub-symbol — a real cross-stack reflection quirk, not
# a bug in this example. Describing the service works identically on both
# and already prints every RPC's full signature, including GetQuote's
# request/response types — see "On the wire" in the chapter.
DESCRIBE_SERVICE="shipping.routing.v1.RoutingService"

# The same single-cargo-item request used throughout this book's unary
# chapters: 1200.5kg * 2.50 = 3001.25.
GETQUOTE_REQUEST='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'
EXPECT_QUOTE_AMOUNT="3001.25"

# ghz: loose bounds only (same philosophy as Ch18's one-shot ghz run).
GHZ_CONCURRENCY=10
GHZ_TOTAL=300
GHZ_P99_CEILING_S="1.5"
GHZ_RPS_FLOOR="20"

# --- local helpers (verify.sh-only; lib.sh is shared and not modified) -----

assert_lt_num() {
  local actual="$1" bound="$2" context="${3:-less-than}"
  if ! python3 -I -c '
import sys
a, b = float(sys.argv[1]), float(sys.argv[2])
sys.exit(0 if a < b else 1)
' "$actual" "$bound"; then
    echo "lib.sh: FAIL — ${context}: ${actual} is not < ${bound}" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: ${actual} < ${bound}" >&2
}

assert_gt_num() {
  local actual="$1" bound="$2" context="${3:-greater-than}"
  if ! python3 -I -c '
import sys
a, b = float(sys.argv[1]), float(sys.argv[2])
sys.exit(0 if a > b else 1)
' "$actual" "$bound"; then
    echo "lib.sh: FAIL — ${context}: ${actual} is not > ${bound}" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: ${actual} > ${bound}" >&2
}

run_stack_correctness_and_reflection() {
  local stack="$1" host_target="$2"

  echo
  echo "=== verifying stack '$stack' at $host_target (grpcurl, host port) ==="
  wait_for_grpc "$host_target"

  # --- 1. Correctness: GetQuote ---------------------------------------------
  local resp
  resp="$(grpc_call "$host_target" "$GETQUOTE_METHOD" "$GETQUOTE_REQUEST")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack quote.currency"
  assert_eq "$EXPECT_QUOTE_AMOUNT" "$(json_field '.quote.amount' <<<"$resp")" "$stack quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack route.legs.0.carrier"
  echo "=== $stack: correctness assertions passed ==="

  # --- 2. Reflection probe (the grpcui/Insomnia/Yaak stand-in) --------------
  echo
  echo "=== $stack: reflection probe (grpcurl list / describe) ==="
  ensure_grpcurl
  local list_out
  list_out="$(grpcurl $GRPCURL_OPTS "$host_target" list)"
  assert_contains "shipping.routing.v1.RoutingService" "$list_out" "$stack reflection list names RoutingService"

  local describe_out
  describe_out="$(grpcurl $GRPCURL_OPTS "$host_target" describe "$DESCRIBE_SERVICE")"
  assert_contains "GetQuoteRequest" "$describe_out" "$stack reflection describe names the request type"
  assert_contains "GetQuoteResponse" "$describe_out" "$stack reflection describe names the response type"
  assert_contains "rpc GetQuote" "$describe_out" "$stack reflection describe names the method"
  echo "=== $stack: reflection probe passed ==="
}

run_test_suite_reruns() {
  echo
  echo "=== Quarkus: one-shot re-run of the @QuarkusTest + @GrpcClient suite ==="
  local quarkus_out
  if ! quarkus_out="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --build quarkus-tests 2>&1)"; then
    echo "$quarkus_out" >&2
    echo "lib.sh: FAIL — quarkus-tests: mvn test re-run exited non-zero" >&2
    exit 1
  fi
  echo "$quarkus_out"
  assert_contains "BUILD SUCCESS" "$quarkus_out" "quarkus-tests mvn pass marker"
  assert_contains "Tests run:" "$quarkus_out" "quarkus-tests surefire summary present"

  echo
  echo "=== Python: one-shot re-run of the pytest in-process grpc.aio suite ==="
  local python_out
  if ! python_out="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --build python-tests 2>&1)"; then
    echo "$python_out" >&2
    echo "lib.sh: FAIL — python-tests: pytest re-run exited non-zero" >&2
    exit 1
  fi
  echo "$python_out"
  assert_contains "passed" "$python_out" "python-tests pytest pass marker"
}

run_ghz() {
  local stack="$1" in_network_target="$2"

  echo
  echo "=== $stack: ghz load-test sanity check (GetQuote, c=$GHZ_CONCURRENCY n=$GHZ_TOTAL) ==="
  local out_file
  out_file="$(mktemp)"
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm ghz \
    --insecure \
    --proto /contracts/shipping/routing/v1/routing.proto \
    --import-paths /contracts \
    --call shipping.routing.v1.RoutingService.GetQuote \
    -d "$GETQUOTE_REQUEST" \
    -c "$GHZ_CONCURRENCY" -n "$GHZ_TOTAL" -O json \
    "$in_network_target" > "$out_file"

  local errors rps p99_s
  errors="$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(d.get("errorDistribution",{}).values()))' "$out_file")"
  rps="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["rps"])' "$out_file")"
  p99_s="$(python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1]))
p99 = next(x["latency"] for x in d["latencyDistribution"] if x["percentage"] == 99)
print(p99 / 1e9)
' "$out_file")"
  rm -f "$out_file"

  echo "lib.sh: info — $stack ghz: errors=$errors rps=$rps p99=${p99_s}s" >&2
  assert_eq "0" "$errors" "$stack ghz error count"
  assert_lt_num "$p99_s" "$GHZ_P99_CEILING_S" "$stack ghz p99 latency vs generous ceiling"
  assert_gt_num "$rps" "$GHZ_RPS_FLOOR" "$stack ghz throughput vs low floor"
}

echo "=== Step 1: docker compose up (each Containerfile's build-stage gate already ran) ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: correctness + reflection probe on both stacks ==="
run_stack_correctness_and_reflection "quarkus" "localhost:9250"
run_stack_correctness_and_reflection "python" "localhost:9251"

echo
echo "=== Step 3: surface the in-process test suites green, one-shot ==="
run_test_suite_reruns

echo
echo "=== Step 4: ghz load-test sanity check on both stacks ==="
run_ghz "quarkus" "quarkus:9000"
run_ghz "python" "python:9000"

echo
echo "PASS — Ch25 testing-and-cli: Quarkus and Python both serve GetQuote" \
     "correctly; grpcurl's reflection-driven list/describe (the" \
     "grpcui/Insomnia/Yaak stand-in) names RoutingService and GetQuote on" \
     "both; the @QuarkusTest+@GrpcClient suite and the pytest in-process" \
     "grpc.aio suite both re-run green (and already gated each image's" \
     "build); and ghz reports zero errors with generous latency/throughput" \
     "bounds against GetQuote on both stacks."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
