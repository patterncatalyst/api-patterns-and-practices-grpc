# Ch15 — Backend I/O concurrency ANCHOR: `RoutingService.FindOptimalRoute`, offloaded vs starving

The reference both-stack implementation of `shipping.routing.v1.RoutingService.FindOptimalRoute`
behind ~400ms of simulated blocking DB+file I/O — the chapter's proof that
*where* a blocking call runs, not merely whether it eventually returns, is
what decides whether a server scales under concurrent load. The contract —
not either codebase — is the source of truth:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its eight RPCs (only `FindOptimalRoute` is implemented here; the rest
  return `UNIMPLEMENTED`, same discipline as every prior chapter's example).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Route`,
  `Leg`, `Location`, `Money` messages `FindOptimalRoute` returns.

Quarkus (`quarkus/`, host port 9150) and Python (`python/`, host port 9151)
independently implement the identical RPC, generated from the **same**
`.proto` files, each performing the identical simulated blocking I/O step
(`PricingCache.lookup` / `app.blocking_lookup.blocking_lookup`) — a
~200ms sleep standing in for a database round trip, a real blocking read of
a bundled cache file, then a second ~200ms sleep standing in for a slow,
network-attached store. `verify.sh` calls `FindOptimalRoute` on **both**
stacks via `grpcurl`, fires eight of those calls concurrently, and times the
batch — not just checks that each call eventually returns `OK`.

## The execution models this chapter compares

| Mode | Quarkus | Python |
|---|---|---|
| **Correct (default)** | `@Blocking` dispatches the call onto the Vert.x worker pool before the method body runs; the ~400ms lookup runs there. | `asyncio.to_thread` hands the lookup to the default thread-pool executor and awaits the result. |
| **Starving** | The same lookup runs directly on one fixed Vert.x event-loop context (`RoutingServiceImpl.onEventLoop`), occupying it for the full ~400ms. | The same lookup is called in-line inside the `async def` handler, with no `await` point until it returns — it runs on grpc.aio's one event-loop thread. |
| **Virtual thread (Quarkus only, illustrative)** | The lookup runs on a fresh virtual thread per call (`RoutingServiceImpl.onVirtualThread`), reproducing what `@RunOnVirtualThread` does automatically when it is a method's sole execution-model annotation. |  — |

A single request flag selects the mode on both stacks: `FindOptimalRouteRequest.origin.name`.
This field carries no routing meaning anywhere else in this example — matching
a route is done purely by `origin`/`destination` UN/LOCODEs — so this demo
repurposes it as an execution-mode selector rather than changing the frozen
contract:

| `origin.name` | Mode |
|---|---|
| unset / `""` (default) | Correct (offloaded) |
| `"starving"` | Starving (blocks the event loop / blocks the coroutine) |
| `"virtual"` | Virtual-thread (Quarkus only; Python treats any value other than `"starving"` as the default, offloaded path) |

See the chapter's "How the code works" section for why a single shared gRPC
method, rather than three separate methods, has to pick its execution model
at request time to demonstrate all three live.

## Run it

```bash
cd examples/15-backend-io-concurrency
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, then against **each** of
`localhost:9150` (Quarkus) and `localhost:9151` (Python):

1. Calls `FindOptimalRoute` once (default mode) and asserts the exact
   `route.id`/`route.price` fields — an `OK` status with a wrong-shaped or
   wrong-valued message fails this check, not just a transport error.
2. Fires 8 **concurrent** default-mode calls (`grpc_call ... &` in a loop,
   then `wait`), asserts every one of the 8 responses has the identical
   correct fields, and times the whole batch with `date +%s.%N`.
3. Asserts that batch finished in well under 2.5 seconds — a loose bound,
   chosen to sit comfortably below the ~3.2 seconds 8 serial 400ms calls
   would take, without pinning the assertion to a specific millisecond
   figure that would be flaky across machines.
4. Fires 8 concurrent **starving**-mode calls, times that batch the same
   way, and asserts `correct_total * 2 < starving_total` — a loose 2x
   margin, not an exact ratio, so the check stays robust to scheduler jitter
   while still catching a server that fails to tell the two models apart.

A bonus (non-required) check repeats step 2–3 for Quarkus's illustrative
`"virtual"` mode. Prints `PASS` only if every assertion holds for **both**
stacks.

To poke at it by hand instead:

```bash
docker compose up --build

# Correct model: offloaded, ~400ms.
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9150 shipping.routing.v1.RoutingService/FindOptimalRoute

# Starving model: same request, same ~400ms of work, but it runs on the
# shared event loop / blocks the one coroutine thread instead.
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC","name":"starving"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9150 shipping.routing.v1.RoutingService/FindOptimalRoute

docker compose down -v
```

Swap `9150` for `9151` to hit the Python stack instead (Python ignores
`"virtual"`, so only `""` and `"starving"` produce different behavior there).

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `FindOptimalRoute` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## The pricing cache

Both stacks read the identical bundled cache file (`quarkus/src/main/resources/pricing-cache.txt`,
`python/app/pricing_cache.txt`) — the same five routes as the Ch13
schema-design catalog, copied rather than shared (this example has no code
dependency on Ch13) so the expected values line up with a shape this book's
readers have already seen:

| `origin.un_locode` | `destination.un_locode` | `route.id` | carrier | `route.price` |
|---|---|---|---|---|
| USNYC | NLRTM | `rte_001` | MAERSK | `1200.00 USD` |
| USLAX | CNSHA | `rte_002` | MSC | `2400.00 USD` |
| DEHAM | SGSIN | `rte_003` | HMM | `1800.50 USD` |
| NLRTM | USNYC | `rte_004` | MAERSK | `1150.75 USD` |
| CNSHA | USLAX | `rte_005` | COSCO | `2600.25 USD` |

A pair with no exact match falls back to the cache's first row (`rte_001`) —
a simplification documented in both `PricingCache.lookup` and
`blocking_lookup`: this demo's subject is *where* the blocking work runs,
not route-matching logic. `verify.sh` only ever calls with the first pair.

## Why the Quarkus starving path pins one event-loop context

Vert.x's default event-loop pool size is 2x the host's CPU count. Left at
that default, 8 concurrent starving-mode calls would likely land on 8
*different* event loops on any machine with 4+ cores — each call would get
its own thread and nothing would starve, which would make this chapter's
central claim untestable on exactly the machines readers are most likely to
run it on. `RoutingServiceImpl` instead lazily captures ONE
`io.vertx.core.Context` on the first starving call
(`RoutingServiceImpl.starvingContext()`) and reuses it for every later one,
so every starving call shares the same underlying thread regardless of host
core count — without shrinking the whole application down to one event loop
(which would also delay every *other* call's response write, including the
correct-model and virtual-thread ones, as an earlier draft of this example
discovered the hard way: globally setting
`quarkus.vertx.event-loops-pool-size=1` left a backlog on that one shared
loop that measurably slowed down an *unrelated* batch of calls run
immediately afterward). Python needs no equivalent trick: `grpc.aio` already
runs every coroutine on a single asyncio event-loop thread by construction.

## The other seven RPCs

Only `FindOptimalRoute` has a real implementation; the rest return
`UNIMPLEMENTED`, same as every prior chapter — see `RoutingServiceImpl.java`
(each of `GetQuote`, `ListRoutes`, `NegotiateRoute`, `RecomputeRoutes`,
`GetOperation`, `WatchOperation`, `CancelOperation` is overridden explicitly)
and the generated `RoutingServiceServicer` base class's default behavior in
`app/routing_service.py` (none of the seven are overridden there — the base
class already returns `UNIMPLEMENTED` for anything a subclass skips).

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files — same
discipline as every prior anchor. Each `Containerfile` builds with the
**repo root** as its Docker build context (see `compose.yaml`) so it can
`COPY` the two proto files this service needs straight from
`contracts/proto/` at build time. For a local, non-container `mvn`/`uv` run,
copy the same two files by hand first:

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

Both copy destinations are gitignored (see `.gitignore`) — build-time-only,
never committed.

## On the wire

Server reflection is enabled on both stacks, so `grpcurl` needs no local
`.proto` copy:

```bash
grpcurl -plaintext localhost:9150 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService
```

`verify.sh` asserts, per stack:

| Check | Expected |
|---|---|
| single correct-model call | `route.id="rte_001"`, `route.price.currency="USD"`, `route.price.amount="1200.00"` |
| 8 concurrent correct-model calls | all 8 succeed with the identical fields above |
| 8 concurrent correct-model calls, elapsed | `< 2.5s` |
| 8 concurrent starving calls | all 8 succeed with the identical fields above |
| starve-vs-scale | `correct_total * 2 < starving_total` |
| (Quarkus bonus) 8 concurrent virtual-thread calls, elapsed | `< 2.5s` |

A real run's numbers (22-core dev host): correct-model batch ≈0.44s,
starving batch ≈3.24–3.26s (close to the 8×0.4s = 3.2s serial figure the
model predicts), virtual-thread batch ≈0.45s. These are illustrative, not
asserted exactly — only the loose bounds above are checked, so the test
stays robust on slower or more contended hardware.

## Diagrams

Three paired figures in `assets/diagrams/` (generated with
`scripts/generate_diagram.py`) back this chapter: `15-jvm-execution-models`
(event loop vs `@Blocking` worker pool vs `@RunOnVirtualThread`, and where
the starving path sits), `15-python-gil-concurrency` (`grpc.aio`'s event
loop with `asyncio.to_thread` offload vs the GIL's effect on I/O-bound vs
CPU-bound work, plus the free-threaded 3.14 caveat), and
`15-thread-exhaustion-overlap` (two timelines: the same 8 concurrent calls
serialized vs overlapped).
