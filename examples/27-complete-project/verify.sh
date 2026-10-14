#!/usr/bin/env bash
# examples/27-complete-project/verify.sh
#
# Ch27 final project — the CI-gated Compose tier, both stacks. Brings up the
# whole system (certgen, the always-on LGTM stack, and both app services) and
# runs it through every integration claim this chapter makes:
#
#   1. The full flow: POST /booking/quote on both stacks returns correct
#      Money/route fields plus a traceId.
#   2. All four RPC shapes, each asserted for real: unary GetQuote, server-
#      streaming WatchShipment, client-streaming ReportPositions, and
#      bidirectional NegotiateRoute.
#   3. mTLS enforced: a call with no client cert, and a -plaintext call,
#      are both refused at the handshake layer (Ch19's assert_tls_rejected).
#   4. JWT enforced: a missing token is UNAUTHENTICATED; a wrong-scope token
#      on the admin-gated RPC is PERMISSION_DENIED (Ch20's shape).
#   5. Trace-id continuity (hard): the REST response's traceId is the SAME
#      id both RoutingService's and QuoteService's handlers logged while
#      serving that one request (Ch21's pattern).
#   6. Soft: Tempo actually holds a multi-span trace for the request (bounded,
#      non-fatal — a slow/absent trace does not fail the gate).
#   7. A pinned ghz smoke test against GetQuote (loose bounds, 3-retry).
#
# Every helper below is EXAMPLE-LOCAL (examples/_lib/lib.sh is shared across
# every chapter and stays untouched).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch27-final-project"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
HOST_OUT_DIR="$SCRIPT_DIR/.host-out"

CA_CRT="$HOST_OUT_DIR/ca.crt"
CLIENT_CRT="$HOST_OUT_DIR/client.crt"
CLIENT_KEY="$HOST_OUT_DIR/client.key"

# host:port per stack (gRPC, mTLS+JWT) and (REST, plain HTTP)
QUARKUS_GRPC="localhost:9270"
PYTHON_GRPC="localhost:9271"
QUARKUS_REST="http://localhost:8270"
PYTHON_REST="http://localhost:8271"
TEMPO_URL="http://localhost:3200"

# The single-cargo-item request this book's unary chapters have used since
# Ch7/Ch19/Ch21: 1200.5kg * 2.50 = 3001.25.
UNARY_REQUEST='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'
EXPECT_AMOUNT="3001.25"

# ---------------------------------------------------------------------------
# local helpers (verify.sh-only; lib.sh is shared and not modified)
# ---------------------------------------------------------------------------

wait_for_certs() {
  local waited=0 timeout=30
  while (( waited < timeout )); do
    if [[ -s "$CA_CRT" && -s "$CLIENT_CRT" && -s "$CLIENT_KEY" ]]; then
      echo "verify.sh: ok — certgen output present in $HOST_OUT_DIR" >&2
      return 0
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  echo "verify.sh: FAIL — certgen output never appeared in $HOST_OUT_DIR after ${timeout}s" >&2
  return 1
}

# wait_for_rest <url> [timeout_secs] — polls a REST base URL's /booking/quote
# with a throwaway POST until the gRPC-backed handler answers (the mTLS+JWT
# gRPC server and its loopback clients may come up a beat after the HTTP
# listener itself).
wait_for_rest() {
  local url="$1" timeout="${2:-90}" waited=0
  while (( waited < timeout )); do
    if curl -fsS -X POST "$url/booking/quote" -H 'content-type: application/json' \
         -d '{"origin":"USNYC","destination":"NLRTM","cargoKg":1}' >/dev/null 2>&1; then
      echo "verify.sh: ok — $url is up after ${waited}s" >&2
      return 0
    fi
    sleep 3
    waited=$(( waited + 3 ))
  done
  echo "verify.sh: FAIL — $url did not come up within ${timeout}s" >&2
  return 1
}

# assert_tls_rejected <combined-output> <context> — Ch19's helper, reused
# verbatim: the call must already be confirmed non-zero-exit by the caller;
# this only checks the error text names a transport/handshake failure.
assert_tls_rejected() {
  local out="$1" context="${2:-tls-rejected}"
  if ! grep -qiE 'failed to dial|tls|handshake|certificate|unavailable|eof|deadline exceeded' <<<"$out"; then
    echo "verify.sh: FAIL — ${context}: error text doesn't name a transport/TLS failure: $out" >&2
    return 1
  fi
  echo "verify.sh: ok — ${context}: rejected at the transport/handshake layer" >&2
}

# mint_token <case> — mints an HS256 JWT via the already-built python service
# (app/mint_token.py). Both stacks verify against the SAME hardcoded shared
# secret (see python/app/auth.py and quarkus/.../security/JwtVerifier.java),
# so one minted token is valid against either stack's gRPC port.
mint_token() {
  local case="$1"
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps --entrypoint python python \
    -m app.mint_token "$case" | tr -d '\r\n'
}

# lib.sh's grpc_call/grpc_expect_code/grpc_client_stream don't pass -H or
# per-call -cacert/-cert/-key, and GRPCURL_OPTS is plain word-split (a
# "Bearer <token>" value with a space would split into two argv words) — so
# every mTLS+JWT call below invokes grpcurl DIRECTLY, with real shell
# quoting, the same convention Ch20's verify.sh uses for its header cases.

# mtls_grpcurl <servername> <token> <grpcurl-args...> — echoes nothing; the
# caller wraps this in `out="$(mtls_grpcurl ...)"`.
mtls_grpcurl() {
  local servername="$1" token="$2"
  shift 2
  ensure_grpcurl
  grpcurl -cacert "$CA_CRT" -cert "$CLIENT_CRT" -key "$CLIENT_KEY" -servername "$servername" \
    -H "authorization: Bearer $token" "$@"
}

# mtls_expect_code <servername> <token> <target> <method> <json> <expected> <context>
#
# The mTLS+JWT twin of lib.sh's grpc_expect_code (same PascalCase-vs-
# UPPER_SNAKE code normalization).
mtls_expect_code() {
  local servername="$1" token="$2" target="$3" method="$4" data="$5" expected="$6" context="${7:-$method}"
  local out rc=0
  out="$(mtls_grpcurl "$servername" "$token" -d "$data" "$target" "$method" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "verify.sh: FAIL — ${context}: expected error code $expected, but the call succeeded" >&2
    return 1
  fi
  local got exp_n got_n
  got="$(grep -oiE "Code:[[:space:]]*[A-Za-z_]+" <<<"$out" | head -1 | sed -E 's/^[Cc]ode:[[:space:]]*//')"
  exp_n="$(printf '%s' "$expected" | tr -d '_ ' | tr '[:upper:]' '[:lower:]')"
  got_n="$(printf '%s' "$got" | tr -d '_ ' | tr '[:upper:]' '[:lower:]')"
  if [[ -n "$got_n" && "$got_n" == "$exp_n" ]]; then
    echo "verify.sh: ok — ${context}: got expected code $expected (grpcurl: ${got})" >&2
    return 0
  fi
  echo "verify.sh: FAIL — ${context}: expected code $expected, got: $out" >&2
  return 1
}

# ---------------------------------------------------------------------------
# assertions, parameterized by stack
# ---------------------------------------------------------------------------

# assert_full_flow <stack> <rest-base-url>
assert_full_flow() {
  local stack="$1" rest="$2"
  echo
  echo "=== $stack: full flow — POST /booking/quote ==="
  local resp
  resp="$(curl -fsS -X POST "$rest/booking/quote" -H 'content-type: application/json' \
    -d '{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}')"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack booking.quote.currency"
  assert_eq "2500.00" "$(json_field '.quote.amount' <<<"$resp")" "$stack booking.quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack booking.route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack booking.route.legs.0.carrier"
  local trace_id
  trace_id="$(json_field '.traceId' <<<"$resp")"
  if [[ ! "$trace_id" =~ ^[0-9a-f]{32}$ ]]; then
    echo "verify.sh: FAIL — $stack booking.traceId: '$trace_id' is not a 32-hex-digit W3C trace id" >&2
    return 1
  fi
  echo "verify.sh: ok — $stack booking.traceId: $trace_id" >&2
  # Exported for the caller (trace-id-continuity assertion and the soft
  # Tempo check both need it); bash has no return-by-value, so a global.
  LAST_TRACE_ID="$trace_id"
}

# assert_unary_get_quote <stack> <grpc-target> <servername> <token>
assert_unary_get_quote() {
  local stack="$1" target="$2" servername="$3" token="$4"
  echo
  echo "=== $stack: unary GetQuote (mTLS + JWT) ==="
  local resp
  resp="$(mtls_grpcurl "$servername" "$token" -d "$UNARY_REQUEST" "$target" "shipping.routing.v1.RoutingService/GetQuote")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack GetQuote quote.currency"
  assert_eq "$EXPECT_AMOUNT" "$(json_field '.quote.amount' <<<"$resp")" "$stack GetQuote quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack GetQuote route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack GetQuote route.legs.0.carrier"
}

# assert_watch_shipment <stack> <grpc-target> <servername> <token>
assert_watch_shipment() {
  local stack="$1" target="$2" servername="$3" token="$4"
  echo
  echo "=== $stack: server-streaming WatchShipment (mTLS + JWT) ==="
  local stream
  stream="$(mtls_grpcurl "$servername" "$token" -d '{"bookingId":"bkg_ch27_verify"}' "$target" "shipping.tracking.v1.TrackingService/WatchShipment")"
  local count
  count="$(json_stream_count <<<"$stream")"
  assert_eq "4" "$count" "$stack WatchShipment event count"
  assert_eq "BOOKING_STATE_PENDING" "$(json_stream_field 0 '.event.state' <<<"$stream")" "$stack WatchShipment[0].state"
  assert_eq "BOOKING_STATE_CONFIRMED" "$(json_stream_field 1 '.event.state' <<<"$stream")" "$stack WatchShipment[1].state"
  assert_eq "BOOKING_STATE_IN_TRANSIT" "$(json_stream_field 2 '.event.state' <<<"$stream")" "$stack WatchShipment[2].state"
  assert_eq "BOOKING_STATE_DELIVERED" "$(json_stream_field 3 '.event.state' <<<"$stream")" "$stack WatchShipment[3].state"
}

# assert_report_positions <stack> <grpc-target> <servername> <token>
assert_report_positions() {
  local stack="$1" target="$2" servername="$3" token="$4"
  echo
  echo "=== $stack: client-streaming ReportPositions (mTLS + JWT) ==="
  local resp
  resp="$(printf '%s\n%s\n%s\n' \
    '{"event":{"bookingId":"bkg_ch27_verify","location":{"unLocode":"USNYC"},"state":"BOOKING_STATE_PENDING"}}' \
    '{"event":{"bookingId":"bkg_ch27_verify","location":{"unLocode":"USNYC"},"state":"BOOKING_STATE_CONFIRMED"}}' \
    '{"event":{"bookingId":"bkg_ch27_verify","location":{"unLocode":"NLRTM"},"state":"BOOKING_STATE_DELIVERED"}}' \
    | mtls_grpcurl "$servername" "$token" -d @ "$target" "shipping.tracking.v1.TrackingService/ReportPositions")"
  assert_eq "3" "$(json_field '.accepted_count' <<<"$resp")" "$stack ReportPositions accepted_count"
}

# assert_negotiate_route <stack> <grpc-target> <servername> <token>
assert_negotiate_route() {
  local stack="$1" target="$2" servername="$3" token="$4"
  echo
  echo "=== $stack: bidirectional NegotiateRoute (mTLS + JWT) ==="
  local stream
  stream="$(printf '%s\n%s\n' \
    '{"proposal":{"id":"rte_demo-accept","price":{"currency":"USD","amount":"2500.00"}}}' \
    '{"proposal":{"id":"rte_demo-counter","price":{"currency":"USD","amount":"9000.00"}}}' \
    | mtls_grpcurl "$servername" "$token" -d @ "$target" "shipping.routing.v1.RoutingService/NegotiateRoute")"
  assert_eq "2" "$(json_stream_count <<<"$stream")" "$stack NegotiateRoute response count"
  assert_eq "true" "$(json_stream_field 0 '.accepted' <<<"$stream")" "$stack NegotiateRoute[0].accepted (at-threshold proposal)"
  assert_eq "2500.00" "$(json_stream_field 0 '.counter.price.amount' <<<"$stream")" "$stack NegotiateRoute[0].counter.price.amount"
  # proto3 omits a false bool from JSON, so .accepted is ABSENT here (the json
  # walker raises on a missing key — tolerate it and read absent as "not accepted").
  local acc1; acc1="$(json_stream_field 1 '.accepted' <<<"$stream" 2>/dev/null || true)"
  assert_eq "false" "${acc1:-false}" "$stack NegotiateRoute[1].accepted (over-threshold proposal; proto3 omits false)"
  assert_eq "8100.00" "$(json_stream_field 1 '.counter.price.amount' <<<"$stream")" "$stack NegotiateRoute[1].counter.price.amount (90% of 9000.00)"
}

# assert_mtls_enforced <stack> <grpc-target> <servername> <token>
assert_mtls_enforced() {
  local stack="$1" target="$2" servername="$3" token="$4"
  ensure_grpcurl
  echo
  echo "=== $stack: mTLS enforced — no client cert rejected ==="
  local out rc=0
  out="$(grpcurl -cacert "$CA_CRT" -servername "$servername" -H "authorization: Bearer $token" \
    -d "$UNARY_REQUEST" "$target" "shipping.routing.v1.RoutingService/GetQuote" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "verify.sh: FAIL — $stack mtls-no-client-cert: call without a client cert succeeded" >&2
    return 1
  fi
  assert_tls_rejected "$out" "$stack mtls-no-client-cert"

  echo
  echo "=== $stack: mTLS enforced — plaintext rejected ==="
  rc=0
  out="$(grpcurl -plaintext -H "authorization: Bearer $token" \
    -d "$UNARY_REQUEST" "$target" "shipping.routing.v1.RoutingService/GetQuote" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "verify.sh: FAIL — $stack mtls-plaintext: a -plaintext call succeeded against an mTLS-only server" >&2
    return 1
  fi
  assert_tls_rejected "$out" "$stack mtls-plaintext"
}

# assert_jwt_enforced <stack> <grpc-target> <servername> <wrong-scope-token> <expired-token> <bad-sig-token>
assert_jwt_enforced() {
  local stack="$1" target="$2" servername="$3" wrong_scope="$4" expired="$5" bad_sig="$6"
  echo
  echo "=== $stack: JWT enforced — missing token -> UNAUTHENTICATED ==="
  ensure_grpcurl
  local out rc=0
  out="$(grpcurl -cacert "$CA_CRT" -cert "$CLIENT_CRT" -key "$CLIENT_KEY" -servername "$servername" \
    -d "$UNARY_REQUEST" "$target" "shipping.routing.v1.RoutingService/GetQuote" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "verify.sh: FAIL — $stack jwt-missing: expected UNAUTHENTICATED, but the call succeeded" >&2
    return 1
  fi
  if ! grep -qiE 'unauthenticated' <<<"$out"; then
    echo "verify.sh: FAIL — $stack jwt-missing: expected UNAUTHENTICATED, got: $out" >&2
    return 1
  fi
  echo "verify.sh: ok — $stack jwt-missing: got expected code UNAUTHENTICATED" >&2

  echo
  echo "=== $stack: JWT enforced — expired token -> UNAUTHENTICATED ==="
  mtls_expect_code "$servername" "$expired" "$target" "shipping.routing.v1.RoutingService/GetQuote" \
    "$UNARY_REQUEST" "UNAUTHENTICATED" "$stack jwt-expired"

  echo
  echo "=== $stack: JWT enforced — bad signature -> UNAUTHENTICATED ==="
  mtls_expect_code "$servername" "$bad_sig" "$target" "shipping.routing.v1.RoutingService/GetQuote" \
    "$UNARY_REQUEST" "UNAUTHENTICATED" "$stack jwt-bad-sig"

  echo
  echo "=== $stack: JWT enforced — wrong scope on the admin-gated RPC -> PERMISSION_DENIED ==="
  mtls_expect_code "$servername" "$wrong_scope" "$target" "shipping.routing.v1.RoutingService/ListRoutes" \
    '{"pageSize":10}' "PERMISSION_DENIED" "$stack jwt-wrong-scope-ListRoutes"
}

# assert_trace_id_continuity <stack> <compose-service-name> <log-key>
#
# Hard assertion: the trace id POST /booking/quote returned (assert_full_flow
# set LAST_TRACE_ID) must appear in BOTH the RoutingService handler's log line
# AND the QuoteService handler's log line for that one request — proof the
# trace context survived the internal mTLS+JWT loopback hop (Ch21's pattern).
assert_trace_id_continuity() {
  local stack="$1" service="$2" log_key="$3"
  echo
  echo "=== $stack: trace-id continuity (hard) — trace_id=$LAST_TRACE_ID ==="
  local logs
  logs="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs "$service" 2>&1)"

  if ! grep -q "RoutingService.*${log_key}=${LAST_TRACE_ID}" <<<"$logs" \
      && ! grep -qi "routingservice.*${log_key}=${LAST_TRACE_ID}" <<<"$logs"; then
    echo "verify.sh: FAIL — $stack trace-id-continuity: RoutingService handler log does not show ${log_key}=${LAST_TRACE_ID}" >&2
    return 1
  fi
  echo "verify.sh: ok — $stack trace-id-continuity: RoutingService handler logged ${log_key}=${LAST_TRACE_ID}" >&2

  if ! grep -qi "quoteservice.*${log_key}=${LAST_TRACE_ID}" <<<"$logs"; then
    echo "verify.sh: FAIL — $stack trace-id-continuity: QuoteService handler log does not show ${log_key}=${LAST_TRACE_ID}" >&2
    return 1
  fi
  echo "verify.sh: ok — $stack trace-id-continuity: QuoteService handler logged ${log_key}=${LAST_TRACE_ID} (SAME id as the REST response)" >&2
}

# assert_tempo_soft <stack> — SOFT: queries Tempo for a multi-span trace with
# this trace id. Bounded retries, never fails the gate — Tempo's own ingest
# latency and this book's CI runners are both out of this chapter's control.
assert_tempo_soft() {
  local stack="$1"
  echo
  echo "=== $stack: Tempo multi-span check (SOFT, non-fatal) — trace_id=$LAST_TRACE_ID ==="
  local attempt=0 max_attempts=6 span_count="0"
  while (( attempt < max_attempts )); do
    local resp
    resp="$(curl -fsS "$TEMPO_URL/api/traces/${LAST_TRACE_ID}" 2>/dev/null || true)"
    if [[ -n "$resp" ]]; then
      span_count="$(python3 -I -c '
import json, sys
try:
    doc = json.loads(sys.argv[1])
except Exception:
    print(0); raise SystemExit
batches = doc.get("batches") or []
n = sum(len(b.get("scopeSpans", b.get("instrumentationLibrarySpans", []))[0].get("spans", []))
        for b in batches if b.get("scopeSpans") or b.get("instrumentationLibrarySpans"))
print(n)
' "$resp" 2>/dev/null || echo 0)"
      if [[ "$span_count" -ge 2 ]]; then
        break
      fi
    fi
    attempt=$(( attempt + 1 ))
    sleep 5
  done
  if [[ "$span_count" -ge 2 ]]; then
    echo "verify.sh: ok (soft) — $stack Tempo holds a $span_count-span trace for $LAST_TRACE_ID" >&2
  else
    echo "verify.sh: soft-skip — $stack Tempo did not show >=2 spans for $LAST_TRACE_ID within $(( max_attempts * 5 ))s (non-fatal; Tempo ingest lag is out of this chapter's control)" >&2
  fi
}

# ---------------------------------------------------------------------------
# ghz smoke (pinned ghcr.io/bojand/ghz, loose bounds, 3-retry) — Ch18's shape
# ---------------------------------------------------------------------------

# run_ghz_smoke <stack> <in-network-target> <servername> <token>
#
# ghz runs INSIDE the compose network (`docker compose run` auto-attaches to
# the project's default network — Ch18's shape), so <in-network-target> is
# the service DNS name + the CONTAINER port (e.g. "quarkus:9000"), never the
# host-published one. mTLS via --cacert/--cert/--key (certgen's /host-out
# copies, bind-mounted at /certs — see compose.yaml's ghz service) and
# --cname for the SAN-matched server-name override (TLS's twin of grpcurl's
# -servername; --authority only works with -insecure, per `ghz --help`).
run_ghz_smoke() {
  local stack="$1" target="$2" servername="$3" token="$4"
  echo
  echo "=== $stack: ghz smoke on GetQuote (pinned ghcr.io/bojand/ghz:0.121.0) ==="
  local out_file="/tmp/ch27-ghz-${stack}.json"
  local attempt ok=0
  for attempt in 1 2 3; do
    if docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm ghz \
        --proto /contracts/shipping/routing/v1/routing.proto \
        --import-paths /contracts \
        --call shipping.routing.v1.RoutingService.GetQuote \
        --cacert /certs/ca.crt --cert /certs/client.crt --key /certs/client.key \
        --cname "$servername" \
        --metadata "{\"authorization\":\"Bearer ${token}\"}" \
        -d "$UNARY_REQUEST" \
        -c 4 -n 80 -t 10s --connect-timeout 10s -O json \
        "$target" > "$out_file" 2>/tmp/ch27-ghz-"${stack}".err; then
      ok=1
      break
    fi
    echo "verify.sh: ghz attempt $attempt/3 failed for $stack — retrying" >&2
    cat /tmp/ch27-ghz-"${stack}".err >&2 || true
    [[ "$attempt" -lt 3 ]] && sleep 10
  done
  if [[ "$ok" -ne 1 ]]; then
    echo "verify.sh: FAIL — ghz smoke never completed for $stack after 3 attempts" >&2
    return 1
  fi

  # LOOSE: this is a smoke test confirming the server survives a short burst
  # under ghz's own mTLS+metadata flags, not a performance benchmark (Ch18
  # owns that). Only assert zero errors and that every requested call ran.
  local errors total
  errors="$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(d.get("errorDistribution",{}).values()))' "$out_file")"
  total="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["count"])' "$out_file")"
  rm -f "$out_file" /tmp/ch27-ghz-"${stack}".err
  echo "verify.sh: info — $stack ghz: total=$total errors=$errors" >&2
  assert_eq "0" "$errors" "$stack ghz error count"
  assert_eq "80" "$total" "$stack ghz completed request count"
}

# ---------------------------------------------------------------------------
# run both stacks
# ---------------------------------------------------------------------------

echo "=== Step 1: docker compose up (certgen, LGTM, quarkus, python) ==="
compose_up "$COMPOSE_FILE" "$PROJECT"
wait_for_certs

echo
echo "=== Step 2: wait for both stacks (gRPC + REST) ==="
# wait_for_grpc's reflection probe needs the SAME mTLS creds every other call
# in this file presents — this server never speaks plaintext gRPC, so the
# default GRPCURL_OPTS (-plaintext) would time out waiting for a handshake
# that never completes.
GRPCURL_OPTS="-cacert $CA_CRT -cert $CLIENT_CRT -key $CLIENT_KEY -servername quarkus"
wait_for_grpc "$QUARKUS_GRPC"
GRPCURL_OPTS="-cacert $CA_CRT -cert $CLIENT_CRT -key $CLIENT_KEY -servername python"
wait_for_grpc "$PYTHON_GRPC"
wait_for_rest "$QUARKUS_REST"
wait_for_rest "$PYTHON_REST"

echo
echo "=== Step 3: mint the four demo tokens (via the python stack; both stacks share one HMAC secret) ==="
TOKEN_VALID="$(mint_token valid)"
TOKEN_EXPIRED="$(mint_token expired)"
TOKEN_WRONG_SCOPE="$(mint_token wrong-scope)"
TOKEN_BAD_SIG="$(mint_token bad-sig)"
echo "verify.sh: minted valid/expired/wrong-scope/bad-sig tokens" >&2

# Fields are '|'-delimited (NOT ':' — host:port and http://host:port values
# below contain colons themselves): host-published gRPC target | servername |
# REST base URL | compose service name | REST-response trace-id JSON key |
# in-network target (for ghz, which runs INSIDE the compose network via
# `docker compose run` and so dials the container port under the service's
# own DNS name, never the host-published one).
for STACK_SPEC in "quarkus|$QUARKUS_GRPC|quarkus|$QUARKUS_REST|quarkus|traceId|quarkus:9000" \
                   "python|$PYTHON_GRPC|python|$PYTHON_REST|python|trace_id|python:9000"; do
  IFS='|' read -r STACK GRPC_TARGET SERVERNAME REST_BASE SERVICE LOG_KEY GHZ_TARGET <<<"$STACK_SPEC"

  assert_full_flow "$STACK" "$REST_BASE"
  assert_unary_get_quote "$STACK" "$GRPC_TARGET" "$SERVERNAME" "$TOKEN_VALID"
  assert_watch_shipment "$STACK" "$GRPC_TARGET" "$SERVERNAME" "$TOKEN_VALID"
  assert_report_positions "$STACK" "$GRPC_TARGET" "$SERVERNAME" "$TOKEN_VALID"
  assert_negotiate_route "$STACK" "$GRPC_TARGET" "$SERVERNAME" "$TOKEN_VALID"
  assert_mtls_enforced "$STACK" "$GRPC_TARGET" "$SERVERNAME" "$TOKEN_VALID"
  assert_jwt_enforced "$STACK" "$GRPC_TARGET" "$SERVERNAME" "$TOKEN_WRONG_SCOPE" "$TOKEN_EXPIRED" "$TOKEN_BAD_SIG"
  assert_trace_id_continuity "$STACK" "$SERVICE" "$LOG_KEY"
  assert_tempo_soft "$STACK"
  run_ghz_smoke "$STACK" "$GHZ_TARGET" "$SERVERNAME" "$TOKEN_VALID"
done

echo
echo "PASS — Ch27 final project: RoutingService, QuoteService, and TrackingService" \
     "run end to end on both stacks — the full REST->gRPC->gRPC booking flow, all" \
     "four RPC shapes (unary, server-stream, client-stream, bidi), mTLS enforced" \
     "at the handshake layer, JWT enforced with both UNAUTHENTICATED and" \
     "PERMISSION_DENIED outcomes, trace-id continuity across the internal mTLS+JWT" \
     "hop, and a ghz smoke pass — all against the SAME contracts/proto/ this" \
     "book has used since Chapter 5, with zero contract change."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
