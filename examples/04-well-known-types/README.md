# Ch4 — Well-known types ANCHOR: RoutingService.FindOptimalRoute

The reference both-stack implementation of
`shipping.routing.v1.RoutingService.FindOptimalRoute` — proof that the
canonical proto3 JSON mapping (Chapter 4's spine) renders the exact same
JSON on two independently-generated implementations. The contract — not
either codebase — is the source of truth:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs (only `FindOptimalRoute` is implemented here; this
  example is independent of Chapter 5's `GetQuote` anchor — the other four
  methods, including `GetQuote`, return `UNIMPLEMENTED`).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Route`, `Leg` messages, including the `google.protobuf.Timestamp`
  fields on `Leg`.

Quarkus (`quarkus/`, host port 9007) and Python (`python/`, host port 9008)
independently implement the identical RPC, generated from the **same**
`.proto` files, and both return a **fixed, deterministic** `Route` — not
computed from the request — so the only variable left is whether each
stack's generated code renders a `Timestamp` and a `Money` the same way.
`verify.sh` calls `FindOptimalRoute` on **both** stacks via `grpcurl` and
asserts the exact rendered JSON, not just a gRPC `OK` status.

## Run it

```bash
cd examples/04-well-known-types
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, calls `FindOptimalRoute` against
`localhost:9007` (Quarkus) and `localhost:9008` (Python), asserts every
response field below, and tears the stack down again. Prints `PASS` only if
every assertion holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build
grpcurl -plaintext localhost:9007 list                      # reflection: list services
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"}
}' localhost:9007 shipping.routing.v1.RoutingService/FindOptimalRoute
docker compose down -v
```

Swap `9007` for `9008` to hit the Python stack instead — same request, same
response shape, same values.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `FindOptimalRoute` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## The fixed Route

`FindOptimalRouteResponse` is identical on both stacks — no pricing formula,
no randomness, so the response is pure proof of the JSON mapping, not of
arithmetic:

```
route.id              = "rte_" + origin.un_locode + "-" + destination.un_locode
route.legs            = [ { carrier: "MAERSK", origin, destination,
                             departs_at: 2026-02-01T10:00:00Z,
                             arrives_at: 2026-02-18T06:00:00Z } ]
route.price           = { currency: "USD", amount: "4200.00" }
```

`departs_at` and `arrives_at` are `google.protobuf.Timestamp` values built
from fixed `Instant`s (Java, `RouteBuilder.java`) / timezone-aware
`datetime`s (Python, `app/route.py`) — never "now" — so the exact RFC 3339
string each stack renders is a checkable constant, not a moving target.
`price.amount` is a decimal **string** ("4200.00"), per
`shipping.type.v1.Money` — never a binary float, the same convention
Chapter 5's `QuoteCalculator`/`quote.py` use for the identical reason.

## The other four RPCs

`RoutingService` declares five RPCs; only `FindOptimalRoute` has a real
implementation here (this example does not depend on, or repeat, Chapter
5's `GetQuote` anchor):

| RPC | Status in this chapter |
|---|---|
| `GetQuote` | `UNIMPLEMENTED` — implemented in Chapter 5's own example |
| `FindOptimalRoute` | implemented (this chapter) |
| `ListRoutes` | `UNIMPLEMENTED` — later chapter (field-mask projection, Ch13) |
| `NegotiateRoute` (bidi stream) | `UNIMPLEMENTED` — Part 3 streaming |
| `RecomputeRoutes` (async) | `UNIMPLEMENTED` — Part 6 async |

On Quarkus, the generated Mutiny `RoutingService` interface declares all
five RPCs as abstract methods, so `RoutingServiceImpl` implements all five
explicitly — the four unimplemented ones just return
`Status.UNIMPLEMENTED.asRuntimeException()`. On Python, the generated
`RoutingServiceServicer` base class already sets `UNIMPLEMENTED` and raises
for any method a subclass doesn't override, so the Python side only defines
`FindOptimalRoute` — the rest fall through to that generated default.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) specifically so it can `COPY` the two proto files this
service needs straight from `contracts/proto/` at build time — identical
mechanics to Chapter 5's example:

- **Quarkus**: the Containerfile copies `types.proto` and `routing.proto`
  into `src/main/proto/shipping/{type,routing}/v1/` inside the build stage.
  The module's `pom.xml` declares `<packaging>quarkus</packaging>`, which
  binds the `quarkus-grpc` extension's proto-to-Mutiny code generation to
  the `generate-sources` phase, before `compile` runs. The generated
  `com.google.protobuf.Timestamp` class this chapter's `RouteBuilder` uses
  ships inside `protobuf-java` itself (a transitive dependency of
  `quarkus-grpc`) — no extra Maven dependency needed to build one.
- **Python**: the Containerfile copies the same two files into a `proto/`
  staging directory, then runs
  `python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated`
  to produce `generated/shipping/{type,routing}/v1/*_pb2{,_grpc}.py`, which
  `PYTHONPATH=/app/generated:/app` makes importable as
  `from shipping.routing.v1 import routing_pb2`. `google.protobuf.timestamp_pb2`
  ships inside the `protobuf` package itself — already a runtime dependency,
  not something `grpcio-tools` adds. `grpcio-tools` (needed only to run
  `protoc`) lives in a `dev` dependency group and never ships in the runtime
  image — the venv is rebuilt with `uv sync --no-dev` after codegen.

For a local, non-container `mvn`/`uv` run, copy the same two files into the
same two destinations by hand first:

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

Both copy destinations (`quarkus/src/main/proto/`, `python/proto/`,
`python/generated/`) are gitignored (see `../.gitignore`) — they are
build-time-only, never committed.

## On the wire

Server reflection is enabled on both stacks (`enable-reflection-service=true`
on Quarkus; `grpc_reflection.v1alpha.reflection` on Python), so `grpcurl`
needs no local `.proto` copy:

```bash
grpcurl -plaintext localhost:9007 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext localhost:9007 describe shipping.routing.v1.RoutingService
```

`verify.sh` asserts these exact fields — note the request uses proto3 JSON's
default `unLocode` (camelCase), while grpcurl prints the response back in
each field's original snake_case name:

| Field (as grpcurl prints it) | Expected |
|---|---|
| `route.legs.0.carrier` | `"MAERSK"` |
| `route.legs.0.departs_at` | `"2026-02-01T10:00:00Z"` |
| `route.legs.0.arrives_at` | `"2026-02-18T06:00:00Z"` |
| `route.price.currency` | `"USD"` |
| `route.price.amount` | `"4200.00"` |

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show the compose topology: the shared proto
feeding independently-generated stubs on both stacks, a client calling
`FindOptimalRoute` on each over its own port, and the opt-in `otel-lgtm`
sink.
