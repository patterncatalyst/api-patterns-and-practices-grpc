#!/usr/bin/env bash
# examples/16-async-long-running-jobs/verify.sh
#
# Ch16 async/long-running-jobs example — the reference both-stack
# implementation of the server-owned Operation pattern, split across two
# services: shipping.routing.v1.RoutingService.RecomputeRoutes starts
# background work and returns an Operation{id, done=false, progress_pct=0}
# immediately; shipping.routing.v1.OperationsService.GetOperation polls it,
# WatchOperation server-streams its progress, and CancelOperation stops the
# server-owned job early. See README.md for the full story, and the chapter
# for why the three lookups live on their own OperationsService rather than
# on RoutingService itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch16-operation"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

SVC_ROUTING="shipping.routing.v1.RoutingService"
SVC_OPERATIONS="shipping.routing.v1.OperationsService"
M_RECOMPUTE="$SVC_ROUTING/RecomputeRoutes"
M_GET="$SVC_OPERATIONS/GetOperation"
M_WATCH="$SVC_OPERATIONS/WatchOperation"
M_CANCEL="$SVC_OPERATIONS/CancelOperation"
M_GETQUOTE="$SVC_ROUTING/GetQuote"

# ---------------------------------------------------------------------------
# verify.sh-local helpers (examples/_lib/lib.sh is shared and frozen; these
# are specific enough to this chapter's Operation polling/streaming shape
# that they live here instead).
# ---------------------------------------------------------------------------

# assert_ge <expected_min> <actual> <context> — numeric >=, for the "at least
# N stream snapshots" claim lib.sh's exact-match assert_eq can't express.
assert_ge() {
  local expected_min="$1" actual="$2" context="${3:-at-least}"
  if (( actual < expected_min )); then
    echo "lib.sh: FAIL — ${context}: expected >= $expected_min, got $actual" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: $actual >= $expected_min" >&2
}

# assert_contains_ci <needle> <haystack> <context> — case-insensitive
# substring match, for asserting a cancelled Operation's message names its
# own terminal state regardless of exact casing.
assert_contains_ci() {
  local needle="$1" haystack="$2" context="${3:-contains-ci}"
  local needle_l hay_l
  needle_l="$(printf '%s' "$needle" | tr '[:upper:]' '[:lower:]')"
  hay_l="$(printf '%s' "$haystack" | tr '[:upper:]' '[:lower:]')"
  if [[ "$hay_l" != *"$needle_l"* ]]; then
    echo "lib.sh: FAIL — ${context}: '$needle' not found (case-insensitive) in '$haystack'" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: found '$needle' (case-insensitive)" >&2
}

# field_or <dot.path> <default> — reads stdin JSON via json_field, printing
# <default> when the path is absent. proto3 omits a field at its zero value
# (false, 0, "") from JSON entirely — Chapter 13 noted this for
# next_page_token, and this chapter's own done=false/progress_pct=0 hit the
# identical case — so "absent" and "at the zero value" are the same
# observable fact here, not two different things callers must special-case.
field_or() {
  local path="$1" default="$2" val
  val="$(json_field "$path" 2>/dev/null)" || true
  if [[ -z "$val" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$val"
  fi
}

# poll_operation_until_done <target> <operation_id> [max_tries] [interval_s]
# Polls GetOperation on a bounded schedule (default 25 x 0.2s = 5s, well over
# this example's ~1s normal job) and prints the terminal response JSON on
# stdout once done=true. Fails loudly if the bound is exhausted first.
poll_operation_until_done() {
  local target="$1" op_id="$2" max_tries="${3:-25}" interval_s="${4:-0.2}"
  local resp i
  for ((i = 0; i < max_tries; i++)); do
    resp="$(grpc_call "$target" "$M_GET" "{\"operationId\":\"$op_id\"}")"
    if [[ "$(field_or '.done' 'false' <<<"$resp")" == "true" ]]; then
      printf '%s' "$resp"
      return 0
    fi
    sleep "$interval_s"
  done
  echo "lib.sh: FAIL — poll_operation_until_done: $op_id did not reach done=true within $((max_tries))x${interval_s}s" >&2
  return 1
}

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  # --- 1. Start: RecomputeRoutes returns a fresh, non-terminal Operation ---
  local start_resp op_id
  start_resp="$(grpc_call "$target" "$M_RECOMPUTE" '{"reason":"reconcile"}')"
  op_id="$(json_field '.operation.id' <<<"$start_resp")"
  assert_contains "op_" "$op_id" "$stack start: operation id carries the op_ prefix"
  assert_eq "false" "$(field_or '.operation.done' 'false' <<<"$start_resp")" "$stack start: freshly-created operation is not done"

  # --- 2. Poll: GetOperation converges to a terminal snapshot -------------
  local polled
  polled="$(poll_operation_until_done "$target" "$op_id")"
  assert_eq "true" "$(field_or '.done' 'false' <<<"$polled")" "$stack poll: terminal done"
  assert_eq "100" "$(field_or '.progress_pct' '0' <<<"$polled")" "$stack poll: terminal progress_pct"

  # --- 3. Watch: WatchOperation streams >=2 snapshots, last one terminal --
  # A FRESH operation, watched immediately (before it has had time to finish
  # on its own), so the stream has real progress to report rather than a
  # single already-done snapshot.
  local watch_start_resp watch_op_id watch_out watch_count last_idx
  watch_start_resp="$(grpc_call "$target" "$M_RECOMPUTE" '{"reason":"reconcile"}')"
  watch_op_id="$(json_field '.operation.id' <<<"$watch_start_resp")"
  watch_out="$(grpc_call "$target" "$M_WATCH" "{\"operationId\":\"$watch_op_id\"}")"
  watch_count="$(printf '%s' "$watch_out" | json_stream_count)"
  assert_ge 2 "$watch_count" "$stack watch: stream snapshot count"
  last_idx=$((watch_count - 1))
  assert_eq "true" \
    "$(printf '%s' "$watch_out" | json_stream_field "$last_idx" .done 2>/dev/null || printf 'false')" \
    "$stack watch: last snapshot done"
  assert_eq "100" \
    "$(printf '%s' "$watch_out" | json_stream_field "$last_idx" .progress_pct 2>/dev/null || printf '0')" \
    "$stack watch: last snapshot progress_pct"

  # --- 4. Cancel: a server-owned job stopped mid-flight, not finished -----
  # The "slow" variant (reason contains "slow") runs for several seconds, so
  # a cancel sent shortly after it starts always lands well before natural
  # completion — deterministic, not a race against the job's own clock.
  local cancel_start_resp cancel_op_id cancel_resp get_after_cancel
  cancel_start_resp="$(grpc_call "$target" "$M_RECOMPUTE" '{"reason":"slow reroute"}')"
  cancel_op_id="$(json_field '.operation.id' <<<"$cancel_start_resp")"
  sleep 0.3
  cancel_resp="$(grpc_call "$target" "$M_CANCEL" "{\"operationId\":\"$cancel_op_id\"}")"
  assert_eq "true" "$(field_or '.done' 'false' <<<"$cancel_resp")" "$stack cancel: CancelOperation response is terminal"
  get_after_cancel="$(grpc_call "$target" "$M_GET" "{\"operationId\":\"$cancel_op_id\"}")"
  assert_eq "true" "$(field_or '.done' 'false' <<<"$get_after_cancel")" "$stack cancel: GetOperation after cancel is terminal"
  assert_contains_ci "cancelled" "$(json_field '.message' <<<"$get_after_cancel")" "$stack cancel: message names cancellation"
  local cancel_pct
  cancel_pct="$(field_or '.progress_pct' '0' <<<"$get_after_cancel")"
  if (( cancel_pct >= 100 )); then
    echo "lib.sh: FAIL — $stack cancel: progress_pct $cancel_pct, expected < 100 (cancelled before natural completion)" >&2
    exit 1
  fi
  echo "lib.sh: ok — $stack cancel: progress_pct $cancel_pct < 100 (server-owned job stopped early)" >&2

  # --- 5. Rerunnable reconcile: two independent runs, each to the same ----
  #        consistent terminal state.
  local run1_start run1_id run1_final run2_start run2_id run2_final
  run1_start="$(grpc_call "$target" "$M_RECOMPUTE" '{"reason":"reconcile"}')"
  run1_id="$(json_field '.operation.id' <<<"$run1_start")"
  run1_final="$(poll_operation_until_done "$target" "$run1_id")"
  assert_eq "true" "$(field_or '.done' 'false' <<<"$run1_final")" "$stack rerun #1: terminal done"
  assert_eq "100" "$(field_or '.progress_pct' '0' <<<"$run1_final")" "$stack rerun #1: terminal progress_pct"

  run2_start="$(grpc_call "$target" "$M_RECOMPUTE" '{"reason":"reconcile"}')"
  run2_id="$(json_field '.operation.id' <<<"$run2_start")"
  run2_final="$(poll_operation_until_done "$target" "$run2_id")"
  assert_eq "true" "$(field_or '.done' 'false' <<<"$run2_final")" "$stack rerun #2: terminal done"
  assert_eq "100" "$(field_or '.progress_pct' '0' <<<"$run2_final")" "$stack rerun #2: terminal progress_pct"

  if [[ "$run1_id" == "$run2_id" ]]; then
    echo "lib.sh: FAIL — $stack rerun: two RecomputeRoutes calls returned the SAME operation id ($run1_id) — each call must start its own Operation" >&2
    exit 1
  fi
  echo "lib.sh: ok — $stack rerun: two independent operation ids ($run1_id, $run2_id), both converged to the same terminal state" >&2

  # --- 6. An undeclared-for-this-chapter RoutingService RPC still says so -
  grpc_expect_code "$target" "$M_GETQUOTE" '{}' "UNIMPLEMENTED" "$stack GetQuote (declared, not part of this chapter)"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9160"
run_stack_tests "python" "localhost:9161"

echo
echo "PASS — Ch16 async/long-running-jobs: on BOTH the Quarkus and the" \
     "Python stack, RecomputeRoutes returns a server-owned Operation" \
     "immediately, GetOperation polls it to a terminal done=true/100% state," \
     "WatchOperation streams at least two snapshots ending in that same" \
     "terminal state, CancelOperation stops a slow job before it finishes" \
     "naturally (progress_pct < 100, message names the cancellation), two" \
     "independent RecomputeRoutes calls each converge to their own terminal" \
     "state (the reconcile job is rerunnable), and an undeclared-for-this-" \
     "chapter RPC still answers UNIMPLEMENTED."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
