# Ch0 — Prerequisites SKELETON: RoutingService.GetQuote (canned)

The minimal both-stack skeleton that proves the toolchain works, before
Chapter 5 puts a real implementation behind it. The contract is the only
thing that matters here:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs (only `GetQuote` is implemented here, and it returns a
  **hardcoded** response; the rest return `UNIMPLEMENTED`).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages.

Quarkus (`quarkus/`, host port 9000) and Python (`python/`, host port 9001)
each build their own server from the **same** `.proto` files and both
implement `GetQuote` by returning a fixed `GetQuoteResponse` — no weight
math, no persistence, nothing computed from the request. That's deliberate:
this chapter exists to prove codegen, reflection, and Compose all work, not
to teach the quote formula. Chapter 5
(`examples/05-contract-first/`) replaces this canned response with a real,
independently-computed formula that both stacks agree on byte-for-byte.

## Run it

```bash
cd examples/00-prerequisites
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, calls `GetQuote` against
`localhost:9000` (Quarkus) and `localhost:9001` (Python), asserts
`quote.currency == "USD"` on both, and tears the stack down afterward.
Prints `PASS` only if the check holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build
grpcurl -plaintext localhost:9000 list                      # reflection: list services
grpcurl -plaintext -d '{}' localhost:9000 shipping.routing.v1.RoutingService/GetQuote
docker compose down -v
```

Swap `9000` for `9001` to hit the Python stack instead — same request, same
canned response shape.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `GetQuote` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## The canned response

`GetQuoteResponse` is hardcoded identically on both stacks — the point is
that the wire shape and the toolchain work, not the numbers:

```
quote.currency = "USD"
quote.amount   = "0.00"
route.id       = "rte_placeholder"
route.legs     = []   # empty — Chapter 5 fills these in
route.price    = quote
```

Compare this to Chapter 5's `GetQuoteResponse`, which sums `cargo[].weight_kg`,
applies a per-kilogram rate, rounds `HALF_UP` to a decimal string, and
populates a real `route.legs[0]` from `origin`/`destination` — the same
message shape, now carrying a real answer instead of a stand-in.

## The other four RPCs

`RoutingService` declares five RPCs; only `GetQuote` has any implementation
here, and even that one is canned:

| RPC | Status in this chapter |
|---|---|
| `GetQuote` | canned/hardcoded response (this chapter); real formula in Ch5 |
| `FindOptimalRoute` | `UNIMPLEMENTED` — later chapter |
| `ListRoutes` | `UNIMPLEMENTED` — later chapter |
| `NegotiateRoute` (bidi stream) | `UNIMPLEMENTED` — Ch26 streaming |
| `RecomputeRoutes` (async) | `UNIMPLEMENTED` — Ch26 async |

On Quarkus, the generated Mutiny `RoutingService` interface declares all
five RPCs as abstract methods, so `RoutingServiceImpl` implements all five
explicitly — the four unimplemented ones just return
`Status.UNIMPLEMENTED.asRuntimeException()`. On Python, the generated
`RoutingServiceServicer` base class already sets `UNIMPLEMENTED` and raises
for any method a subclass doesn't override, so the Python side only defines
`GetQuote` — the rest fall through to that generated default.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) specifically so it can `COPY` the two proto files this
service needs straight from `contracts/proto/` at build time:

- **Quarkus**: the Containerfile copies `types.proto` and `routing.proto`
  into `src/main/proto/shipping/{type,routing}/v1/` inside the build stage.
  The module's `pom.xml` declares `<packaging>quarkus</packaging>` — not
  plain `jar` — which binds the `quarkus-grpc` extension's proto-to-Mutiny
  code generation (the `quarkus:generate-code` goal) to before `compile`
  runs. (Using plain `jar` packaging compiles fine but silently skips code
  generation — the module needs the custom lifecycle.)
- **Python**: the Containerfile copies the same two files into a `proto/`
  staging directory, then runs
  `python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated ...`
  to produce `generated/shipping/{type,routing}/v1/*_pb2{,_grpc}.py`, which
  `PYTHONPATH=/app/generated:/app` makes importable as
  `from shipping.routing.v1 import routing_pb2`. `grpcio-tools` (needed only
  to run `protoc`) lives in a `dev` dependency group and never ships in the
  runtime image — the venv is rebuilt with `uv sync --no-dev` after codegen.

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
`python/generated/`) are gitignored (see `./.gitignore`) — they are
build-time-only, never committed.

## On the wire

Server reflection is enabled on both stacks (`enable-reflection-service=true`
on Quarkus; `grpc_reflection.v1alpha.reflection` on Python), so `grpcurl`
needs no local `.proto` copy:

```bash
grpcurl -plaintext localhost:9000 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext localhost:9000 describe shipping.routing.v1.RoutingService
```

`verify.sh` asserts one field from the empty-request call:

| Field | Expected |
|---|---|
| `quote.currency` | `"USD"` |

That single, stable field is enough to prove the whole stack — codegen,
reflection, server start, Compose networking — is wired up correctly. It is
intentionally not a test of the quote logic; see Chapter 5 for field-level
semantics assertions.

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show the skeleton's compose topology: a
`grpcurl`/`grpcui` client calling `GetQuote` on each stack over its own
port, both stacks generated from the same proto, and the opt-in `otel-lgtm`
sink.
