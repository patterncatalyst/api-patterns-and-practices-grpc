# Ch11 — Error-handling ANCHOR: rich errors on `RoutingService.GetQuote`

The reference both-stack implementation of `shipping.routing.v1.RoutingService.GetQuote`
returning **deterministic rich errors by input** — the chapter's proof that a
gRPC error is a canonical status code plus a typed, machine-readable detail,
not a string. The contract — not either codebase — is the source of truth:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs (only `GetQuote` is implemented here; the rest return
  `UNIMPLEMENTED`, as in Ch5).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages.

Neither `.proto` declares `BadRequest`, `ErrorInfo`, or `RetryInfo` — those
come from a runtime library on each stack (Java:
`com.google.api.grpc:proto-google-common-protos`, imported as
`com.google.rpc.*`; Python: `grpcio-status`'s `google.rpc.error_details_pb2`),
not from code generation against this chapter's contract.

Quarkus (`quarkus/`, host port 9110) and Python (`python/`, host port 9111)
independently implement the identical RPC, generated from the **same**
`.proto` files. `verify.sh` calls `GetQuote` on **both** stacks via
`grpcurl` and asserts both the canonical status **code** and the rich
**detail** type carried in the trailers — not just a bare error.

## Run it

```bash
cd examples/11-error-handling
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, calls `GetQuote` four ways against
`localhost:9110` (Quarkus) and `localhost:9111` (Python), asserts every code
and detail below, and tears the stack down again. Prints `PASS` only if
every assertion holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build

grpcurl -plaintext -d '{"destination":{"unLocode":"NLRTM"}}' \
  localhost:9110 shipping.routing.v1.RoutingService/GetQuote
# ERROR: Code: InvalidArgument, Message names BadRequest + the missing field

grpcurl -plaintext -d '{"origin":{"unLocode":"ZZZZZ"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9110 shipping.routing.v1.RoutingService/GetQuote
# ERROR: Code: NotFound, Message names ErrorInfo + reason=ORIGIN_UNROUTABLE

grpcurl -plaintext -d '{"origin":{"unLocode":"RETRY"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9110 shipping.routing.v1.RoutingService/GetQuote
# ERROR: Code: Unavailable, Message names RetryInfo

docker compose down -v
```

Swap `9110` for `9111` to hit the Python stack instead — same four input
shapes, same codes, same detail types.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `GetQuote` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## Input -> status code -> detail

`GetQuote` is deterministic: the same input always produces the same code
and the same detail type, on both stacks.

| Input | Code | Detail | Why |
|---|---|---|---|
| `origin.unLocode` or `destination.unLocode` empty/missing | `INVALID_ARGUMENT` | `BadRequest` (`field_violations[]`) | the request is malformed; retrying it unchanged fails the same way |
| `origin.unLocode == "ZZZZZ"` | `NOT_FOUND` | `ErrorInfo` (`reason=ORIGIN_UNROUTABLE`, `domain=shipping.routing.v1`) | the origin exists as input but has no route; a fact about the world, not a glitch |
| `origin.unLocode == "RETRY"` | `UNAVAILABLE` | `RetryInfo` (`retry_delay=2s`) | a transient condition; safe to retry with backoff |
| anything else, both `unLocode`s set | `OK` | — | normal quote, same formula as Ch5 |

The human-readable `message` on every rich error also names its detail type
(`"...see BadRequest details..."`, `"...ErrorInfo reason=..."`,
`"...retry per RetryInfo"`) so the status is legible from the plain message
alone, in addition to the structured `details[]` entry a client unpacks
programmatically — `verify.sh` asserts both the code (via `grpc_expect_code`)
and the detail text (via `grpc_error_output` + `assert_contains`).

## The quote formula (valid path only)

A valid request reaches the same deterministic formula as the Ch5
contract-first anchor (reproduced here, not imported, since this example is
an independent module — see `QuoteCalculator.java` / `app/quote.py`):

```
quote.currency = "USD"
quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
route.id       = "rte_" + origin.un_locode + "-" + destination.un_locode
route.legs     = [ { carrier: "MAERSK", origin, destination } ]
route.price    = quote
```

`verify.sh`'s valid-request case reuses Ch5's exact numbers: one cargo item
at `1200.5kg -> "3001.25"`.

## The other four RPCs

Only `GetQuote` has a real implementation; the rest return `UNIMPLEMENTED`,
same as Ch5 — see `RoutingServiceImpl.java` / the generated
`RoutingServiceServicer` base class's default behavior in `app/routing_service.py`.

## Rich errors: the runtime library, not the `.proto`

`ErrorInfo`, `BadRequest`, and `RetryInfo` are messages from
`google/rpc/error_details.proto`, bundled by a library each stack pulls in
at build time — never declared in, or generated from, this chapter's
`routing.proto`:

- **Quarkus**: `com.google.api.grpc:proto-google-common-protos` (added in
  `pom.xml`) supplies `com.google.rpc.Status`, `Code`, `ErrorInfo`,
  `BadRequest`, and `RetryInfo`. `RoutingServiceImpl` builds a
  `com.google.rpc.Status` with the canonical code and one packed `Any`
  detail, then calls `io.grpc.protobuf.StatusProto.toStatusRuntimeException(status)`
  — a class that ships in `grpc-protobuf`, already on the classpath via the
  `quarkus-grpc` extension — and returns it as a failed `Uni`, exactly the
  pattern `RoutingServiceImpl` already uses for `UNIMPLEMENTED` in Ch5.
- **Python**: `grpcio-status` (added in `pyproject.toml`) supplies
  `google.rpc.status_pb2`, `code_pb2`, and `error_details_pb2`.
  `RoutingServiceServicer` builds a `google.rpc.Status` the same way, then
  calls `grpc_status.rpc_status.to_status(status)` and passes the result to
  `context.abort_with_status(...)` on the `grpc.aio.ServicerContext`.

Both paths land the same `google.rpc.Status` bytes in the gRPC trailers;
`grpcurl` (and any generated client) reads the canonical code off the
standard gRPC status and can unpack the trailer detail using the same
`error_details.proto` definitions, since the message shapes are identical
across languages by construction.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files — same
discipline as Ch5. Each `Containerfile` builds with the **repo root** as its
Docker build context (see `compose.yaml`) so it can `COPY` the two proto
files this service needs straight from `contracts/proto/` at build time. For
a local, non-container `mvn`/`uv` run, copy the same two files by hand
first:

```bash
# Quarkus
mkdir -p quarkus/src/main/proto/shipping/{type,routing}/v1
cp ../../contracts/proto/shipping/type/v1/types.proto    quarkus/src/main/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto quarkus/src/main/proto/shipping/routing/v1/

# Python
mkdir -p python/proto/shipping/{type,routing}/v1 python/generated
cp ../../contracts/proto/shipping/type/v1/types.proto      python/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto python/proto/shipping/routing/v1/
cd python && uv sync --group dev && \
  .venv/bin/python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated \
    proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto
```

Both copy destinations are gitignored (see `.gitignore`) — build-time-only,
never committed.

## On the wire

Server reflection is enabled on both stacks, so `grpcurl` needs no local
`.proto` copy:

```bash
grpcurl -plaintext localhost:9110 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService
```

`lib.sh`'s `grpc_expect_code` matches `grpcurl`'s own rendering of the code
(`InvalidArgument`, `NotFound`, `Unavailable` — PascalCase, no underscore),
not the canonical `UPPER_SNAKE_CASE` enum name used everywhere else in this
chapter; `verify.sh` passes the former.

`verify.sh` asserts, per stack:

| Check | Expected |
|---|---|
| missing-origin code | `INVALID_ARGUMENT` |
| missing-origin detail text | contains `"BadRequest"` and `"origin"` |
| `ZZZZZ`-origin code | `NOT_FOUND` |
| `ZZZZZ`-origin detail text | contains `"ErrorInfo"` and `"ORIGIN_UNROUTABLE"` |
| `RETRY`-origin code | `UNAVAILABLE` |
| `RETRY`-origin detail text | contains `"RetryInfo"` |
| valid request | `quote.currency == "USD"`, `quote.amount == "3001.25"`, `route.id == "rte_USNYC-NLRTM"` |

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show the same contract-first flow as Ch5,
updated for the two error-handling entry points each stack uses to pack a
rich `google.rpc.Status` into the trailers.
