---
title: "Performance tuning"
order: 18
part: "Streaming at Scale & Performance"
description: "Channel reuse, keepalive, message-size caps, gzip and a ghz load test: four levers on GetQuote and ListRoutes, with the cost of each."
duration: "28 min read"
---

## Learning objectives

By the end of this chapter you can:

- Measure channel-per-call against one reused channel, and say why gRPC pooling means one multiplexed channel and not a connection pool.
- Configure keepalive's three knobs (ping interval, permitted-ping floor, idle-ping toggle) and say what each guards against.
- Reason about message-size caps, where sender and receiver each enforce their own limit.
- Decide when gzip is a wire-size win (`ListRoutes`) and when it is CPU for nothing (`GetQuote`).
- Run a `ghz` load test and read RPS, error rate and p99 latency.

## Why this matters

Performance in gRPC is rarely a schema problem. It is how a client holds its connection, how large a message either side will accept, whether the bytes are compressed, and how a server treats an idle connection. The same two RPCs show all four levers: `GetQuote`, a fast unary call that returns a few dozen bytes, and `ListRoutes`, a paginated catalog that can return megabytes. No contract changes.

{% include excalidraw.html file="18-channel-reuse-before-after" alt="Two side-by-side panels. The left panel, labeled Channel-per-call (the footgun), shows a client making three separate calls, each one opening a new channel that pays a full connect-plus-handshake cost before GetQuote runs and the channel closes, annotated 3 calls -> 3 handshakes. The right panel, labeled One reused channel (the fix), shows the same client building one channel with its handshake paid once, then multiplexing N GetQuote calls over that same connection, annotated N calls -> 1 handshake." caption="Figure 18.1: Channel-per-call pays a connection handshake on every call; one reused channel pays it once and multiplexes every call after that." %}

## Channel reuse

A gRPC channel is a real HTTP/2 connection, not a lightweight handle. It costs a TCP handshake, then the HTTP/2 preface and SETTINGS exchange, before the first RPC byte moves. A stub built from the channel is a thin typed wrapper that does no I/O. Building a channel per call is the most common gRPC performance mistake. The two clients differ only in where the channel is built:

```python
        channel = grpc.aio.insecure_channel(target)
        stub = routing_pb2_grpc.RoutingServiceStub(channel)
        try:
            response = await stub.GetQuote(_REQUEST)
            amounts.append(response.quote.amount)
        finally:
            await channel.close()
```

```python
    channel = grpc.aio.insecure_channel(target)
    stub = routing_pb2_grpc.RoutingServiceStub(channel)
```

The pooled client builds its one channel and stub once, before the loop, and calls `GetQuote` on them every iteration. Both print the total wall-clock seconds for the same number of calls against the same server. The footgun must take more than 1.8 times as long, a loose relative gate because the real ratio depends on how cheap a TCP connect and a handshake are on the host. Recorded runs of 50 calls landed at 0.50 s against 0.21 s on Quarkus (2.4x) and 0.27 s against 0.06 s on Python (4.1x). A different machine moves both sides of the ratio together, so don't hardcode a number.

"Pooling" is a slight misnomer. One channel already multiplexes any number of concurrent RPCs over one HTTP/2 connection, so a literal pool of channels to one target is rarely needed. Build the channel once, at startup or on first use, and hand it to every call site. More than one channel is warranted only when concurrency is high enough for one connection's flow-control window to become the bottleneck. Quarkus has a dial for that: `quarkus.grpc.clients.<name>.flow-control-window` raises the client window past its 1 MB default.

## Keepalive

A channel idle between bursts is the connection a load balancer, NAT device or firewall idle timeout is most likely to drop without telling either side. Keepalive sends an HTTP/2 `PING` on a quiet connection often enough that a dead one is noticed and torn down cleanly, rather than surfacing as a hang on the next real call. Three settings exist on both stacks:

| Concept | Quarkus (`application.properties`) | Python (`grpc.aio.server` options) |
|---|---|---|
| How often this side pings an idle peer | `quarkus.grpc.server.netty.keep-alive-time` | `grpc.keepalive_time_ms` |
| Floor on how often a peer may ping this side | `quarkus.grpc.server.netty.permit-keep-alive-time` | `grpc.http2.min_ping_interval_without_data_ms` |
| Whether pings are allowed with zero active RPCs | `quarkus.grpc.server.netty.permit-keep-alive-without-calls` | `grpc.keepalive_permit_without_calls` |

The middle row is a floor, not a target: the minimum interval you tolerate from a client. A client pinging faster is treated as abusive, and grpc-java (`permitKeepAliveTime`) and grpc-core tear the connection down with a `GOAWAY`. Set it too strict and well-behaved clients whose own interval is shorter than your floor break. Set it too permissive and a misconfigured or hostile client turns keepalive into wasted round trips. Both stacks here use a 5-second interval and a matching 5-second floor so a test can fit an idle gap in a short run. Production values are typically tens of seconds to a few minutes, since pinging every 5 seconds forever is a constant small tax.

The idle check builds one channel, calls `GetQuote`, sleeps 8 seconds (longer than the 5-second window on both ends) with no calls, then calls `GetQuote` again on the same channel. Both calls return the same value. The compose network has no intermediary to defeat, so this shows only that aggressive keepalive doesn't break a merely idle channel. Keepalive's payoff in production is detecting the silent drop this network can't produce.

## Message-size caps

Every gRPC implementation caps the size of a single message it will **receive**. The default is 4 MB across grpc-go (so `grpcurl` and `ghz`), grpc-core (so the Python stack) and grpc-java's separate-server mode (so Quarkus, with `quarkus.grpc.server.use-separate-server` at its default `true`).

`ListRoutes` returns a 25-route catalog sized to land between the 4 MB default and an 8 MB raised cap. Each route has two legs, and each leg's `carrier` string is a readable prefix such as `MAERSK-001-1-` followed by 100,000 filler characters. `carrier` is the only free-text field the frozen contract exposes, so it carries the padding. That is about 5.0 MB of payload. The padding is a simplification: a real catalog reaches that size through more legs and metadata, never repeated characters.

The cap that fires is the one on the side about to exceed its own limit: the sender checks its send cap, the receiver its receive cap. Both servers raise their caps to 16 MB, so they always finish sending the catalog. On Quarkus one property, `quarkus.grpc.server.max-inbound-message-size=16777216`, also governs what the separate server receives. On Python the options are `grpc.max_receive_message_length` and `grpc.max_send_message_length`:

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

The failure comes from the receiving client's default 4 MB cap:

```bash
grpcurl -plaintext -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
# ERROR: Code: ResourceExhausted
# Message: grpc: received message after decompression larger than max 4194304

grpcurl -plaintext -max-msg-sz 8388608 -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes
# succeeds: 25 routes, routes[0].id="rte_001", routes[24].id="rte_025"
```

`-max-msg-sz` raises the client's receive cap; the server was never the side rejecting anything. A Python stub behaves the same: its channel needs `options=[("grpc.max_receive_message_length", 16 * 1024 * 1024)]` before the 25-route page succeeds. Raising a server's inbound cap protects it from a large request, but does nothing for a client about to reject a large response. Whoever controls the client code has to raise that cap.

`ListRoutes` clamps `page_size` to 25 (the whole catalog) and defaults it to 3 when it is zero or negative. `page_token` is a raw list index here; a catalog backed by a changing datastore needs a stable cursor instead. `field_mask` is accepted but not applied, since the subject here is wire size.

## Compression

{% include excalidraw.html file="18-compression-size-tradeoff" alt="Two side-by-side panels comparing gzip compression on two different payloads. The left panel, labeled ListRoutes at about 5 megabytes highly repetitive, shows a wide bar labeled Uncompressed at about 5.0 megabytes on the wire shrinking via a compress arrow into a much narrower bar labeled Gzip far smaller, captioned Win: big size cut, CPU cost easily amortized. The right panel, labeled GetQuote at about 40 bytes, shows a tiny bar labeled Uncompressed at about 40 bytes staying almost the same width after a dashed compress arrow into a bar labeled Gzip no real win, captioned Wash: overhead about equals savings, CPU spent for nothing." caption="Figure 18.2: gzip compression wins decisively on ListRoutes' large, repetitive payload and barely breaks even on GetQuote's few dozen bytes." %}

Gzip trades CPU for wire bytes, which pays only with enough bytes and enough redundancy to spend CPU on. `ListRoutes` has both: it is large, and its repeated padding compresses about as well as a payload can. `GetQuote` returns a currency code, a decimal string and a route id, a few dozen bytes already as dense as protobuf varints make them. Gzip there costs a fixed amount of CPU for a ratio near zero.

| Payload | Size | Compressible | Gzip verdict |
|---|---|---|---|
| `ListRoutes` full catalog | about 5 MB | Highly | Large cut, CPU amortized |
| `GetQuote` response | a few dozen bytes | Barely | No gain, CPU wasted |

Both servers set gzip server-wide (`quarkus.grpc.server.compression=gzip`; `grpc.aio.server(..., compression=grpc.Compression.Gzip)`), because `ListRoutes` dominates this payload mix and neither stack's documented server configuration offers per-call control. A service that mixes both workloads wants per-call control, which Quarkus and grpc-core expose through lower-level interceptor APIs. Compression changes wire bytes, never message content: calling `ListRoutes` with the call's compression at its default and again with `compression=grpc.Compression.Gzip` decodes to identical responses. Python's high-level API can't report how many bytes crossed the wire, so the size reduction here is illustrative: the padded catalog compresses to a low double-digit percentage of its size.

{% include excalidraw.html file="18-performance-levers" alt="A labelled panel of four boxes under the heading RoutingService tuning knobs. The first box, Keepalive, reads Idle connection stays alive, cost periodic ping traffic. The second, Max message size, reads Large payloads allowed through, cost raise both ends. The third, Gzip compression, reads Smaller payload on the wire, cost CPU per call. The fourth, Channel pooling, reads Reuse never reconnect, cost none, always do this." caption="Figure 18.3: The four tuning levers and what each costs to turn on." %}

## Load testing with ghz

Unlike `grpcurl`, `ghz` has no reflection client. Every run names its target method and needs a `.proto` or protoset on disk. The compose file mounts `contracts/proto/` read-only into a dedicated `ghz` service, pinned to a specific tag, from `ghcr.io` rather than `docker.io`. The service sits behind a profile so a plain `docker compose up` never starts it, and `docker compose run --rm ghz ...` enables it on demand. A run against `GetQuote` uses 10 concurrent workers and 300 requests (`-c 10 -n 300`).

`verify.sh` asserts three loose bounds on the JSON output: zero errors, a p99 under 1.5 seconds, and RPS above 20. Recorded runs landed at p99 around 10 to 20 ms and 800 to 1,800 requests per second on both stacks. The bounds carry that much headroom because `ghz` varies from run to run under CI load. A sample Quarkus run:

```
Count:        300
RPS:          910.32
Average:      ~11ms
Fastest:      ~3ms
Slowest:      ~22ms
p99 Latency:  19.43ms
Error count:  0
```

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Always reuse a channel: no workload makes a channel per call right, and the cost compounds with every call a service makes. Raise <code>max-message-size</code> only for the RPC that needs it, on both the sending and the receiving side, and prefer shrinking an oversized response (pagination, field-mask projection, a narrower message) over raising the cap indefinitely, since a larger allowed message is more memory held per in-flight call. Use gzip when a payload is large and compressible, such as a list of records with repeated structure, never for a scalar or an already-compressed blob (an image, pre-gzipped bytes, encrypted data), and gate it per call when calls split cleanly between the two shapes. Configure keepalive on both ends whenever a channel may sit idle behind a load balancer, NAT gateway or cloud idle timeout, and set the permitted-ping floor low enough that a well-behaved client's interval never trips it.</p></div>

> **🤖 Explore with your agent**
>
> "In examples/18-performance-tuning, review the Python clients under python/app and the Quarkus application.properties. Confirm every call site builds its channel once and reuses the stub, find any max-message-size setting that only one side of ListRoutes has raised, and propose a per-call way to apply gzip to ListRoutes but not GetQuote."
>
> Check: run `./verify.sh` in examples/18-performance-tuning and confirm the footgun-to-pooled ratio is still above 1.8 and that `grpcurl -plaintext -d '{"pageSize":25}' localhost:9180 shipping.routing.v1.RoutingService/ListRoutes` still returns ResourceExhausted without `-max-msg-sz`.

## Build, run, observe

```bash
cd examples/18-performance-tuning && ./verify.sh
```

`verify.sh` starts both stacks with `docker compose`: Quarkus on `localhost:9180`, Python on `localhost:9181`. It passes when `GetQuote` and `ListRoutes`' default page answer on both stacks, the channel-reuse ratio clears 1.8, the full catalog returns `RESOURCE_EXHAUSTED` at the default cap and succeeds at the raised one, the gzip and plain `ListRoutes` calls decode identically (`MATCH`), the keepalive idle call survives (`SURVIVED`), and `ghz` stays within its bounds on each stack. The recorded numbers are in `examples/18-performance-tuning/README.md`.

The four Python clients run inside the Python image on the compose network, against the container port 9000 rather than the host-mapped 9180 and 9181. Each prints one machine-readable line (a float, `MATCH` or `SURVIVED`) to stdout:

```bash
docker compose run --rm --entrypoint python python -m app.footgun_client quarkus:9000 50
docker compose run --rm --entrypoint python python -m app.pooled_client quarkus:9000 50
```

The `ghz` run, fed the proto directly:

```bash
docker compose run --rm ghz --insecure \
  --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \
  --call shipping.routing.v1.RoutingService.GetQuote \
  -d '{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}' \
  -c 10 -n 300 -O json quarkus:9000
```

Default page of `ListRoutes`:

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

Experiments:

- Drop `-max-msg-sz` from the 8 MB grpcurl call. It fails with `ResourceExhausted` again.
- Swap `quarkus:9000` for `python:9000` in the client and `ghz` commands, and `9180` for `9181` in the grpcurl calls. The Python stack gives the same outputs on both sides of the 4 MB and 8 MB caps.
- Time `grpcurl` against `GetQuote` twenty times in a shell loop. Single calls land in the same low tens of milliseconds as the `ghz` p99, a sanity check that the load tool reflects the server and not its own driving.

## For deeper coverage

- [grpc.io: Performance best practices](https://grpc.io/docs/guides/performance/): the general and language-specific guidance behind the channel-reuse, message-size and compression levers.
- Ben Evans & Jim Gough, *Optimizing Cloud Native Java*, 2nd ed. (O'Reilly, 2024): JVM-side tuning that complements the Quarkus measurements.
- Jonathan Schneider, *SRE with Java Microservices* (O'Reilly, 2020): load testing and latency-percentile interpretation.
- Cloud Native Design Patterns, "Appendix L: Caching": response-size and latency trade-offs adjacent to message-size and compression decisions.
