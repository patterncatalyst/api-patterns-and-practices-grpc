---
title: "Contract-first with Buf"
order: 5
part: "Protocol Buffers: the Contract Language"
description: "Gate the shipping proto with buf lint, buf build, and buf breaking, generate stubs on both stacks, and serve RoutingService.GetQuote end to end, traced."
duration: "22 min read"
---

## Learning objectives

By the end of this chapter you can:

- Gate a proto change with `buf lint`, `buf build -o /dev/null`, and `buf breaking` before either stack generates a line of code from it.
- Explain why contract-first beats code-first once a second, independently-built stack consumes the same `.proto` file.
- Generate client and server stubs from `routing.proto`/`types.proto` on both Quarkus (`quarkus:generate-code` under `quarkus` packaging) and Python (`grpc_tools.protoc`).
- Implement `RoutingService.GetQuote` identically on both stacks, including the `HALF_UP` rounding rule that keeps `Money.amount` byte-for-byte comparable.
- Verify two independently-generated servers agree, using `grpcurl` and `verify.sh`'s field-level assertions rather than a bare `OK` status.

## Why this matters

Chapter 3 named the message types. Chapter 4 mapped them to JSON at the edges. Neither chapter ran anything. This one does: `shipping.routing.v1.RoutingService.GetQuote` goes from a worked example on paper to a call you make with `grpcurl` and watch succeed, served identically by a Quarkus process and a Python process that have never read each other's source. The thing that makes "identically" a checkable claim rather than a hope is the same `.proto` file both of them compile, and the three `buf` commands that gate every change to it before either stack ever sees it.

## Contract-first versus code-first, for a generated wire format

REST's version of this question is about documentation drift: a hand-maintained OpenAPI file can say one thing while the code serving requests does another, and nothing catches the gap until a client does. gRPC's version is sharper, because the contract isn't descriptive, it's generative. The `.proto` file doesn't describe `GetQuoteRequest`, it produces the Java class and the Python class that both stacks compile against. There's no gap between "what the contract says" and "what the code does" to drift apart, because the code is derived from the contract by a build step, not written by a human reading it.

That sharpness cuts both ways. It's exactly why a code-first approach — hand-writing a `RoutingServiceImpl` first, then reverse-engineering a `.proto` from it with a reflection tool, then handing that generated file to the Python team — fails faster here than it does over REST. The reverse-engineered proto encodes whatever field order and naming the first implementer happened to choose, with no review step that asks whether `weight_kg` belongs on `Cargo` or on a nested `Dimensions` message, because by the time anyone's looking at the proto, a working server already depends on the answer it gives. A second team generating Python stubs from that file isn't implementing a decision anyone reviewed; they're implementing an accident, and the first schema change either team needs — adding a field, renaming one, changing a type — has no file anyone reviewed as the place that change happens, only two sets of generated code to patch in parallel and hope they still agree.

`contracts/proto/shipping/routing/v1/routing.proto` reverses that order. It's written, reviewed, and gated before a single `RoutingServiceImpl.java` or `routing_service.py` exists, and both stacks are implementations of it, never sources for it. `contracts/proto/shipping/type/v1/types.proto` holds `Money`, `Location`, `Cargo`, `Route`, `Leg`, and `Operation` — the shared domain vocabulary, defined once and imported by every service package, matching the same nouns the REST site's JSON Schema defines for the booking API. A `Cargo` field added to the proto is reviewable as a diff against a file everyone can see before it's a divergence between two running services nobody can see into.

## The proto: one RoutingService, five RPCs, one implemented

`RoutingService` declares five RPCs. `GetQuote` is the unary anchor this chapter implements; `FindOptimalRoute` and `ListRoutes` are unary methods later chapters fill in; `NegotiateRoute` is the bidirectional-streaming method Part 3 covers; `RecomputeRoutes` returns an `Operation` for the async long-running-job pattern Part 6 covers. All five are declared now, in the one file, because the contract is supposed to describe the whole service's shape even before every method has a body — a caller reading `routing.proto` today sees the complete interface this service commits to, not just the fraction that happens to be live.

```protobuf
service RoutingService {
  rpc GetQuote(GetQuoteRequest) returns (GetQuoteResponse);
  rpc FindOptimalRoute(FindOptimalRouteRequest) returns (FindOptimalRouteResponse);
  rpc ListRoutes(ListRoutesRequest) returns (ListRoutesResponse);
  rpc NegotiateRoute(stream NegotiateRouteRequest) returns (stream NegotiateRouteResponse);
  rpc RecomputeRoutes(RecomputeRoutesRequest) returns (RecomputeRoutesResponse);
}
```

On Quarkus, the generated Mutiny interface declares all five as abstract methods, so `RoutingServiceImpl` has to implement all five explicitly — the four unimplemented ones each return `Status.UNIMPLEMENTED.asRuntimeException()` rather than being left out. On Python, the generated `RoutingServiceServicer` base class already sets `UNIMPLEMENTED` and raises for any method a subclass doesn't override, so the Python side defines only `GetQuote` and lets the other four fall through to that generated default. Same contract, same observable behavior over the wire — a client calling `FindOptimalRoute` against either stack gets the identical gRPC status — reached by two different idioms, because each generator's handling of "methods you haven't written yet" differs and the proto doesn't need to care which.

## The three gates

`contracts/buf.yaml` is short enough to read in full:

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

Three commands run against it, in CI and identically on a laptop:

```bash
cd contracts
buf lint                                                      # STANDARD rule set
buf build -o /dev/null                                        # compiles; every import resolves
buf breaking --against '.git#branch=main,subdir=contracts'    # no breaking change vs main
```

`buf lint` enforces the `STANDARD` rule set — consistent naming, a comment on every service and RPC, no unused imports — the same category of check Spectral runs against the REST site's OpenAPI document, just aimed at `.proto` syntax instead of YAML. `buf build -o /dev/null` compiles the whole module without writing output anywhere; it exists to catch the failure mode where `routing.proto`'s `import "shipping/type/v1/types.proto"` points at a path that doesn't resolve, or a message references a field number that collides with the same message's own existing field — the protobuf equivalent of a `$ref` in an OpenAPI document that points at nothing. Both of those gates are cheap, deterministic, and run on every push regardless of branch.

`buf breaking` is different in kind. It diffs the current `.proto` against the version on `main` and fails the build if a reader of the old schema could misinterpret a message produced from the new one: a reused field number, a field whose type changed, a required-in-practice field removed. This is gRPC's direct analog of the REST site's response-schema-drift gate, except it runs before either stack generates a line of code rather than after a live response is captured — catching the break at the one point where fixing it costs a diff instead of a coordinated redeploy of every service that already compiled against the old field. This chapter only needs the gate to exist and run green; Chapter 14 is where the backward-compatibility rules behind it — which changes are safe, which aren't, and why a removed field is worse than an added one — get the full treatment.

{% include excalidraw.html file="05-buf-three-gates" alt="Three buf gates run in sequence against a candidate proto change: buf lint enforces the STANDARD rule set for naming, comments, and unused imports; buf build -o /dev/null compiles the module and confirms every import resolves; buf breaking diffs the candidate against main and rejects a reused field number, a retyped field, or a removed field. A change that fails any gate is rejected before either the Quarkus or Python stack generates a line of code; only a change passing all three reaches stub generation." caption="Figure 5.1 — three buf gates, in sequence: lint, then build, then breaking, before either stack generates code." %}

## Generating stubs: two toolchains, one proto

Neither module commits generated or copied `.proto` files; `contracts/` is the only copy on disk that either stack treats as input. Each Containerfile builds with the repo root as its Docker context specifically so it can `COPY` the two files this service needs straight out of `contracts/proto/` at image-build time, and both copy destinations are gitignored — they're build artifacts, not source.

On Quarkus, the Containerfile copies `types.proto` and `routing.proto` into `src/main/proto/shipping/{type,routing}/v1/` before the build runs. The module's `pom.xml` sets `<packaging>quarkus</packaging>` rather than plain `jar`, and that packaging choice matters: Quarkus's own gRPC code-generation reference confirms that the `quarkus:generate-code` goal runs by default during the Quarkus Maven plugin's lifecycle only under `quarkus` packaging. A plain `jar`-packaged module with the same `quarkus-grpc` dependency and the same `src/main/proto` files compiles without error and silently skips code generation, because the goal that turns `.proto` into Java never runs — a failure mode that looks like success until something tries to call a method the compiler never generated.

On Python, the Containerfile copies the same two files into a staging `proto/` directory, then runs `python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated` against them, producing `generated/shipping/{type,routing}/v1/*_pb2.py` and `*_pb2_grpc.py`. `PYTHONPATH=/app/generated:/app` makes the result importable as `from shipping.routing.v1 import routing_pb2`. `grpcio-tools` — needed only to invoke `protoc` — lives in a `dev` dependency group and never ships in the runtime image; the venv is rebuilt with `uv sync --no-dev` after code generation finishes, so the image that actually serves traffic never carries the compiler that built it.

For a quick local look at what Buf itself would generate, `contracts/buf.gen.yaml` configures a one-shot Python generation via Buf's remote plugins — `cd contracts && buf generate` writes to `examples/_generated/python`, which is git-ignored and exists purely for inspection. CI never depends on this path; each example regenerates its own stubs from its own build, which is the generation CI actually exercises end to end.

{% include excalidraw.html file="05-contract-first-buf-flow" alt="One proto file feeds buf lint, buf build, and buf breaking; once those gates pass, the Quarkus stack generates Mutiny stubs via the quarkus-maven-plugin and the Python stack generates pb2/pb2_grpc stubs via grpcio-tools; each stack's independently-generated server implements GetQuote and is asserted by one verify.sh CI gate; a REST booking service calls GetQuote on both ports; both servers export OTLP traces to an opt-in grafana/otel-lgtm sink." caption="Figure 5.2 — One proto, two generators, one CI gate." %}

## Serving GetQuote identically

Both services implement the same formula against no persistence: sum every cargo item's `weight_kg`, multiply by a fixed rate of 2.50 per kilogram, round half-up to two decimal places, and render the result as a decimal string — never a binary float — per `shipping.type.v1.Money`. The route returned alongside the quote is a single `MAERSK` leg from origin to destination with `departs_at` and `arrives_at` left unset, and an id built as `"rte_" + origin.un_locode + "-" + destination.un_locode`.

{% include codetabs.html langs="Quarkus|Python" %}

```java
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final String CARRIER = "MAERSK";

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        Types.Location origin = request.getOrigin();
        Types.Location destination = request.getDestination();
        Types.Money quote = QuoteCalculator.compute(request.getCargoList());

        Types.Leg leg = Types.Leg.newBuilder()
                .setCarrier(CARRIER)
                .setOrigin(origin)
                .setDestination(destination)
                .build();

        Types.Route route = Types.Route.newBuilder()
                .setId("rte_" + origin.getUnLocode() + "-" + destination.getUnLocode())
                .addLegs(leg)
                .setPrice(quote)
                .build();

        return Uni.createFrom().item(
                Routing.GetQuoteResponse.newBuilder().setQuote(quote).setRoute(route).build());
    }
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

        leg = types_pb2.Leg(carrier="MAERSK", origin=origin, destination=destination)
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}",
            legs=[leg],
            price=quote,
        )
        return routing_pb2.GetQuoteResponse(quote=quote, route=route)
```

`Uni<GetQuoteResponse>` and a plain `async def` returning `GetQuoteResponse` are each stack's native idiom for "compute and return one value," and the generated types on both sides — `Routing.GetQuoteRequest` in Java, `routing_pb2.GetQuoteRequest` in Python — are the same message compiled twice. Neither file imports or calls the other; the only thing holding them to the same answer is that both read the formula out of the same proto-shaped request and apply it the same way.

That "same way" has a sharp edge once rounding is involved. Java computes with `BigDecimal.valueOf(totalWeightKg * RATE_PER_KG).setScale(2, RoundingMode.HALF_UP).toPlainString()`; Python computes with `Decimal(str(total_weight_kg * _RATE_PER_KG)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)`. Both are explicit about `HALF_UP`. That explicitness matters because the obvious shortcut on each side — Java's `String.format("%.2f", ...)`, which happens to also be half-up, paired with Python's `f"{x:.2f}"`, which rounds half-to-even — agrees with its counterpart only on inputs that don't land exactly on a rounding boundary. Pinning both implementations to the same named rounding mode, rather than to whatever each language's default formatter does, is what makes the two responses agree on every input the formula can receive, not just the ones a quick manual test happens to try.

## Byte-identical, and verify.sh proves it

`verify.sh` brings both services up with `docker compose`, waits for each gRPC server to answer reflection's `list`, and calls `GetQuote` against `localhost:9005` (Quarkus) and `localhost:9006` (Python) with the identical request body on both targets. It asserts five fields from each response — `quote.currency`, `quote.amount`, `route.id`, `route.legs[0].carrier`, `route.price.amount` — not just that the call returned `OK`. A method that silently dropped the `MAERSK` leg, or returned `quote.amount` as `"3001.2"` instead of `"3001.25"`, would still answer with a clean gRPC status; only the field-level assertion catches it, which is the same lesson the REST site's schema-validation gate teaches applied to a binary wire format instead of JSON.

A second request, with two cargo items instead of one, closes the one gap a single assertion would leave open: it proves the formula sums every item in the list rather than hardcoding the answer for exactly one. `1000 kg + 500.5 kg = 1500.5 kg`, times `2.50`, is `3751.25` — and `verify.sh` checks that exact figure against both stacks before it prints `PASS`.

## The REST→gRPC seam, made real

Chapter 2 named this boundary without a running example to point at: the REST booking service, accepting a customer's request over HTTP, needs a price before it can confirm a booking, and it gets that price by calling `RoutingService.GetQuote` over gRPC rather than computing it inline. This chapter is where that seam gets code on both sides of it. The booking service's request carries the same shipping nouns the REST site's OpenAPI contract already defines — an origin, a destination, a cargo manifest — translated into the proto messages this contract declares, not a second, independently-invented shape. A `Location` on the gRPC side and a `Location` in the REST site's JSON Schema describe the same thing in two different serialization formats, because the domain underneath both contracts is one domain, modeled once in two notations that fit two different protocols.

## Traced end to end, the first time

The opt-in `observability` compose profile — `docker compose --profile observability up --build` — brings up `grafana/otel-lgtm`, a single-container Grafana LGTM stack listening for OTLP on `4317`. Both services are instrumented without being coupled to that container's presence: `quarkus-opentelemetry` instruments the gRPC server automatically, with `quarkus.otel.exporter.otlp.endpoint` defaulting to `http://localhost:4317` and overridable by the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable compose sets when the profile is active; the Python side runs under the `opentelemetry-instrument` wrapper with the matching `opentelemetry-exporter-otlp-proto-grpc` and `opentelemetry-instrumentation-grpc` packages doing the same job with zero application code. Neither service's startup or request path depends on a collector actually being reachable — a failed OTLP export is logged and discarded asynchronously, never blocking the response — which is why the default `docker compose up` (no profile) leaves the collector out entirely and both services still answer `GetQuote` correctly. Turn the profile on, make one call, and that one `GetQuote` request produces a trace in Grafana: this is the earliest point in the book where "it runs" and "it's traced" are the same milestone, rather than two things built in separate chapters.

## On the wire

Server reflection is enabled on both stacks (`enable-reflection-service=true` on Quarkus, `grpc_reflection.v1alpha.reflection` on Python), so `grpcurl` needs no local copy of the proto to call either one:

```bash
grpcurl -plaintext localhost:9005 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1200.5}]}' \
  localhost:9005 shipping.routing.v1.RoutingService/GetQuote
```

Expect `quote.amount` back as `"3001.25"` — `1200.5 × 2.50`, rounded half-up, rendered as a string, never a JSON number. Swap port `9005` for `9006` and run the identical command against the Python stack for the identical answer:

| Field | Expected |
|---|---|
| `quote.currency` | `"USD"` |
| `quote.amount` | `"3001.25"` |
| `route.id` | `"rte_USNYC-NLRTM"` |
| `route.legs[0].carrier` | `"MAERSK"` |

One quirk worth knowing before it surprises you: `grpcurl` happily accepts a request body written in proto3 JSON's default camelCase (`unLocode`), but it prints the response back using each message's original, snake_case field names. Look for `route.legs[0].origin.un_locode` in the printed output, not `unLocode` — the request and the response pass through the same JSON mapping Chapter 4 covered, in opposite directions, and the tool doesn't normalize the two to match.

## Where this goes next

The gates this chapter wires — `buf lint`, `buf build`, `buf breaking` — run against every later change to this contract, which means every streaming method Part 3 adds, every error detail Chapter 11 attaches, and every field Chapter 13 reconsiders all pass through the same three commands before a stack generates a line of code from them. `GetQuote` itself keeps serving as this site's anchor: Chapter 7 opens up what `quarkus-grpc` and `grpcio` actually generate from a unary RPC and why; Chapter 10 puts a real deadline on this exact call instead of letting it run unbounded; Chapter 14 returns to `buf breaking` and spells out precisely which proto changes it catches and which category of change still requires a new package version. The four `UNIMPLEMENTED` methods sitting beside `GetQuote` in `routing.proto` are promises this chapter made and later chapters keep — `NegotiateRoute` streams once Part 3 covers bidirectional RPCs, and `RecomputeRoutes` returns a pollable `Operation` once Part 6 covers async work.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Run this chapter's choice through the same lens Chapter 2 established. Contract-first costs something code-first doesn't: a review step before either stack writes a handler, and a CI job that has to run before every merge rather than after. It pays that cost back exactly where this contract lives — generated code on two independently-deployed stacks, each compiled from the proto rather than hand-synchronized against it, where a silent divergence wouldn't surface as a lint warning but as two services that compile cleanly and disagree about what a message means. <code>buf breaking</code> is what makes that payoff concrete: it turns a reused field number or a removed field — the failure class this site treats as non-retryable, because no amount of resending a request fixes a schema the two sides no longer agree on — into a failed build instead of a production incident discovered when one stack's deploy reaches a client still expecting the old shape. A single team with one implementation and no second consumer could skip the proto review and still ship correctly; the moment a second generated stack exists, as both do from this chapter forward, the contract is the only thing standing between "two implementations of one service" and "two services that happen to share a name."</p></div>

## For deeper coverage

- Clément Jean, *gRPC Go for Professionals* (Packt, 2023) — the Protocol Buffers language, schema design, and schema evolution behind the contract this chapter gates.
- *Cloud Native Design Patterns* — "API Registry" chapter — one authoritative, versioned home for a `.proto` contract with compatibility rules gating breaking changes in CI, the same role `buf breaking` plays here.
- [Buf docs](https://buf.build/docs/) — `buf.yaml`, the `lint` and `breaking` rule sets, and the `STANDARD` lint ruleset this chapter's `buf.yaml` selects.
- [Protocol Buffers documentation](https://protobuf.dev/) — the proto3 language reference behind `routing.proto` and `types.proto`.
