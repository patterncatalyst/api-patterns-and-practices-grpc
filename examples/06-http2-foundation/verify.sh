#!/usr/bin/env bash
# examples/06-http2-foundation/verify.sh
#
# Ch6's docker-free example. No compose stack, no ports, no server, no
# packet capture — HTTP/2 framing itself needs a running connection to
# observe, which this example doesn't stand up. What it measures instead is
# the half of "gRPC is fast" that's deterministic without one: the payload
# protobuf puts on each stream versus the proto3 JSON equivalent. Three
# steps:
#
#   1. `buf build` on contracts/ — proves the real shipping contracts still
#      compile as one Buf module (same check Ch3's and Ch5's examples run).
#   2. Generate Python stubs for `shipping.type.v1` AND `shipping.routing.v1`
#      (the real GetQuoteResponse contract, not a standalone demo proto) with
#      `python -m grpc_tools.protoc`, inside a throwaway venv under a temp
#      dir — same pattern as examples/03-protobuf/verify.sh.
#   3. Build a representative GetQuoteResponse (Money + a Route with one
#      Leg), serialize it two ways — SerializeToString() and proto3 JSON via
#      json_format.MessageToJson() — assert the protobuf form is smaller,
#      print both sizes and the ratio, and hand-decode the first bytes
#      against Ch3's tag-number math. See measure.py.
#
# This file must stay `bash -n` clean: scripts/validate.py runs `bash -n` on
# every *.sh in the repo. The CI examples matrix auto-discovers any
# examples/*/verify.sh, so this script installs everything it needs and
# leaves nothing running — safe to invoke from a clean checkout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---------------------------------------------------------------------------
# Step 1: buf build
# ---------------------------------------------------------------------------

echo "=== Step 1: buf build (contracts/) ==="

export PATH="$HOME/.local/bin:$PATH"

BUF_VERSION="${BUF_VERSION:-1.73.0}"
BIN_DIR="$SCRIPT_DIR/.bin"

# Self-contained buf: use it from PATH if present, else download a pinned
# binary into a cached local dir so this script needs no pre-installed tool
# or CI YAML change (mirrors examples/03-protobuf/verify.sh's ensure_buf).
ensure_buf() {
  if command -v buf >/dev/null 2>&1; then
    return 0
  fi
  if [[ -x "$BIN_DIR/buf" ]]; then
    export PATH="$BIN_DIR:$PATH"
    return 0
  fi
  local os arch url
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) arch="x86_64" ;;
    aarch64 | arm64) arch="aarch64" ;;
  esac
  url="https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-${os}-${arch}"
  echo "verify.sh: downloading buf ${BUF_VERSION} (${os}/${arch}) ..." >&2
  mkdir -p "$BIN_DIR"
  if ! curl -fsSL "$url" -o "$BIN_DIR/buf"; then
    echo "verify.sh: FAIL — could not download buf from $url" >&2
    return 1
  fi
  chmod +x "$BIN_DIR/buf"
  export PATH="$BIN_DIR:$PATH"
}

ensure_buf
( cd "$REPO_ROOT/contracts" && buf build )
echo "buf build: ok — contracts/ compiles as one module"

# ---------------------------------------------------------------------------
# Step 2: throwaway venv + Python stub generation
# ---------------------------------------------------------------------------

echo
echo "=== Step 2: throwaway venv + Python stub generation ==="

WORKDIR="$(mktemp -d -t ch06-http2.XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

python3 -m venv "$WORKDIR/venv"
# shellcheck source=/dev/null
source "$WORKDIR/venv/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet grpcio-tools protobuf

GEN_DIR="$WORKDIR/gen"
mkdir -p "$GEN_DIR"

python -m grpc_tools.protoc \
  -I "$REPO_ROOT/contracts/proto" \
  --python_out="$GEN_DIR" \
  "$REPO_ROOT/contracts/proto/shipping/type/v1/types.proto" \
  "$REPO_ROOT/contracts/proto/shipping/routing/v1/routing.proto"

stub_count="$(find "$GEN_DIR" -name '*_pb2.py' | wc -l | tr -d ' ')"
echo "protoc: ok — generated $stub_count stub module(s) under $GEN_DIR (shipping.type.v1 + shipping.routing.v1)"

# ---------------------------------------------------------------------------
# Step 3: measure protobuf vs. proto3 JSON, then hand-decode
# ---------------------------------------------------------------------------

echo
echo "=== Step 3: measure GetQuoteResponse — protobuf bytes vs. proto3 JSON ==="

PYTHONPATH="$GEN_DIR" python3 "$SCRIPT_DIR/measure.py"
