#!/usr/bin/env bash
# examples/21-observability/verify.sh
#
# Ch21 observability ANCHOR — both the Quarkus and the Python stack run the
# Ch10 two-service loopback (RoutingService.GetQuote calling DOWNSTREAM
# QuoteService.GetQuote) PLUS a minimal REST front door, POST /booking/quote,
# that calls RoutingService.GetQuote. OpenTelemetry auto-instrumentation
# makes ONE trace span REST -> gRPC -> QuoteService, injecting a W3C
# traceparent into the gRPC call's metadata; Micrometer/prometheus-client
# publish gRPC server metrics; grpc.health.v1.Health answers SERVING. This
# script asserts all five claims, against BOTH stacks, before printing PASS.
#
# The helpers below (wait_for_lgtm, wait_for_http, assert_metric_present,
# assert_trace_id_in_logs, check_tempo_trace) are example-local — they live
# only in this file, not in ../_lib/lib.sh, because they're specific to this
# chapter's assertions (a Tempo poll, a Prometheus text-format scrape, a
# same-process dual-log-line grep) rather than general-purpose gRPC
# verification helpers every example needs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch21-observability"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

HEALTH_METHOD="grpc.health.v1.Health/Check"
BOOKING_REQUEST='{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}'

# ---------------------------------------------------------------------------
# Example-local helpers
# ---------------------------------------------------------------------------

# wait_for_lgtm [timeout_secs] — poll the always-on LGTM stack's Grafana
# health endpoint. Budgeted generously (default 90s) to cover the stack's
# cold start (Grafana + Tempo + Mimir + Loki + the Collector, all in one
# image) on a first `docker compose up --build`.
wait_for_lgtm() {
  local timeout="${1:-90}" waited=0 interval=5
  echo "verify.sh: waiting for lgtm (Grafana LGTM) health (timeout ${timeout}s) ..." >&2
  while (( waited < timeout )); do
    if curl -fsS -o /dev/null "http://localhost:3000/api/health"; then
      echo "verify.sh: lgtm is up after ${waited}s" >&2
      return 0
    fi
    sleep "$interval"
    waited=$(( waited + interval ))
  done
  echo "verify.sh: FAIL — lgtm did not become healthy within ${timeout}s" >&2
  return 1
}

# wait_for_http <url> [timeout_secs] — poll a plain HTTP GET until it
# answers (any response, even a 404, proves the server is accepting
# connections) or fail loudly after timeout_secs.
wait_for_http() {
  local url="$1" timeout="${2:-60}" waited=0 interval=3
  echo "verify.sh: waiting for HTTP $url (timeout ${timeout}s) ..." >&2
  while (( waited < timeout )); do
    if curl -fsS -o /dev/null "$url"; then
      echo "verify.sh: HTTP $url is up after ${waited}s" >&2
      return 0
    fi
    sleep "$interval"
    waited=$(( waited + interval ))
  done
  echo "verify.sh: FAIL — HTTP $url did not respond within ${timeout}s" >&2
  return 1
}

# assert_metric_present <metrics-text> <metric-name> <context> — sums every
# Prometheus text-format sample line whose name is exactly <metric-name>
# (ignoring labels) and asserts the total is > 0. Used against each app's
# OWN metrics endpoint (/q/metrics on Quarkus, /metrics on Python), never
# against Mimir, so the assertion is synchronous — no scrape-interval wait.
assert_metric_present() {
  local metrics_text="$1" metric_name="$2" context="${3:-$metric_name}"
  local total
  total="$(python3 -I -c '
import sys
text, name = sys.argv[1], sys.argv[2]
found = False
total = 0.0
for line in text.splitlines():
    line = line.strip()
    if not line or line.startswith("#") or not line.startswith(name):
        continue
    rest = line[len(name):]
    if rest and rest[0] not in (" ", "{"):
        continue  # a longer metric name that happens to share this prefix
    try:
        value = float(line.rsplit(" ", 1)[-1])
    except ValueError:
        continue
    found = True
    total += value
print(total if found else "NOTFOUND")
' "$metrics_text" "$metric_name")"

  if [[ "$total" == "NOTFOUND" ]]; then
    echo "lib.sh: FAIL — ${context}: metric '$metric_name' not found" >&2
    return 1
  fi
  if ! python3 -I -c "import sys; sys.exit(0 if float(sys.argv[1]) > 0 else 1)" "$total"; then
    echo "lib.sh: FAIL — ${context}: metric '$metric_name' total is $total, expected > 0" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: metric '$metric_name' total=$total" >&2
}

# assert_trace_id_in_logs <project> <compose-file> <service> <trace-id> <routing-pattern> <quote-pattern>
#
# HARD assertion: RoutingService and QuoteService run in the SAME container
# (the Ch10 loopback shape), so proving the traceparent crossed that
# loopback gRPC hop means finding the SAME trace id in TWO DISTINCT log
# lines from that one container's stdout — one from the Routing handler, one
# from the Quote handler — not just finding it once.
assert_trace_id_in_logs() {
  local project="$1" compose_file="$2" service="$3" trace_id="$4"
  local routing_pattern="$5" quote_pattern="$6"
  local logs
  logs="$(docker compose -p "$project" -f "$compose_file" logs "$service" 2>&1)"

  if ! grep -F "$routing_pattern$trace_id" <<<"$logs" >/dev/null; then
    echo "lib.sh: FAIL — $service: no Routing handler log line carrying trace_id=$trace_id" >&2
    echo "--- $service logs ---" >&2
    echo "$logs" >&2
    return 1
  fi
  echo "lib.sh: ok — $service: Routing handler logged trace_id=$trace_id" >&2

  if ! grep -F "$quote_pattern$trace_id" <<<"$logs" >/dev/null; then
    echo "lib.sh: FAIL — $service: no Quote handler log line carrying trace_id=$trace_id" >&2
    echo "--- $service logs ---" >&2
    echo "$logs" >&2
    return 1
  fi
  echo "lib.sh: ok — $service: Quote handler logged trace_id=$trace_id (SAME id — traceparent crossed the loopback hop)" >&2
}

# check_tempo_trace <trace-id> — SOFT, bounded-retry poll of Tempo's query
# API. Counts distinct values across BOTH the OTLP resource attribute
# "service.name" AND the RPC semantic-convention span attribute
# "rpc.service" found anywhere in the trace JSON. Because this chapter keeps
# the Ch10 colocated-process topology (RoutingService and QuoteService share
# one OTel resource/service.name per stack), two distinct resource names
# never appear in a single stack's trace; "rpc.service" differentiates them
# instead (shipping.routing.v1.RoutingService vs shipping.quote.v1.QuoteService),
# set automatically by the gRPC semantic-convention instrumentation on both
# stacks with no extra code. A real deployment where QuoteService is its own
# deployable would show two distinct service.name resources instead, for
# free. This check is loose on purpose (ingest lag) and NEVER fails the
# build — it only logs ok or a non-fatal warning.
check_tempo_trace() {
  local trace_id="$1" attempts=10 delay=5 i svc_count resp
  echo "verify.sh: polling Tempo for trace $trace_id (soft, up to $(( attempts * delay ))s) ..." >&2
  for (( i = 1; i <= attempts; i++ )); do
    resp="$(curl -fsS "http://localhost:3200/api/traces/${trace_id}" 2>/dev/null || true)"
    if [[ -n "$resp" ]]; then
      svc_count="$(python3 -I -c '
import json, sys
try:
    doc = json.loads(sys.argv[1])
except Exception:
    print(0)
    raise SystemExit
names = set()
KEYS = ("service.name", "rpc.service")
def walk(obj):
    if isinstance(obj, dict):
        if obj.get("key") in KEYS:
            v = obj.get("value", {})
            s = v.get("stringValue") or v.get("string_value")
            if s:
                names.add(s)
        for v in obj.values():
            walk(v)
    elif isinstance(obj, list):
        for item in obj:
            walk(item)
walk(doc)
print(len(names))
' "$resp" 2>/dev/null || echo 0)"
      if [[ "$svc_count" =~ ^[0-9]+$ ]] && (( svc_count >= 2 )); then
        echo "verify.sh: ok (soft) — Tempo has trace $trace_id with $svc_count distinct service names" >&2
        return 0
      fi
    fi
    sleep "$delay"
  done
  echo "verify.sh: WARN (soft, non-fatal) — Tempo did not show >=2 service names for trace" \
       "$trace_id within $(( attempts * delay ))s (ingest lag); not failing the build" >&2
  return 0
}

# ---------------------------------------------------------------------------
# Per-stack assertions
# ---------------------------------------------------------------------------

run_stack_tests() {
  local stack="$1" grpc_target="$2" rest_base="$3" metrics_url="$4"
  local metrics_metric="$5" routing_log_pattern="$6" quote_log_pattern="$7"

  echo
  echo "=== verifying stack '$stack' (gRPC $grpc_target, REST $rest_base) ==="

  wait_for_grpc "$grpc_target"
  wait_for_http "$metrics_url"

  # --- 1. Functional seam: REST -> RoutingService.GetQuote -> QuoteService ---
  local resp
  resp="$(curl -fsS -X POST "$rest_base/booking/quote" \
    -H 'content-type: application/json' -d "$BOOKING_REQUEST")"

  assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "$stack booking_quote quote.currency"
  assert_eq "2500.00" "$(json_field '.quote.amount' <<<"$resp")" "$stack booking_quote quote.amount"
  assert_eq "rte_USNYC-NLRTM" "$(json_field '.route.id' <<<"$resp")" "$stack booking_quote route.id"
  assert_eq "MAERSK" "$(json_field '.route.legs.0.carrier' <<<"$resp")" "$stack booking_quote route.legs.0.carrier"

  local trace_id
  trace_id="$(json_field '.traceId' <<<"$resp")"
  if [[ -z "$trace_id" || "$trace_id" == "00000000000000000000000000000000" ]]; then
    echo "lib.sh: FAIL — $stack: booking_quote response carried no usable traceId" >&2
    exit 1
  fi
  echo "lib.sh: ok — $stack booking_quote traceId=$trace_id" >&2

  # --- 2. HARD: the SAME trace id logged by BOTH handlers in this container ---
  assert_trace_id_in_logs "$PROJECT" "$COMPOSE_FILE" "$stack" "$trace_id" \
    "$routing_log_pattern" "$quote_log_pattern"

  # --- 3. SOFT: Tempo eventually ingests a multi-span trace for this id ---
  check_tempo_trace "$trace_id"

  # --- 4. Metrics: the app's OWN metrics endpoint shows a gRPC server metric ---
  local metrics_text
  metrics_text="$(curl -fsS "$metrics_url")"
  assert_metric_present "$metrics_text" "$metrics_metric" "$stack gRPC server metrics"

  # --- 5. Health: grpc.health.v1.Health/Check answers SERVING ---
  local health_resp
  health_resp="$(grpc_call "$grpc_target" "$HEALTH_METHOD" '{"service":""}')"
  assert_eq "SERVING" "$(json_field '.status' <<<"$health_resp")" "$stack grpc.health.v1.Health/Check status"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up (incl. the always-on lgtm service) ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: wait for the LGTM stack (Grafana + Tempo + Mimir + Loki) ==="
wait_for_lgtm

echo
echo "=== Step 3: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9210" "http://localhost:8210" "http://localhost:8210/q/metrics" \
  "grpc_server_processing_duration_seconds_count" \
  "RoutingServiceImpl.GetQuote traceId=" "QuoteServiceImpl.GetQuote traceId="

run_stack_tests "python" "localhost:9211" "http://localhost:8211" "http://localhost:8211/metrics" \
  "grpc_server_handled_total" \
  "RoutingServiceServicer.GetQuote trace_id=" "QuoteServiceServicer.GetQuote trace_id="

echo
echo "PASS — Ch21 observability anchor: on BOTH the Quarkus and the Python" \
     "stack, POST /booking/quote returns the correct quote (USD 2500.00," \
     "rte_USNYC-NLRTM, MAERSK) AND a trace id that RoutingService and" \
     "QuoteService EACH logged while handling the request — proving the W3C" \
     "traceparent survived the loopback gRPC hop — AND each app's own" \
     "metrics endpoint shows a gRPC server metric with a nonzero count AND" \
     "grpc.health.v1.Health/Check answers SERVING."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
