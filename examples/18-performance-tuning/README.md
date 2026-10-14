# Ch18 — Performance tuning ANCHOR: channel reuse, keepalive, max-message-size, gzip

The reference both-stack implementation of `shipping.routing.v1.RoutingService.{GetQuote,ListRoutes}`,
tuned for the four levers the chapter covers, plus a `ghz` load-test sanity
check. `GetQuote` (the Ch7 fast-unary formula, unchanged) is the "small
message" half of this chapter's story; `ListRoutes` returns a fixed,
deterministic 25-route catalog padded well past gRPC's 4MB default
max-message-size — the "large message" half. The contract is unchanged from
every prior chapter:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs (`GetQuote` and `ListRoutes` are implemented here; the
  rest return `UNIMPLEMENTED`, same discipline as every prior example).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Route`,
  `Leg`, `Location`, `Money` messages both RPCs use.

Quarkus (`quarkus/`, host port **9180**) and Python (`python/`, host port
**9181**) independently implement both RPCs, generated from the **same**
`.proto` files, tuned with the same four levers:

| Lever | Quarkus (`application.properties`) | Python (`grpc.aio.server` options) |
|---|---|---|
| Max message size | `quarkus.grpc.server.max-inbound-message-size=16777216` | `grpc.max_receive_message_length` / `grpc.max_send_message_length` = `16777216` |
| Keepalive (server pings) | `quarkus.grpc.server.netty.keep-alive-time=5s` | `grpc.keepalive_time_ms=5000` |
| Keepalive (ping floor) | `quarkus.grpc.server.netty.permit-keep-alive-time=5s` | `grpc.http2.min_ping_interval_without_data_ms=5000` |
| Keepalive (idle pings) | `quarkus.grpc.server.netty.permit-keep-alive-without-calls=true` | `grpc.keepalive_permit_without_calls=1` |
| Compression | `quarkus.grpc.server.compression=gzip` | `compression=grpc.Compression.Gzip` |

The 5s keepalive window is a demo-only shortcut (a production value is
typically tens of seconds to a few minutes) so `keepalive_client.py`'s idle
gap fits inside a `verify.sh` run.

## Run it

```bash
cd examples/18-performance-tuning
./verify.sh
```

This brings both services up with `docker compose`, verifies correctness on
both stacks via `grpcurl`, runs four bundled Python demo clients against
each stack's in-network address, runs `ghz` against `GetQuote` on each
stack, and tears the stack down again. Prints `PASS` only if every assertion
holds for **both** stacks. A real run on this book's dev box:

```
lib.sh: info — quarkus: footgun_total=0.499890s pooled_total=0.206003s
lib.sh: ok — quarkus channel-per-call (50 calls) vs one reused channel: 0.499890s > 0.206003s * 1.8
lib.sh: ok — quarkus full catalog, default 4MB cap: got expected code RESOURCE_EXHAUSTED (grpcurl: ResourceExhausted)
lib.sh: ok — quarkus full catalog, raised 8388608-byte cap, route count: '25'
lib.sh: ok — quarkus gzip-enabled call matches the uncompressed call: 'MATCH'
lib.sh: ok — quarkus keepalive survives idle gap: 'SURVIVED'
lib.sh: info — quarkus ghz: errors=0 rps=910.32 p99=0.0194s
```

To poke at it by hand instead:

```bash
docker compose up --build

# GetQuote (fast unary, unchanged from Ch7)
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC", "name": "New York"},
  "destination": {"unLocode": "NLRTM", "name": "Rotterdam"},
  "cargo": [{"weightKg": 1200.5, "description": "Palletized electronics", "cargoType": "GENERAL"}]
}' localhost:9180 shipping.routing.v1.RoutingService/GetQuote

# ListRoutes' small default page (well under 4MB)
grpcurl -plaintext -d '{}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes

# ListRoutes' full 25-route catalog (~5MB) — fails at the default 4MB cap
grpcurl -plaintext -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
# ERROR: Code: ResourceExhausted, Message: grpc: received message after
# decompression larger than max 4194304

# ...and succeeds once the CLIENT raises its own receive cap
grpcurl -plaintext -max-msg-sz 8388608 -d '{"pageSize":25}' \
  localhost:9180 shipping.routing.v1.RoutingService/ListRoutes

# Channel reuse: the #1 footgun, side by side, against either stack's
# in-network address (container port 9000, not the host-mapped 9180/9181 —
# this runs *inside* the compose network):
docker compose run --rm --entrypoint python python -m app.footgun_client quarkus:9000 50
docker compose run --rm --entrypoint python python -m app.pooled_client quarkus:9000 50

# gzip: functional identity with and without per-call compression requested
docker compose run --rm --entrypoint python python -m app.gzip_client quarkus:9000 25

# keepalive: one channel survives an idle gap
docker compose run --rm --entrypoint python python -m app.keepalive_client quarkus:9000 8

# ghz: a real load-test run against GetQuote, fed the proto directly
# (no reflection support in ghz)
docker compose run --rm ghz --insecure \
  --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \
  --call shipping.routing.v1.RoutingService.GetQuote \
  -d '{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}' \
  -c 10 -n 300 -O json quarkus:9000

docker compose down -v
```

Swap `9180`/`quarkus` for `9181`/`python` to hit the Python stack instead —
identical inputs, identical outputs, identical numbers on both sides of the
4MB/8MB cap.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve either RPC fine without a collector; export
failures are async and never block a response):

```bash
docker compose --profile observability up --build
```

## The catalog

`GetQuote` is unchanged from Ch7: `quote.amount = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)`,
rendered as a decimal string, with `route.id = "rte_" + origin.un_locode + "-" + destination.un_locode`
and a single `MAERSK` leg.

`ListRoutes` builds a fixed, 25-route catalog (`RouteCatalog.java` /
`app/catalog.py`) from five origin/destination pairs and five carriers,
cycled. The only field inflated to manufacture size is `Leg.carrier` — the
one free-text field `Route`/`Leg` expose in the frozen contract (there is no
spare "description" field on either message) — padded to 100,000 filler
characters past a short, readable prefix:

| Route | `id` | carrier prefix | origin -> destination | `price` |
|---|---|---|---|---|
| 1 | `rte_001` | `MAERSK-001-1-XXX…` | USNYC -> NLRTM | `1001.00 USD` |
| 2 | `rte_002` | `MSC-002-1-XXX…` | USLAX -> CNSHA | `1002.00 USD` |
| … | … | … | … | … |
| 25 | `rte_025` | `CMA CGM-025-1-XXX…` | USLAX -> CNSHA | `1025.00 USD` |

Each route carries 2 legs, so 25 routes x 2 legs x (~15-byte prefix +
100,000-byte pad) totals **~5.0MB** of carrier payload alone — comfortably
past the 4MB default and comfortably under an 8MB raised one. `page_size`
clamps to this catalog's bounds exactly like Ch13's: `<= 0` defaults to 3
(the small page this chapter's correctness check uses), `> 25` clamps down
to 25 (the whole catalog, in one response). `field_mask` is accepted (the
proto requires the field) but **not applied** — that projection lever is
Chapter 13's; re-implementing it here would duplicate it without adding a
new teaching point, since this chapter's subject is wire size and channel
lifecycle, not field-level shaping.

## Channel reuse: `footgun_client.py` vs `pooled_client.py`

Both scripts run from the already-built Python image (`docker compose run
--rm --entrypoint python python -m app.<name> <target> <calls>`), call
`GetQuote` the same number of times against the same target, and print
exactly one number to stdout: total wall-clock seconds for every call
(diagnostics go to stderr):

```python
# footgun_client.py — THE MISTAKE
for i in range(calls):
    channel = grpc.aio.insecure_channel(target)        # new EVERY iteration
    stub = routing_pb2_grpc.RoutingServiceStub(channel)
    response = await stub.GetQuote(_REQUEST)
    await channel.close()

# pooled_client.py — THE FIX
channel = grpc.aio.insecure_channel(target)             # built ONCE
stub = routing_pb2_grpc.RoutingServiceStub(channel)      # built ONCE
for i in range(calls):
    response = await stub.GetQuote(_REQUEST)             # same stub, every time
```

`verify.sh` runs both against **both** stacks' in-network address
(`quarkus:9000`, `python:9000`) and asserts `footgun_total > pooled_total * 1.8`
— a loose, relative gate (real runs on this book's dev box land ~2.4-4x),
never a tight absolute number, because the exact ratio depends on the host's
TCP/HTTP2 connection-setup cost, which varies by machine and by network.

## Max-message-size: client AND server both have to raise it

Message size is enforced on whichever side is about to go over a cap that
side itself configured — the sender for its SEND cap, the receiver for its
RECEIVE cap. `ListRoutes`' ~5MB catalog is comfortably under both stacks'
raised 16MB SEND limit, so the server always finishes building and sending
it; the failure, when it happens, is the RECEIVING client's own 4MB default:

- `grpcurl` with no `-max-msg-sz` flag enforces gRPC's cross-language 4MB
  default receive cap — `ResourceExhausted`, `"larger than max"`.
- `grpcurl -max-msg-sz 8388608` raises that cap to 8MB — success, 25 routes.
- `gzip_client.py` (a native Python stub, not `grpcurl`) hits the identical
  4MB default on `grpc.aio.insecure_channel` until its own channel is built
  with `options=[("grpc.max_receive_message_length", 16 * 1024 * 1024)]` —
  the native-stub equivalent of grpcurl's `-max-msg-sz` flag.

`verify.sh` asserts both outcomes against both servers: `RESOURCE_EXHAUSTED`
at the default cap, success with the correct 25-route count and the correct
last route ID (`rte_025`) at the raised one.

## gzip: a functional gate, not a size assertion

Both servers are configured with `compression=gzip` (server-wide — every
response gets compressed, not just `ListRoutes`'), so compression is already
in effect before `gzip_client.py` ever runs; the script's job is to prove
decompression is lossless, not to produce it. It calls `ListRoutes` for the
full catalog twice — once with the request's compression left at its
default, once with `compression=grpc.Compression.Gzip` explicitly set on
the call — and asserts the two decoded responses are identical:

```python
plain = await stub.ListRoutes(request)
gzipped = await stub.ListRoutes(request, compression=grpc.Compression.Gzip)
assert plain == gzipped   # same 25 routes, same every field — compression changes wire bytes, never content
```

`verify.sh` asserts the script's own final output is the literal string
`MATCH`. The wire-size reduction gzip buys on this padded, highly
repetitive catalog is real and substantial — see the chapter's "On the
wire" box — but it's illustrative there, not gated here, because grpc's
high-level Python API doesn't expose compressed frame size for a script to
assert against.

## Keepalive: one channel across an idle gap

`keepalive_client.py` builds one channel (with the same `keepalive_time_ms`/
`keepalive_timeout_ms`/`keepalive_permit_without_calls` options the servers
use), calls `GetQuote` once, sleeps 8 seconds — past the 5-second keepalive
window configured on both ends — making zero calls during the gap, then
calls `GetQuote` again on the **same** channel and stub. Both calls must
return identical field values.

This compose network has no NAT, load balancer, or other intermediary whose
own idle-connection timeout keepalive exists to defeat, so this script
doesn't reproduce a connection actually being dropped and recovered — it
proves the opposite risk, that turning keepalive on with a short interval
doesn't itself break a channel across an idle period. In production,
keepalive's payoff is exactly the silent drop this local network can't
exhibit.

## ghz: a real load-test run, loose bounds only

`ghz` (pinned at `ghcr.io/bojand/ghz:0.121.0` — **not** published to
`docker.io`, only to `ghcr.io`; re-check with `skopeo list-tags
docker://ghcr.io/bojand/ghz` before bumping, like the UBI/grpcurl pins used
elsewhere in this book) runs as a one-shot `docker compose run` service on
this example's own compose network, fed the proto directly:

```bash
docker compose run --rm ghz --insecure \
  --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \
  --call shipping.routing.v1.RoutingService.GetQuote \
  -d '{...}' -c 10 -n 300 -O json quarkus:9000
```

`ghz` has no server-reflection support (unlike `grpcurl`), so
`contracts/proto/` is mounted read-only into the container and passed via
`--proto`/`--import-paths` — the one place in this example a client needs
the `.proto` file on disk rather than discovering the service at runtime.
`verify.sh` parses the JSON output with `python3 -I` and asserts only LOOSE,
RELATIVE bounds: zero errors, p99 latency under a generous 1.5s ceiling, and
throughput over a low 20 requests/second floor — real runs on this book's
dev box land at p99 ~10-20ms and 800-1800 requests/second, so the bounds
have enormous headroom for a slower CI runner. `contracts.yml`'s existing
3-attempt verify retry absorbs ordinary load-test variance; no CI
configuration changed for this chapter.

## The other three RPCs

Only `GetQuote` and `ListRoutes` have real implementations; the rest return
`UNIMPLEMENTED`, same as every prior chapter — see `RoutingServiceImpl.java`
/ the generated `RoutingServiceServicer` base class's default behavior in
`app/routing_service.py`.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files — same
discipline as every prior anchor. Each `Containerfile` builds with the
**repo root** as its Docker build context (see `compose.yaml`) so it can
`COPY` the two proto files this service needs straight from
`contracts/proto/` at build time. See Ch7's README for the full local,
non-container `mvn`/`uv` copy instructions; the destinations are identical
here, just under `examples/18-performance-tuning/`.

## On the wire

```bash
grpcurl -plaintext -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
```

```
ERROR:
  Code: ResourceExhausted
  Message: grpc: received message after decompression larger than max 4194304
```

```bash
grpcurl -plaintext -max-msg-sz 8388608 -d '{"pageSize":25}' \
  localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
```

Succeeds: 25 routes, `routes[0].id = "rte_001"`, `routes[24].id = "rte_025"`.
`grpcurl`'s own JSON output renders every field by its **proto name**
(`next_page_token`, not `nextPageToken`) regardless of how the request body
spelled its keys — the same rendering asymmetry Ch13's README documents, not
a protocol difference.

ghz summary from a real run (`quarkus:9000`, `-c 10 -n 300`):

```
Count:        300
RPS:          910.32
Average:      ~11ms
Fastest:      ~3ms
Slowest:      ~22ms
p99 Latency:  19.43ms
Error count:  0
```

Wire-size note (illustrative — not asserted by `verify.sh`): the 25-route
catalog's highly repetitive padding compresses extremely well under gzip,
easily into the double-digit percent of its uncompressed size; a `GetQuote`
response, a few dozen bytes of mostly-already-dense protobuf varints and a
short decimal string, has essentially nothing left for gzip to remove and
pays the (tiny, but nonzero) CPU cost of attempting it regardless. See the
chapter's "Decision" callout for when to make that trade.

## Diagrams

Three paired figures in `assets/diagrams/` (generated with
`scripts/generate_diagram.py`) back this chapter: `18-channel-reuse-before-after`
(channel-per-call's handshake tax vs. one reused channel), `18-performance-levers`
(the four knobs this example tunes, as a labelled panel with each trade-off),
and `18-compression-size-tradeoff` (gzip's wire-size win for `ListRoutes`'
padded payload vs. its near-wash cost for `GetQuote`'s few dozen bytes).
