#!/usr/bin/env bash
# examples/24-cross-protocol-http3/verify.sh
#
# Ch24 cross-protocol-http3 — three things get verified, with two very
# different severities:
#
#   1. HARD, CI-GATED — h2 correctness: shipping.routing.v1.RoutingService.
#      GetQuote over native gRPC (which means HTTP/2 on both stacks) returns
#      the correct quote fields. A failure here fails this script.
#   2. HARD, CI-GATED — a measured h2 ghz baseline: a real `ghz` load-test
#      run against GetQuote on each stack, through the pinned `ghz` compose
#      service. Asserts loose, relative bounds only (zero errors, a generous
#      p99 ceiling, a low rps floor) — contracts.yml's existing 3-attempt
#      verify retry absorbs ordinary CI load variance. A failure here fails
#      this script.
#   3. SOFT, CAPABILITY-GATED, NON-FATAL — an HTTP/3-over-QUIC transport
#      probe against the `caddy` service (a static JSON file, not a gRPC
#      endpoint). On success this logs a confirmed QUIC handshake + 200 and
#      is explicit that this is the transport, not gRPC-over-HTTP/3. On any
#      failure (sandboxed CI network blocking UDP, a dropped handshake) this
#      logs a clear SKIP with the documented fallback and the script keeps
#      going — it never reds the build over this step. Neither this script
#      nor any assertion in it ever claims a gRPC-over-HTTP/3 measurement;
#      grpc-java and grpcio have no such transport as of this writing (see
#      the chapter prose).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch24-cross-protocol"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

GETQUOTE_METHOD="shipping.routing.v1.RoutingService/GetQuote"

# The same single-cargo-item request used throughout this book's unary
# chapters: 1200.5kg * 2.50 = 3001.25.
GETQUOTE_REQUEST='{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}'
EXPECT_QUOTE_AMOUNT="3001.25"

# ghz: loose bounds only (same discipline as Ch18's).
GHZ_CONCURRENCY=10
GHZ_TOTAL=300
GHZ_P99_CEILING_S="1.5"
GHZ_RPS_FLOOR="20"

# h3 transport probe: non-fatal, with a small internal retry to absorb Caddy
# cold-start — not a correctness retry, just "has the container finished
# minting its internal TLS cert and bound the UDP socket yet."
H3_PROBE_ATTEMPTS=3
H3_PROBE_RETRY_DELAY_S=3

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

# --- 1. HARD: h2 correctness ------------------------------------------------
run_correctness() {
  local stack="$1" host_target="$2"

  echo
  echo "=== $stack: h2 correctness (native gRPC GetQuote, HTTP/2) at $host_target ==="
  wait_for_grpc "$host_target"

  local resp
  resp="$(grpc_call "$host_target" "$GETQUOTE_METHOD" "$GETQUOTE_REQUEST")"
  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack quote.currency"
  assert_eq "$EXPECT_QUOTE_AMOUNT" "$(json_field '.quote.amount' <<<"$resp")" "$stack quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack route.legs.0.carrier"
  echo "=== $stack: h2 correctness passed ==="
}

# --- 2. HARD: measured h2 ghz baseline --------------------------------------
run_ghz() {
  local stack="$1" in_network_target="$2"

  echo
  echo "=== $stack: ghz measured h2 baseline (GetQuote, c=$GHZ_CONCURRENCY n=$GHZ_TOTAL) ==="
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

  echo "lib.sh: info — $stack ghz (h2): errors=$errors rps=$rps p99=${p99_s}s" >&2
  assert_eq "0" "$errors" "$stack ghz (h2) error count"
  assert_lt_num "$p99_s" "$GHZ_P99_CEILING_S" "$stack ghz (h2) p99 latency vs generous ceiling"
  assert_gt_num "$rps" "$GHZ_RPS_FLOOR" "$stack ghz (h2) throughput vs low floor"
}

# --- 3. SOFT/capability-gated, NON-FATAL: h3 transport probe ---------------
#
# Runs app/h3_probe.py (aioquic) from the already-built python image against
# the caddy service. Retries a few times to absorb Caddy's own cold start
# (minting its internal CA + leaf cert, binding the UDP socket), but any
# failure after that is a SKIP, never a script failure — this function
# always returns 0.
run_h3_probe() {
  echo
  echo "=== h3 transport probe (aioquic -> caddy:8443, QUIC/HTTP-3 — not gRPC-over-HTTP/3) ==="

  local attempt out rc
  for (( attempt=1; attempt<=H3_PROBE_ATTEMPTS; attempt++ )); do
    echo "lib.sh: info — h3 probe attempt $attempt/$H3_PROBE_ATTEMPTS" >&2
    rc=0
    out="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm --no-deps \
          --entrypoint python python -m app.h3_probe caddy 8443 --path /transport.json 2>&1)" || rc=$?
    echo "$out" | sed 's/^/lib.sh: h3_probe: /' >&2

    if [[ "$rc" -eq 0 ]] && grep -q "PROBE_OK" <<<"$out"; then
      echo "lib.sh: ok — h3 transport confirmed: a real QUIC handshake completed and Caddy" >&2
      echo "          answered HTTP/3 with 200. This is the transport, not gRPC-over-HTTP/3 —" >&2
      echo "          no gRPC call was made against it; GetQuote above is the only gRPC traffic" >&2
      echo "          in this chapter's example, and it ran over native gRPC/HTTP2." >&2
      return 0
    fi
    [[ "$attempt" -lt "$H3_PROBE_ATTEMPTS" ]] && sleep "$H3_PROBE_RETRY_DELAY_S"
  done

  echo "lib.sh: SKIP — h3 transport probe did not complete after $H3_PROBE_ATTEMPTS attempt(s)." >&2
  echo "          Non-fatal by design: this environment may block outbound/inter-container UDP" >&2
  echo "          (QUIC rides on UDP), which some sandboxed CI runners and corporate networks do." >&2
  echo "          Documented fallback: run 'docker compose up caddy' and 'docker compose run --rm" >&2
  echo "          --entrypoint python python -m app.h3_probe caddy 8443' locally, or point a" >&2
  echo "          HTTP/3-capable curl ('curl --http3-only -k https://localhost:8443/transport.json')" >&2
  echo "          at the published port. This SKIP does not fail the build — the chapter treats" >&2
  echo "          h2 as the hard gate and HTTP/3 here as a capability-gated demo." >&2
  return 0
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: h2 correctness on both stacks (HARD) ==="
run_correctness "quarkus" "localhost:9240"
run_correctness "python" "localhost:9241"

echo
echo "=== Step 3: ghz measured h2 baseline on both stacks (HARD) ==="
run_ghz "quarkus" "quarkus:9000"
run_ghz "python" "python:9000"

echo
echo "=== Step 4: HTTP/3 transport probe (SOFT, capability-gated, non-fatal) ==="
run_h3_probe

echo
echo "PASS — Ch24 cross-protocol-http3: GetQuote is correct over native gRPC/HTTP2" \
     "on both stacks, and ghz reports zero errors with generous latency/throughput" \
     "bounds against GetQuote on both stacks (the HARD gates). The HTTP/3 transport" \
     "probe result is logged above as either confirmed or a documented, non-fatal" \
     "SKIP — it never gates this build, and it never asserts a gRPC-over-HTTP/3" \
     "measurement."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
