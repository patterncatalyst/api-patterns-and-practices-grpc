---
title: "Unary RPCs and the generated code"
order: 7
part: "HTTP/2 & the Four RPC Types"
description: "The stub-to-stub path for a unary call in both stacks, the channel and stub split that governs every gRPC client, and the reuse rule that keeps it fast."
duration: "15 min read"
---

## Learning objectives

By the end of this chapter you can:

- Trace a unary `GetQuote` call from a typed client stub, across the protobuf wire, to a typed server handler and back, on Quarkus and Python.
- Explain the channel and stub split: a channel is expensive, a stub is cheap.
- Spot the per-call channel anti-pattern and move the channel to a once-at-startup location on either stack.
- Choose a blocking or a reactive/`async` stub for a unary call from the concurrency model.

## Why this matters

`shipping.routing.v1.RoutingService.GetQuote` is unary, the simplest of the four RPC shapes, which makes it the cleanest place to see what each toolchain generates and the two objects every gRPC client is built from: a channel and a stub.

A unary RPC is one request message in, one response message out, on a single HTTP/2 stream that opens for the call and closes when the response arrives: a request frame, a response frame and a trailer carrying the gRPC status. There is no flow control to tune and no half-open state. It also can't amortize connection overhead over many messages the way a stream can, so whatever a client pays to get from request to response, it pays on every call. Keeping that cost low is a client-side concern more than a protocol one.

## The stub-to-stub path

`routing.proto` declares `GetQuote(GetQuoteRequest) returns (GetQuoteResponse)` inside `RoutingService`. Each toolchain produces a pair from it: a server skeleton the handler implements, and a client stub that a caller invokes like a local function. The stub serializes the typed request to bytes and sends an HTTP/2 frame, the skeleton deserializes it into the identical typed object, and the handler's typed return value makes the same trip back. Nobody writing a handler or a caller touches a byte.

| | Quarkus | Python |
|---|---|---|
| Generator | `quarkus-grpc`, bound to `generate-sources` by the module's `quarkus` packaging | `grpc_tools.protoc` |
| Messages | Generated classes in `shipping.routing.v1` | `routing_pb2.py` |
| Server side | `RoutingService` interface, one Mutiny method per RPC: `Uni<GetQuoteResponse> getQuote(GetQuoteRequest)`, and `Multi<NegotiateRouteResponse> negotiateRoute(Multi<NegotiateRouteRequest>)` for the bidirectional one | `RoutingServiceServicer` in `routing_pb2_grpc.py`; its default for every method sets `UNIMPLEMENTED` and raises, so a subclass overrides only what it implements |
| Client side | `MutinyRoutingServiceGrpc.MutinyRoutingServiceStub` (returns `Uni`) and `RoutingServiceGrpc.RoutingServiceBlockingStub` (returns `GetQuoteResponse` directly) | One `RoutingServiceStub`, a method per RPC built on `channel.unary_unary(...)` |

{% include excalidraw.html file="07-unary-stub-to-stub" alt="Two parallel lanes, Quarkus and Python, both fed by the single shipping.routing.v1.RoutingService.GetQuote proto at top. In each lane: client code calls a generated client stub (Mutiny or blocking stub on Quarkus; sync or grpc.aio RoutingServiceStub on Python) labeled 'typed call in'; the stub hands off to one reused HTTP/2 channel, built once and cached rather than created per call; the channel carries protobuf-encoded bytes on the wire to a generated server skeleton (the Mutiny RoutingService interface on Quarkus, the RoutingServiceServicer base class on Python); the skeleton dispatches to the handler, labeled 'typed call out'." caption="Figure 7.2: The stub-to-stub path: one proto, two generated pairs, one reused channel per stack." %}

## Blocking or async: the channel on Python, the type on Quarkus

On Python the same `RoutingServiceStub` class serves both styles. Built over `grpc.insecure_channel(target)`, `stub.GetQuote(request)` blocks the calling thread and returns a `GetQuoteResponse`. Built over `grpc.aio.insecure_channel(target)`, the same call returns a coroutine: `await stub.GetQuote(request)` suspends instead of blocking. The generated code never branches; `channel.unary_unary()` does, because `grpc.Channel` and `grpc.aio.Channel` implement it with different return semantics. Match the client to the server: an asyncio service gets a `grpc.aio` client.

Quarkus generates a separate class per style, so the choice is a type:

| Injection | `getQuote` behavior |
|---|---|
| `@GrpcClient("routing") RoutingServiceGrpc.RoutingServiceBlockingStub` | Blocks the calling thread, returns `GetQuoteResponse` |
| `@GrpcClient("routing") MutinyRoutingServiceGrpc.MutinyRoutingServiceStub` | Returns `Uni<GetQuoteResponse>`; safe on an I/O thread |
| `@GrpcClient("routing") RoutingService` | Same `Uni` shape as the Mutiny stub; what most Quarkus code injects |

{% include excalidraw.html file="07-channel-decides-call-style" alt="Diagram contrasting where the blocking-versus-async split lives on each stack. A shared GetQuote(request) proto node feeds both. On Quarkus, the split is type-level: quarkus-grpc generates three distinct stub types from one proto: RoutingServiceBlockingStub, whose getQuote(request) blocks the calling thread and returns GetQuoteResponse directly; MutinyRoutingServiceStub, whose getQuote(request) is non-blocking and returns Uni<GetQuoteResponse>; and the RoutingService service interface, injected the same way and returning the identical Uni<GetQuoteResponse> shape, with the type chosen at injection fixed in code, not at runtime. On Python, the split is channel-level: one generated RoutingServiceStub class serves both styles. Built over grpc.insecure_channel(target), an ordinary grpc.Channel, stub.GetQuote(request) blocks the calling thread and returns GetQuoteResponse directly. Built over grpc.aio.insecure_channel(target), an asyncio-native grpc.aio.Channel, the identical method call becomes await stub.GetQuote(request), which suspends the coroutine and returns GetQuoteResponse only once awaited: channel.unary_unary() decides the behavior, not the generated code." caption="Figure 7.1: On Python the channel decides call style; on Quarkus the stub type does." %}

## One channel, many stubs

### The problem

A `Channel` is a live HTTP/2 connection (or a small pool) to one target. Establishing it costs a DNS lookup, a TCP handshake and, outside plaintext examples, a TLS handshake. None of that is needed twice, because HTTP/2 carries many concurrent streams on one connection. A client that builds a channel inside the code path that handles a request pays the full setup on the hot path, serially, before any byte of the request moves, and throws away multiplexing, since a channel built and closed per call never carries a second stream. This is the most common gRPC performance mistake, and it's easy to write by accident. `grpc.aio.insecure_channel(target)` or `ManagedChannelBuilder.forTarget(target).build()` is a bug only because of where it sits. In a constructor, a field initializer or a DI provider it runs once. In a request handler or a loop body it runs on every `GetQuote`.

### The solution

**Build one channel per target at startup, hold it for the life of the process, and build as many cheap stubs from it as you need.**

A stub is a small object holding a channel reference and the generated per-method call logic. Constructing one does no network I/O.

### How Quarkus and Python model it

Quarkus removes the mistake for the common case. Every `@GrpcClient` injection point with the same name resolves against one `Channel`, built once from `quarkus.grpc.clients.<name>.host` and `.port` and cached for the application's lifetime. The Mutiny interface, the Mutiny stub and the blocking stub injected under `"routing"` all share it. You can still defeat this by injecting a raw `@GrpcClient Channel` and building stubs from it on a hot path without caching the result.

Python has no such guard. Nothing warns about a repeated `grpc.aio.insecure_channel()`, so building the channel in a constructor or at startup and keeping it is the application's job:

```python
    # ONE channel, built once. Everything below reuses it.
    channel = grpc.aio.insecure_channel(target)
    # ONE stub, built once from that one channel. Cheap: no network I/O
    # happens here, just a typed wrapper around `channel`.
    stub = routing_pb2_grpc.RoutingServiceStub(channel)

    print(f"reuse_client: one channel id={id(channel)}, one stub id={id(stub)}, target={target}")

    amounts: list[str] = []
    try:
        for i in range(calls):
            # Same stub object, same underlying channel, every iteration:
            # no `grpc.aio.insecure_channel(...)` call inside this loop.
            response = await stub.GetQuote(_REQUEST)
            amounts.append(response.quote.amount)
            print(f"reuse_client: call {i + 1}/{calls} -> quote.amount={response.quote.amount}")
```

The booking service applies the same rule at the REST to gRPC seam: one `Channel` to `RoutingService` for the process lifetime, and stubs built from it per request, rather than dialing routing for every booking confirmation that needs a quote.

Reuse doesn't mean never creating anything. A stub per request from a reused channel costs nothing worth optimizing away. The expensive parts are the connection, the handshake and the resolver work behind it, which is why the rule is one channel for as long as the target doesn't change.

## Choosing a stub style

RPC shape, failure class and deadline are the same for both stub flavors: both call `GetQuote` once, see the same status codes, and a deadline attaches to the call, not the calling convention. The concurrency model decides.

| Stub | Use it when |
|---|---|
| Blocking | The code already runs on a thread built to park: a virtual thread or a dedicated worker on Quarkus |
| Mutiny (Quarkus), `grpc.aio` (Python) | The default. `GetQuote` is I/O-bound, so the thread is idle until bytes return; free it for the round trip. Required on a Quarkus I/O thread, where blocking stalls every other request that thread serves |

The cost of a reactive style you didn't strictly need is close to zero. The cost of the wrong concurrency model compounds with every concurrent caller.

> **🤖 Explore with your agent**
>
> "In examples/07-unary-rpcs, review python/app/reuse_client.py against the one-channel rule: write a variant of reuse_client.py that builds a new `grpc.aio.insecure_channel` inside the loop, run both variants for 20 calls against quarkus:9000, and report the difference in total time."
>
> Check: both variants print the same `quote.amount` for every call, and the reply reports the elapsed time of each.

## Build, run, observe

```bash
cd examples/07-unary-rpcs
./verify.sh
```

`verify.sh` starts both services (Quarkus on `9070`, Python on `9071`), waits for reflection, calls `GetQuote` with the same request on each, checks the response fields, and runs `reuse_client.py` against each stack. It prints `PASS` only if all of that holds. By hand:

```bash
grpcurl -plaintext localhost:9070 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1200.5}]}' \
  localhost:9070 shipping.routing.v1.RoutingService/GetQuote
```

Port `9071` returns the same `quote.amount`, `"3001.25"` (`1200.5 x 2.50`, rounded half-up). `grpcurl` can't observe the channel, so `reuse_client.py` runs from the built Python image inside the compose network, once against each stack:

```bash
docker compose run --rm --entrypoint python python -m app.reuse_client quarkus:9000 3 3001.25
docker compose run --rm --entrypoint python python -m app.reuse_client python:9000 3 3001.25
```

It prints the identity of the one channel and the one stub once (the ids vary per run), then three calls on that pair:

```text
reuse_client: one channel id=140470774709088, one stub id=140470774709760, target=quarkus:9000
reuse_client: call 1/3 -> quote.amount=3001.25
reuse_client: call 2/3 -> quote.amount=3001.25
reuse_client: call 3/3 -> quote.amount=3001.25
reuse_client: ok, 3 calls on one reused channel/stub, all quote.amount=3001.25
```

Experiments:

- Point `reuse_client` at `python:9000` instead of `quarkus:9000`: only the server answering changes, and the amounts stay `3001.25`.
- Pass a wrong expected amount as the last argument: `reuse_client` exits 1 with a FAIL message.

## For deeper coverage

- Clément Jean, *gRPC Go for Professionals* (Packt, 2023): the generated client surface, channels and stubs.
- [grpc.io: Core concepts: channels](https://grpc.io/docs/what-is-grpc/core-concepts/).
- [Quarkus gRPC: service consumption and `@GrpcClient`](https://quarkus.io/guides/grpc-service-consumption).
- grpc-java `ManagedChannel` lifecycle; Python `grpc.aio` channel API.
