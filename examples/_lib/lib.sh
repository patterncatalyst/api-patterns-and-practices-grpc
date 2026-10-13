#!/usr/bin/env bash
# examples/_lib/lib.sh
#
# Shared verification harness for every hands-on example's verify.sh.
# Source this file, then use the functions below to bring up the example's
# docker compose stack, wait for the gRPC server, call methods via grpcurl
# (server reflection), and assert RESPONSE FIELD SEMANTICS against the proto
# contract — not just an OK status. A gRPC OK that carries a wrong-shaped or
# wrong-valued message must fail the check.
#
# Usage (from an example's verify.sh):
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=../_lib/lib.sh
#   source "$SCRIPT_DIR/../_lib/lib.sh"
#
#   PROJECT="grpc-ch05-quarkus"            # unique per example+stack, for CI isolation
#   compose_up "$SCRIPT_DIR/quarkus/compose.yaml" "$PROJECT"
#
#   wait_for_grpc localhost:9005
#   resp="$(grpc_call localhost:9005 shipping.routing.v1.RoutingService/GetQuote \
#            '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}')"
#   assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "quote currency"
#
# compose_down runs automatically on EXIT via a trap registered by compose_up.
#
# This file must stay `bash -n` clean: scripts/validate.py runs `bash -n` on
# every *.sh in the repo.

set -euo pipefail

# ---------------------------------------------------------------------------
# Path resolution — works regardless of the calling example's cwd.
# ---------------------------------------------------------------------------

LGTM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LGTM_LIB_DIR/../.." && pwd)"
export REPO_ROOT

# ---------------------------------------------------------------------------
# Self-contained grpcurl: download a pinned binary into a cached .bin dir so
# verify.sh needs no pre-installed tool / CI YAML change (mirrors the REST
# harness's self-contained venv philosophy).
# ---------------------------------------------------------------------------

LGTM_BIN_DIR="${LGTM_BIN_DIR:-$LGTM_LIB_DIR/.bin}"
GRPCURL_VERSION="${GRPCURL_VERSION:-1.9.3}"

ensure_grpcurl() {
  if command -v grpcurl >/dev/null 2>&1; then
    return 0
  fi
  local bin="$LGTM_BIN_DIR/grpcurl"
  if [[ -x "$bin" ]]; then
    export PATH="$LGTM_BIN_DIR:$PATH"
    return 0
  fi
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="arm64" ;;
  esac
  local url="https://github.com/fullstorydev/grpcurl/releases/download/v${GRPCURL_VERSION}/grpcurl_${GRPCURL_VERSION}_${os}_${arch}.tar.gz"
  echo "lib.sh: downloading grpcurl ${GRPCURL_VERSION} (${os}/${arch}) ..." >&2
  mkdir -p "$LGTM_BIN_DIR"
  if ! curl -fsSL "$url" -o "$LGTM_BIN_DIR/grpcurl.tar.gz"; then
    echo "lib.sh: FAIL — could not download grpcurl from $url" >&2
    return 1
  fi
  tar -xzf "$LGTM_BIN_DIR/grpcurl.tar.gz" -C "$LGTM_BIN_DIR" grpcurl
  chmod +x "$bin"
  rm -f "$LGTM_BIN_DIR/grpcurl.tar.gz"
  export PATH="$LGTM_BIN_DIR:$PATH"
}

# ---------------------------------------------------------------------------
# Docker compose lifecycle
# ---------------------------------------------------------------------------

_LIB_COMPOSE_FILE=""
_LIB_COMPOSE_PROJECT=""

# compose_up <compose-file> <project-name>
compose_up() {
  local compose_file="$1"
  local project="$2"

  if [[ ! -f "$compose_file" ]]; then
    echo "lib.sh: compose file not found: $compose_file" >&2
    return 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "lib.sh: docker is required but not found on PATH" >&2
    return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "lib.sh: 'docker compose' (v2 plugin) is required; legacy docker-compose is not supported" >&2
    return 1
  fi

  _LIB_COMPOSE_FILE="$compose_file"
  _LIB_COMPOSE_PROJECT="$project"

  echo "lib.sh: docker compose -p $project up -d --build" >&2
  docker compose -p "$project" -f "$compose_file" up -d --build

  trap 'compose_down "$_LIB_COMPOSE_FILE" "$_LIB_COMPOSE_PROJECT"' EXIT
}

# compose_down <compose-file> <project-name>
compose_down() {
  local compose_file="$1"
  local project="$2"

  if [[ -z "$project" ]]; then
    return 0
  fi

  echo "lib.sh: docker compose -p $project down -v --remove-orphans" >&2
  docker compose -p "$project" -f "$compose_file" down -v --remove-orphans || true
}

# ---------------------------------------------------------------------------
# gRPC helpers (plaintext by default; override with GRPCURL_OPTS, e.g. certs)
# ---------------------------------------------------------------------------

GRPCURL_OPTS="${GRPCURL_OPTS:--plaintext}"

# wait_for_grpc <host:port> [timeout_secs]
#
# Polls the server with grpcurl reflection (`list`) until it answers, or fails
# loudly after timeout_secs (default 90, to cover JVM/native cold start).
wait_for_grpc() {
  local target="$1"
  local timeout="${2:-90}"
  local waited=0
  local interval=3

  ensure_grpcurl
  echo "lib.sh: waiting for gRPC $target (timeout ${timeout}s) ..." >&2
  while (( waited < timeout )); do
    if grpcurl $GRPCURL_OPTS "$target" list >/dev/null 2>&1; then
      echo "lib.sh: gRPC $target is up after ${waited}s" >&2
      return 0
    fi
    sleep "$interval"
    waited=$(( waited + interval ))
  done

  echo "lib.sh: FAIL — gRPC $target did not come up within ${timeout}s" >&2
  return 1
}

# grpc_call <host:port> <fully.qualified.Service/Method> <json-request>
#
# Invokes a method via grpcurl with server reflection; prints the response
# JSON on stdout. Exits non-zero if the call returns a gRPC error. The
# reflected descriptors enforce that the request and response conform to the
# proto message shapes.
grpc_call() {
  local target="$1"
  local method="$2"
  # NOTE: not written as `local data="${3:-{}}"` — bash's parameter-expansion
  # parser matches the FIRST unescaped '}' as the closing brace of ${...},
  # so that form evaluates to `${3:-{}` followed by a stray literal '}',
  # silently appending an extra '}' onto every request payload (breaks any
  # non-empty $3, not just the empty-default case).
  local data="$3"
  if [[ -z "$data" ]]; then
    data='{}'
  fi
  ensure_grpcurl
  grpcurl $GRPCURL_OPTS -d "$data" "$target" "$method"
}

# grpc_expect_code <host:port> <Service/Method> <json-request> <EXPECTED_CODE> [context]
#
# Asserts that the call fails with the given canonical gRPC status code
# (e.g. UNAUTHENTICATED, INVALID_ARGUMENT, NOT_FOUND). Used by the error and
# auth chapters. Succeeds only when the call errors with that exact code.
grpc_expect_code() {
  local target="$1"
  local method="$2"
  local data="$3"
  local expected="$4"
  local context="${5:-$method}"
  ensure_grpcurl

  local out rc=0
  out="$(grpcurl $GRPCURL_OPTS -d "$data" "$target" "$method" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    echo "lib.sh: FAIL — ${context}: expected error code $expected, but the call succeeded" >&2
    return 1
  fi
  if grep -qiE "Code:[[:space:]]*$expected\b" <<<"$out"; then
    echo "lib.sh: ok — ${context}: got expected code $expected" >&2
    return 0
  fi
  echo "lib.sh: FAIL — ${context}: expected code $expected, got: $out" >&2
  return 1
}

# grpc_error_output <host:port> <Service/Method> <json>
# Runs the call and prints grpcurl's COMBINED output — the error Code, Message,
# and any google.rpc.Status Details (ErrorInfo/RetryInfo/BadRequest). Always
# returns 0 so the caller can assert_contains on the text. For the rich-error
# chapter, where asserting the detail payload matters, not just the status code.
grpc_error_output() {
  local target="$1"
  local method="$2"
  local data="${3:-}"
  [[ -z "$data" ]] && data='{}'
  ensure_grpcurl
  grpcurl $GRPCURL_OPTS -d "$data" "$target" "$method" 2>&1 || true
}

# ---------------------------------------------------------------------------
# Assertions (stdlib-python JSON field extraction; no extra deps)
# ---------------------------------------------------------------------------

# json_field <dot.path> — read JSON on stdin, print the value at the given
# dotted path. Supports numeric indices: `.legs.0.carrier`. Prints nothing
# (and returns non-zero) if the path is absent.
json_field() {
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
        cur = cur[part]
if isinstance(cur, (dict, list)):
    print(json.dumps(cur, separators=(",", ":")))
elif isinstance(cur, bool):
    print("true" if cur else "false")
else:
    print(cur)
' "$path"
}

# assert_eq <expected> <actual> <context>
assert_eq() {
  local expected="$1"
  local actual="$2"
  local context="${3:-equality}"
  if [[ "$expected" != "$actual" ]]; then
    echo "lib.sh: FAIL — ${context}: expected '$expected', got '$actual'" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: '$actual'" >&2
}

# assert_contains <needle> <haystack> <context>
assert_contains() {
  local needle="$1"
  local haystack="$2"
  local context="${3:-contains}"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "lib.sh: FAIL — ${context}: '$needle' not found" >&2
    return 1
  fi
  echo "lib.sh: ok — ${context}: found '$needle'" >&2
}

# ---------------------------------------------------------------------------
# Streaming helpers (server-/client-/bidirectional-streaming RPCs)
#
# grpcurl prints one JSON object per streamed message, back to back. For a
# SERVER stream, call grpc_call as usual and pipe its output to the json_stream_*
# parsers below. For a CLIENT or BIDI stream, feed newline-delimited JSON request
# messages on stdin to grpc_client_stream (grpcurl -d @ reads them in order).
# ---------------------------------------------------------------------------

# grpc_client_stream <host:port> <Service/Method>
# Reads newline-delimited JSON request messages on stdin and sends them as a
# client (or bidirectional) stream. Prints the response(s) on stdout.
#   printf '%s\n' "$m1" "$m2" | grpc_client_stream localhost:9090 pkg.Svc/Method
grpc_client_stream() {
  local target="$1"
  local method="$2"
  ensure_grpcurl
  grpcurl $GRPCURL_OPTS -d @ "$target" "$method"
}

# json_stream_count — read concatenated JSON objects on stdin, print how many.
json_stream_count() {
  python3 -I -c '
import json, sys
dec = json.JSONDecoder()
s = sys.stdin.read()
i = 0; n = 0
while True:
    while i < len(s) and s[i].isspace():
        i += 1
    if i >= len(s):
        break
    _, i = dec.raw_decode(s, i)
    n += 1
print(n)'
}

# json_stream_field <index> <dot.path> — field at <dot.path> from the Nth
# (0-based) streamed JSON object on stdin. Supports numeric list indices.
json_stream_field() {
  python3 -I -c '
import json, sys
idx = int(sys.argv[1]); path = sys.argv[2].strip(".")
dec = json.JSONDecoder()
s = sys.stdin.read()
i = 0; objs = []
while True:
    while i < len(s) and s[i].isspace():
        i += 1
    if i >= len(s):
        break
    o, i = dec.raw_decode(s, i); objs.append(o)
cur = objs[idx]
for p in [x for x in path.split(".") if x]:
    cur = cur[int(p)] if isinstance(cur, list) else cur[p]
if isinstance(cur, (dict, list)):
    print(json.dumps(cur, separators=(",", ":")))
elif isinstance(cur, bool):
    print("true" if cur else "false")
else:
    print(cur)' "$1" "$2"
}
