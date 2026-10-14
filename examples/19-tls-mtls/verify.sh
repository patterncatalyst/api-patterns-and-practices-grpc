#!/usr/bin/env bash
# examples/19-tls-mtls/verify.sh
#
# Ch19 tls-mtls — shipping.routing.v1.RoutingService.GetQuote on both stacks,
# served over TLS and then mTLS, from the SAME certificates certgen mints
# fresh on every run (see certgen/gen-certs.sh and compose.yaml). Four
# assertions, on BOTH stacks, in two phases:
#
#   Phase A — TLS only (GRPC_CLIENT_AUTH=NONE):
#     1. A grpcurl call presenting only the CA succeeds, with correct
#        GetQuote field values (semantic, not just a clean exit).
#     2. The SAME call over -plaintext fails at the transport/handshake
#        layer — a TLS-only server never speaks plaintext gRPC.
#
#   Phase B — mTLS (GRPC_CLIENT_AUTH=REQUIRED, this example's steady state):
#     3. A grpcurl call presenting the CA AND a client cert/key succeeds,
#        with correct GetQuote field values.
#     4. The IDENTICAL call minus the client cert/key — the exact invocation
#        that succeeded in assertion 1 — now fails at the handshake layer,
#        because the server now requires a client certificate.
#
# Assertions 1 and 4 use the same grpcurl flags against the same server;
# they disagree only because the server's client-auth requirement changed
# between phases. That contrast IS this chapter's point: TLS alone proves
# the server's identity to the client; mTLS adds the other direction.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch19-tls"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
HOST_OUT_DIR="$SCRIPT_DIR/.host-out"

CA_CRT="$HOST_OUT_DIR/ca.crt"
CLIENT_CRT="$HOST_OUT_DIR/client.crt"
CLIENT_KEY="$HOST_OUT_DIR/client.key"

METHOD="shipping.routing.v1.RoutingService/GetQuote"
# The same single-cargo-item request used throughout this book's unary
# chapters: 1200.5kg * 2.50 = 3001.25.
REQUEST='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'
EXPECT_AMOUNT="3001.25"

# --- local helpers (verify.sh-only; lib.sh is shared and not modified) -----

# wait_for_certs — certgen's depends_on:condition:service_completed_successfully
# means it has already exited 0 by the time `docker compose up -d` returns,
# so these files should exist immediately; this loop is defensive headroom
# against filesystem-visibility races, not the primary synchronization.
wait_for_certs() {
  local waited=0 timeout=30
  while (( waited < timeout )); do
    if [[ -s "$CA_CRT" && -s "$CLIENT_CRT" && -s "$CLIENT_KEY" ]]; then
      echo "lib.sh: ok — certgen output present in $HOST_OUT_DIR" >&2
      return 0
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  echo "lib.sh: FAIL — certgen output never appeared in $HOST_OUT_DIR after ${timeout}s" >&2
  return 1
}

# assert_tls_rejected <combined-output> <context> — the call must have
# already been confirmed non-zero-exit by the caller; this only checks the
# error text names a transport/handshake failure rather than a clean
# application-level gRPC status (e.g. a normal PERMISSION_DENIED would NOT
# satisfy this). Real runs produce one of three shapes depending on exactly
# where the handshake dies: "remote error: tls: certificate required" (a
# clean TLS alert), "EOF" (the server closed the socket outright), or
# "context deadline exceeded" (the client gave up waiting) — grpcurl prefixes
# all three with "Failed to dial target host", which is itself diagnostic:
# that prefix only ever appears when a call fails before a gRPC status was
# ever negotiated, i.e. never for a clean application-level error.
assert_tls_rejected() {
  local out="$1" context="${2:-tls-rejected}"
  if ! grep -qiE 'failed to dial|tls|handshake|certificate|unavailable|eof|deadline exceeded' <<<"$out"; then
    echo "lib.sh: FAIL — ${context}: error text doesn't name a transport/TLS failure: $out" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: rejected at the transport/handshake layer" >&2
}

# run_plaintext_refused <host:port> <context>
run_plaintext_refused() {
  local target="$1" context="$2"
  ensure_grpcurl
  local out rc=0
  out="$(grpcurl -plaintext -d "$REQUEST" "$target" "$METHOD" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "lib.sh: FAIL — ${context}: plaintext call succeeded against a TLS-only server" >&2
    return 1
  fi
  assert_tls_rejected "$out" "$context"
}

# run_no_client_cert_rejected <host:port> <servername> <context>
run_no_client_cert_rejected() {
  local target="$1" servername="$2" context="$3"
  ensure_grpcurl
  local out rc=0
  out="$(grpcurl -cacert "$CA_CRT" -servername "$servername" -d "$REQUEST" "$target" "$METHOD" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "lib.sh: FAIL — ${context}: call without a client cert succeeded against an mTLS-required server" >&2
    return 1
  fi
  assert_tls_rejected "$out" "$context"
}

# assert_quote <response-json> <stack> <phase>
assert_quote() {
  local resp="$1" stack="$2" phase="$3"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack $phase quote.currency"
  assert_eq "$EXPECT_AMOUNT" "$(json_field '.quote.amount' <<<"$resp")" "$stack $phase quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack $phase route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack $phase route.legs.0.carrier"
}

run_phase_a() {
  local stack="$1" target="$2" servername="$3"

  echo
  echo "=== $stack phase A (TLS only): CA-only call succeeds ==="
  GRPCURL_OPTS="-cacert $CA_CRT -servername $servername"
  wait_for_grpc "$target"
  local resp
  resp="$(grpc_call "$target" "$METHOD" "$REQUEST")"
  assert_quote "$resp" "$stack" "phase A TLS"
  echo "=== $stack phase A: CA-only call ok ==="

  echo
  echo "=== $stack phase A: plaintext refused ==="
  run_plaintext_refused "$target" "$stack phase A plaintext-refused"
}

run_phase_b() {
  local stack="$1" target="$2" servername="$3"

  echo
  echo "=== $stack phase B (mTLS): CA + client cert call succeeds ==="
  GRPCURL_OPTS="-cacert $CA_CRT -cert $CLIENT_CRT -key $CLIENT_KEY -servername $servername"
  wait_for_grpc "$target"
  local resp
  resp="$(grpc_call "$target" "$METHOD" "$REQUEST")"
  assert_quote "$resp" "$stack" "phase B mTLS"
  echo "=== $stack phase B: CA + client cert call ok ==="

  echo
  echo "=== $stack phase B: CA-only call (no client cert) rejected ==="
  run_no_client_cert_rejected "$target" "$servername" "$stack phase B no-client-cert-rejected"
}

echo "=== Step 1: docker compose up (phase A — GRPC_CLIENT_AUTH=NONE) ==="
export GRPC_CLIENT_AUTH=NONE
compose_up "$COMPOSE_FILE" "$PROJECT"
wait_for_certs

echo
echo "=== Step 2: phase A assertions (TLS only) on both stacks ==="
run_phase_a "quarkus" "localhost:9190" "quarkus"
run_phase_a "python" "localhost:9191" "python"

echo
echo "=== Step 3: docker compose up (phase B — GRPC_CLIENT_AUTH=REQUIRED) ==="
export GRPC_CLIENT_AUTH=REQUIRED
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d quarkus python

echo
echo "=== Step 4: phase B assertions (mTLS) on both stacks ==="
run_phase_b "quarkus" "localhost:9190" "quarkus"
run_phase_b "python" "localhost:9191" "python"

echo
echo "PASS — Ch19 tls-mtls: Quarkus and Python both serve GetQuote over" \
     "TLS with correct field values; a plaintext call against either is" \
     "refused at the handshake layer; switching both servers to" \
     "client-auth=REQUIRED makes the identical CA-only call that succeeded" \
     "under TLS fail the same way, while presenting a client cert/key" \
     "succeeds — the full TLS-then-mTLS progression, on both stacks."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
