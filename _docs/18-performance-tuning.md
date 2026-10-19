---
title: "Performance tuning"
order: 18
part: "Streaming at Scale & Performance"
description: "Channel and stub reuse revisited, keepalive, max-message-size, gzip compression, connection pooling, and benchmarking with ghz."
duration: "28 min read"
---

## Learning objectives

By the end of this chapter you can:

- Measure the cost of channel-per-call versus one reused channel/stub, and explain why gRPC "pooling" means one multiplexed channel, not a literal connection pool.
- Configure keepalive's three knobs (ping interval, permitted-ping floor, idle-ping toggle) and know what each one guards against.
- Reason about max-message-size caps, recognizing that the sender and the receiver each enforce their own independently-configured limit.
- Decide when gzip compression is a wire-size win (`ListRoutes`) versus a CPU cost for no benefit (`GetQuote`).
- Run and interpret a `ghz` load-test benchmark (RPS, error rate, p99 latency) against a live gRPC service.

## Why this matters

Chapter 7 mentioned the #1 gRPC performance mistake in passing — build a channel once, reuse it forever — and moved on to the generated stub-to-stub path it was really about. This chapter comes back to collect on that promise, and brings three more levers with it. `RoutingService.GetQuote`, the same fast unary call Chapter 7 served, and `RoutingService.ListRoutes`, Chapter 13's paginated catalog, are the same two RPCs this chapter's example reuses — no new RPC, no contract change, because performance tuning is almost never a schema problem. It's a question of how a client holds its connection, how big a message either side will tolerate, whether the bytes on the wire are compressed, and how a server reacts when an idle connection goes quiet. Get all four right and the two RPCs this chapter already had on hand are all it takes to show the difference.

The code is in `examples/18-performance-tuning/`. The run script there (`verify.sh`) builds and starts both stacks, runs four bundled Python demo clients against each one, drives a real `ghz` load-test run, and asserts every claim this chapter makes; its `README.md` covers what it does and how to drive it by hand.

{% include excalidraw.html file="18-channel-reuse-before-after" alt="Two side-by-side panels. The left panel, labeled Channel-per-call (the footgun), shows a client making three separate calls, each one opening a new channel that pays a full connect-plus-handshake cost before GetQuote runs and the channel closes, annotated 3 calls -> 3 handshakes. The right panel, labeled One reused channel (the fix), shows the same client building one channel with its handshake paid once, then multiplexing N GetQuote calls over that same connection, annotated N calls -> 1 handshake." caption="Figure 18.1 — Channel-per-call pays a connection handshake on every call; one reused channel pays it once and multiplexes every call after that." %}

## Channel reuse: the #1 performance footgun, measured

A gRPC channel is not a lightweight handle — it is a real HTTP/2 connection: a TCP handshake, then an HTTP/2 connection preface and SETTINGS exchange, before the first byte of an actual RPC can go anywhere. A stub built from that channel is cheap, a thin typed wrapper that does no I/O of its own. Chapter 7's `reuse_client.py` built one channel and one stub outside a loop and called `GetQuote` on them repeatedly; this chapter's `footgun_client.py` and `pooled_client.py` make the cost of *not* doing that directly measurable, side by side, against the same server:

```python
# footgun_client.py — a NEW channel, and a new stub from it, every iteration
for i in range(calls):
    channel = grpc.aio.insecure_channel(target)
    stub = routing_pb2_grpc.RoutingServiceStub(channel)
    response = await stub.GetQuote(_REQUEST)
    await channel.close()

# pooled_client.py — ONE channel, ONE stub, built once, outside the loop
channel = grpc.aio.insecure_channel(target)
stub = routing_pb2_grpc.RoutingServiceStub(channel)
for i in range(calls):
    response = await stub.GetQuote(_REQUEST)
```

Both scripts call `GetQuote` the same number of times against the same target and print one number: total wall-clock seconds. `verify.sh` runs both against each stack's in-network address and asserts `footgun_total > pooled_total * 1.8` — a loose, relative gate, not a tight absolute number, because the exact ratio is a function of how cheap a TCP connect and an HTTP/2 handshake are on whatever host runs the test. Real runs on this book's dev box, 50 calls each, landed `footgun_total=0.50s` against `pooled_total=0.21s` for Quarkus (2.4x) and `footgun_total=0.27s` against `pooled_total=0.06s` for Python (4.1x) — both comfortably over the 1.8x floor, both nowhere near a number worth hardcoding, because a slower or faster machine changes both sides of the ratio together.

"Pooling," in the sense connection-pool libraries use the word for a database driver, is a slight misnomer for gRPC: a single channel already multiplexes an arbitrary number of concurrent RPCs over one HTTP/2 connection, using HTTP/2's own stream multiplexing, so there is rarely a reason to hold a literal pool of channels to one target the way you would hold a pool of database connections. `pooled_client.py` holds exactly one channel for its entire run and that is enough — the "pool," here, is one channel wide, and the lesson generalizes past this specific script: whatever language sits on the client side of a gRPC call, build the channel once, at startup or on first use, and hand the same one to every call site that needs it. The only case that calls for more than one channel to the same target is sustained concurrency so high that a single HTTP/2 connection's own flow-control window becomes the bottleneck — a real but much rarer condition than the channel-per-call mistake this section measures, and one Quarkus exposes a dial for directly: `quarkus.grpc.clients.<name>.flow-control-window`, documented in the gRPC reference guide, raises a client channel's HTTP/2 window past its 1MB default specifically for this case.

## Keepalive: pinging a connection nobody is using

A channel that sits idle between bursts of calls is exactly the kind of connection an intermediary — a load balancer, a NAT device, a firewall with an idle-connection timeout — is most likely to silently drop without telling either endpoint. Keepalive is gRPC's answer: configure one side (usually both) to send an HTTP/2 `PING` frame on an otherwise-quiet connection, often enough that a dropped connection gets noticed and torn down cleanly instead of surfacing as a mysterious hang on the next real call. Three settings make up the full picture, and they exist on both stacks under different names for the same HTTP/2-level concept:

| Concept | Quarkus (`application.properties`) | Python (`grpc.aio.server` options) |
|---|---|---|
| How often THIS side pings an idle peer | `quarkus.grpc.server.netty.keep-alive-time` | `grpc.keepalive_time_ms` |
| The floor on how often a PEER may ping THIS side | `quarkus.grpc.server.netty.permit-keep-alive-time` | `grpc.http2.min_ping_interval_without_data_ms` |
| Whether pings are allowed with zero active RPCs | `quarkus.grpc.server.netty.permit-keep-alive-without-calls` | `grpc.keepalive_permit_without_calls` |

The middle row is not how often *you* ping — it's the minimum interval you'll *tolerate* a client pinging *you* — a floor, not a target. A client that pings more aggressively than this floor allows is, in gRPC's own framing, abusive: it is spending server resources acknowledging pings instead of serving calls, and both grpc-java (via `permitKeepAliveTime`) and grpc-core (via `grpc.http2.min_ping_interval_without_data_ms`) will tear the connection down with a `GOAWAY` rather than keep humoring it. Getting this floor wrong in the conservative direction — too strict — breaks well-behaved clients whose own keepalive interval happens to be shorter than your floor; too permissive, and a misconfigured or malicious client can turn keepalive into a trickle of wasted round trips. This example sets all three identically on both stacks: a 5-second `keep-alive-time`/`keepalive_time_ms` and matching 5-second floor, values chosen purely so `keepalive_client.py`'s idle gap fits inside a `verify.sh` run — a production value is typically tens of seconds to a few minutes, since pinging every 5 seconds forever is its own small, constant tax on an otherwise-quiet connection.

`keepalive_client.py` builds one channel, calls `GetQuote`, sleeps 8 seconds — longer than the 5-second window configured on both ends — making zero calls during the gap, then calls `GetQuote` again on that same channel. Both calls return identical values, which is the whole assertion: the configured keepalive didn't need a second, fresh channel to survive an idle period. This book's compose network has no NAT, load balancer, or other intermediary whose idle-connection timeout keepalive exists to defeat, so this test proves the less dramatic but still real half of the story — that turning keepalive on, with an aggressively short interval, doesn't itself break a channel that's merely idle rather than actually abandoned. In production, keepalive's payoff is detecting exactly the silent drop this local network structurally can't exhibit.

## Max-message-size: two caps, and whoever is about to exceed theirs enforces it

Every gRPC implementation ships a default cap on how large a single message it will **receive** — 4MB, consistently, across grpc-go (and therefore `grpcurl` and `ghz`), grpc-core (and therefore this book's Python stack), and grpc-java's separate-server mode (and therefore Quarkus, with `quarkus.grpc.server.use-separate-server` left at its default `true`). `ListRoutes`' full 25-route catalog in this chapter's example is built to land well past that line: each route carries two legs, each leg's `carrier` field padded to 100,000 filler characters past a short, readable prefix — the only free-text field `Route`/`Leg` expose in this book's frozen contract, since there is no spare "description" field on either message to pad instead. Twenty-five routes, two legs each, at just over 100,000 bytes per leg's `carrier` field, totals roughly 5.0MB of carrier payload alone: comfortably past the 4MB default, comfortably under an 8MB raised one, by design, so the same call reliably demonstrates both sides of the cap on every run.

The cap that actually fires is whichever side is about to go over a limit *it itself* configured — the sender checks its own send cap before transmitting, and the receiver checks its own receive cap as bytes arrive. This chapter's servers raise their **send** cap to 16MB on both stacks (`quarkus.grpc.server.max-inbound-message-size=16777216` — the same property also governs what Quarkus's separate-server mode will *receive*, so one setting covers both directions there; `grpc.max_receive_message_length` and `grpc.max_send_message_length` separately on the Python side), so the server always finishes building and sending the ~5MB catalog without ever hitting its own limit. The failure, when it happens, is the **receiving client's** default 4MB cap:

```bash
grpcurl -plaintext -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
# ERROR: Code: ResourceExhausted
# Message: grpc: received message after decompression larger than max 4194304

grpcurl -plaintext -max-msg-sz 8388608 -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
# succeeds: 25 routes, routes[0].id="rte_001", routes[24].id="rte_025"
```

`grpcurl`'s `-max-msg-sz` flag raises exactly this client-side receive cap; there is no equivalent server-side change to make, because the server was never the side rejecting anything. A native Python stub hits the identical wall under the identical conditions — `gzip_client.py` fetches the same 25-route page from inside this chapter's own container network, and its channel has to be built with `options=[("grpc.max_receive_message_length", 16 * 1024 * 1024)]` before that call succeeds, the exact native-stub counterpart of `grpcurl`'s flag. The lesson generalizes past this chapter's specific numbers: raising a server's inbound cap protects it from rejecting a legitimately large *request*, but it does nothing for a client about to reject a large *response* — that cap lives on the client, and whoever controls the client code is the one who has to raise it.

## Compression: a real win for one of this chapter's two RPCs, a wash for the other

{% include excalidraw.html file="18-compression-size-tradeoff" alt="Two side-by-side panels comparing gzip compression on two different payloads. The left panel, labeled ListRoutes at about 5 megabytes highly repetitive, shows a wide bar labeled Uncompressed at about 5.0 megabytes on the wire shrinking via a compress arrow into a much narrower bar labeled Gzip far smaller, captioned Win: big size cut, CPU cost easily amortized. The right panel, labeled GetQuote at about 40 bytes, shows a tiny bar labeled Uncompressed at about 40 bytes staying almost the same width after a dashed compress arrow into a bar labeled Gzip no real win, captioned Wash: overhead about equals savings, CPU spent for nothing." caption="Figure 18.2 — gzip compression wins decisively on ListRoutes' large, repetitive payload and barely breaks even on GetQuote's few dozen bytes." %}

Gzip compression trades CPU time for wire bytes, and that trade is only worth making when there are enough wire bytes, and enough redundancy in them, to be worth spending CPU on. `ListRoutes`' catalog is both: large, and — because its padding is a repeated character rather than high-entropy data — about as compressible as a payload gets. `GetQuote`'s response is a currency code, a decimal string, and a route id: a few dozen bytes that are already about as dense as protobuf's own varint encoding makes them, with essentially nothing left for gzip to find. Compressing it anyway costs a small, fixed amount of CPU for a compression ratio close to zero — not a correctness problem, just money spent for nothing.

Both servers in this example are configured with `compression=gzip` (`quarkus.grpc.server.compression=gzip`; `grpc.aio.server(..., compression=grpc.Compression.Gzip)` on Python) — server-wide, applied to every response either RPC sends, because `ListRoutes` is this example's dominant payload and the chapter would rather show the win than gate it behind per-call logic that doesn't exist in either stack's public configuration surface today. A service split between a GetQuote-shaped workload and a ListRoutes-shaped one would want that per-call control — Quarkus and grpc-core both expose compression at the level of an individual server call via lower-level interceptor APIs, not exercised in this example so the configuration surface this chapter asserts against stays limited to what each stack's documented server config already supports.

Because compression changes wire bytes and never message content, `gzip_client.py`'s job is a functional check, not a size measurement: it calls `ListRoutes` for the full catalog twice, once with the request's own compression left at its default and once with `compression=grpc.Compression.Gzip` explicitly set on the call, and asserts the two decoded responses are identical field for field. `verify.sh` asserts the script prints `MATCH`. The wire-size reduction gzip buys on this catalog is real and substantial — see "On the wire" below — but it's illustrative there, not gated in `verify.sh`, because grpc's high-level Python API has no call to ask "how many bytes did that cost on the wire," only "what came back."

{% include excalidraw.html file="18-performance-levers" alt="A labelled panel of four boxes under the heading RoutingService tuning knobs. The first box, Keepalive, reads Idle connection stays alive, cost periodic ping traffic. The second, Max message size, reads Large payloads allowed through, cost raise both ends. The third, Gzip compression, reads Smaller payload on the wire, cost CPU per call. The fourth, Channel pooling, reads Reuse never reconnect, cost none, always do this." caption="Figure 18.3 — The four levers this chapter tunes, and what each one costs to turn on." %}

## How the code works

`GetQuote` is byte-for-byte the formula Chapter 7 shipped — `quote.amount = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)`, a single `MAERSK` leg, a route id built from the two UN/LOCODEs — unchanged here because this chapter's point about it is entirely about the client side of the call, not its handler. `ListRoutes` is the new logic, and it exists for one reason: to manufacture a response whose size is deterministic and reliably on the correct side of both the 4MB and 8MB thresholds, every run, on both stacks.

**The catalog: fixed data, not randomness, because the byte count has to be exact.** `RouteCatalog.java`'s `buildCatalog()` and `app/catalog.py`'s `_build_catalog()` both loop `i` from 1 to 25, picking an origin/destination pair and a carrier name from two five-element lists cycled by `(i - 1) % 5`, and building a `Route` with two `Leg`s:

```python
def _padded_carrier(carrier_name: str, route_idx: int, leg_idx: int) -> str:
    prefix = f"{carrier_name}-{route_idx:03d}-{leg_idx}-"
    return prefix + ("X" * PAD_LEN)
```

`PAD_LEN` is 100,000. The prefix exists so a reader (or a `grpcurl` call) can see which route and leg a given `carrier` string came from without decoding anything — `MAERSK-001-1-XXX…` is route 1, leg 1 — while the `X` repetition is what manufactures size deterministically: the same 25 routes, in the same order, with the same exact byte count, on every run, on both stacks. This is a simplification, not realistic data: a production catalog gets to this size from real content (more legs, carrier metadata, timestamps), never from a block of repeated characters, and `Leg.carrier`'s odd shape here exists only to make a byte count land exactly where this chapter needs it. `field_mask` is accepted on the request (the proto requires the field to exist) but never applied: Chapter 13 already owns field-mask projection in depth, and re-implementing it against this catalog would duplicate that chapter's lever without teaching anything new, since this chapter's subject is wire size and channel lifecycle, not which fields come back populated.

**Pagination is Chapter 13's mechanics, reused, with different default and maximum constants.** `page_size <= 0` falls back to a default of 3 — small enough that the correctness assertion's "normal page" call never comes close to either size threshold. `page_size` above `MAX_PAGE_SIZE` (25, the whole catalog) clamps down to it rather than erroring, so a caller who asks for "all of it" with any sufficiently large number gets exactly the 25-route catalog this chapter's size story depends on. `page_token` resolves to a start offset exactly the way Chapter 13's did — a raw list index in this demo, opaque to any well-behaved client, with the same caveat that a real catalog backed by a changing datastore needs a stable cursor instead of an offset, for the reasons Chapter 13's "Pagination with page tokens" section lays out in full.

**The server wiring: five tuning options and a compression flag, in one place.** Quarkus's four levers are plain `application.properties` keys, verified against the quarkus-grpc 3.40.1 config model rather than assumed from memory (`quarkus.grpc.server.max-inbound-message-size`'s own javadoc spells out the 4MB-separate-server-mode-default this chapter's numbers depend on). Python's equivalent lives in one `options` list passed to `grpc.aio.server()`:

```python
server = grpc.aio.server(
    options=[
        ("grpc.max_receive_message_length", MAX_MESSAGE_BYTES),
        ("grpc.max_send_message_length", MAX_MESSAGE_BYTES),
        ("grpc.keepalive_time_ms", KEEPALIVE_TIME_MS),
        ("grpc.keepalive_timeout_ms", KEEPALIVE_TIMEOUT_MS),
        ("grpc.keepalive_permit_without_calls", 1),
        ("grpc.http2.min_ping_interval_without_data_ms", PERMIT_KEEPALIVE_TIME_MS),
    ],
    compression=grpc.Compression.Gzip,
)
```

Every one of these six option strings and the `compression` keyword were confirmed against the installed `grpcio` 1.83 package itself — `strings` against its compiled Cython extension turns up the exact channel-argument literals (`grpc.keepalive_time_ms`, `grpc.http2.min_ping_interval_without_data_ms`, and the rest) grpc-core expects, the same discipline this chapter's Quarkus side applies by reading the shipped `quarkus-grpc` jar's own config-doc model rather than trusting either stack's configuration surface from memory.

**Four bundled clients, one image.** `footgun_client.py`, `pooled_client.py`, `gzip_client.py`, and `keepalive_client.py` all live inside the Python service's own built image and run via `docker compose run --rm --entrypoint python python -m app.<name> <target> ...` — no second image to build, the same pattern Chapter 7's `reuse_client.py` established. Each one imports the identical generated `shipping.routing.v1`/`shipping.type.v1` stub packages the server itself uses, and each prints exactly one line of machine-readable output to stdout (a float, or the literal string `MATCH`/`SURVIVED`) while every diagnostic line goes to stderr — the convention that lets `verify.sh` capture just the signal it needs from a container's combined output stream.

**ghz: fed the proto directly, because it has no reflection client.** Unlike `grpcurl`, `ghz` cannot ask a server what services it exposes — every run names its target method explicitly and needs either a compiled `.proto` or a protoset on disk. This example's `compose.yaml` mounts `contracts/proto/` read-only into a dedicated `ghz` service (`ghcr.io/bojand/ghz:0.121.0`, pinned; note that `bojand/ghz` publishes to `ghcr.io`, not `docker.io`, confirmed with `skopeo list-tags`), profiled off so a plain `docker compose up` never starts it — `docker compose run --rm ghz ...` auto-enables a service's own profile, so no extra flag is needed to invoke it:

```bash
docker compose run --rm ghz --insecure \
  --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \
  --call shipping.routing.v1.RoutingService.GetQuote \
  -d '{...}' -c 10 -n 300 -O json quarkus:9000
```

`verify.sh` parses the JSON output with `python3 -I` and asserts three things only, all loose and relative: `errorDistribution` sums to zero, the 99th-percentile latency entry in `latencyDistribution` is under a generous 1.5-second ceiling, and `rps` clears a low 20-requests-per-second floor. Real runs land p99 around 10-20 milliseconds and 800-1800 requests per second against both stacks — the bounds carry that much headroom because `ghz`'s own run-to-run variance under CI load is real, and `contracts.yml`'s existing 3-attempt verify retry, unchanged for this chapter, is what absorbs it.

## Build, run, observe

```bash
cd examples/18-performance-tuning && ./verify.sh
```

`verify.sh` brings both services up with `docker compose`, verifies `GetQuote` and `ListRoutes`' default page on both stacks via `grpcurl`, runs `footgun_client.py` and `pooled_client.py` against each stack's in-network address and asserts the channel-reuse ratio, asserts the full catalog's `RESOURCE_EXHAUSTED`-then-succeeds behavior at the default and raised message-size caps, runs `gzip_client.py` and `keepalive_client.py`, then runs `ghz` against `GetQuote` on each stack and asserts its loose bounds. Expect `PASS` once every assertion holds for both stacks; the full set of numbers from a real run is in `examples/18-performance-tuning/README.md`.

## Cross-check

Point `grpcurl`'s own timing at the comparison `ghz` makes more rigorously: `time grpcurl -plaintext -d '{...}' localhost:9180 shipping.routing.v1.RoutingService/GetQuote` run twenty times in a shell loop against `localhost:9180` lands in the same low-tens-of-milliseconds range `ghz`'s p99 reports for the same call — a single-digit sample from a different tool, agreeing with a 300-request statistical one, is a reasonable sanity check that `ghz`'s numbers reflect the server's real behavior rather than an artifact of how `ghz` itself drives load.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Always reuse a channel — there is no workload shape where opening a new one per call is the right call, and the cost compounds with every call a service makes over its lifetime. Raise <code>max-message-size</code> only for the specific RPC that needs it, on both the side that sends and the side that receives, and prefer shrinking an oversized response (pagination, field-mask projection, a narrower message) over raising the cap indefinitely — a bigger allowed message is a bigger amount of memory a server commits to holding per in-flight call. Reach for gzip compression when a payload is both large and compressible — a paginated list of records with repeated structure, not a single scalar or an already-compressed blob (an image, a pre-gzipped blob, encrypted bytes) where compression has nothing left to remove and only adds CPU cost for its own sake; where a service's calls split cleanly between the two shapes, gate compression per call rather than forcing it server-wide. Configure keepalive on both ends whenever a channel might sit idle between bursts of traffic — anything behind a load balancer, a NAT gateway, or a cloud provider's own idle-connection timeout — and set the permitted-ping floor generously enough that a well-behaved client's own keepalive interval never trips it.</p></div>

## What you learned

- A gRPC channel is a real HTTP/2 connection with a real handshake cost; reusing one channel and one stub across every call a client makes is the single highest-leverage performance decision available, measured here as a loose but repeatable multiple of a channel-per-call baseline.
- Message-size caps are enforced independently by whichever side — sender or receiver — is about to exceed the limit *it* configured; raising a server's inbound cap does nothing for a client that still rejects a large response with its own default receive limit, which is why both `grpcurl -max-msg-sz` and a native stub's own channel options exist.
- gzip compression is a real win for a large, repetitive payload and a wash (sometimes a net loss) for a small, already-dense one — the same lever, two different verdicts, depending entirely on the shape of what's being sent; keepalive's three settings (ping interval, permitted-ping floor, idle-ping toggle) exist under different names on every stack for the identical HTTP/2-level concept.

Chapter 19 turns from making an existing plaintext connection fast to making it private and mutually authenticated — channel and transport credentials, certificate management, and the progression from a Compose-local cert bootstrap toward a real Kubernetes cluster.

## On the wire

```bash
grpcurl -plaintext -d '{}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
```

```
{
  "routes": [
    { "id": "rte_001", "legs": [...], "price": { "currency": "USD", "amount": "1001.00" } },
    { "id": "rte_002", "legs": [...], "price": { "currency": "USD", "amount": "1002.00" } },
    { "id": "rte_003", "legs": [...], "price": { "currency": "USD", "amount": "1003.00" } }
  ],
  "next_page_token": "3"
}
```

```bash
grpcurl -plaintext -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
# ERROR: Code: ResourceExhausted
# Message: grpc: received message after decompression larger than max 4194304

grpcurl -plaintext -max-msg-sz 8388608 -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
# succeeds — 25 routes, routes[0].id="rte_001", routes[24].id="rte_025"
```

A real `ghz` run against `GetQuote` (`-c 10 -n 300`, Quarkus):

```
Count:        300
RPS:          910.32
Average:      ~11ms
Fastest:      ~3ms
Slowest:      ~22ms
p99 Latency:  19.43ms
Error count:  0
```

Wire-size note, illustrative only (not asserted by `verify.sh`, since neither stack's high-level API exposes a compressed frame's exact byte count): the 25-route catalog's repeated-character padding compresses extremely well under gzip, easily into the low double digits as a percentage of its uncompressed size; `GetQuote`'s few dozen bytes have essentially nothing left for gzip to remove, and the attempt costs a small, fixed amount of CPU regardless of the outcome.

---

*Verification status: <span class="status status--unverified">unverified</span>.
`verify.sh` ran green against both stacks on the authoring machine across
repeated runs, including the channel-reuse ratio, the max-message-size
`RESOURCE_EXHAUSTED`-then-succeeds pair, the gzip functional check, the
keepalive idle-gap survival, and the `ghz` loose bounds. The highest-risk
things a reader's own run should confirm: that the channel-reuse factor
(`footgun_total > pooled_total * 1.8`) and the `ghz` bounds (`p99 < 1.5s`,
`rps > 20`) hold on meaningfully slower or more contended hardware than the
authoring machine, and that the exact channel-argument strings this chapter
cites for `grpcio` 1.83 (`grpc.keepalive_time_ms`,
`grpc.http2.min_ping_interval_without_data_ms`, and the rest) and the
`quarkus-grpc` 3.40.1 config keys this chapter cites continue to resolve
identically on a future point release of either.*

## For deeper coverage

- [grpc.io — Performance best practices](https://grpc.io/docs/guides/performance/) — the general and language-specific tuning guidance this chapter's channel-reuse, message-size, and compression levers all draw from.
- Ben Evans & Jim Gough, *Optimizing Cloud Native Java*, 2nd ed. — O'Reilly, 2024 — JVM-side tuning that complements this chapter's Quarkus-side measurements.
- Jonathan Schneider, *SRE with Java Microservices* — O'Reilly, 2020 — load testing and latency-percentile interpretation, the same vocabulary this chapter's `ghz` run reports in.
- Cloud Native Design Patterns — "Appendix L: Caching" — response-size and latency trade-offs adjacent to this chapter's message-size and compression decisions.
