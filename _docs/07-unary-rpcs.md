---
title: "Unary RPCs and the generated code"
order: 7
part: "HTTP/2 & the Four RPC Types"
description: "The stub-to-stub path for a unary call in both stacks, the channel/stub split that governs every gRPC client, and the reuse rule that keeps it fast."
duration: "20 min read"
---

Chapter 5 proved that `shipping.routing.v1.RoutingService.GetQuote` runs the same way on a Quarkus process and a Python process built from one `.proto` file. This chapter opens up what each toolchain actually generated to make that call possible, and introduces the two objects every gRPC client is built from: a channel and a stub. `GetQuote` is unary — the simplest of the four RPC shapes Chapter 6 named — which makes it the cleanest place to see the stub-to-stub path end to end before Chapter 8 complicates the picture with a stream on one side of the call.

## What "unary" buys you

A unary RPC is one request message in, one response message out, carried on a single HTTP/2 stream that opens for the call and closes when the response arrives. Chapter 6 covered how HTTP/2 multiplexes many such streams over one TCP connection; a unary call is the smallest unit of work that connection carries — no flow control tuning for a long-lived stream, no half-open states to reason about, just a request frame, a response frame, and a trailer carrying the gRPC status. That simplicity is also a cost: a unary call can't amortize connection overhead the way a stream of many messages can, so whatever cost a client pays to get from "I have a request" to "I have a response" is paid in full on every single call. Keeping that cost low is this chapter's actual subject, and it turns out to be a client-side concern more than a protocol one.

## The stub-to-stub path

`routing.proto` declares `GetQuote(GetQuoteRequest) returns (GetQuoteResponse)` inside `RoutingService`. Neither stack's toolchain reads that line and produces one artifact — each produces a pair: a server-side skeleton the handler implements, and a client-side stub any caller uses to invoke the method as if it were a local function call. The protobuf wire format sits between the two halves of that pair, invisible to both: a caller invokes a typed method with a typed request object, the stub serializes it to bytes and sends an HTTP/2 frame, the server's generated skeleton deserializes those bytes back into the identical typed request object, and the handler's typed return value makes the same trip in reverse. A typed call goes in on one end, protobuf travels the wire in the middle, and a typed call comes out the other end — nobody writing `RoutingServiceImpl.getQuote` or a caller invoking that method ever touches a byte directly.

On Quarkus, `quarkus-grpc`'s code generation (bound to the `generate-sources` phase by the module's `quarkus` packaging, the fact Chapter 5 flagged as easy to get wrong) reads `routing.proto` and emits a `RoutingService` interface in the `shipping.routing.v1` package with one method per RPC, each returning a Mutiny type: `Uni<GetQuoteResponse> getQuote(GetQuoteRequest request)` for the unary methods, `Multi<NegotiateRouteResponse> negotiateRoute(Multi<NegotiateRouteRequest> request)` for the one bidirectional method. `RoutingServiceImpl implements RoutingService` is the server skeleton's concrete half — the class Chapter 5 already showed, unchanged here. The client half is generated into the same package: `MutinyRoutingServiceGrpc.MutinyRoutingServiceStub` wraps the identical Mutiny-shaped methods for a caller instead of a handler, and `RoutingServiceGrpc.RoutingServiceBlockingStub` offers the same five methods as plain synchronous Java calls that return `GetQuoteResponse` directly rather than a `Uni` wrapping it. Three different shapes, one proto, one code-generation pass.

On Python, `grpc_tools.protoc` produces two files from the same two `.proto` inputs: `routing_pb2.py` holds the message classes — `GetQuoteRequest`, `GetQuoteResponse`, and the rest — and `routing_pb2_grpc.py` holds the service plumbing. That second file defines `RoutingServiceServicer`, the base class `RoutingServiceServicer` in `app/routing_service.py` extends, whose default implementation of every method calls `context.set_code(grpc.StatusCode.UNIMPLEMENTED)` and raises — which is exactly why Chapter 5's Python side only needed to override `GetQuote`, leaving the other four to answer `UNIMPLEMENTED` without any code of their own. The same file also defines `RoutingServiceStub`, a class with one method per RPC — `GetQuote`, `FindOptimalRoute`, and so on — built around `channel.unary_unary(...)` and the other three gRPC call shapes. That one stub class is the whole client surface; nothing in `routing_pb2_grpc.py` distinguishes a synchronous caller from an asynchronous one.

## Blocking, sync, and async: the surprising split is in the channel, not the stub

Here's the detail worth sitting with, because it cuts against the instinct that "blocking" and "async" are properties of generated code: on the Python side, the exact same `RoutingServiceStub` class serves both styles. Construct it with `grpc.insecure_channel(target)` — an ordinary synchronous `grpc.Channel` — and `stub.GetQuote(request)` blocks the calling thread until the response arrives, returning a `GetQuoteResponse` directly. Construct that identical `RoutingServiceStub` class with `grpc.aio.insecure_channel(target)` instead — an asyncio-native `grpc.aio.Channel` — and the very same method call becomes awaitable: `await stub.GetQuote(request)` suspends the coroutine rather than blocking a thread, and the method itself returns a coroutine object you have to await to get the `GetQuoteResponse` out of. The generated code never branches on which channel type built it; `channel.unary_unary()` does, because `grpc.Channel` and `grpc.aio.Channel` implement that method with different return semantics. One generated file, one stub class, two runtime behaviors selected entirely by which channel constructed it — this chapter's example builds the `grpc.aio` flavor because that's `app/main.py`'s own server style, matching an asyncio service with an asyncio client rather than mixing concurrency models for no reason.

Quarkus makes the same split a type-level choice instead of a channel-level one, because it generates separate classes for each style rather than one class that adapts. `@GrpcClient("routing") RoutingServiceGrpc.RoutingServiceBlockingStub routing` gives you a stub whose `getQuote(request)` method blocks the calling thread and hands back a `GetQuoteResponse` — the right shape for code already running on a thread it's willing to park. `@GrpcClient("routing") MutinyRoutingServiceGrpc.MutinyRoutingServiceStub routing` gives you the identical method returning `Uni<GetQuoteResponse>`, composable within a Mutiny pipeline and safe to call from one of Quarkus's I/O threads, which a blocking call would stall. `@GrpcClient("routing") RoutingService routing` — injecting the service interface itself — gives you the same `Uni`-returning shape as the Mutiny stub, which is why most Quarkus code reaches for the interface rather than naming the generated stub class directly.

{% include excalidraw.html file="07-channel-decides-call-style" alt="Diagram contrasting where the blocking-versus-async split lives on each stack. A shared GetQuote(request) proto node feeds both. On Quarkus, the split is type-level: quarkus-grpc generates three distinct stub types from one proto — RoutingServiceBlockingStub, whose getQuote(request) blocks the calling thread and returns GetQuoteResponse directly; MutinyRoutingServiceStub, whose getQuote(request) is non-blocking and returns Uni<GetQuoteResponse>; and the RoutingService service interface, injected the same way and returning the identical Uni<GetQuoteResponse> shape — the type chosen at injection is fixed in code, not at runtime. On Python, the split is channel-level: one generated RoutingServiceStub class serves both styles. Built over grpc.insecure_channel(target), an ordinary grpc.Channel, stub.GetQuote(request) blocks the calling thread and returns GetQuoteResponse directly. Built over grpc.aio.insecure_channel(target), an asyncio-native grpc.aio.Channel, the identical method call becomes await stub.GetQuote(request), which suspends the coroutine and returns GetQuoteResponse only once awaited — channel.unary_unary() decides the behavior, not the generated code." caption="Figure 7.1 — the channel decides call style on Python; Quarkus makes the same split type-level instead." %}

{% include codetabs.html langs="Quarkus|Python" %}

```java
@ApplicationScoped
public class BookingQuoteClient {

    // Injected once; Quarkus builds ONE Channel for the "routing" client name
    // and this Mutiny service interface is a thin typed view over it — not a
    // connection of its own.
    @GrpcClient("routing")
    RoutingService routing;

    public Uni<Types.Money> quote(Routing.GetQuoteRequest request) {
        return routing.getQuote(request).onItem().transform(Routing.GetQuoteResponse::getQuote);
    }
}
```

```python
class BookingQuoteClient:
    def __init__(self, target: str) -> None:
        # Built ONCE, held for the client's lifetime — not per call.
        self._channel = grpc.aio.insecure_channel(target)
        self._stub = routing_pb2_grpc.RoutingServiceStub(self._channel)

    async def quote(self, request: routing_pb2.GetQuoteRequest) -> types_pb2.Money:
        response = await self._stub.GetQuote(request)
        return response.quote

    async def close(self) -> None:
        await self._channel.close()
```

## Channels and stubs: the chapter's actual spine

Every example above shares one structural fact that matters more than which stub flavor you pick: a `Channel` and a stub are not the same kind of object, and treating them as interchangeable is how a gRPC client gets slow. A `Channel` represents a live HTTP/2 connection (or a small pool of them) to a specific target — establishing one means a DNS lookup, a TCP handshake, and, for anything running outside this book's plaintext examples, a TLS handshake on top of that. None of that work is free, and none of it needs repeating once it's done, because the whole point of HTTP/2 multiplexing — the mechanism Chapter 6 covered — is that one connection carries many concurrent streams without new connection setup per stream. A stub, by contrast, is cheap: it's a small object holding a reference to a channel plus the generated per-method call logic, and constructing one does no network I/O at all. The correct lifecycle pairs a long-lived channel with however many stubs you like built from it, created and discarded freely, because creating a stub costs nothing a channel's setup already didn't pay for once.

The failure mode this chapter exists to name is building a new `Channel` inside the code path that handles a request — once per `GetQuote` call instead of once at startup. Every such call now pays the full connection-setup cost on the hot path, serially, before a single byte of the actual request goes anywhere; worse, it throws away the multiplexing Chapter 6 spent a chapter explaining, because a channel built and torn down per call gets zero benefit from carrying more than one stream before it closes. This is the single most common gRPC performance mistake, and it's easy to write by accident: a line that looks perfectly reasonable in isolation — `grpc.aio.insecure_channel(target)` or `ManagedChannelBuilder.forTarget(target).build()` — becomes a bug only because of where it sits. Inside a constructor, a field initializer, or a dependency-injection provider method, it runs once. Inside a request handler, a loop body, or anything invoked per call, it runs on every single `GetQuote`, and the fix is never a cleverer channel — it's moving that one line somewhere that only executes once.

Quarkus removes this mistake from the set of things you can get wrong, for the common case: every `@GrpcClient` injection point sharing the same client name resolves against one `Channel`, built once from that name's `quarkus.grpc.clients.<name>.host`/`.port` configuration and cached for the application's lifetime. Inject the Mutiny service interface, the Mutiny stub, and the blocking stub all under the name `"routing"`, and all three share that one channel — the framework decides when a channel gets built, and CDI's own object lifecycle keeps the injected field around for exactly as long as the bean holding it lives, which for a singleton service is the life of the application. You can still shoot yourself if you inject `@GrpcClient Channel` directly and build your own stubs from it inside a hot path instead of caching the result, but the common path — inject a stub, call it — reuses the one channel Quarkus already built without any extra code. Python offers no equivalent framework behavior: nothing watches for a repeated `grpc.aio.insecure_channel()` call and warns you, so the discipline of building the channel once, at startup or in a constructor, and holding onto it for the life of the process, is a decision the application code has to make and keep making correctly. This chapter's example makes that reuse visible rather than assumed: `reuse_client.py` builds one channel and one stub outside any loop, then calls `GetQuote` on that same pair repeatedly, printing the Python object identity of both so "the same channel, every time" is a claim you can check rather than take on faith.

{% include excalidraw.html file="07-unary-stub-to-stub" alt="Two parallel lanes, Quarkus and Python, both fed by the single shipping.routing.v1.RoutingService.GetQuote proto at top. In each lane: client code calls a generated client stub (Mutiny or blocking stub on Quarkus; sync or grpc.aio RoutingServiceStub on Python) labeled 'typed call in'; the stub hands off to one reused HTTP/2 channel, built once and cached rather than created per call; the channel carries protobuf-encoded bytes on the wire to a generated server skeleton (the Mutiny RoutingService interface on Quarkus, the RoutingServiceServicer base class on Python); the skeleton dispatches to the handler, labeled 'typed call out'." caption="Figure 7.2 — The stub-to-stub path: one proto, two generated pairs, one reused channel per stack." %}

The REST→gRPC seam Chapter 2 named gets a concrete answer here too: the booking service holds one `Channel` to `RoutingService` for the lifetime of the process and builds whatever stubs it needs from that single channel per request, rather than dialing routing fresh for every booking confirmation that needs a quote. That's the same reuse rule this chapter applies everywhere else, just at the one point where an HTTP request on one protocol turns into a gRPC call on another.

## Where the cost actually goes, and where it doesn't

It's worth being precise about what reuse saves and what it doesn't, because overcorrecting into "never create anything new" is its own mistake. A stub is cheap enough that creating one per request, from an already-reused channel, costs nothing worth optimizing away — the `BookingQuoteClient` example above could just as easily construct a fresh `RoutingServiceStub` inside `quote()` on every call, provided `self._channel` stays the one built in `__init__`, and the cost profile wouldn't change. What's expensive is specifically the channel: the connection, the handshake, the resolver work behind it. Chapter 18 comes back to this with numbers — how much a cold handshake costs relative to a warm call, what a connection pool buys you under concurrent load the single channel here doesn't — but the qualitative rule doesn't wait for measurements to be true: one channel, held for as long as the target doesn't change, any number of stubs built from it, as many calls through those stubs as the workload needs.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Run this chapter's choice — blocking stub versus Mutiny/<code>grpc.aio</code> stub for a unary call — through the same five axes Chapter 2 established. RPC shape doesn't move the needle here; both options still call <code>GetQuote</code> once and get one response back. The axis that decides it is concurrency model: a blocking stub parks the calling thread for the round trip, which is fine on a thread the runtime can afford to park (a virtual thread on Quarkus, a dedicated worker) and wasteful on one it can't (a Quarkus I/O thread, where blocking long enough stalls every other request that thread would otherwise serve). <code>GetQuote</code> is I/O-bound, not CPU-bound — the thread isn't computing anything while it waits, it's idle until bytes come back — which is precisely the case the reactive and <code>async</code> styles exist for: free the thread (or never occupy one) while the network round trip is in flight, and resume only when there's real work to do. Sync vs. stream and failure class don't change between the two stub flavors, since both see the identical gRPC status codes Chapter 2 classified; deadline and budget apply identically to either, since a deadline attaches to the call, not to the calling convention. The chapter's actual default follows from this: reach for the Mutiny service interface on Quarkus and <code>grpc.aio</code> on Python unless the calling code already runs on a thread built to block, because the cost of getting the concurrency model wrong compounds with every concurrent caller, while the cost of a reactive style you didn't strictly need is close to zero.</p></div>

## Where this goes next

The channel/stub split named here doesn't go away once a call stops being unary — it's the same two objects underneath a server stream, a client stream, or the bidirectional negotiation `NegotiateRoute` still returns `UNIMPLEMENTED` for. Chapter 8 opens a server stream from this same `RoutingService` and the stub that calls it is built exactly the way this chapter built one, just invoked with a method that returns a `Multi`/an async iterator instead of a single value. Chapter 10 puts a real deadline on this exact `GetQuote` call rather than letting it run unbounded, attaching to the stub-level call Chapter 2 flagged as the second axis this chapter left untouched. Chapter 15 returns to the concurrency-model axis from this chapter's Decision callout and goes deep on what backs a blocking stub versus an async one on the server side of the same question — virtual threads, event loops, and what each costs under load. Chapter 18 is where "build one channel" stops being a rule taken on faith and becomes a number: how much a cold handshake costs against a warm call, and what a connection pool buys past a single channel once concurrency climbs high enough to need one.

## On the wire

`verify.sh` brings both services up, waits for each to answer reflection's `list`, and calls `GetQuote` with the identical request on both:

```bash
grpcurl -plaintext localhost:9070 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1200.5}]}' \
  localhost:9070 shipping.routing.v1.RoutingService/GetQuote
```

Swap `9070` for `9071` and the same request against the Python stack returns the same `quote.amount`: `"3001.25"`, `1200.5 × 2.50` rounded half-up. That's the same correctness bar Chapter 5 set. This chapter's own check runs one level lower, where `grpcurl` can't reach: `verify.sh` also invokes `reuse_client.py` straight from the already-built Python image, pointed in turn at each stack's in-network address, and watches it build one `grpc.aio.insecure_channel` and one `RoutingServiceStub`, then call `GetQuote` three times on that same pair:

```
reuse_client: one channel id=140470774709088, one stub id=140470774709760, target=quarkus:9000
reuse_client: call 1/3 -> quote.amount=3001.25
reuse_client: call 2/3 -> quote.amount=3001.25
reuse_client: call 3/3 -> quote.amount=3001.25
reuse_client: ok — 3 calls on one reused channel/stub, all quote.amount=3001.25
```

Three calls, one channel object identity, one stub object identity, printed once and never rebuilt — run the same script against `python:9000` instead and the only thing that changes is which server answers. The generated code took care of getting a typed request onto the wire and a typed response back off it; keeping the connection underneath that round trip from being rebuilt on every call is the one piece this chapter leaves to the calling code, on both stacks, every time.
