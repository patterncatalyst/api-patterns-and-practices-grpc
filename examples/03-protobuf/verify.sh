#!/usr/bin/env bash
# examples/03-protobuf/verify.sh
#
# Ch3's small, docker-free example. No compose stack, no ports, no server.
# Three steps:
#
#   1. `buf build` on contracts/ — proves the real shipping contracts compile
#      as a single Buf module (the module Ch5 onward serves from).
#   2. Generate Python stubs for `shipping.type.v1` (the real contract) plus a
#      tiny standalone oneof demo proto (oneof_demo.proto, next to this
#      script, NOT part of the contract) with `python -m grpc_tools.protoc`,
#      inside a throwaway venv created under a temp dir.
#   3. Round-trip: build a Money and a Booking message, serialize to bytes,
#      hand-decode the Money bytes field-by-field against the tag-number math
#      this chapter teaches, parse back, and assert every field survives —
#      then round-trip both branches of the oneof demo. See roundtrip.py.
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
# or CI YAML change (mirrors examples/_lib/lib.sh's ensure_grpcurl pattern).
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

WORKDIR="$(mktemp -d -t ch03-protobuf.XXXXXX)"
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
  -I "$SCRIPT_DIR" \
  --python_out="$GEN_DIR" \
  "$REPO_ROOT/contracts/proto/shipping/type/v1/types.proto" \
  "$SCRIPT_DIR/oneof_demo.proto"

stub_count="$(find "$GEN_DIR" -name '*_pb2.py' | wc -l | tr -d ' ')"
echo "protoc: ok — generated $stub_count stub module(s) under $GEN_DIR"

# ---------------------------------------------------------------------------
# Step 3: round-trip
# ---------------------------------------------------------------------------

echo
echo "=== Step 3: round-trip Booking/Money (the contract) + oneof demo ==="

PYTHONPATH="$GEN_DIR" python3 "$SCRIPT_DIR/roundtrip.py"

echo
echo "PASS — buf build succeeded, Python stubs generated from shipping.type.v1" \
     "(the real contract) plus the oneof demo, and every round-tripped" \
     "message survived serialize -> parse with every field intact."
