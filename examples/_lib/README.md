# examples/_lib — shared verification harness

Every hands-on example's `verify.sh` sources `lib.sh`. The harness brings up the
example's Docker Compose stack, waits for the gRPC server, calls methods via
**grpcurl** (server reflection), and asserts **response field semantics against the
proto contract** — not just an `OK` status. A gRPC `OK` carrying a wrong-valued
message must fail the check (this is the "On the wire" box of each chapter, encoded).

## Functions

| Function | Purpose |
|---|---|
| `compose_up <file> <project>` | `docker compose up -d --build`; registers an EXIT trap that tears the stack down automatically. |
| `compose_down <file> <project>` | `docker compose down -v --remove-orphans` (called by the trap). |
| `wait_for_grpc <host:port> [timeout]` | Poll with grpcurl reflection until the server answers (default 90s, covers JVM cold start). |
| `grpc_call <host:port> <Service/Method> <json>` | Invoke a method; print the response JSON; non-zero on a gRPC error. |
| `grpc_expect_code <host:port> <Service/Method> <json> <CODE> [ctx]` | Assert the call fails with a specific canonical status code (e.g. `UNAUTHENTICATED`). |
| `json_field <dot.path>` | Extract a value from JSON on stdin (supports numeric indices: `.legs.0.carrier`). |
| `assert_eq <expected> <actual> <ctx>` / `assert_contains <needle> <hay> <ctx>` | Value assertions. |

`grpcurl` is downloaded into a cached `.bin/` on first use (pinned via
`GRPCURL_VERSION`), so `verify.sh` is self-contained and needs no CI pre-install.
Override `GRPCURL_OPTS` (default `-plaintext`) to pass TLS/mTLS flags in the
security chapters.

## Minimal example

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../_lib/lib.sh"

PROJECT="grpc-ch05-quarkus"
compose_up "$SCRIPT_DIR/quarkus/compose.yaml" "$PROJECT"
wait_for_grpc localhost:9005

resp="$(grpc_call localhost:9005 shipping.routing.v1.RoutingService/GetQuote \
  '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}')"
assert_eq "USD" "$(json_field '.quote.currency' <<<"$resp")" "quote currency"
```
