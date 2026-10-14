#!/usr/bin/env bash
# examples/23-grpc-web-transcoding/verify.sh
#
# Ch23 grpc-web & JSON/HTTP transcoding ANCHOR — one RoutingService.GetQuote,
# reached FOUR ways, on BOTH stacks:
#
#   1. Native internal gRPC — grpcurl (reflection) straight to the app's own
#      gRPC port (9230/9231).
#   2. The hand-written REST shim — POST /booking/quote (8230/8231), the Ch21
#      seam: a human-written handler that knows this one request/response
#      shape.
#   3. Envoy's grpc_json_transcoder — a plain JSON POST to the RPC-shaped URL
#      (10230/10231), decoded against a baked-in proto descriptor with NO
#      hand-written mapping code at all.
#   4. Envoy's grpc_web filter — grpcweb_client.py (the deterministic browser
#      stand-in) POSTs a grpc-web-framed request to the SAME Envoy listener.
#
# All four must return the IDENTICAL quote: USD 2500.00 for a 1000kg shipment
# USNYC -> NLRTM, route rte_USNYC-NLRTM, carrier MAERSK — the same formula
# every prior anchor chapter uses. A fifth, non-fatal check feeds malformed
# JSON to the transcoder and expects an HTTP 4xx via convert_grpc_status.
#
# The helpers below are example-local — they live only in this file, not in
# ../_lib/lib.sh, because they are specific to this chapter's JSON/HTTP and
# grpc-web assertions rather than general-purpose gRPC verification every
# example needs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch23-grpc-web"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

GETQUOTE_METHOD="shipping.routing.v1.RoutingService/GetQuote"

# The same request, three different wire shapes (gRPC JSON mapping for the
# native/transcoder paths; the booking shim's own flat shape for the REST
# path); 1000kg * 2.50 = 2500.00, matching every prior anchor's formula.
GRPC_REQUEST='{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}'
BOOKING_REQUEST='{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}'
EXPECT_CURRENCY="USD"
EXPECT_AMOUNT="2500.00"
EXPECT_ROUTE_ID="rte_USNYC-NLRTM"
EXPECT_CARRIER="MAERSK"

# --- example-local helpers --------------------------------------------------

# wait_for_booking <rest-base> [timeout_secs] — poll the REST shim with the
# real booking request until it answers 200 (the app's HTTP server can come
# up slightly after its gRPC port starts accepting connections).
wait_for_booking() {
  local rest_base="$1" timeout="${2:-60}" waited=0 interval=3
  echo "verify.sh: waiting for REST shim $rest_base/booking/quote (timeout ${timeout}s) ..." >&2
  while (( waited < timeout )); do
    if curl -fsS -o /dev/null -X POST "$rest_base/booking/quote" \
         -H 'content-type: application/json' -d "$BOOKING_REQUEST" 2>/dev/null; then
      echo "verify.sh: REST shim $rest_base is up after ${waited}s" >&2
      return 0
    fi
    sleep "$interval"
    waited=$(( waited + interval ))
  done
  echo "verify.sh: FAIL — REST shim $rest_base did not respond within ${timeout}s" >&2
  return 1
}

# wait_for_envoy <host:port> [timeout_secs] — poll Envoy's admin
# "/ready" endpoint is not exposed on the data-plane port, so instead poll
# the data-plane listener itself with a request that Envoy will always
# answer (even a 404/415 proves the listener and its filter chain are up).
wait_for_envoy() {
  local target="$1" timeout="${2:-60}" waited=0 interval=3
  echo "verify.sh: waiting for Envoy $target (timeout ${timeout}s) ..." >&2
  while (( waited < timeout )); do
    if curl -fsS -o /dev/null -w '%{http_code}' \
         -X POST "http://$target/shipping.routing.v1.RoutingService/GetQuote" \
         -H 'content-type: application/json' -d '{}' 2>/dev/null | grep -qE '^[0-9]+$'; then
      echo "verify.sh: Envoy $target is up after ${waited}s" >&2
      return 0
    fi
    sleep "$interval"
    waited=$(( waited + interval ))
  done
  echo "verify.sh: FAIL — Envoy $target did not respond within ${timeout}s" >&2
  return 1
}

# assert_quote_fields_json <json> <context> — the four fields every path in
# this chapter must agree on, read from a gRPC-JSON-shaped response
# (`.quote.currency`, `.quote.amount`, `.route.id`, `.route.legs.0.carrier`).
assert_quote_fields_json() {
  local json="$1" context="$2"
  assert_eq "$EXPECT_CURRENCY" "$(json_field '.quote.currency' <<<"$json")" "$context quote.currency"
  assert_eq "$EXPECT_AMOUNT" "$(json_field '.quote.amount' <<<"$json")" "$context quote.amount"
  assert_eq "$EXPECT_ROUTE_ID" "$(json_field '.route.id' <<<"$json")" "$context route.id"
  assert_eq "$EXPECT_CARRIER" "$(json_field '.route.legs.0.carrier' <<<"$json")" "$context route.legs.0.carrier"
}

# check_transcoder_malformed_json <envoy-target> — SOFT, non-fatal: a
# malformed JSON body to the transcoder's RPC-shaped URL should trip
# convert_grpc_status's gRPC-INVALID_ARGUMENT -> HTTP 4xx mapping. Logged as
# ok or a non-fatal warning; never fails the build (illustrative per the
# execution plan, not a hard contract on Envoy's exact status-code choice).
check_transcoder_malformed_json() {
  local envoy_target="$1"
  local http_code
  http_code="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "http://$envoy_target/shipping.routing.v1.RoutingService/GetQuote" \
    -H 'content-type: application/json' -d '{"origin": not-json')"
  if [[ "$http_code" =~ ^4[0-9][0-9]$ ]]; then
    echo "verify.sh: ok (soft) — $envoy_target malformed JSON -> HTTP $http_code (convert_grpc_status)" >&2
  else
    echo "verify.sh: WARN (soft, non-fatal) — $envoy_target malformed JSON -> HTTP $http_code," \
         "expected 4xx; not failing the build" >&2
  fi
}

# --- per-stack assertions ----------------------------------------------------

run_stack_tests() {
  local stack="$1" grpc_target="$2" rest_base="$3" envoy_target="$4" envoy_internal_target="$5"

  echo
  echo "=== verifying stack '$stack' (gRPC $grpc_target, REST $rest_base, Envoy $envoy_target) ==="

  wait_for_grpc "$grpc_target"
  wait_for_booking "$rest_base"
  wait_for_envoy "$envoy_target"

  # --- 1. Native internal gRPC ---------------------------------------------
  local native_resp
  native_resp="$(grpc_call "$grpc_target" "$GETQUOTE_METHOD" "$GRPC_REQUEST")"
  assert_quote_fields_json "$native_resp" "$stack native gRPC"
  echo "=== $stack: native gRPC OK ===" >&2

  # --- 2. The hand-written REST shim (the Ch21 booking seam) ---------------
  local booking_resp
  booking_resp="$(curl -fsS -X POST "$rest_base/booking/quote" \
    -H 'content-type: application/json' -d "$BOOKING_REQUEST")"
  assert_quote_fields_json "$booking_resp" "$stack REST shim (/booking/quote)"
  echo "=== $stack: REST shim OK ===" >&2

  # --- 3. Envoy JSON/HTTP transcoder: the SAME RPC, now reached over plain
  #        JSON at the RPC-shaped URL, with NO hand-written mapping code ----
  local transcoded_resp
  transcoded_resp="$(curl -fsS -X POST "http://$envoy_target/$GETQUOTE_METHOD" \
    -H 'content-type: application/json' -d "$GRPC_REQUEST")"
  assert_quote_fields_json "$transcoded_resp" "$stack Envoy JSON transcoder"
  echo "=== $stack: Envoy JSON/HTTP transcoder OK ===" >&2

  # --- 4. Envoy grpc-web: the deterministic browser stand-in ----------------
  # Runs INSIDE the compose network as an ephemeral container (`docker
  # compose run`), so the target is the Envoy service's IN-NETWORK name and
  # container port (envoy-quarkus:10000 / envoy-python:10000) — NOT the
  # host-published "localhost:1023x" address every other check in this
  # function uses from outside the network.
  local grpcweb_resp
  grpcweb_resp="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps \
    --entrypoint python python -m app.grpcweb_client "$envoy_internal_target" \
    --origin USNYC --destination NLRTM --weight-kg 1000)"
  assert_quote_fields_json "$grpcweb_resp" "$stack Envoy grpc-web"
  echo "=== $stack: Envoy grpc-web OK ===" >&2

  # --- 5. (opt, non-fatal) malformed JSON -> HTTP 4xx -----------------------
  check_transcoder_malformed_json "$envoy_target"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up (apps + both Envoys) ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks, all four paths ==="
run_stack_tests "quarkus" "localhost:9230" "http://localhost:8230" "localhost:10230" "envoy-quarkus:10000"
run_stack_tests "python" "localhost:9231" "http://localhost:8231" "localhost:10231" "envoy-python:10000"

echo
echo "PASS — Ch23 grpc-web & JSON/HTTP transcoding: on BOTH the Quarkus and" \
     "the Python stack, RoutingService.GetQuote returns the identical quote" \
     "(USD 2500.00, rte_USNYC-NLRTM, MAERSK) over native gRPC, the" \
     "hand-written REST shim, Envoy's JSON/HTTP transcoder, AND Envoy's" \
     "grpc-web filter — one RPC, four doors in."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
