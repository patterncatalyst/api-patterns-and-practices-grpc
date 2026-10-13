#!/usr/bin/env bash
# examples/14-evolution/verify.sh
#
# Ch14's docker-free example. No compose stack, no ports, no server — this
# proves `buf breaking` mechanics directly against a standalone, trimmed
# stand-in for shipping.routing.v1.RoutingService (NOT the real module under
# contracts/, which this example never touches or imports).
#
# Five steps:
#
#   1. `buf lint` + `buf build` on baseline/ — the schema compiles and passes
#      the same STANDARD rule set contracts/buf.yaml uses.
#   2. SAFE case: `buf breaking candidate-safe --against baseline` — a new
#      field, a new RPC, and a defensive `reserved` on never-used numbers.
#      Must exit 0.
#   3. BREAKING case: `buf breaking candidate-breaking --against baseline` —
#      a deleted field, a second deleted field, and a changed field type.
#      Must exit non-zero, and the failure text must name the specific
#      violations, not just "something broke".
#   4. BREAKING-AND-RESERVED case: `buf breaking candidate-breaking-reserved
#      --against baseline` — the same field 4 deleted, but this time its
#      number and name are ALSO marked `reserved` on the way out. Must still
#      exit non-zero, proving the chapter's "reserved" section claim that
#      reservation does not make deletion safe under the FILE breaking
#      category — it only blocks a future field from reusing the number.
#   5. BONUS — the package-version escape hatch: `buf breaking v2-migration
#      --against baseline` succeeds even though v2's message drops the same
#      field candidate-breaking got rejected for deleting, because v2 lives
#      at a new file path `buf breaking` never compares against v1.
#
# This file must stay `bash -n` clean: scripts/validate.py runs `bash -n` on
# every *.sh in the repo. The CI examples matrix auto-discovers any
# examples/*/verify.sh, so this script installs everything it needs and
# leaves nothing running — safe to invoke from a clean checkout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Self-contained buf: use it from PATH if present, else download a pinned
# binary into a cached local dir (mirrors examples/03-protobuf/verify.sh and
# examples/_lib/lib.sh's ensure_grpcurl pattern) — same BUF_VERSION pin as
# the rest of the repo.
# ---------------------------------------------------------------------------

export PATH="$HOME/.local/bin:$PATH"

BUF_VERSION="${BUF_VERSION:-1.73.0}"
BIN_DIR="$SCRIPT_DIR/.bin"

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
echo "buf version: $(buf --version)"

cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Step 1: lint + build the baseline schema
# ---------------------------------------------------------------------------

echo
echo "=== Step 1: buf lint + buf build (baseline/) ==="
buf lint
buf build -o /dev/null
echo "buf lint + buf build: ok — baseline/ passes STANDARD lint and compiles"

# ---------------------------------------------------------------------------
# Step 2: the SAFE candidate must pass
# ---------------------------------------------------------------------------

echo
echo "=== Step 2: SAFE candidate (add field, add RPC, defensive reserved) ==="
safe_out=""
safe_rc=0
safe_out="$(buf breaking candidate-safe --against baseline 2>&1)" || safe_rc=$?

if [[ $safe_rc -ne 0 ]]; then
  echo "verify.sh: FAIL — expected the safe candidate to pass buf breaking (exit 0), got exit $safe_rc" >&2
  echo "$safe_out" >&2
  exit 1
fi
echo "ok — buf breaking candidate-safe --against baseline: exit 0 (no breaking changes)"

# ---------------------------------------------------------------------------
# Step 3: the BREAKING candidate must fail, and fail for the right reasons
# ---------------------------------------------------------------------------

echo
echo "=== Step 3: BREAKING candidate (delete fields, change a field's type) ==="
breaking_out=""
breaking_rc=0
breaking_out="$(buf breaking candidate-breaking --against baseline 2>&1)" || breaking_rc=$?

if [[ $breaking_rc -eq 0 ]]; then
  echo "verify.sh: FAIL — expected the breaking candidate to fail buf breaking, but it passed" >&2
  exit 1
fi
echo "ok — buf breaking candidate-breaking --against baseline: exit $breaking_rc (breaking changes found)"
echo "$breaking_out"

# Confirm the failure is the SEEDED breaking changes, not some unrelated
# error (a lint failure, a compile error, a missing binary) masquerading as
# the expected result.
for needle in \
  'name "destination_un_locode" on message "GetQuoteRequest" was deleted' \
  'name "legacy_notes" on message "GetQuoteRequest" was deleted' \
  'changed type from "double" to "int32"'; do
  if [[ "$breaking_out" != *"$needle"* ]]; then
    echo "verify.sh: FAIL — expected breaking-change text not found: $needle" >&2
    exit 1
  fi
  echo "ok — found expected violation: $needle"
done

# ---------------------------------------------------------------------------
# Step 4: the BREAKING-AND-RESERVED candidate must also fail — reservation
# does not make a deletion safe under the FILE breaking category.
# ---------------------------------------------------------------------------

echo
echo "=== Step 4: BREAKING-AND-RESERVED candidate (delete a field, reserve its number anyway) ==="
reserved_out=""
reserved_rc=0
reserved_out="$(buf breaking candidate-breaking-reserved --against baseline 2>&1)" || reserved_rc=$?

if [[ $reserved_rc -eq 0 ]]; then
  echo "verify.sh: FAIL — expected the breaking-and-reserved candidate to fail buf breaking (reserved does not excuse a deletion under FILE), but it passed" >&2
  exit 1
fi
echo "ok — buf breaking candidate-breaking-reserved --against baseline: exit $reserved_rc (reserved field 4 still can't be deleted)"
echo "$reserved_out"

reserved_needle='name "legacy_notes" on message "GetQuoteRequest" was deleted'
if [[ "$reserved_out" != *"$reserved_needle"* ]]; then
  echo "verify.sh: FAIL — expected breaking-change text not found: $reserved_needle" >&2
  exit 1
fi
echo "ok — found expected violation: $reserved_needle"

# ---------------------------------------------------------------------------
# Step 5 (bonus): the package-version escape hatch
# ---------------------------------------------------------------------------

echo
echo "=== Step 5: v2-migration (new package carries the retired field as reserved) ==="
v2_out=""
v2_rc=0
v2_out="$(buf breaking v2-migration --against baseline 2>&1)" || v2_rc=$?

if [[ $v2_rc -ne 0 ]]; then
  echo "verify.sh: FAIL — expected v2-migration to pass buf breaking (new file path, nothing to diff), got exit $v2_rc" >&2
  echo "$v2_out" >&2
  exit 1
fi
echo "ok — buf breaking v2-migration --against baseline: exit 0 (shipping.routing.v2 is a new file; v1 is untouched)"

echo
echo "PASS — buf breaking caught every seeded breaking change (deleted fields," \
     "changed field type) in the breaking candidate, caught the same deletion" \
     "again even with the field's number and name reserved, passed the safe" \
     "candidate (added field, added RPC, defensive reserved) clean, and" \
     "confirmed that a new package version sidesteps the same gate by" \
     "construction."
