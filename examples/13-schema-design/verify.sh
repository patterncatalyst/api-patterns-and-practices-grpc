#!/usr/bin/env bash
# examples/13-schema-design/verify.sh
#
# Ch13 schema-design ANCHOR — both the Quarkus and the Python stack
# implement shipping.routing.v1.RoutingService.ListRoutes over the SAME
# 5-route in-memory catalog (contracts/proto/shipping/routing/v1/routing.proto,
# contracts/proto/shipping/type/v1/types.proto). It asserts the three claims
# this chapter teaches:
#
#   1. page 1 (page_size=3) returns exactly 3 routes and a non-empty
#      next_page_token.
#   2. page 2 (that token) continues with NO overlap and ends with an EMPTY
#      next_page_token (the catalog is exhausted).
#   3. a field_mask naming a subset of paths returns ONLY those fields
#      populated — the unmasked field is absent from the response.
#
# See README.md for the full pagination and field-mask tables.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../_lib/lib.sh
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="ch13-schema"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"

METHOD="shipping.routing.v1.RoutingService/ListRoutes"

# --- local helpers (verify.sh-only; lib.sh is shared and not modified) -----

# json_array_len <dot.path> — read JSON on stdin, print the length of the
# array at <dot.path> (0 if it is absent or empty — proto3 omits an empty
# repeated field from JSON, so "absent" and "empty" are the same signal).
json_array_len() {
  local path="$1"
  python3 -I -c '
import json, sys
path = sys.argv[1].strip(".")
doc = json.load(sys.stdin)
cur = doc
for part in [p for p in path.split(".") if p != ""]:
    if isinstance(cur, list):
        cur = cur[int(part)]
    else:
        cur = cur.get(part, [])
print(len(cur) if isinstance(cur, list) else 0)
' "$path"
}

# json_field_or_empty <dot.path> — like lib.sh's json_field, but prints ""
# instead of raising when the path is absent. proto3 JSON omits a field at
# its default value (an empty string, for next_page_token), so "absent" and
# "empty string" are the same wire signal — this helper treats them that way
# instead of letting a Python KeyError traceback spill into verify.sh output.
json_field_or_empty() {
  local path="$1"
  python3 -I -c '
import json, sys
path = sys.argv[1].strip(".")
doc = json.load(sys.stdin)
cur = doc
try:
    for part in [p for p in path.split(".") if p != ""]:
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
except (KeyError, IndexError, TypeError):
    cur = ""
print(cur if isinstance(cur, str) else json.dumps(cur, separators=(",", ":")))
' "$path"
}

# assert_not_contains <needle> <haystack> <context> — the inverse of
# lib.sh's assert_contains, for asserting an unmasked field is ABSENT.
assert_not_contains() {
  local needle="$1"
  local haystack="$2"
  local context="${3:-not-contains}"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "lib.sh: FAIL — ${context}: unexpected '$needle' found" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: '$needle' correctly absent" >&2
}

run_stack_tests() {
  local stack="$1" target="$2"

  echo
  echo "=== verifying stack '$stack' at $target ==="

  wait_for_grpc "$target"

  # --- Page 1: page_size=3, no token -> exactly 3 routes, non-empty token ---
  local resp1
  resp1="$(grpc_call "$target" "$METHOD" '{"pageSize":3}')"
  assert_eq "3" "$(json_array_len '.routes' <<<"$resp1")" "$stack page 1 route count"
  assert_eq "rte_001" "$(json_field '.routes.0.id' <<<"$resp1")" "$stack page 1 route[0].id"
  assert_eq "rte_002" "$(json_field '.routes.1.id' <<<"$resp1")" "$stack page 1 route[1].id"
  assert_eq "rte_003" "$(json_field '.routes.2.id' <<<"$resp1")" "$stack page 1 route[2].id"
  local token1
  token1="$(json_field_or_empty '.next_page_token' <<<"$resp1")"
  if [[ -z "$token1" ]]; then
    echo "lib.sh: FAIL — $stack page 1 next_page_token must be non-empty" >&2
    exit 1
  fi
  echo "lib.sh: ok — $stack page 1 next_page_token is non-empty ('$token1')" >&2

  # --- Page 2: carry the token forward -> the rest, NO overlap, empty token ---
  local resp2
  resp2="$(grpc_call "$target" "$METHOD" "{\"pageSize\":3,\"pageToken\":\"$token1\"}")"
  assert_eq "2" "$(json_array_len '.routes' <<<"$resp2")" "$stack page 2 route count"
  assert_eq "rte_004" "$(json_field '.routes.0.id' <<<"$resp2")" "$stack page 2 route[0].id (no overlap with page 1)"
  assert_eq "rte_005" "$(json_field '.routes.1.id' <<<"$resp2")" "$stack page 2 route[1].id (no overlap with page 1)"
  local token2
  token2="$(json_field_or_empty '.next_page_token' <<<"$resp2")"
  assert_eq "" "$token2" "$stack page 2 next_page_token is empty (catalog exhausted)"

  # --- FieldMask: paths=["id","price"] -> legs absent from every route ------
  # grpcurl's JSON unmarshaling of a WELL-KNOWN-TYPE field sourced from SERVER
  # REFLECTION (a dynamic descriptor, not a compiled-in Go type) does not
  # accept FieldMask's special comma-joined STRING form here; it wants the
  # field's own message shape, `{"paths": [...]}` — grpcurl accepts this
  # input form regardless of whether the proto itself names the field
  # `field_mask` or the JSON name `fieldMask` is used as the request key.
  local resp_masked
  resp_masked="$(grpc_call "$target" "$METHOD" '{"pageSize":3,"fieldMask":{"paths":["id","price"]}}')"
  assert_eq "rte_001" "$(json_field '.routes.0.id' <<<"$resp_masked")" "$stack masked route[0].id present"
  assert_eq "USD" "$(json_field '.routes.0.price.currency' <<<"$resp_masked")" "$stack masked route[0].price present"
  assert_not_contains '"legs"' "$resp_masked" "$stack masked response has no legs (unmasked field)"
  assert_not_contains "MAERSK" "$resp_masked" "$stack masked response carries no carrier (legs content)"

  # --- Contrast: no field_mask at all -> the full object, legs included -----
  local resp_full
  resp_full="$(grpc_call "$target" "$METHOD" '{"pageSize":1}')"
  assert_contains '"legs"' "$resp_full" "$stack unmasked response includes legs"
  assert_contains "MAERSK" "$resp_full" "$stack unmasked response carries the carrier"

  echo "=== $stack: all assertions passed ==="
}

echo "=== Step 1: docker compose up ==="
compose_up "$COMPOSE_FILE" "$PROJECT"

echo
echo "=== Step 2: verify both stacks ==="
run_stack_tests "quarkus" "localhost:9130"
run_stack_tests "python" "localhost:9131"

echo
echo "PASS — Ch13 schema-design anchor: Quarkus and Python both page the" \
     "identical 5-route catalog with page_size/page_token (page 1 returns" \
     "exactly 3 routes + a continuation token, page 2 returns the remaining" \
     "2 with NO overlap and an empty token) AND both apply field_mask" \
     "projection identically (named fields present, unmasked fields absent)" \
     "— generated from one proto, built from one well-known-type library" \
     "(FieldMaskUtil / FieldMask.MergeMessage) on each stack."

# Explicit teardown in addition to lib.sh's EXIT trap (belt-and-suspenders);
# compose_down is idempotent/safe to call twice.
compose_down "$COMPOSE_FILE" "$PROJECT"
