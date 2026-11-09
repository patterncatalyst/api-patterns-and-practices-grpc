---
title: "Contract-first with Buf"
order: 5
part: "Protocol Buffers: the Contract Language"
description: "Gate the shipping proto with buf lint, buf build and buf breaking, generate stubs on both stacks, and serve RoutingService.GetQuote end to end, traced."
duration: "17 min read"
---

## Learning objectives

By the end of this chapter you can:

- Gate a proto change with `buf lint`, `buf build -o /dev/null` and `buf breaking` before either stack generates code from it.
- Explain why contract-first beats code-first once a second, independently built stack consumes the same `.proto`.
- Generate stubs from `routing.proto` and `types.proto` on Quarkus (`quarkus:generate-code` under `quarkus` packaging) and Python (`grpc_tools.protoc`).
- Implement `RoutingService.GetQuote` identically on both stacks, including the `HALF_UP` rule that keeps `Money.amount` comparable.
- Check that two independently generated servers agree with `grpcurl` and field-level assertions, not a bare `OK` status.

## Why this matters

`shipping.routing.v1.RoutingService.GetQuote` is served here by a Quarkus process and a Python process that have never read each other's source. "Identically" is checkable because both compile the same `.proto`, and three `buf` commands gate every change to it before either stack sees it.

## Contract-first versus code-first

REST's version of this question is documentation drift: a hand-maintained OpenAPI file can disagree with the code serving requests. gRPC's version is sharper, because the contract is generative. The `.proto` doesn't describe `GetQuoteRequest`, it produces the Java class and the Python class. Nothing can drift between what the contract says and what the code does, because a build step derives one from the other.

That is also why code-first fails faster here. Hand-write a `RoutingServiceImpl`, reverse-engineer a `.proto` from it, hand that file to the Python team, and the proto encodes whatever field order and naming the first implementer picked. Nobody reviewed whether `weight_kg` belongs on `Cargo` or on a nested `Dimensions` message, because a working server already depends on the answer. The first schema change then has no reviewed home, only two sets of generated code to patch in parallel.

`contracts/proto/shipping/routing/v1/routing.proto` reverses the order. It is written, reviewed and gated before any `RoutingServiceImpl.java` or `routing_service.py` exists. `contracts/proto/shipping/type/v1/types.proto` holds the shared vocabulary (`Money`, `Location`, `Cargo`, `Route`, `Leg`, `Operation`), defined once and imported by every service package, matching the nouns in the REST site's JSON Schema. A field added to the proto is a reviewable diff, not a divergence between two running services.

| | Contract-first | Code-first |
|---|---|---|
| Review step | Before any handler exists | After a server depends on the shape |
| Second stack | Implements a reviewed file | Implements an accident |
| Schema change | One file, gated by `buf breaking` | Two sets of generated code patched in parallel |
| Cost | A review step and a CI job before every merge | None up front |

A single team with one implementation and no second consumer can skip the proto review. Once a second generated stack exists, the contract is the only thing separating two implementations of one service from two services that share a name.

## One service, five RPCs, one implemented

`RoutingService` declares all five RPCs, so a caller reading the file sees the whole interface the service commits to. `GetQuote` is the unary RPC implemented here. `FindOptimalRoute` and `ListRoutes` are unary methods filled in later, `NegotiateRoute` is bidirectional streaming, and `RecomputeRoutes` returns an `Operation` for long-running work.

```protobuf
service RoutingService {
  // Unary anchor: quote the cost + route for a shipment.
  rpc GetQuote(GetQuoteRequest) returns (GetQuoteResponse);
  // Unary: choose the best route for origin -> destination.
  rpc FindOptimalRoute(FindOptimalRouteRequest) returns (FindOptimalRouteResponse);
  // Unary: paginated catalog of routes with field-mask projection.
  rpc ListRoutes(ListRoutesRequest) returns (ListRoutesResponse);
  // Bidirectional: negotiate a route by exchanging proposals and counters.
  rpc NegotiateRoute(stream NegotiateRouteRequest) returns (stream NegotiateRouteResponse);
  // Async: kick off a background route recomputation, returning an Operation.
  rpc RecomputeRoutes(RecomputeRoutesRequest) returns (RecomputeRoutesResponse);
}
```

On Quarkus the generated Mutiny interface makes all five abstract, so `RoutingServiceImpl` implements each one and the four unfinished methods return `Status.UNIMPLEMENTED`. On Python the generated `RoutingServiceServicer` already raises `UNIMPLEMENTED` for any method a subclass doesn't override, so only `GetQuote` is defined. A client calling `FindOptimalRoute` gets the same status from either stack.

## The three gates

`contracts/buf.yaml`:

```yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD
breaking:
  use:
    - FILE
```

```bash
cd contracts
buf lint                                                      # STANDARD rule set
buf build -o /dev/null                                        # compiles; every import resolves
buf breaking --against '../.git#branch=main,subdir=contracts' # no breaking change vs main
```

| Gate | Catches |
|---|---|
| `buf lint` | Inconsistent naming, a missing comment on a service or RPC, unused imports. The `.proto` analog of Spectral on an OpenAPI document |
| `buf build -o /dev/null` | An `import` that doesn't resolve, a field number that collides within a message. The `.proto` analog of a dangling `$ref` |
| `buf breaking` | A change after which a reader of the old schema could misread a message from the new one: a reused field number, a retyped field, a removed field |

Lint and build are cheap and deterministic and run on every push. `buf breaking` diffs the current `.proto` against `main`, and it runs before either stack generates code, so the break is caught while fixing it costs a diff rather than a coordinated redeploy. It's the gRPC counterpart of the REST site's response-schema-drift gate. Which changes are safe is a later topic.

{% include excalidraw.html file="05-buf-three-gates" alt="Three buf gates run in sequence against a candidate proto change: buf lint enforces the STANDARD rule set for naming, comments, and unused imports; buf build -o /dev/null compiles the module and confirms every import resolves; buf breaking diffs the candidate against main and rejects a reused field number, a retyped field, or a removed field. A change that fails any gate is rejected before either the Quarkus or Python stack generates a line of code; only a change passing all three reaches stub generation." caption="Figure 5.1: Three buf gates in sequence, before either stack generates code." %}

## Generating stubs

Neither module commits generated or copied `.proto` files; `contracts/` is the only copy either stack treats as input. Each Containerfile builds with the repo root as its context and copies the two proto files out of `contracts/proto/` at image-build time. Both copy destinations are gitignored.

On **Quarkus**, the files land in `src/main/proto/shipping/{type,routing}/v1/`. The `pom.xml` sets `<packaging>quarkus</packaging>` rather than `jar`, and that matters: `quarkus:generate-code` runs by default only under `quarkus` packaging. A `jar`-packaged module with the same `quarkus-grpc` dependency and the same proto files compiles cleanly and silently skips generation, which looks like success until something calls a method that was never generated.

On **Python**, the files land in a staging `proto/` directory and `python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated` produces `generated/shipping/{type,routing}/v1/*_pb2.py` and `*_pb2_grpc.py`. `PYTHONPATH=/app/generated:/app` makes them importable. `grpcio-tools` lives in a `dev` dependency group, and the venv is rebuilt with `uv sync --no-dev` after generation, so the serving image never carries the compiler.

For a local look at Buf's own output, `cd contracts && buf generate` writes Python stubs to the gitignored `examples/_generated/python` using `contracts/buf.gen.yaml`. Nothing in CI depends on it.

{% include excalidraw.html file="05-contract-first-buf-flow" alt="One proto file feeds buf lint, buf build, and buf breaking; once those gates pass, the Quarkus stack generates Mutiny stubs via the quarkus-maven-plugin and the Python stack generates pb2/pb2_grpc stubs via grpcio-tools; each stack's independently-generated server implements GetQuote and is asserted by one verify.sh CI gate; a REST booking service calls GetQuote on both ports; both servers export OTLP traces to an opt-in grafana/otel-lgtm sink." caption="Figure 5.2: One proto, two generators, one CI gate." %}

## Serving GetQuote identically

Both services apply one formula with no persistence: sum every cargo item's `weight_kg`, multiply by 2.50 per kilogram, round half-up to two decimals and render a decimal string per `shipping.type.v1.Money`. The route is a single `MAERSK` leg from origin to destination, `departs_at` and `arrives_at` unset, with id `"rte_" + origin.un_locode + "-" + destination.un_locode`.

{% include codetabs.html langs="Quarkus|Python" %}

```java
    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        Types.Location origin = request.getOrigin();
        Types.Location destination = request.getDestination();

        Types.Money quote = QuoteCalculator.compute(request.getCargoList());

        Types.Leg leg = Types.Leg.newBuilder()
                .setCarrier(CARRIER)
                .setOrigin(origin)
                .setDestination(destination)
                // departsAt / arrivesAt intentionally left unset.
                .build();

        Types.Route route = Types.Route.newBuilder()
                .setId("rte_" + origin.getUnLocode() + "-" + destination.getUnLocode())
                .addLegs(leg)
                .setPrice(quote)
                .build();

        LOG.infof("GetQuote: %s -> %s, %d cargo item(s), quote=%s %s",
                origin.getUnLocode(), destination.getUnLocode(),
                request.getCargoCount(), quote.getCurrency(), quote.getAmount());

        Routing.GetQuoteResponse response = Routing.GetQuoteResponse.newBuilder()
                .setQuote(quote)
                .setRoute(route)
                .build();
        return Uni.createFrom().item(response);
    }
```

```python
class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    async def GetQuote(
        self,
        request: routing_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.GetQuoteResponse:
        origin = request.origin
        destination = request.destination

        quote = compute_quote(request.cargo)

        leg = types_pb2.Leg(
            carrier=_CARRIER,
            origin=origin,
            destination=destination,
            # departs_at / arrives_at intentionally left unset.
        )
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}",
            legs=[leg],
            price=quote,
        )

        logger.info(
            "GetQuote: %s -> %s, %d cargo item(s), quote=%s %s",
            origin.un_locode,
            destination.un_locode,
            len(request.cargo),
            quote.currency,
            quote.amount,
        )

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)
```

`Uni<GetQuoteResponse>` and an `async def` returning `GetQuoteResponse` are each stack's idiom for returning one value. `Routing.GetQuoteRequest` and `routing_pb2.GetQuoteRequest` are the same message compiled twice; neither file calls the other, and only the shared proto and the shared formula hold them to the same answer.

Rounding needs care. Java computes `BigDecimal.valueOf(totalWeightKg * RATE_PER_KG).setScale(2, RoundingMode.HALF_UP).toPlainString()`; Python computes `Decimal(str(total_weight_kg * _RATE_PER_KG)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)`. Both name the mode. The shortcuts, `String.format("%.2f", ...)` in Java and `f"{x:.2f}"` in Python, agree only on inputs that miss a rounding boundary, because Python's formatter rounds half to even. Pinning both sides to one named mode makes the responses agree on every input.

## The REST to gRPC seam

A REST booking service accepting a customer request needs a price before it confirms, and gets it by calling `RoutingService.GetQuote` over gRPC instead of computing it inline. Its request carries the nouns the REST site's OpenAPI contract already defines (origin, destination, cargo manifest), translated into the proto messages. A `Location` in gRPC and a `Location` in the REST JSON Schema describe one domain in two notations.

## Traced end to end

The opt-in `observability` compose profile (`docker compose --profile observability up --build`) adds `grafana/otel-lgtm`, which listens for OTLP on `4317`. On Quarkus, `quarkus-opentelemetry` instruments the gRPC server automatically; `quarkus.otel.exporter.otlp.endpoint` defaults to `http://localhost:4317` and the `OTEL_EXPORTER_OTLP_ENDPOINT` variable overrides it. On Python, the `opentelemetry-instrument` wrapper with `opentelemetry-exporter-otlp-proto-grpc` and `opentelemetry-instrumentation-grpc` does the same with no application code. A failed OTLP export is logged and discarded asynchronously, so neither service depends on a reachable collector, and plain `docker compose up` leaves it out. With the profile on, one `GetQuote` call produces one trace in Grafana.

## On the wire

Server reflection is on for both stacks (`enable-reflection-service=true` on Quarkus, `grpc_reflection.v1alpha.reflection` on Python), so `grpcurl` needs no local proto:

```bash
grpcurl -plaintext localhost:9005 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1200.5}]}' \
  localhost:9005 shipping.routing.v1.RoutingService/GetQuote
```

Expect `quote.amount` back as `"3001.25"`: `1200.5 x 2.50`, rounded half-up, rendered as a string, never a JSON number. Port `9006` returns the same answer from Python:

| Field | Expected |
|---|---|
| `quote.currency` | `"USD"` |
| `quote.amount` | `"3001.25"` |
| `route.id` | `"rte_USNYC-NLRTM"` |
| `route.legs[0].carrier` | `"MAERSK"` |

`grpcurl` accepts the request in camelCase (`unLocode`) but prints the response with declared snake_case names, so look for `route.legs[0].origin.un_locode`. Both directions pass through the same proto3 JSON mapping.

> **🤖 Explore with your agent**
>
> "In examples/05-contract-first, review contracts/proto/shipping/routing/v1/routing.proto against the contract-first rule: add a `string currency` field to `GetQuoteRequest` using the next free field number, regenerate stubs for the Quarkus and Python RoutingService implementations, and run the three buf gates from contracts/ before touching either handler. Then delete an existing field, give its number to a new field of a different type, and report which gate rejects it."
>
> Check: `cd contracts && buf lint && buf build -o /dev/null && buf breaking --against '../.git#branch=main,subdir=contracts'` passes for the added field, and `buf breaking` fails for the reassigned number.

## Build, run, observe

```bash
cd examples/05-contract-first
./verify.sh
```

`verify.sh` starts both services with `docker compose` (Quarkus on `9005`, Python on `9006`), calls `GetQuote` on each with the same request, and prints `PASS` only if five fields match on both: `quote.currency`, `quote.amount`, `route.id`, `route.legs[0].carrier` and `route.price.amount`. A method that dropped the `MAERSK` leg or returned `"3001.2"` for `"3001.25"` would still answer with `OK`; only field-level checks catch it. A second request with two cargo items (`1000 kg + 500.5 kg` is `3751.25`) confirms the formula sums the whole list rather than hardcoding one answer.

Experiments:

- Switch the Quarkus module's `<packaging>` from `quarkus` to `jar` and rebuild: `quarkus:generate-code` no longer runs, so no stubs are generated from the copied protos.
- Run the stack with `docker compose --profile observability up --build`, call `GetQuote`, and look for the trace in Grafana.

## For deeper coverage

- Clément Jean, *gRPC Go for Professionals* (Packt, 2023): the Protocol Buffers language, schema design and schema evolution behind the contract gated here.
- *Cloud Native Design Patterns*, "API Registry" chapter: one authoritative, versioned home for a `.proto` contract with compatibility rules gating breaking changes in CI, the role `buf breaking` plays here.
- [Buf docs](https://buf.build/docs/): `buf.yaml`, the `lint` and `breaking` rule sets, and the `STANDARD` ruleset selected here.
- [Protocol Buffers documentation](https://protobuf.dev/): the proto3 language reference behind `routing.proto` and `types.proto`.
