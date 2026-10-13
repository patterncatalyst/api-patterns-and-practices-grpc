# Ch5 — Contract-first ANCHOR: RoutingService.GetQuote

The reference both-stack implementation of `shipping.routing.v1.RoutingService.GetQuote`
— the earliest "it runs, end to end" milestone for this site. The contract
— not either codebase — is the source of truth:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs (only `GetQuote` is implemented here; the rest land in
  later chapters and return `UNIMPLEMENTED`).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages.

Quarkus (`quarkus/`, host port 9005) and Python (`python/`, host port 9006)
independently implement the identical RPC, generated from the **same**
`.proto` files, against no persistence (stateless quote computation).
`verify.sh` calls `GetQuote` on **both** stacks via `grpcurl` and asserts
**response field semantics** — not just a gRPC `OK` status. That's the
load-bearing correctness step this chapter exists to teach: two independent
implementations built from one proto contract produce identical, assertable
wire output.

## Run it

```bash
cd examples/05-contract-first
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, calls `GetQuote` against
`localhost:9005` (Quarkus) and `localhost:9006` (Python), asserts every
response field below, and tears the stack down again. Prints `PASS` only if
every assertion holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build
grpcurl -plaintext localhost:9005 list                      # reflection: list services
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC", "name": "New York"},
  "destination": {"unLocode": "NLRTM", "name": "Rotterdam"},
  "cargo": [{"weightKg": 1200.5, "description": "Palletized electronics", "cargoType": "GENERAL"}]
}' localhost:9005 shipping.routing.v1.RoutingService/GetQuote
docker compose down -v
```

Swap `9005` for `9006` to hit the Python stack instead — same request, same
response shape, same numbers.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `GetQuote` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## The quote formula

`GetQuoteResponse` is computed identically on both stacks so their responses
are byte-for-byte comparable, not just independently valid:

```
quote.currency = "USD"
quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
route.id       = "rte_" + origin.un_locode + "-" + destination.un_locode
route.legs     = [ { carrier: "MAERSK", origin, destination } ]  # departs_at/arrives_at unset
route.price    = quote
```

`amount` is always a **decimal string** (e.g. `"3001.25"`), per
`shipping.type.v1.Money` — never a binary float. Both implementations
compute the sum/round independently (`QuoteCalculator.java` /
`app/quote.py`) and both round the same way: Java via
`BigDecimal.valueOf(amount).setScale(2, RoundingMode.HALF_UP)`, Python via
`Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)`.
Explicit `HALF_UP` on both sides — rather than Java's `String.format("%.2f",
...)` (also HALF_UP) paired with Python's `f"{x:.2f}"` (round-half-to-even)
— means the two stacks agree on every input, not just ones that land
exactly on two decimal places. `verify.sh` proves the formula sums every
cargo item (not just one) with a second call: `1000 + 500.5 = 1500.5kg *
2.50 = "3751.25"`.

## The other four RPCs

`RoutingService` declares five RPCs; only `GetQuote` has a real
implementation here:

| RPC | Status in this chapter |
|---|---|
| `GetQuote` | implemented (this chapter) |
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
  plain `jar` — which is what binds the `quarkus-grpc` extension's
  proto-to-Mutiny code generation to the `generate-sources` phase, before
  `compile` runs. (Using plain `jar` packaging compiles fine but silently
  skips code generation — the module needs the custom lifecycle.)
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

Both copy destinations (`quarkus/src/main/proto/`, `python/generated/`,
`python/proto/`) are gitignored (see `../.gitignore`) — they are
build-time-only, never committed.

## On the wire

Server reflection is enabled on both stacks (`enable-reflection-service=true`
on Quarkus; `grpc_reflection.v1alpha.reflection` on Python), so `grpcurl`
needs no local `.proto` copy:

```bash
grpcurl -plaintext localhost:9005 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext localhost:9005 describe shipping.routing.v1.RoutingService
```

`verify.sh` asserts these exact fields from the single-cargo request above:

| Field | Expected |
|---|---|
| `quote.currency` | `"USD"` |
| `quote.amount` | `"3001.25"` |
| `route.id` | `"rte_USNYC-NLRTM"` |
| `route.legs[0].carrier` | `"MAERSK"` |
| `route.price.amount` | `"3001.25"` |

and `"3751.25"` for `quote.amount` on a second, two-cargo-item request —
proving the formula sums every item rather than hardcoding the single-item
answer.

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show the contract-first flow: the shared
proto feeding independently-generated stubs on both stacks, a client
calling `GetQuote` on each over its own port, and the opt-in `otel-lgtm`
sink.
