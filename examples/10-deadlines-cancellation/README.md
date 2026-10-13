# Ch10 — Deadline-propagation ANCHOR: RoutingService.GetQuote -> QuoteService.GetQuote

The reference both-stack implementation of deadline propagation across a real
downstream gRPC hop:

- `contracts/proto/shipping/routing/v1/routing.proto` — `RoutingService.GetQuote`,
  the inbound call a client sets a deadline on.
- `contracts/proto/shipping/quote/v1/quote.proto` — `QuoteService.GetQuote`, the
  DOWNSTREAM call `RoutingService.GetQuote` makes, artificially slowed by ~2s.
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages (same as Ch5/Ch11).

Quarkus (`quarkus/`, host port 9100) and Python (`python/`, host port 9101)
each run **one process implementing both services**. `RoutingServiceImpl` /
`RoutingServiceServicer` calls `QuoteServiceImpl` / `QuoteServiceServicer`
over a **loopback channel back to the container's own port 9000** — a real
gRPC hop, with real serialization and a real network round trip (through the
loopback interface), not a same-object method call that happens to look like
one. That's what makes this example's deadline propagation checkable: the
budget a caller hands `RoutingService.GetQuote` has to survive crossing that
hop before `QuoteService.GetQuote` ever sees it.

## The experiment

`QuoteService.GetQuote` always takes about 2 seconds to answer — a fixed,
artificial delay standing in for a slow downstream dependency. The **client's
deadline**, not anything server-side, decides whether that 2 seconds is
affordable:

| Client deadline (`grpcurl -max-time`) | What happens |
|---|---|
| **1s** (tight — shorter than QuoteService's ~2s delay) | `RoutingService.GetQuote` carves a downstream slice of ~0.9s, hands it to `QuoteService.GetQuote`, and that call is cancelled out from under it before the 2s delay finishes. The caller sees `DEADLINE_EXCEEDED` in about a second — not two. |
| **10s** (generous — longer than QuoteService's ~2s delay) | The downstream slice is ~9.9s, comfortably more than the delay needs. `QuoteService.GetQuote` answers normally and `RoutingService.GetQuote` returns `OK` with the usual quote. |

`QuoteService`'s delay never changes between these two runs. Only the budget
each caller hands it does. `verify.sh` runs **both** cases against **both**
stacks: four assertions, not two, because "fails fast under a tight deadline"
and "succeeds under a generous one" are both part of the claim.

## Run it

```bash
cd examples/10-deadlines-cancellation
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, then against **each** of
`localhost:9100` (Quarkus) and `localhost:9101` (Python):

1. Calls `GetQuote` with `-max-time 1` and asserts the call fails with
   `DEADLINE_EXCEEDED`.
2. Calls the identical `GetQuote` request with `-max-time 10` and asserts an
   `OK` response with the expected quote, route, and leg fields.

Prints `PASS` only if every assertion holds for **both** stacks in **both**
deadline scenarios.

To poke at it by hand instead:

```bash
docker compose up --build

# Tight deadline -> DEADLINE_EXCEEDED in ~1s, not ~2s:
grpcurl -plaintext -max-time 1 -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"},
  "cargo": [{"weightKg": 1000}]
}' localhost:9100 shipping.routing.v1.RoutingService/GetQuote

# Generous deadline -> OK with the normal quote:
grpcurl -plaintext -max-time 10 -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"},
  "cargo": [{"weightKg": 1000}]
}' localhost:9100 shipping.routing.v1.RoutingService/GetQuote

docker compose down -v
```

Swap `9100` for `9101` to hit the Python stack instead — same requests, same
timing behavior, same numbers.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `GetQuote` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## How the budget is carved

Neither stack uses a fixed, per-client timeout configuration for the
downstream call — a static duration can't tell the difference between a
caller with 9 seconds left and one with 90 milliseconds left, which is
exactly the distinction this example exists to make. Both stacks instead read
how much time is actually left on the INBOUND call and derive the downstream
deadline from it:

- **Quarkus**: `RoutingServiceImpl.getQuote` reads `Context.current().getDeadline()`
  — the `Deadline` grpc-java attached to the call's `io.grpc.Context` from the
  inbound `grpc-timeout` metadata — subtracts a small margin
  (`DOWNSTREAM_MARGIN_MS = 100`) for its own overhead, and passes what's left
  to `MutinyQuoteServiceGrpc.MutinyQuoteServiceStub#withDeadlineAfter` before
  calling the injected `@GrpcClient("quote")` stub. `quarkus.grpc.clients.quote.deadline`
  (a config property that applies a fixed duration to every call, which the
  Quarkus docs themselves warn isn't a substitute for a real per-request
  timeout) is not used here — see `application.properties`.
- **Python**: `RoutingServiceServicer.GetQuote` reads `context.time_remaining()`
  — seconds left on the inbound call, or `None` if the caller set no deadline
  at all — subtracts the same kind of margin (`_DOWNSTREAM_MARGIN_S = 0.1`),
  and passes what's left as the `timeout=` on the downstream
  `QuoteServiceStub.GetQuote` call.

If the inbound budget is already exhausted before the downstream call would
even start, both implementations fail with `DEADLINE_EXCEEDED` immediately —
no network round trip, no 2-second wait, nothing to show for a call that was
already doomed.

## Cancellation, not only a late timeout

A tight deadline doesn't just make `QuoteService.GetQuote` return an error
late — the point of propagating a deadline onto the downstream call (rather
than, say, racing it against a local timer) is that `QuoteService` finds out
its work stopped mattering and stops doing it:

- **Quarkus**: `QuoteServiceImpl` uses `Uni.createFrom().item(...).onItem().delayIt().by(Duration.ofSeconds(2))`
  — a Mutiny timer, not `Thread.sleep`. When the downstream deadline expires,
  grpc-java cancels the client call, which cancels the subscription on the
  server side's `Uni`, which tears down the timer before it fires. The
  `.onCancellation().invoke(...)` in `QuoteServiceImpl` logs exactly this.
  `RoutingServiceImpl`'s own `.onFailure().invoke(...)` logs
  `Context.current().isCancelled()` on the way back up.
- **Python**: `QuoteServiceServicer` awaits `asyncio.sleep(2.0)` inside the
  handler coroutine. When the downstream deadline expires, `grpc.aio` cancels
  the `asyncio.Task` running that coroutine, `asyncio.sleep` raises
  `asyncio.CancelledError` immediately rather than running out its full two
  seconds, and the `except asyncio.CancelledError` block logs the early exit
  before re-raising. `RoutingServiceServicer` logs `context.cancelled()` in
  its own `except grpc.aio.AioRpcError` handler.

## The other four RPCs

`RoutingService` declares five RPCs; only `GetQuote` has a real implementation
here, exactly as in Ch5/Ch11 — see those chapters' READMEs for the pattern
(`UNIMPLEMENTED` on Quarkus returned explicitly, on Python left to the
generated servicer base class's default).

## Proto code generation: `contracts/` is the only source of truth

Same pattern as Ch5/Ch11, extended to a third proto file. Neither module
commits generated or copied `.proto`/stub files; each `Containerfile` builds
with the **repo root** as its Docker build context so it can `COPY` the three
proto files this module needs (`types.proto`, `routing.proto`, `quote.proto`)
straight from `contracts/proto/` at build time — see `quarkus/Containerfile`
and `python/Containerfile` for the exact `COPY` lines. For a local,
non-container `mvn`/`uv` run, copy the same three files by hand first:

```bash
# Quarkus
mkdir -p quarkus/src/main/proto/shipping/{type,routing,quote}/v1
cp ../../contracts/proto/shipping/type/v1/types.proto      quarkus/src/main/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto quarkus/src/main/proto/shipping/routing/v1/
cp ../../contracts/proto/shipping/quote/v1/quote.proto     quarkus/src/main/proto/shipping/quote/v1/

# Python
mkdir -p python/proto/shipping/{type,routing,quote}/v1 python/generated
cp ../../contracts/proto/shipping/type/v1/types.proto      python/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto python/proto/shipping/routing/v1/
cp ../../contracts/proto/shipping/quote/v1/quote.proto     python/proto/shipping/quote/v1/
cd python && uv sync --group dev && \
  .venv/bin/python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated \
    proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto proto/shipping/quote/v1/quote.proto
```

Both copy destinations (`quarkus/src/main/proto/`, `python/proto/`,
`python/generated/`) are gitignored (see `../.gitignore`) — they are
build-time-only, never committed.

## On the wire

Server reflection is enabled on both stacks for both services, so `grpcurl`
needs no local `.proto` copy:

```bash
grpcurl -plaintext localhost:9100 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.quote.v1.QuoteService
# shipping.routing.v1.RoutingService
```

`verify.sh` asserts these exact fields from the generous-deadline request
above (`1000kg * 2.50 = "2500.00"`, the same formula Ch5/Ch11 use):

| Field | Expected |
|---|---|
| `quote.currency` | `"USD"` |
| `quote.amount` | `"2500.00"` |
| `route.id` | `"rte_USNYC-NLRTM"` |
| `route.legs[0].carrier` | `"MAERSK"` |
| `route.price.amount` | `"2500.00"` |

and `DEADLINE_EXCEEDED` for the identical request sent with `-max-time 1`.

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show the compose topology: the shared proto
feeding independently-generated stubs on both stacks, a client calling
`GetQuote` on each container's host port, and each `RoutingService` dialing
its own container's `QuoteService` over a loopback channel on container port
9000.
