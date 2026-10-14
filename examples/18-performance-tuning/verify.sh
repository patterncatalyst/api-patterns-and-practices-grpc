#!/usr/bin/env bash
# examples/18-performance-tuning/verify.sh
#
# Ch18 performance-tuning — shipping.routing.v1.RoutingService.{GetQuote,
# ListRoutes} on both stacks, tuned for channel reuse, keepalive, raised
# max-message-size, and gzip compression, plus a ghz load-test sanity check.
# Six things get verified, on BOTH stacks:
#
#   1. Correctness: GetQuote field values; ListRoutes' default (small) page
#      returns the expected count and first-route fields.
#   2. Channel-reuse before/after (the #1 footgun): footgun_client.py
#      (one new channel per call) vs pooled_client.py (one reused channel)
#      for the SAME call count — footgun's total must be meaningfully
#      larger (loose, relative gate; never a tight absolute number).
#   3. max-message-size: the full 25-route catalog (~5MB) via grpcurl with
#      the DEFAULT 4MB cap -> RESOURCE_EXHAUSTED; with -max-msg-sz 8388608
#      -> success, and the correct 25-route count.
#   4. gzip: gzip_client.py proves a gzip-enabled call returns the IDENTICAL
#      large payload as the uncompressed default (functional gate; the
#      wire-size reduction itself is illustrative — see the chapter's
#      "On the wire" box, not gated here).
#   5. keepalive: keepalive_client.py proves one reused channel survives an
#      idle gap longer than the configured keepalive window and serves a
#      second call.
#   6. ghz: a real load-test run against GetQuote on each stack, through the
#      pinned `ghz` compose service, fed contracts/proto directly (ghz has
#      no server-reflection support). Asserts LOOSE/RELATIVE bounds only —
#      zero errors, a generous p99 ceiling, a low rps floor — never tight
#      absolutes. contracts.yml's existing 3-attempt verify retry absorbs
#      ordinary CI load variance.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch18-performance"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

GETQUOTE_METHOD="shipping.routing.v1.RoutingService/GetQuote"
LISTROUTES_METHOD="shipping.routing.v1.RoutingService/ListRoutes"

# The same single-cargo-item request used throughout this book's unary
# chapters: 1200.5kg * 2.50 = 3001.25.
GETQUOTE_REQUEST='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'
EXPECT_QUOTE_AMOUNT="3001.25"

# ListRoutes' fixed, 25-route catalog: DEFAULT_PAGE_SIZE=3 is the "normal"
# page; MAX_PAGE_SIZE=25 (the whole catalog) is the "large" page this
# chapter's max-message-size lever acts on.
ROUTE_COUNT=25
DEFAULT_PAGE_SIZE=3

# Channel-reuse: calls per client, and the loose relative factor
# footgun_total must clear over pooled_total for the SAME call count.
REUSE_CALLS=50
REUSE_FACTOR="1.8"   # loose: real runs on this book's dev box land ~2.7x

# max-message-size: gRPC's cross-language default receive cap (4MB) vs a
# raised one, matching the chapter's quarkus.grpc.server.max-inbound-
# message-size / grpc.max_receive_message_length constants.
RAISED_MAX_MSG_SZ=8388608

KEEPALIVE_IDLE_S=8

# ghz: loose bounds only.
GHZ_CONCURRENCY=10
GHZ_TOTAL=300
GHZ_P99_CEILING_S="1.5"
GHZ_RPS_FLOOR="20"

# --- local helpers (verify.sh-only; lib.sh is shared and not modified) -----

# assert_gt_factor <bigger> <factor> <smaller> <context> — float-aware
# "bigger > smaller * factor", the channel-reuse relative gate.
assert_gt_factor() {
  local bigger="$1" factor="$2" smaller="$3" context="${4:-gt-factor}"
  if ! python3 -I -c '
import sys
bigger, factor, smaller = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
sys.exit(0 if bigger > smaller * factor else 1)
' "$bigger" "$factor" "$smaller"; then
    echo "lib.sh: FAIL — ${context}: ${bigger}s is not > ${smaller}s * ${factor}" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: ${bigger}s > ${smaller}s * ${factor}" >&2
}

# assert_lt_num / assert_gt_num — float-aware comparisons for ghz bounds.
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

# run_client <stack> <in_network_target> <module> [args...] — runs a bundled
# demo client from the already-built python image (no second image to
# build) against either stack's in-network address, prints ONLY the
# client's own stdout (its diagnostics go to stderr, same convention as
# Ch15's timing helpers).
run_client() {
  local stack="$1" target="$2" module="$3"
  shift 3
  local out
  out="$(mktemp)"
  if ! docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps \
        --entrypoint python python -m "$module" "$target" "$@" >"$out"; then
    echo "lib.sh: FAIL — $stack: $module against $target failed" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

run_stack_tests() {
  local stack="$1" host_target="$2" in_network_target="$3"

  echo
  echo "=== verifying stack '$stack' at $host_target (grpcurl, host port) ==="
  wait_for_grpc "$host_target"

  # --- 1a. Correctness: GetQuote -------------------------------------------
  local resp
  resp="$(grpc_call "$host_target" "$GETQUOTE_METHOD" "$GETQUOTE_REQUEST")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack quote.currency"
  assert_eq "$EXPECT_QUOTE_AMOUNT" "$(json_field '.quote.amount' <<<"$resp")" "$stack quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack route.legs.0.carrier"

  # --- 1b. Correctness: ListRoutes' default (small) page -------------------
  local list_resp
  list_resp="$(grpc_call "$host_target" "$LISTROUTES_METHOD" '{}')"
  local route_count
  route_count="$(python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["routes"]))' <<<"$list_resp")"
  assert_eq "$DEFAULT_PAGE_SIZE" "$route_count" "$stack ListRoutes default page count"
  assert_eq "rte_001" "$(json_field '.routes.0.id' <<<"$list_resp")" "$stack ListRoutes default page routes.0.id"
  assert_eq "1001.00" "$(json_field '.routes.0.price.amount' <<<"$list_resp")" \
    "$stack ListRoutes default page routes.0.price.amount"
  assert_contains "MAERSK-001-1-" "$(json_field '.routes.0.legs.0.carrier' <<<"$list_resp")" \
    "$stack ListRoutes default page routes.0.legs.0.carrier prefix"
  echo "=== $stack: correctness assertions passed ==="

  # --- 2. Channel-reuse before/after (the #1 footgun) -----------------------
  echo
  echo "=== $stack: channel-reuse before/after ($REUSE_CALLS calls each) ==="
  local footgun_total pooled_total
  footgun_total="$(run_client "$stack" "$in_network_target" app.footgun_client "$REUSE_CALLS")"
  pooled_total="$(run_client "$stack" "$in_network_target" app.pooled_client "$REUSE_CALLS")"
  echo "lib.sh: info — $stack: footgun_total=${footgun_total}s pooled_total=${pooled_total}s" >&2
  assert_gt_factor "$footgun_total" "$REUSE_FACTOR" "$pooled_total" \
    "$stack channel-per-call ($REUSE_CALLS calls) vs one reused channel"

  # --- 3. max-message-size: default cap -> RESOURCE_EXHAUSTED, raised -> OK -
  echo
  echo "=== $stack: max-message-size (default cap vs raised cap) ==="
  local exhausted_out
  exhausted_out="$(grpc_error_output "$host_target" "$LISTROUTES_METHOD" "{\"pageSize\":$ROUTE_COUNT}")"
  grpc_expect_code "$host_target" "$LISTROUTES_METHOD" "{\"pageSize\":$ROUTE_COUNT}" "RESOURCE_EXHAUSTED" \
    "$stack full catalog, default 4MB cap"
  assert_contains "larger than max" "$exhausted_out" "$stack RESOURCE_EXHAUSTED message names the cap"

  ensure_grpcurl
  local raised_resp
  raised_resp="$(grpcurl $GRPCURL_OPTS -max-msg-sz "$RAISED_MAX_MSG_SZ" \
    -d "{\"pageSize\":$ROUTE_COUNT}" "$host_target" "$LISTROUTES_METHOD")"
  local raised_count
  raised_count="$(python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["routes"]))' <<<"$raised_resp")"
  assert_eq "$ROUTE_COUNT" "$raised_count" "$stack full catalog, raised $RAISED_MAX_MSG_SZ-byte cap, route count"
  assert_eq "rte_025" "$(json_field '.routes.24.id' <<<"$raised_resp")" \
    "$stack full catalog, raised cap, last route id"

  # --- 4. gzip: functional identity, not a size assertion -------------------
  echo
  echo "=== $stack: gzip-enabled call returns the identical large payload ==="
  local gzip_out
  gzip_out="$(run_client "$stack" "$in_network_target" app.gzip_client "$ROUTE_COUNT")"
  assert_eq "MATCH" "$gzip_out" "$stack gzip-enabled call matches the uncompressed call"

  # --- 5. keepalive: one reused channel survives an idle gap -----------------
  echo
  echo "=== $stack: keepalive survives a ${KEEPALIVE_IDLE_S}s idle gap ==="
  local keepalive_out
  keepalive_out="$(run_client "$stack" "$in_network_target" app.keepalive_client "$KEEPALIVE_IDLE_S")"
  assert_eq "SURVIVED" "$keepalive_out" "$stack keepalive survives idle gap"

  echo "=== $stack: all assertions passed ==="
}

run_ghz() {
  local stack="$1" in_network_target="$2"

  echo
  echo "=== $stack: ghz load-test sanity check (GetQuote, c=$GHZ_CONCURRENCY n=$GHZ_TOTAL) ==="
  local out_file="/tmp/ch18-ghz-$stack.json"
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

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks (correctness, channel-reuse, max-size, gzip, keepalive) ==="
run_stack_tests "quarkus" "localhost:9180" "quarkus:9000"
run_stack_tests "python" "localhost:9181" "python:9000"

echo
echo "=== Step 3: ghz load-test sanity check on both stacks ==="
run_ghz "quarkus" "quarkus:9000"
run_ghz "python" "python:9000"

echo
echo "PASS — Ch18 performance-tuning: Quarkus and Python both serve GetQuote" \
     "and a deterministic ~5MB ListRoutes catalog; channel reuse beats a" \
     "new channel per call by over ${REUSE_FACTOR}x on both stacks; the" \
     "full catalog trips RESOURCE_EXHAUSTED at the default 4MB cap and" \
     "succeeds at a raised $RAISED_MAX_MSG_SZ-byte one; a gzip-enabled call" \
     "returns an identical payload; a reused channel survives a" \
     "${KEEPALIVE_IDLE_S}s idle gap under keepalive; and ghz reports zero" \
     "errors with generous latency/throughput bounds against GetQuote on" \
     "both stacks."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
