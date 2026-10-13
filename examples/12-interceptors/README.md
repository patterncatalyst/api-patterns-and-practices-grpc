# Ch12 — Interceptors ANCHOR: logging + timing + the auth hook

The reference both-stack implementation of a server interceptor in front of
`shipping.routing.v1.RoutingService.GetQuote` — the same RPC Chapter 5
(`examples/05-contract-first`) anchors, now running behind a single
cross-cutting bean instead of unprotected.

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs (only `GetQuote` is implemented; the rest return
  `UNIMPLEMENTED`, same as Chapter 5).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages.

Quarkus (`quarkus/`, host port 9120) and Python (`python/`, host port 9121)
each register one interceptor — `AuthLoggingInterceptor` — that does two
things on **every** call, in order:

1. **Logs and times it.** A structured log line (`grpc_call method=... status=...
   duration_ms=...`) is written for every call that reaches the interceptor,
   with the real status the call ends with — `OK` for `GetQuote`,
   `UNIMPLEMENTED` for the other four `RoutingService` methods.
2. **Checks for an `authorization` metadata entry.** Missing it rejects the
   call with `UNAUTHENTICATED` *before* `RoutingServiceImpl`/
   `RoutingServiceServicer` ever runs — a hook, not a real credential check.
   Chapter 20 is where a real token gets validated.

`verify.sh` proves both halves on **both** stacks: a call with no
`authorization` metadata gets `UNAUTHENTICATED` (the interceptor ran, the
handler didn't), and a call carrying `authorization: Bearer demo-token`
reaches `GetQuote` and gets the identical Ch5 quote back.

## Run it

```bash
cd examples/12-interceptors
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, drives both assertions against
`localhost:9120` (Quarkus) and `localhost:9121` (Python), and tears the
stack down again. Prints `PASS` only if every assertion holds for **both**
stacks.

To poke at it by hand instead:

```bash
docker compose up --build

# No authorization metadata: the auth hook rejects before GetQuote runs.
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"},
  "cargo": [{"weightKg": 1000}]
}' localhost:9120 shipping.routing.v1.RoutingService/GetQuote
# ERROR: Code: Unauthenticated ... missing 'authorization' metadata

# With authorization metadata: the call reaches the handler.
grpcurl -plaintext -H 'authorization: Bearer demo-token' -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"},
  "cargo": [{"weightKg": 1000}]
}' localhost:9120 shipping.routing.v1.RoutingService/GetQuote
# { "quote": { "currency": "USD", "amount": "2500.00" }, ... }

docker compose down -v
```

Swap `9120` for `9121` to hit the Python stack instead — same two outcomes,
same numbers.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `GetQuote` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## The interceptor, on each stack

**Quarkus** (`quarkus/src/main/java/.../AuthLoggingInterceptor.java`): an
`@ApplicationScoped` bean implementing `io.grpc.ServerInterceptor`, annotated
`@io.quarkus.grpc.GlobalInterceptor` so it runs in front of every
`@GrpcService` in the application (one, here — `RoutingServiceImpl`). On a
missing `authorization` header, `interceptCall` closes the `ServerCall`
directly with `Status.UNAUTHENTICATED` and never calls
`next.startCall(...)` — the handler this call would have reached never runs.
When the header is present, the `ServerCall` itself is wrapped
(`ForwardingServerCall.SimpleForwardingServerCall`) so that whichever status
the handler eventually closes the call with gets logged, along with the
elapsed time.

**Python** (`python/app/interceptors.py`): a `grpc.aio.ServerInterceptor`
subclass passed to `grpc.aio.server(interceptors=[...])` in `app/main.py`.
`intercept_service` resolves the method's `RpcMethodHandler` via
`continuation(...)` (which looks the handler up without running it), checks
`handler_call_details.invocation_metadata` for `authorization`, and either
substitutes a handler that immediately calls `context.abort(UNAUTHENTICATED,
...)`, or wraps the real handler's behavior function to log the outcome in a
`finally` block once it completes. Both replacement handlers match the
original handler's cardinality (unary/streaming on each side) rather than
assuming unary-unary, so the same interceptor works in front of
`NegotiateRoute`'s bidirectional stream too, even though this chapter's
`verify.sh` only exercises `GetQuote`.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) specifically so it can `COPY` the two proto files this
service needs straight from `contracts/proto/` at build time — identical
mechanics to Chapter 5's anchor (`examples/05-contract-first/README.md`
documents the local, non-container `mvn`/`uv` workaround if you need it
here too).

## On the wire

Server reflection is enabled on both stacks, so `grpcurl` needs no local
`.proto` copy. `verify.sh` asserts:

| Call | Stack | Expected |
|---|---|---|
| `GetQuote`, no `authorization` metadata | both | `UNAUTHENTICATED` |
| `GetQuote`, `authorization: Bearer demo-token` | both | `quote.currency = "USD"`, `quote.amount = "2500.00"` |

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show the topology: the shared proto feeding
both stacks, each registering `AuthLoggingInterceptor` in front of
`RoutingService`, a client either rejected before the handler or answered by
it, and the opt-in `otel-lgtm` sink.
