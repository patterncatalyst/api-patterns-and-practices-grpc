#!/usr/bin/env bash
# examples/15-backend-io-concurrency/verify.sh
#
# Ch15 backend-io-concurrency ANCHOR — both the Quarkus and the Python stack
# implement shipping.routing.v1.RoutingService.FindOptimalRoute behind the
# SAME ~400ms simulated blocking DB+file I/O step (PricingCache.lookup /
# app.blocking_lookup.blocking_lookup), served in the CORRECT non-starving
# model by default. A demo-only flag carried in request.origin.name selects
# the STARVING contrast path on both stacks (see README.md). This script
# asserts the four claims the chapter teaches:
#
#   1. Correctness: a single correct-model call returns the expected
#      route.id / route.price — an OK status with a wrong-shaped or
#      wrong-valued message must fail this check, not just a non-error call.
#   2. Eight CONCURRENT correct-model calls ALL succeed with the identical
#      correct values — no thread exhaustion, no corrupted responses.
#   3. Those eight concurrent calls overlap: they finish in well under the
#      ~3.2s eight serial 400ms calls would take (loose bound: < 2.5s).
#   4. Starve-vs-scale: eight concurrent STARVING-mode calls take at least
#      2x as long as the eight concurrent correct-model calls — the
#      event-loop-blocking path measurably fails to scale where the
#      offloaded path does.
#
# A bonus, non-required check also exercises Quarkus's illustrative
# @RunOnVirtualThread-style mode (origin.name="virtual") for good measure.
#
# See README.md for the full request-flag table and the timing numbers from
# a real run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch15-concurrency"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

METHOD="shipping.routing.v1.RoutingService/FindOptimalRoute"

# The one origin/destination pair every assertion uses — rte_001/MAERSK from
# the bundled pricing cache (see quarkus/src/main/resources/pricing-cache.txt
# and python/app/pricing_cache.txt), the same values as the Ch13 catalog's
# first route.
ORIGIN_CODE="USNYC"
DEST_CODE="NLRTM"
EXPECT_ROUTE_ID="rte_001"
EXPECT_PRICE_AMOUNT="1200.00"
EXPECT_PRICE_CURRENCY="USD"

CONCURRENCY=8
OVERLAP_BOUND_S="2.5"   # loose: well under 8 x 0.4s = 3.2s serial
STARVE_FACTOR="2"       # loose: starving must take at least 2x the correct total

# --- local helpers (verify.sh-only; lib.sh is shared and not modified) -----

# now_s — high-resolution wall-clock seconds, as a float string.
now_s() { date +%s.%N; }

# elapsed_s <start> <end> — float seconds between two now_s readings.
elapsed_s() {
  python3 -I -c 'import sys; print(float(sys.argv[2]) - float(sys.argv[1]))' "$1" "$2"
}

# assert_lt <actual> <bound> <context> — float-aware "actual < bound".
assert_lt() {
  local actual="$1" bound="$2" context="${3:-less-than}"
  if ! python3 -I -c '
import sys
actual, bound = float(sys.argv[1]), float(sys.argv[2])
sys.exit(0 if actual < bound else 1)
' "$actual" "$bound"; then
    echo "lib.sh: FAIL — ${context}: ${actual}s is not < ${bound}s" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: ${actual}s < ${bound}s" >&2
}

# assert_scaled_lt <a> <factor> <b> <context> — float-aware "a * factor < b",
# the starve-vs-scale assertion (correct_total * 2 < starving_total).
assert_scaled_lt() {
  local a="$1" factor="$2" b="$3" context="${4:-scaled-less-than}"
  if ! python3 -I -c '
import sys
a, factor, b = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
sys.exit(0 if a * factor < b else 1)
' "$a" "$factor" "$b"; then
    echo "lib.sh: FAIL — ${context}: ${a}s * ${factor} is not < ${b}s" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: ${a}s * ${factor} < ${b}s" >&2
}

# request_json <mode> — builds a FindOptimalRouteRequest. `mode` is "" for
# the default (correct) model, or a demo-only flag ("starving", "virtual")
# repurposing origin.name as an execution-model selector (see README.md) —
# it carries no routing meaning; matching uses origin/destination UN/LOCODEs
# only.
request_json() {
  local mode="$1"
  if [[ -z "$mode" ]]; then
    printf '{"origin":{"unLocode":"%s"},"destination":{"unLocode":"%s"}}' "$ORIGIN_CODE" "$DEST_CODE"
  else
    printf '{"origin":{"unLocode":"%s","name":"%s"},"destination":{"unLocode":"%s"}}' \
      "$ORIGIN_CODE" "$mode" "$DEST_CODE"
  fi
}

# run_concurrent <target> <mode> <n> — fires <n> concurrent FindOptimalRoute
# calls (background `grpc_call &` + `wait`, per the house pattern for timing
# N concurrent RPCs), asserts every one succeeded with the expected route
# fields, and prints the wall-clock elapsed seconds for the whole batch on
# stdout (the only thing this function writes to stdout — every assertion
# writes to stderr, same convention as lib.sh's assert_eq/assert_contains).
run_concurrent() {
  local target="$1" mode="$2" n="$3"
  local request outdir
  request="$(request_json "$mode")"
  outdir="$(mktemp -d)"

  local start pids=()
  start="$(now_s)"
  for i in $(seq 1 "$n"); do
    ( grpc_call "$target" "$METHOD" "$request" >"$outdir/resp-$i.json" 2>"$outdir/err-$i.log" ) &
    pids+=("$!")
  done

  local rc=0
  for pid in "${pids[@]}"; do
    wait "$pid" || rc=1
  done
  local end
  end="$(now_s)"

  if (( rc != 0 )); then
    echo "lib.sh: FAIL — one or more concurrent FindOptimalRoute calls (mode='$mode') failed:" >&2
    cat "$outdir"/err-*.log >&2
    rm -rf "$outdir"
    return 1
  fi

  local i resp
  for i in $(seq 1 "$n"); do
    resp="$(cat "$outdir/resp-$i.json")"
    assert_eq "$EXPECT_ROUTE_ID" "$(json_field '.route.id' <<<"$resp")" "mode='$mode' call $i route.id"
    assert_eq "$EXPECT_PRICE_CURRENCY" "$(json_field '.route.price.currency' <<<"$resp")" \
      "mode='$mode' call $i route.price.currency"
    assert_eq "$EXPECT_PRICE_AMOUNT" "$(json_field '.route.price.amount' <<<"$resp")" \
      "mode='$mode' call $i route.price.amount"
  done

  rm -rf "$outdir"
  elapsed_s "$start" "$end"
}

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  # --- 1. Correctness: one correct-model call, exact field values ----------
  local resp
  resp="$(grpc_call "$target" "$METHOD" "$(request_json "")")"
  assert_eq "$EXPECT_ROUTE_ID" "$(json_field '.route.id' <<<"$resp")" "$stack single call route.id"
  assert_eq "$EXPECT_PRICE_CURRENCY" "$(json_field '.route.price.currency' <<<"$resp")" \
    "$stack single call route.price.currency"
  assert_eq "$EXPECT_PRICE_AMOUNT" "$(json_field '.route.price.amount' <<<"$resp")" \
    "$stack single call route.price.amount"

  # --- 2 + 3. Eight concurrent correct-model calls: correct AND overlapped -
  local correct_elapsed
  correct_elapsed="$(run_concurrent "$target" "" "$CONCURRENCY")"
  echo "lib.sh: info — $stack: $CONCURRENCY concurrent correct-model calls took ${correct_elapsed}s" >&2
  assert_lt "$correct_elapsed" "$OVERLAP_BOUND_S" \
    "$stack $CONCURRENCY concurrent correct-model calls overlap (well under ${CONCURRENCY}x0.4s serial)"

  # --- 4. Starve-vs-scale: starving takes at least 2x the correct total ----
  local starving_elapsed
  starving_elapsed="$(run_concurrent "$target" "starving" "$CONCURRENCY")"
  echo "lib.sh: info — $stack: $CONCURRENCY concurrent STARVING calls took ${starving_elapsed}s" >&2
  assert_scaled_lt "$correct_elapsed" "$STARVE_FACTOR" "$starving_elapsed" \
    "$stack starve-vs-scale (correct_total * ${STARVE_FACTOR} < starving_total)"

  # --- Bonus (Quarkus only): the illustrative @RunOnVirtualThread-style mode
  if [[ "$stack" == "quarkus" ]]; then
    local virtual_elapsed
    virtual_elapsed="$(run_concurrent "$target" "virtual" "$CONCURRENCY")"
    echo "lib.sh: info — $stack: $CONCURRENCY concurrent virtual-thread-mode calls took ${virtual_elapsed}s" >&2
    assert_lt "$virtual_elapsed" "$OVERLAP_BOUND_S" \
      "$stack $CONCURRENCY concurrent virtual-thread-mode calls overlap (well under ${CONCURRENCY}x0.4s serial)"
  fi

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9150"
run_stack_tests "python" "localhost:9151"

echo
echo "PASS — Ch15 backend-io-concurrency anchor: on BOTH the Quarkus and the" \
     "Python stack, FindOptimalRoute's correct, default execution model" \
     "(Quarkus: the @Blocking worker pool; Python: asyncio.to_thread) serves" \
     "$CONCURRENCY concurrent ~400ms-blocking calls correctly and overlapped" \
     "(well under ${OVERLAP_BOUND_S}s, not the ~3.2s eight serial calls would" \
     "take), while the identical work run on the STARVING path (the same" \
     "blocking I/O done directly on the event loop / a bare coroutine sleep)" \
     "measurably fails to scale the same way — at least ${STARVE_FACTOR}x" \
     "slower for the same $CONCURRENCY concurrent callers."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
