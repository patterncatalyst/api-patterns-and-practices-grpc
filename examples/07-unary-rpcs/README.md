# Ch7 — Unary RPCs and the generated code

`shipping.routing.v1.RoutingService.GetQuote` again — the same formula Ch5
shipped — but this chapter's example is about the **client** side, not the
server side: a channel is the expensive, long-lived HTTP/2 connection; a
stub is a cheap typed view over it; and the #1 gRPC performance footgun is
building a new channel for every call instead of reusing one.

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs (only `GetQuote` is implemented here; the rest return
  `UNIMPLEMENTED`, same as Ch5).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages.

Quarkus (`quarkus/`, host port **9070**) and Python (`python/`, host port
**9071**) independently implement the identical RPC. `python/app/reuse_client.py`
is the teaching artifact: it builds **one** `grpc.aio` channel and **one**
stub from it, then calls `GetQuote` on that same stub repeatedly — proving
the channel is reused, not recreated per call. `verify.sh` runs it against
**both** stacks' in-network address.

## Run it

```bash
cd examples/07-unary-rpcs
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, calls `GetQuote` against
`localhost:9070` (Quarkus) and `localhost:9071` (Python) via `grpcurl`,
asserts response field semantics, then runs `reuse_client.py` against each
service's in-network address (`quarkus:9000`, `python:9000`) to prove
channel/stub reuse, and tears the stack down again. Prints `PASS` only if
every assertion holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build
grpcurl -plaintext localhost:9070 list                      # reflection: list services
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC", "name": "New York"},
  "destination": {"unLocode": "NLRTM", "name": "Rotterdam"},
  "cargo": [{"weightKg": 1200.5, "description": "Palletized electronics", "cargoType": "GENERAL"}]
}' localhost:9070 shipping.routing.v1.RoutingService/GetQuote

# Run the reuse demo from the already-built python image, against either
# stack's in-network address (container port 9000, not the host-mapped
# 9070/9071 ports — this runs *inside* the compose network):
docker compose run --rm --entrypoint python python -m app.reuse_client quarkus:9000 3 3001.25
docker compose run --rm --entrypoint python python -m app.reuse_client python:9000 3 3001.25

docker compose down -v
```

Swap `9070` for `9071` to hit the Python stack instead — same request, same
response shape, same numbers.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `GetQuote` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## The quote formula (unchanged from Ch5)

```
quote.currency = "USD"
quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
route.id       = "rte_" + origin.un_locode + "-" + destination.un_locode
route.legs     = [ { carrier: "MAERSK", origin, destination } ]  # departs_at/arrives_at unset
route.price    = quote
```

`amount` is always a **decimal string** (e.g. `"3001.25"`), per
`shipping.type.v1.Money` — never a binary float. Both implementations round
the same explicit way: Java via `BigDecimal.setScale(2, RoundingMode.HALF_UP)`,
Python via `Decimal(...).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)`.

## The reuse demo: one channel, repeated calls

`python/app/reuse_client.py` is a standalone script that runs from the
Python service's own built image (no second image to build):

```python
channel = grpc.aio.insecure_channel(target)              # built ONCE
stub = routing_pb2_grpc.RoutingServiceStub(channel)       # built ONCE
for i in range(calls):
    response = await stub.GetQuote(_REQUEST)              # same stub, every time
```

It prints `id(channel)` and `id(stub)` once up front, then one line per
call — all against the same two objects — and fails loudly (non-zero exit)
if any response disagrees with the others or with an expected amount passed
on the command line. `verify.sh` runs it with 3 calls against **both**
`quarkus:9000` and `python:9000`, because the point generalizes across
stacks: whichever language is on the client side of this seam, the channel
is the thing you build once and hold onto.

## The other four RPCs

Same as Ch5 — only `GetQuote` has a real implementation:

| RPC | Status in this chapter |
|---|---|
| `GetQuote` | implemented |
| `FindOptimalRoute` | `UNIMPLEMENTED` — later chapter |
| `ListRoutes` | `UNIMPLEMENTED` — later chapter |
| `NegotiateRoute` (bidi stream) | `UNIMPLEMENTED` — Part 3 streaming |
| `RecomputeRoutes` (async) | `UNIMPLEMENTED` — Part 6 async |

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files — same setup
as Ch5. Each `Containerfile` builds with the **repo root** as its Docker
build context (see `compose.yaml`) so it can `COPY` the two proto files this
service needs straight from `contracts/proto/` at build time. See Ch5's
README for the full local (non-container) `mvn`/`uv` copy instructions; the
destinations are identical here, just under `examples/07-unary-rpcs/`.

One Containerfile difference from Ch5: the Quarkus build's `mvn` line adds
`-Daether.syncContext.named.time=300 -Daether.syncContext.named.time.unit=SECONDS
-Dmaven.wagon.http.retryHandler.count=3 -Daether.connector.http.retryHandler.count=3`
— a slow-network CI mitigation that widens Maven's resolver lock-wait window
and retries transient dependency downloads. It has no effect on a fast,
already-warm local Maven cache.

## On the wire

Server reflection is enabled on both stacks, so `grpcurl` needs no local
`.proto` copy:

```bash
grpcurl -plaintext localhost:9070 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext localhost:9070 describe shipping.routing.v1.RoutingService
```

`verify.sh` asserts these exact fields from the request above, against
**both** ports, and then runs the reuse demo against both in-network
addresses:

| Field | Expected |
|---|---|
| `quote.currency` | `"USD"` |
| `quote.amount` | `"3001.25"` |
| `route.id` | `"rte_USNYC-NLRTM"` |
| `route.legs[0].carrier` | `"MAERSK"` |

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show both stacks' `GetQuote` path on their
own ports, `reuse_client.py` calling each in-network, and the opt-in
`otel-lgtm` sink.
