---
title: "Interceptors"
order: 12
part: "Reliability: Deadlines, Errors & Interceptors"
description: "The interceptor chain as gRPC's cross-cutting seam: logging and timing on every call, an auth hook in front of the handler, and where request-id propagation and error mapping belong."
duration: "14 min read"
---

## Learning objectives

By the end of this chapter you can:

- Implement a server-side interceptor (`io.grpc.ServerInterceptor` / `grpc.aio.ServerInterceptor`) that runs before a handler sees a request.
- Order a chain of interceptors with `@GlobalInterceptor`, `@RegisterInterceptor` and `Prioritized` on Quarkus, or the `interceptors=[...]` list on Python.
- Reject an unauthenticated call with `UNAUTHENTICATED` before the handler runs, by reading call metadata.
- Tell headers from trailers, and know which one carries what is only known at `close(status, trailers)`.
- Decide whether a concern belongs in an interceptor or in the handler with the "unmodified in front of every method" test.

## Why this matters

Logging, timing and credential checks apply identically to every RPC a service exposes: `GetQuote`, `FindOptimalRoute`, `NegotiateRoute` and whatever is added next year. Writing them at the top of each handler drifts the moment one copy is updated and eleven aren't. An interceptor sits between the transport and the handler, runs for every call, and nobody who writes the next RPC has to remember it.

{% include excalidraw.html file="12-interceptor-chain" alt="A client sends a call through a Logging and Timing interceptor, then an Auth Hook interceptor, then the GetQuote handler. The response returns through the same boxes in reverse. A dashed arrow from the Auth Hook back to the client shows a call with no authorization closing UNAUTHENTICATED without reaching the handler." caption="Figure 12.1: The server-side interceptor chain. Logging and timing wrap every call, the auth hook decides whether the handler runs, and the response passes back out through the chain in reverse." %}

## Pattern: Interceptor Chain

### The problem

Every method needs the same four things: one log line with method, duration and outcome; a credential check; a request id that survives the hop from another service; a last-resort mapping for exceptions a handler didn't convert. Copied into each handler, any of them goes missing from the next RPC until a reviewer notices.

### The solution

**An interceptor is code between the wire and the handler that sees every call's metadata before the request body is decoded and the response before the client gets it, and can decline to pass the call on.**

Servlet filters, ASP.NET middleware and Express stacks are the same idea. The difference is that gRPC runs an interceptor once per call, not once per round trip, so a stream passes through it once. On the client side the same seam attaches metadata to an outgoing call, inspects the response or retries a failed attempt, without the calling code knowing.

Registered interceptors compose into a chain. Each one's `next` (or `continuation`) is the following interceptor, and only the last reaches the handler. The first one registered wraps all the others: it sees the call first on the way in and last on the way out. A logging interceptor placed first times the whole chain, auth included. Placed last, it times only what remains after the others let the call through.

| Concern | Interceptor | Handler |
| --- | --- | --- |
| Logging and timing | Yes: one line per call, identical for every method | No |
| Credential presence | Yes: in front of every handler | No |
| Request id and trace propagation | Yes: read from incoming metadata or mint one | No |
| Catch-all for unhandled exceptions, mapped once to `INTERNAL` | Yes: one more link in the chain | No |
| `NOT_FOUND` versus `INVALID_ARGUMENT` for an origin | No: needs domain knowledge | Yes |
| A deadline | No: it lives on the call's `Context` | Whatever code is running when it expires |

`AuthLoggingInterceptor` adds no catch-all: `GetQuote` returns `OK` and the other four methods return `UNIMPLEMENTED`, so no unhandled case is left to rescue. The catch-all is one more link on the same chain. The auth hook only checks that a credential is present. Parsing and verifying a JWT or OAuth2 token is a separate concern that runs through this same seam.

### How Quarkus and Python model it

Quarkus's `ServerInterceptor` declares `interceptCall(ServerCall, Metadata, ServerCallHandler)`. The handler is whatever `next.startCall(...)` returns, and an interceptor may never call it. Python's `grpc.aio.ServerInterceptor` declares `intercept_service(continuation, handler_call_details)`, where `continuation` resolves the handler for the method path. Resolving does not run it.

Ordering differs:

| | Quarkus | Python |
| --- | --- | --- |
| Apply to every service | `@GlobalInterceptor` on an `@ApplicationScoped` bean | `grpc.aio.server(interceptors=[...])` |
| Apply to one service | `@RegisterInterceptor` on the service | Not separate: the list is the chain for every service |
| Order | Global interceptors run before service-specific ones; within a tier, implement `jakarta.enterprise.inject.spi.Prioritized`, because CDI doesn't promise discovery order | The order of the list |

`AuthLoggingInterceptor` is the one registered interceptor. It rejects with `UNAUTHENTICATED` if `authorization` is absent from metadata, then logs and times the call, capturing the status it actually closes with.

{% include codetabs.html langs="Quarkus|Python" %}

```java
@ApplicationScoped
@GlobalInterceptor
public class AuthLoggingInterceptor implements ServerInterceptor {

    private static final Logger LOG = Logger.getLogger(AuthLoggingInterceptor.class);
    private static final Metadata.Key<String> AUTHORIZATION =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);

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
                // No listener does anything meaningful once the call is closed;
                // gRPC still requires one back from interceptCall.
                return new ServerCall.Listener<>() {
                };
            }
        }

        // Wrap the CALL, not the handler: close(status, trailers) is the one
        // place every RPC shape (unary, streaming, successful or not)
        // reports its final status, so this is the one place to log it from.
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

    private static boolean isReflection(String method) {
        return method.startsWith("grpc.reflection.");
    }

    private static void logOutcome(String method, Status status, long startNanos) {
        long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000;
        LOG.infof("grpc_call method=%s status=%s duration_ms=%d", method, status.getCode(), elapsedMs);
    }
}
```

```python
class AuthLoggingInterceptor(grpc.aio.ServerInterceptor):
    async def intercept_service(
        self,
        continuation: Callable[[grpc.HandlerCallDetails], Awaitable[grpc.RpcMethodHandler]],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler:
        method = handler_call_details.method
        start = time.monotonic()
        metadata = dict(handler_call_details.invocation_metadata or ())

        # Resolving the handler only looks up what GetQuote/FindOptimalRoute/
        # etc. WOULD run; it does not call it. The handler's own body still
        # hasn't executed by the time either branch below returns.
        handler = await continuation(handler_call_details)
        if handler is None:
            return handler

        if not _is_reflection(method) and _AUTH_KEY not in metadata:
            duration_ms = (time.monotonic() - start) * 1000
            logger.info(
                "grpc_call method=%s status=UNAUTHENTICATED duration_ms=%.1f",
                method,
                duration_ms,
            )
            return _reject_unauthenticated(handler)

        return _with_logging(handler, method, start)
```

Both do the same two things in the same order. Quarkus's interceptor returns a `ServerCall.Listener`, so timing attaches to the `ServerCall` through `ForwardingServerCall`, overriding only `close`, the one method every RPC shape calls when it ends. Python's returns an `RpcMethodHandler`, a resolved description of the method, so timing substitutes a wrapped behavior function built with the constructor that matches the original handler's cardinality. That is why the same interceptor works in front of the unary `GetQuote` and the bidirectional `NegotiateRoute`. Neither stack lets an interceptor call the handler and inspect the result directly. Both make it replace a `ServerCall` or an `RpcMethodHandler` with one that does the real work plus the logging.

Neither applies the auth check to the server reflection service. A global interceptor covers every exposed service, reflection included, and `grpcurl list` has to work before a client has a token. A production interceptor makes the same exception for reflection and for health checks: discovery and health must answer before whatever they report on has authenticated.

### Metadata, headers and trailers

`Metadata` (Java) and `invocation_metadata` (Python) are gRPC's header map: string or binary values keyed by string, sent once at the start of a call, independent of the message. The interceptor reads exactly one key, `authorization`.

Interceptors write metadata too. A client-side interceptor attaches a request id or trace context to an outgoing call. A server-side interceptor can write **trailers**, the map sent at `close(status, trailers)` for what isn't known until the handler finishes; here it is empty. A header carries what the caller knew in advance, a trailer what the callee learned by the end.

{% include excalidraw.html file="12-metadata-headers-trailers" alt="A timeline between a client and the GetQuote handler. Headers (authorization, request-id) travel before the first message. The request message follows, the handler computes, and the response returns, followed by trailers (status, counts, timing) sent at close." caption="Figure 12.2: Headers travel before the first message. Trailers travel only at close and carry what the handler learned by the end." %}

Across a REST-to-gRPC hop, the booking service's inbound `X-Request-Id` or W3C `traceparent` is attached to the outgoing call by a client-side interceptor on its channel. A server-side interceptor on `RoutingService` reads the same key and puts it in every log line the call produces. The two sides need only agree on the metadata key.

### Where it touches the other design axes

- **RPC shape:** an interceptor is indifferent to it. The same code sits in front of unary and streaming methods.
- **Deadline:** an interceptor can reject a call whose deadline already expired, saving a handler that would lose the race.
- **Failure class:** the handler picks the specific code for a domain failure; only an exception nobody converted gets the generic `INTERNAL`.
- **Concurrency:** an interceptor that blocks its thread, such as a synchronous session lookup, blocks on every call to every method it covers. A bad concurrency choice is multiplied across the service instead of confined to one handler.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Put a concern in an interceptor when the same code, unmodified, is correct in front of every method: logging and timing, a credential's presence, a propagated request id, a last-resort exception mapping. Keep it in the handler when it depends on what the handler does. Once the interceptor needs an <code>if</code> keyed on the method being called, that branch belongs back in a handler, because the interceptor has become five handlers wearing one name.</p></div>

> **🤖 Explore with your agent**
>
> "In `examples/12-interceptors`, add a request-id step to `AuthLoggingInterceptor` on both stacks (`AuthLoggingInterceptor.java` and `python/app/interceptors.py`). Read an `x-request-id` header from metadata, mint one if absent, and include it in the `grpc_call` log line. Keep it a pure cross-cutting change: the `GetQuote` handler must not change, and the reflection exemption must stay."
>
> Check: call `GetQuote` with `-H 'authorization: Bearer demo-token' -H 'x-request-id: abc123'` and confirm `abc123` appears in the `grpc_call` line, and that `git diff` touches neither `RoutingServiceImpl` nor `RoutingServiceServicer`.

## Build, run, observe

`examples/12-interceptors/verify.sh` starts both stacks with `docker compose` (Quarkus on 9120, Python on 9121) and checks both. By hand:

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

The first call never reaches the handler. The interceptor closes it with `UNAUTHENTICATED`, and the server log shows a `grpc_call ... status=UNAUTHENTICATED` line with no `GetQuote` line after it. The second call passes, and the quote is `1000 kg × 2.50 = 2500.00`. Port 9121 answers both calls identically.

Experiments:

- Drop the header from the second call: it fails with `UNAUTHENTICATED` and the handler's log line is missing.
- Call a stub such as `FindOptimalRoute` with the header: it fails with `UNIMPLEMENTED`, and the `grpc_call` line still reports that status. The same interceptor fronts all five methods.
- Run `grpcurl -plaintext localhost:9120 list` without a header: reflection answers, because of the exemption.

## For deeper coverage

- [grpc.io: Interceptors](https://grpc.io/docs/guides/interceptors/): the official server- and client-side interceptor API.
- [Quarkus gRPC reference guide](https://quarkus.io/guides/grpc-reference): `@GlobalInterceptor`, `@RegisterInterceptor`, ordering, and the CDI-managed lifecycle.
- Cloud Native Design Patterns, Appendix G, "Balancing Coupling": the dimensions (integration strength, distance, volatility) behind the rule for what belongs in a cross-cutting seam versus a handler.
- Clément Jean, *gRPC Go for Professionals*, Packt, 2023: cross-cutting middleware patterns applied to a gRPC service.
