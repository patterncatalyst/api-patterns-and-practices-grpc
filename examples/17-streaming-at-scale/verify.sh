#!/usr/bin/env bash
# examples/17-streaming-at-scale/verify.sh
#
# Ch17 streaming-at-scale ANCHOR — shipping.tracking.v1.TrackingService.WatchShipment
# served as a DEMAND-DRIVEN live feed on both stacks (Quarkus: a Mutiny Multi
# built from Multi.createFrom().emitter(...) whose production is gated by
# MultiEmitter.onRequest; Python: an async-generator-based WatchShipment,
# pull-based by construction). The booking_id on the request selects one of
# three demo-only modes (see README.md): bkg_demo (6-event demand feed),
# bkg_eager (the same 6 events, pre-materialized and stamped at t~=0), and
# bkg_quiet (2 events with a ~2s quiet gap). This script asserts the five
# claims the chapter teaches:
#
#   1. Count + order + fields: bkg_demo streams EXACTLY 6 events, in the
#      correct state/location order, with the correct event.booking_id — a
#      wrong-shaped or wrong-valued OK response fails this check, not just a
#      gRPC error.
#   2. Incremental delivery (lower bound): the whole bkg_demo stream's
#      wall-clock duration is >= ~0.6s — proof the events arrive spread over
#      time, not buffered and dumped at the end.
#   3. Slow-consumer backpressure (the headline claim): the bundled
#      python/app/slow_consumer.py (one read every ~300ms) is run against
#      BOTH bkg_demo and bkg_eager. Consecutive SERVER-STAMPED event.at
#      deltas for bkg_demo must be >= ~200ms (the demand-driven producer
#      paces itself well inside what a ~300ms-per-read consumer can keep up
#      with); bkg_eager's event.at values must all cluster within
#      microseconds of each other (the eager producer built and stamped the
#      whole batch before the first byte left the server). The relative gate
#      is eager_spread * 3 < backpressure_spread (the same shape as Ch15's
#      starve-vs-scale check).
#   4. Keepalive quiet stream: bkg_quiet delivers BOTH events (including the
#      one after the ~2s gap) and the whole call's wall-clock duration is
#      >= ~1.9s — the gap is real, the stream was not dropped.
#   5. ReportPositions and Sync both answer UNIMPLEMENTED.
#
# HTTP/2 flow-control window sizes and keepalive-survives-a-proxy's-idle-reap
# are illustrative only (see the chapter's "On the wire" box and figures) —
# this script never gates on either.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch17-streaming"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

METHOD="shipping.tracking.v1.TrackingService/WatchShipment"

INCREMENTAL_FLOOR_S="0.6"   # loose lower bound: 5 gaps x ~260ms self-pacing ~= 1.3s
BACKPRESSURE_FLOOR_S="0.2"  # loose lower bound: self-paced step is ~260ms
QUIET_FLOOR_S="1.9"         # loose lower bound: the quiet gap is 2.0s
SPREAD_FACTOR="3"           # loose: eager_spread * 3 must stay under the demand-driven spread

# --- local helpers (verify.sh-only; lib.sh is shared and not modified) -----

# now_s — high-resolution wall-clock seconds, as a float string.
now_s() { date +%s.%N; }

# elapsed_s <start> <end> — float seconds between two now_s readings.
elapsed_s() {
  python3 -I -c 'import sys; print(float(sys.argv[2]) - float(sys.argv[1]))' "$1" "$2"
}

# assert_ge <actual> <bound> <context> — float-aware "actual >= bound".
assert_ge() {
  local actual="$1" bound="$2" context="${3:-greater-or-equal}"
  if ! python3 -I -c '
import sys
actual, bound = float(sys.argv[1]), float(sys.argv[2])
sys.exit(0 if actual >= bound else 1)
' "$actual" "$bound"; then
    echo "lib.sh: FAIL — ${context}: ${actual}s is not >= ${bound}s" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: ${actual}s >= ${bound}s" >&2
}

# assert_scaled_lt <a> <factor> <b> <context> — float-aware "a * factor < b",
# the starve-vs-scale-shaped relative gate (eager_spread * 3 < backpressure_spread).
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

# at_metrics — reads NDJSON lines on stdin (each with an "at" RFC3339
# protobuf-JSON timestamp string, as printed by slow_consumer.py), and
# prints "<min_consecutive_delta_s> <spread_s>" — the smallest gap between
# consecutive event.at values, and the gap between the first and the last.
# Lines that aren't valid JSON (stray compose/container log noise) are
# skipped rather than failing the parse.
at_metrics() {
  python3 -I -c '
import sys, json
from datetime import datetime, timezone

def parse_rfc3339(s):
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1]
    if "." in s:
        main, frac = s.split(".", 1)
        frac = (frac + "000000")[:6]
        s = main + "." + frac
    dt = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    return dt.timestamp()

ats = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except ValueError:
        continue
    if "at" not in obj:
        continue
    ats.append(parse_rfc3339(obj["at"]))

if len(ats) < 2:
    print("0 0")
else:
    deltas = [ats[i + 1] - ats[i] for i in range(len(ats) - 1)]
    print(f"{min(deltas)} {ats[-1] - ats[0]}")
'
}

# request_json <booking_id> — builds a WatchShipmentRequest. booking_id is
# the demo-only mode selector (bkg_demo / bkg_eager / bkg_quiet — see
# README.md); it carries no domain meaning beyond selecting a mode.
request_json() {
  printf '{"bookingId":"%s"}' "$1"
}

# run_slow_consumer <service> <booking_id> — runs the bundled slow consumer
# as a one-off container ON THE SAME compose network as the already-running
# stack, targeting <service>:9000 (the compose SERVICE name and container
# port — not the host-mapped 9170/9171). Prints its NDJSON stdout.
run_slow_consumer() {
  local service="$1" booking_id="$2"
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm python \
    python -m app.slow_consumer "${service}:9000" "$booking_id" 2>/dev/null
}

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  # --- 1 + 2. bkg_demo: count + order + fields, AND whole-stream timing ----
  local start end demo_out demo_elapsed
  start="$(now_s)"
  demo_out="$(grpc_call "$target" "$METHOD" "$(request_json bkg_demo)")"
  end="$(now_s)"
  demo_elapsed="$(elapsed_s "$start" "$end")"

  assert_eq "6" "$(printf '%s' "$demo_out" | json_stream_count)" "$stack bkg_demo event count"

  assert_eq "BOOKING_STATE_PENDING" \
    "$(printf '%s' "$demo_out" | json_stream_field 0 .event.state)" "$stack bkg_demo event[0].state"
  assert_eq "USNYC" \
    "$(printf '%s' "$demo_out" | json_stream_field 0 .event.location.un_locode)" "$stack bkg_demo event[0].location"
  assert_eq "bkg_demo" \
    "$(printf '%s' "$demo_out" | json_stream_field 0 .event.booking_id)" "$stack bkg_demo event[0].booking_id"
  assert_eq "seq=0" \
    "$(printf '%s' "$demo_out" | json_stream_field 0 .event.note)" "$stack bkg_demo event[0].note"

  assert_eq "BOOKING_STATE_CONFIRMED" \
    "$(printf '%s' "$demo_out" | json_stream_field 1 .event.state)" "$stack bkg_demo event[1].state"
  assert_eq "BOOKING_STATE_IN_TRANSIT" \
    "$(printf '%s' "$demo_out" | json_stream_field 2 .event.state)" "$stack bkg_demo event[2].state"
  assert_eq "NLRTM" \
    "$(printf '%s' "$demo_out" | json_stream_field 2 .event.location.un_locode)" "$stack bkg_demo event[2].location"
  assert_eq "BOOKING_STATE_IN_TRANSIT" \
    "$(printf '%s' "$demo_out" | json_stream_field 3 .event.state)" "$stack bkg_demo event[3].state"
  assert_eq "DEHAM" \
    "$(printf '%s' "$demo_out" | json_stream_field 3 .event.location.un_locode)" "$stack bkg_demo event[3].location"
  assert_eq "BOOKING_STATE_IN_TRANSIT" \
    "$(printf '%s' "$demo_out" | json_stream_field 4 .event.state)" "$stack bkg_demo event[4].state"
  assert_eq "SGSIN" \
    "$(printf '%s' "$demo_out" | json_stream_field 4 .event.location.un_locode)" "$stack bkg_demo event[4].location"

  assert_eq "BOOKING_STATE_DELIVERED" \
    "$(printf '%s' "$demo_out" | json_stream_field 5 .event.state)" "$stack bkg_demo event[5].state"
  assert_eq "SGSIN" \
    "$(printf '%s' "$demo_out" | json_stream_field 5 .event.location.un_locode)" "$stack bkg_demo event[5].location"
  assert_eq "bkg_demo" \
    "$(printf '%s' "$demo_out" | json_stream_field 5 .event.booking_id)" "$stack bkg_demo event[5].booking_id"
  assert_eq "seq=5" \
    "$(printf '%s' "$demo_out" | json_stream_field 5 .event.note)" "$stack bkg_demo event[5].note"

  echo "lib.sh: info — $stack: bkg_demo whole-stream wall-clock = ${demo_elapsed}s" >&2
  assert_ge "$demo_elapsed" "$INCREMENTAL_FLOOR_S" \
    "$stack bkg_demo incremental delivery (whole stream >= ${INCREMENTAL_FLOOR_S}s, not buffered-and-dumped)"

  # --- 3. Slow-consumer backpressure (headline) -----------------------------
  local demo_consumer_out demo_min_delta demo_spread
  demo_consumer_out="$(run_slow_consumer "$stack" "bkg_demo")"
  assert_eq "6" "$(printf '%s\n' "$demo_consumer_out" | json_stream_count)" \
    "$stack slow_consumer vs bkg_demo event count"
  read -r demo_min_delta demo_spread <<<"$(printf '%s\n' "$demo_consumer_out" | at_metrics)"
  echo "lib.sh: info — $stack: slow_consumer vs bkg_demo: min_delta=${demo_min_delta}s spread=${demo_spread}s" >&2
  assert_ge "$demo_min_delta" "$BACKPRESSURE_FLOOR_S" \
    "$stack slow_consumer vs bkg_demo consecutive server-stamped at deltas (producer paced, not raced ahead)"

  local eager_consumer_out eager_min_delta eager_spread
  eager_consumer_out="$(run_slow_consumer "$stack" "bkg_eager")"
  assert_eq "6" "$(printf '%s\n' "$eager_consumer_out" | json_stream_count)" \
    "$stack slow_consumer vs bkg_eager event count"
  read -r eager_min_delta eager_spread <<<"$(printf '%s\n' "$eager_consumer_out" | at_metrics)"
  echo "lib.sh: info — $stack: slow_consumer vs bkg_eager: min_delta=${eager_min_delta}s spread=${eager_spread}s" >&2

  assert_scaled_lt "$eager_spread" "$SPREAD_FACTOR" "$demo_spread" \
    "$stack backpressure relative gate (eager_spread * ${SPREAD_FACTOR} < backpressure_spread)"

  # --- 4. Keepalive quiet stream ---------------------------------------------
  local quiet_out quiet_elapsed
  start="$(now_s)"
  quiet_out="$(grpc_call "$target" "$METHOD" "$(request_json bkg_quiet)")"
  end="$(now_s)"
  quiet_elapsed="$(elapsed_s "$start" "$end")"

  assert_eq "2" "$(printf '%s' "$quiet_out" | json_stream_count)" "$stack bkg_quiet event count"
  assert_eq "BOOKING_STATE_PENDING" \
    "$(printf '%s' "$quiet_out" | json_stream_field 0 .event.state)" "$stack bkg_quiet event[0].state"
  assert_eq "BOOKING_STATE_DELIVERED" \
    "$(printf '%s' "$quiet_out" | json_stream_field 1 .event.state)" "$stack bkg_quiet event[1].state (post-gap, stream not dropped)"
  echo "lib.sh: info — $stack: bkg_quiet whole-call wall-clock = ${quiet_elapsed}s" >&2
  assert_ge "$quiet_elapsed" "$QUIET_FLOOR_S" \
    "$stack bkg_quiet total elapsed (the quiet gap is real, not skipped)"

  # --- 5. The other two RPCs must still be UNIMPLEMENTED --------------------
  grpc_expect_code "$target" "shipping.tracking.v1.TrackingService/ReportPositions" '{}' \
    "UNIMPLEMENTED" "$stack ReportPositions"
  grpc_expect_code "$target" "shipping.tracking.v1.TrackingService/Sync" '{}' \
    "UNIMPLEMENTED" "$stack Sync"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9170"
run_stack_tests "python" "localhost:9171"

echo
echo "PASS — Ch17 streaming-at-scale: on BOTH the Quarkus and the Python" \
     "stack, WatchShipment's demand-driven bkg_demo feed delivers its 6" \
     "ordered events incrementally (whole stream >= ${INCREMENTAL_FLOOR_S}s)" \
     "and paces production to stay well ahead of a ~300ms-per-read slow" \
     "consumer (deltas >= ${BACKPRESSURE_FLOOR_S}s), while the eager" \
     "bkg_eager feed stamps its whole batch within microseconds of itself" \
     "(eager_spread * ${SPREAD_FACTOR} < backpressure_spread); the" \
     "bkg_quiet feed survives a ~2s quiet gap and still delivers its final" \
     "event; and ReportPositions/Sync both answer UNIMPLEMENTED."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
