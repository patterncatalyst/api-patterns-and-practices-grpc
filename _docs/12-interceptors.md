---
title: "Interceptors"
order: 12
part: "Reliability: Deadlines, Errors & Interceptors"
description: "The interceptor chain as gRPC's cross-cutting seam: logging and timing on every call, an auth hook in front of the handler, and where error mapping and request-id propagation belong."
duration: "18 min read"
---

## Learning objectives

By the end of this chapter you can:

- Implement a server-side interceptor (`io.grpc.ServerInterceptor` / `grpc.aio.ServerInterceptor`) that runs before a handler ever sees a request.
- Chain multiple interceptors and control their order with `@GlobalInterceptor`/`@RegisterInterceptor` and `Prioritized` on Quarkus, or the ordered `interceptors=[...]` list on Python.
- Reject an unauthenticated call with `UNAUTHENTICATED` before the handler runs, by reading `Metadata`/`invocation_metadata`.
- Distinguish headers from trailers and know which one carries information only known at `close(status, trailers)`.
- Decide whether a concern belongs in an interceptor or in the handler, using the "unmodified in front of every method" test.

## Why this matters

Chapter 11 gave `RoutingService.GetQuote` a precise way to fail: a canonical code, a safe message, a typed detail. Nothing in that chapter asked where the code gets checked for logging, where a request gets timed, or where a missing credential gets rejected before the handler that would have returned `NOT_FOUND` or `OK` ever runs. Those questions don't belong inside `GetQuote` itself: every one of them applies identically to `FindOptimalRoute`, to `NegotiateRoute`, to any RPC a service adds next year, and writing the same timing call and the same metadata check at the top of every handler is the kind of duplication that drifts the moment one handler's copy gets updated and the other eleven don't. gRPC's interceptor is the seam built for exactly this: code that sits between the transport and the handler, runs for every call that passes through it, and never has to be remembered by whoever writes the next RPC.

## What an interceptor is, and where it sits

A gRPC interceptor is a function (or, on both stacks this book uses, an object with one) that stands between the wire and the business logic: it receives the incoming call before the handler does, and the outgoing response before the client does. On the server side, that means an interceptor sees a call's `Metadata` (the header map a client sends before the first request message) and holds the one chance to act on it before anything decodes the request body. The client-side equivalent sits on the other end of the same idea: it can attach metadata to an outgoing call, inspect the response that comes back, or retry a failed attempt, without the code originating the call knowing any of it happened. Readers who've built a servlet filter chain, an ASP.NET middleware pipeline, or an Express/Koa middleware stack already have the right mental model: gRPC's interceptor is that same seam, specialized for RPC instead of HTTP routes, and running once per *call* rather than once per round trip when the call is a stream.

That "sits between" is not a loose metaphor; it's the literal shape of the server-side API. Quarkus's `io.grpc.ServerInterceptor` declares one method, `interceptCall(ServerCall, Metadata, ServerCallHandler)`, and the handler it eventually reaches is whatever `ServerCallHandler.startCall(...)` returns, which an interceptor is free to never invoke. Python's `grpc.aio.ServerInterceptor` declares `intercept_service(continuation, handler_call_details)`, where `continuation` resolves to the handler the client's method path names, and again, nothing requires actually calling it. Both shapes hand the interceptor metadata to read and a one-way door marked "proceed to the handler" that it can decline to walk through. Chapter 10's deadline and Chapter 11's rich-error-model `Status` both exist at the layer the handler returns through; an interceptor sits one layer upstream, able to act before the handler decides anything.

## The chain: multiple interceptors, one order

Nothing limits a server to one interceptor. A real service typically registers several: one for logging, one for metrics, one for auth, maybe a fourth translating a legacy header into the key a newer client expects. When more than one is registered, they compose into a **chain**: each interceptor's `next`/`continuation` is actually the next interceptor in line, not the handler directly, until the last one finally reaches it. Order matters precisely because of that wrapping: an interceptor registered first wraps every interceptor registered after it, so it sees the call on the way in before any of them do, and the response on the way out after all of them have already run. A logging interceptor placed first times the *entire* chain, auth check included; placed last, it only times what's left after every other interceptor already decided to let the call through.

Quarkus makes that ordering explicit rather than leaving it to insertion order. `@io.quarkus.grpc.GlobalInterceptor` on an `@ApplicationScoped` bean applies it to every `@GrpcService`; `@io.quarkus.grpc.RegisterInterceptor` on a specific service applies one only there. Every global interceptor runs before any service-specific one, and when two interceptors in the same tier need a guaranteed relative order, each implements `jakarta.enterprise.inject.spi.Prioritized` rather than relying on bean-discovery order, which CDI doesn't promise. Python's `grpc.aio.server(interceptors=[...])` is plainer: the list argument *is* the chain, applied in order given, with no separate global/per-service split: one list, one server, applied to every registered service by construction.

{% include excalidraw.html file="12-interceptor-chain" alt="A horizontal chain of four boxes: a client on the left, a Logging and Timing interceptor box, an Auth Hook interceptor box, and a RoutingServiceImpl.getQuote / RoutingServiceServicer.GetQuote handler box on the right, both interceptor boxes drawn in a light amber emphasis style. Grey arrows along the top show the request flowing left to right through each box in order, labeled unary call, next.startCall or continuation, and authorization present. Amber arrows along the bottom show the response flowing right to left through the same boxes in reverse order, labeled GetQuoteResponse, close(status, trailers), and status=OK duration_ms. A dashed grey arrow runs directly from the Auth Hook box back to the client beneath the whole chain, labeled missing authorization: call.close(UNAUTHENTICATED) or context.abort(...): Handler never runs, showing the short-circuit path that skips the handler box entirely. Notes below state that Quarkus wraps the ServerCall itself via ForwardingServerCall so close(status, trailers) always logs the real outcome, that Python wraps the resolved RpcMethodHandler's behavior function the same way so streaming RPCs like NegotiateRoute still work, and that the same auth hook gates both the implemented GetQuote handler and the four UNIMPLEMENTED RoutingService methods." caption="Figure 12.1: The server-side interceptor chain: logging and timing wrap every call, the auth hook decides whether the handler ever runs, and both directions pass back out through the same chain in reverse." %}

## Cross-cutting concerns that belong here, and one that doesn't yet

Four concerns show up on nearly every production gRPC service, and all four are a better fit for an interceptor than for handler code:

- **Logging and timing.** Every call deserves one structured log line naming the method, how long it took, and how it ended; not because any single RPC's timing is interesting alone, but because that line, emitted identically for every method, is what a dashboard or alert rule aggregates against. Hand-writing it inside each handler means it's missing from the next handler someone adds until a reviewer notices.
- **Auth, as a hook.** Checking that a credential is present in metadata (not yet validating what it claims, just confirming it exists) is the cheapest gate to put in front of a handler, and belongs in front of *every* handler, not copy-pasted into each one. This chapter implements exactly that hook: presence, not validity. Chapter 20 is where a real JWT or OAuth2 token gets parsed, verified, and turned into an identity; what's built here is the seam that token eventually runs through, not the token's own logic.
- **Request-id and trace propagation.** A request that crosses the REST→gRPC seam this book keeps returning to (the booking service calling `RoutingService.GetQuote` to price a shipment) carries a trace or request id the booking service generated before it opened a gRPC channel. An interceptor is where that id gets read off incoming metadata (or minted, if absent) and attached to whatever the handler logs, so one customer-facing request stays traceable across the protocol boundary without every handler threading an id parameter through its own logic.
- **Error mapping.** Chapter 11 built `GetQuote` to construct its own `google.rpc.Status` by hand for each failure case, to show exactly what code and detail type fit each one. A service with a few careless handlers often needs the opposite too: a last-resort interceptor catching whatever unhandled exception a handler didn't convert itself and mapping it to `INTERNAL` once, rather than risking a raw stack trace leaking from whichever handler forgot. This chapter's interceptor doesn't add that catch-all: `GetQuote` returns `OK` and the other four raise `UNIMPLEMENTED`, leaving no unhandled case to rescue, but the pattern is the same chain, with one more link on it.

Reading that list against Chapter 10 and Chapter 11 draws the boundary cleanly: a deadline belongs on the call's `Context`, checked by whatever code is already running when it expires; a `Status` and its typed details belong to the handler that knows precisely which domain rule failed. An interceptor is for the concerns that don't know or care which handler is behind them, which is also why a single `AuthLoggingInterceptor` can sit in front of `GetQuote` and the four `UNIMPLEMENTED` stubs alike and do its job identically for all five.

## The interceptor on both stacks

This chapter's example registers one interceptor, `AuthLoggingInterceptor`, in front of the same `RoutingService.GetQuote` Chapter 5 built. It does the auth hook first (reject with `UNAUTHENTICATED` before the handler runs if `authorization` is absent from metadata), then the logging and timing, capturing whatever status the call actually closes with once it's allowed through.

{% include codetabs.html langs="Quarkus|Python" %}

```java
@ApplicationScoped
@GlobalInterceptor
public class AuthLoggingInterceptor implements ServerInterceptor {

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
        String method = call.getMethodDescriptor().getFullMethodName();
        long startNanos = System.nanoTime();

        if (!isReflection(method)) {
            String authorization = headers.get(AUTHORIZATION);
            if (authorization == null || authorization.isBlank()) {
                Status status = Status.UNAUTHENTICATED
                        .withDescription("missing 'authorization' metadata");
                logOutcome(method, status, startNanos);
                call.close(status, new Metadata());
                return new ServerCall.Listener<>() {};
            }
        }

        // Wrap the CALL, not the handler: close(status, trailers) is the one
        // place every RPC shape reports its final status.
        ServerCall<ReqT, RespT> timedCall =
                new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                    @Override
                    public void close(Status status, Metadata trailers) {
                        logOutcome(method, status, startNanos);
                        super.close(status, trailers);
                    }
                };
        return next.startCall(timedCall, headers);
    }
}
```

```python
class AuthLoggingInterceptor(grpc.aio.ServerInterceptor):
    async def intercept_service(self, continuation, handler_call_details):
        method = handler_call_details.method
        start = time.monotonic()
        metadata = dict(handler_call_details.invocation_metadata or ())

        # Resolving the handler only looks it up; it does not run it yet.
        handler = await continuation(handler_call_details)
        if handler is None:
            return handler

        if not _is_reflection(method) and "authorization" not in metadata:
            logger.info("grpc_call method=%s status=UNAUTHENTICATED duration_ms=%.1f",
                        method, (time.monotonic() - start) * 1000)
            return _reject_unauthenticated(handler)

        return _with_logging(handler, method, start)
```

Both bodies do the same two things in the same order, through different APIs: Quarkus's `ServerInterceptor` hands back a `ServerCall.Listener`, so timing attaches to the `ServerCall` object itself (via `ForwardingServerCall`, which forwards every method to the real call except the one, `close`, being overridden), because that's the one object both the handler and gRPC's own machinery agree on calling when the RPC ends. Python's `ServerInterceptor` hands back an `RpcMethodHandler` (a resolved-but-not-yet-invoked description of the method, its behavior function and its (de)serializers), so timing attaches by substituting a wrapped behavior function, built with the same constructor the original handler used. Neither stack lets the interceptor call the handler and inspect what it returns directly; both make it *replace* something, a `ServerCall` or an `RpcMethodHandler`, with a version that does the real work plus the logging.

Both implementations share one detail: neither applies the auth check to gRPC's server reflection service. `@GlobalInterceptor` and a `grpc.aio` interceptor list both apply to *every* exposed service by design, reflection included, and `grpcurl`'s `list`/`describe` (along with this chapter's own `verify.sh`, calling `wait_for_grpc` before anything else) needs reflection to answer before a client has any token to attach. A production interceptor almost always carries the identical exception for reflection and for a liveness/health-check endpoint, for the same reason: discovery and health have to work before whatever they'd be discovering or reporting on has finished authenticating.

## Metadata: the one thing an interceptor reads and writes

`Metadata` (Java) and `invocation_metadata` (Python) are gRPC's header map: a multimap of string keys to string or binary values, sent once at the start of a call, independent of the request message itself. `AuthLoggingInterceptor` reads exactly one key off it, `authorization`, via a typed `Metadata.Key<String>` on the Java side and a plain dict lookup on the Python side once `invocation_metadata()` is collected into one. Metadata isn't read-only from an interceptor's seat, either: a client-side interceptor commonly *writes* an outgoing call's metadata, attaching the request id or trace context mentioned above before the call reaches the wire, and a server-side interceptor can write **trailers**, the end-of-call metadata map gRPC defines for information not known until the handler finishes, which is exactly what `call.close(status, trailers)` passes in its second argument even when, as here, it's empty. A header carries what the caller knew in advance; a trailer carries what the callee only learned by the end.

{% include excalidraw.html file="12-metadata-headers-trailers" alt="A vertical call timeline with a Client box on the left and a RoutingServiceImpl.getQuote / RoutingServiceServicer.GetQuote handler box on the right, joined by dashed lifelines. A grey arrow near the top carries HEADERS: authorization, request-id from the client to the handler before any message, paired with an amber callout reading sent before the first message, what the caller already knew. A second grey arrow beneath it carries the GetQuoteRequest message. A dashed ghost box on the handler's lifeline marks the handler running and computing the quote. An amber arrow then carries the GetQuoteResponse back from the handler to the client, followed by a second amber arrow carrying TRAILERS: status, counts, timing at close, paired with an amber callout reading sent at close(status, trailers), what the callee only learned by the end. Notes below state that a header carries what the caller knew in advance, a trailer carries what the callee only learned by the end, and that Metadata (Java) or invocation_metadata (Python) is the map carrying both: the one thing an interceptor reads on the way in and writes on the way out." caption="Figure 12.2: headers travel before the first message; trailers travel only at close, carrying what the handler learned by the end." %}

## The REST→gRPC seam, once more

The booking service's REST handler that calls `GetQuote` doesn't originate a request id from nothing; it likely received one on its own inbound HTTP request, as an `X-Request-Id` header or a W3C `traceparent`. The natural place to carry that id across the protocol boundary is a client-side interceptor on the booking service's gRPC channel, attaching it to the outgoing call's metadata before `GetQuote` is invoked, matched by a server-side interceptor on the `RoutingService` end reading that same key back off incoming metadata and threading it into every log line the call produces, including the one `AuthLoggingInterceptor` already emits. Neither side needs the other's source code; they need only agree on the metadata key, exactly the kind of contract an interceptor pair holds without touching either handler's logic.

## Where this fits in the five-axis framework

**RPC shape** and **sync call vs. stream** are the axes an interceptor is most indifferent to, by design: `AuthLoggingInterceptor`'s cardinality-matching logic in the Python example exists precisely so the identical interceptor works whether the underlying method is `GetQuote`'s unary shape or `NegotiateRoute`'s bidirectional stream, without the interceptor's own code branching on which. **Deadline & budget** interacts with an interceptor only at the edges: a deadline that's already expired by the time an interceptor runs is something the interceptor can check and reject early on, saving the cost of even starting a handler that's going to lose its race with the clock regardless. **Failure class & retryability** is where an interceptor and Chapter 11's handler-level `Status` divide the work cleanly: the handler still picks the specific code for a domain failure it understands, and only an unhandled case an interceptor catches as a last resort gets the generic `INTERNAL` mapping instead. **Concurrency model** is the one axis an interceptor does change the shape of: a `ServerInterceptor.interceptCall`/`intercept_service` implementation that blocks the calling thread (a synchronous database lookup to validate a session, say) runs on *every* call to *every* method the interceptor is registered against, which multiplies a bad concurrency choice across an entire service rather than confining it to one handler.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Put a concern in an interceptor when it applies uniformly across methods and doesn't need to know which one is running: logging and timing, a credential's presence, a propagated request id, a last-resort mapping for whatever exception a handler didn't convert itself. Leave a concern in the handler when it depends on what the handler actually does: <code>GetQuote</code>'s choice between <code>NOT_FOUND</code> and <code>INVALID_ARGUMENT</code> needs the domain knowledge of what makes an origin routable, which no interceptor sitting in front of five different methods could supply without becoming five special cases bolted onto one class, at which point it has stopped being a cross-cutting concern and become five handlers wearing one name. The test is symmetry: if the same code, unmodified, is correct in front of every method a service exposes, as <code>AuthLoggingInterceptor</code> is in front of <code>GetQuote</code> and the four <code>UNIMPLEMENTED</code> stubs alike, it belongs in the chain. The moment it needs an <code>if</code> branch keyed on which method is being called, that branch belongs back in a handler, because the interceptor has quietly become one.</p></div>

## Where this goes next

Chapter 18's retry and hedging policies run inside the same gRPC machinery an interceptor sits in front of, and a client-side interceptor is often where a custom retry policy that service config can't express gets implemented by hand. Chapter 19 adds mTLS, which an interceptor can read off a call's peer certificate the same way this chapter reads `authorization` off metadata: presence and identity, with validation still handled by the transport layer beneath it. Chapter 20 is where the auth hook built here grows into real authentication and per-method authorization, parsing an actual JWT or OAuth2 token instead of checking that a string merely exists. Chapter 21 wires OpenTelemetry's own interceptor-shaped instrumentation in as a sibling to this one, producing the spans a propagated request id would otherwise have to carry unaided.

## On the wire

```bash
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}' \
  localhost:9120 shipping.routing.v1.RoutingService/GetQuote
```

```
ERROR:
  Code: Unauthenticated
  Message: missing 'authorization' metadata
```

```bash
grpcurl -plaintext -H 'authorization: Bearer demo-token' \
  -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}' \
  localhost:9120 shipping.routing.v1.RoutingService/GetQuote
```

```
{
  "quote": { "currency": "USD", "amount": "2500.00" },
  "route": { "id": "rte_USNYC-NLRTM", "legs": [ { "carrier": "MAERSK" } ] }
}
```

The first call never reaches `RoutingServiceImpl`/`RoutingServiceServicer` at all: `AuthLoggingInterceptor` closes it with `UNAUTHENTICATED` the moment it finds no `authorization` entry in the request's metadata, and the server's own log shows exactly that: a `grpc_call ... status=UNAUTHENTICATED` line with no `GetQuote: ...` line beneath it, because the handler never ran to produce one. The second call carries the header, the interceptor lets it through, and the identical Chapter 5 formula answers: `1000 kg × 2.50 = 2500.00`. Swap port `9120` for `9121` and the Python stack answers both calls identically: same rejection with no header, same quote with it, because `examples/12-interceptors/verify.sh` asserts precisely that for both stacks before it prints `PASS`.

## For deeper coverage

- [grpc.io: Interceptors](https://grpc.io/docs/guides/interceptors/): the official shape of the server- and client-side interceptor API this chapter builds on.
- [Quarkus gRPC reference guide](https://quarkus.io/guides/grpc-reference): `@GlobalInterceptor`/`@RegisterInterceptor`, ordering, and the CDI-managed interceptor lifecycle.
- Cloud Native Design Patterns, Appendix G, "Balancing Coupling": the dimensions (integration strength, distance, volatility) behind this chapter's test for what belongs in a cross-cutting seam versus a handler.
- Clément Jean, *gRPC Go for Professionals*, Packt, 2023: cross-cutting middleware patterns applied to a gRPC service.
