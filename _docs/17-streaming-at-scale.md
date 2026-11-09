---
title: "Streaming deep-dive"
order: 17
part: "Streaming at Scale & Performance"
description: "HTTP/2 flow control, demand-driven production with Mutiny and async generators, and keepalive for streams that sit quiet."
duration: "26 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain HTTP/2 flow control (per-stream and per-connection windows, `WINDOW_UPDATE` frames) as the transport root of backpressure.
- Contrast Mutiny's `Multi` and `MultiEmitter.onRequest` with Python's pull-based async generator.
- Handle the quarkus-grpc bridge's prefetch timing, where `request(256)` lands before `onRequest` is registered.
- Configure keepalive (ping interval, permitted-ping floor, idle-ping toggle) on Quarkus (`quarkus.grpc.server.netty.*`) and Python (`grpc.aio.server(options=...)`).
- Drive a slow consumer against a live stream and read the pacing off the timestamps.

## Why this matters

A four-event `WatchShipment` hides two problems. A server can produce events faster than a client reads them, and a stream can sit quiet for minutes or days while a voyage progresses. Both only bite once a stream outlives the toy case. The contract doesn't change; what changes is how `WatchShipment` produces its events: on demand, with keepalive configured for the quiet stretches.

{% include excalidraw.html file="17-http2-flow-control-window" alt="Two moments on the same HTTP/2 connection. At t0, a server sends DATA frames into a 64 KiB stream window while a client reads normally and returns WINDOW_UPDATE frames that replenish the credit. At t1, the same client has stopped draining its receive buffer; the window shrinks toward zero, WINDOW_UPDATE frames stop arriving, and the server's sender blocks with no credit left to write, shown as a note under the stalled connection." caption="Figure 17.1: the same connection, two moments apart. A reading consumer keeps the window replenished; a stalled one lets it run out." %}

## When a consumer stops reading

HTTP/2 answers the first problem below anything the service code decides. Every stream has its own **flow-control window**, a byte budget the receiver advertises for unacknowledged `DATA` it will buffer on that stream. A sender that fills the window stops sending until the receiver returns a `WINDOW_UPDATE` frame. Nothing errors and nothing is dropped; the sender goes silent. A second window covers the whole connection, so one slow stream can't starve the others multiplexed on it. Both start at 64 KiB, the HTTP/2 default, and can grow dynamically. A consumer that stops reading exhausts that within a few hundred kilobytes.

So a slow reader makes the sender wait until the reader catches up or the call's deadline expires. A server has to decide how its own code behaves under that pressure. Buffering an unbounded queue of built responses just moves the problem from the network into the heap. `WatchShipment` instead never builds an event nobody has asked for.

## Demand-driven production

Both stacks turn "the transport won't take more bytes" into something application code can react to, with different vocabulary.

**Quarkus.** `Multi<T>` is a Reactive Streams `Publisher`: it produces only what its subscriber has requested. The generated bridge (`io.quarkus.grpc.stubs.ServerCalls`) wraps the outbound `ServerCallStreamObserver` with `setOnReadyHandler`. When the HTTP/2 stream is ready for more bytes, the bridge requests more items; when it isn't (the stalled case in the figure above), it doesn't. `Multi.createFrom().items(list)` honors that contract, but the list may have been built eagerly, all at once, long before the first request. A `Multi` can be backpressure-safe on the way out and still have done all its work up front.

**Python.** A handler written as `async def ... yield ...` is an async generator, which is pull-based by construction: nothing past the current `yield` runs until something calls `__anext__()` again. `grpc.aio` does that only when the stream has room, the same signal the Quarkus bridge reads through `setOnReadyHandler`. The generator protocol is the pull contract, so no demand API is needed.

`WatchShipment` dispatches on `booking_id`, a demo-only mode selector with no domain meaning:

| `booking_id` | Feed |
|---|---|
| `bkg_demo` | Six events, `[0, 260, 260, 260, 260, 260]` ms apart, produced on demand |
| `bkg_eager` | The same six events built in one tight loop, then handed to `Multi.createFrom().items(...)` or a plain `for` loop |
| `bkg_quiet` | Two events, `[0, 2000]` ms apart, to carry a multi-second gap |

Each event is stamped with the instant it is built and a `seq=<index>` note, so production order and time can be read off the wire. The Python demand-driven path is an async generator:

```python
    for i in range(len(waypoints)):
        if delays_s[i] > 0:
            await asyncio.sleep(delays_s[i])
        event = build_event(booking_id, i, waypoints)
        yield tracking_pb2.WatchShipmentResponse(event=event)
```

It uses `asyncio.sleep`; a blocking `time.sleep` would stall the whole event loop, not just this call.

Quarkus has to build that guarantee. `Multi.createFrom().emitter(...)` hands over a raw `MultiEmitter` with no scheduling, so `scheduleStep` schedules each event with `Vertx.setTimer` (no thread parked for the delay). After emitting, it checks `emitter.requested()`: with demand outstanding it schedules the next step, and without it a `producing` flag goes back to `false` and the chain idles until something restarts it. It checks `emitter.isCancelled()` on every step, so a dropped connection stops the timers. `onRequest(LongConsumer)` does the restarting.

Registering `onRequest` alone isn't enough. The bridge's subscriber calls `request(256)`, its fixed prefetch, inside `onSubscribe`, before the emitter lambda runs and registers the callback. That demand is counted in `emitter.requested()` but fires no callback. A producer that starts only from `onRequest` would sit silent on a six-event feed, waiting for a signal that already came and went. The fix is to also check `requested() > 0` immediately, so one check catches the prefetch and the callback catches later grants:

```java
            Runnable maybeStart = () -> {
                if (emitter.requested() > 0 && producing.compareAndSet(false, true)) {
                    scheduleStep(emitter, bookingId, waypoints, delaysMs, index, producing);
                }
            };
```

The Reactive Streams contract says you will be asked before you produce. It doesn't say when the first ask arrives relative to when you start listening, so a correct implementation handles both orders.

{% include excalidraw.html file="17-slow-consumer-backpressure" alt="Two producers side by side. On the left, a demand-driven Multi or async generator for bkg_demo produces three events spread across 0, 260, and 520 milliseconds, one in flight at a time, pulled by onRequest or a yield; a consumer box pulls each one as it is ready. On the right, an eager Multi.createFrom().items(list) or a pre-built Python list for bkg_eager shows three events all stamped at approximately zero milliseconds, already built before the first byte leaves the server; a consumer box reads a buffer the producer never waited on." caption="Figure 17.2: demand-paced production spreads event timestamps across real time; eager pre-materialization clusters them at the instant the call started." %}

## Keepalive on a long-lived stream

A quiet stream has to survive the load balancers, NAT devices and stateful firewalls between client and server, which often close idle TCP connections silently, with no error until the next write fails. A keepalive **PING** frame, answered by an **ACK**, is traffic on the same connection that application code never sees. It keeps a middlebox from seeing the connection go quiet long enough to reap it. Without it, survival depends on the quietest link in the path, which neither endpoint can observe.

{% include excalidraw.html file="17-keepalive-quiet-stream" alt="Two outcomes for the same quiet gap on a WatchShipment stream. On top, with server keepalive configured, the server sends a PING roughly every thirty seconds and the client answers with an ACK, holding the connection open across the gap until the next real event arrives. On the bottom, without keepalive, the connection sits idle after the last DATA frame with no PING traffic, and a middlebox reaps it before the final event can be delivered." caption="Figure 17.3: the same quiet gap survives with a keepalive PING/ACK cycle and is at risk without one; illustrative, since reaping depends on middlebox configuration." %}

Quarkus runs gRPC on grpc-java's Netty server by default (`quarkus.grpc.server.use-separate-server` is `true`). Its keepalive properties sit under `netty`, not directly under `quarkus.grpc.server`, and map to `NettyServerBuilder` calls:

| Setting | Quarkus | Python `grpc.aio.server` option | Meaning |
|---|---|---|---|
| Server ping interval | `quarkus.grpc.server.netty.keep-alive-time` | `grpc.keepalive_time_ms` | How often this server pings a silent client |
| Ping ACK wait | not set here | `grpc.keepalive_timeout_ms` | How long the server waits for the ACK |
| Permitted floor | `quarkus.grpc.server.netty.permit-keep-alive-time` | `grpc.http2.min_ping_interval_without_data_ms` | Shortest client ping interval tolerated before the server sends `GOAWAY` |
| Pings with no call | `quarkus.grpc.server.netty.permit-keep-alive-without-calls` | `grpc.keepalive_permit_without_calls` | Lets a client keep a channel warm between calls |

The Quarkus example sets `30s`, `10s` and `true`. The Python options are the channel arguments from the grpc keepalive guide, passed to `grpc.aio.server(options=...)` in `app/main.py`.

A loopback container network never exhausts a 64 KiB window on a few small messages and has no middlebox to reap anything, so neither window behavior nor keepalive survival is asserted automatically. Seeing `WINDOW_UPDATE` traffic needs a frame-level trace, for example `GODEBUG=http2debug=2` against a Go HTTP/2 client.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Use a demand-driven producer (<code>Multi.createFrom().emitter(...)</code> gated on demand, or an async generator) once a stream's length isn't bounded to a few known items, or production is expensive enough that doing it up front wastes work a cancelled call never needed. A pre-built <code>Multi.createFrom().items(list)</code>, or a list built before the first <code>yield</code>, stays right for a short, fixed, cheap sequence: the wire behavior is identical and the code is simpler. Configure keepalive on any stream a caller may hold open longer than the shortest idle timeout on its path, which in practice means every long-lived stream. Set three numbers explicitly: the server's ping interval (how fast it notices a dead peer), the floor on client pings (protection against a client that turns keepalive into a denial-of-service vector), and whether pings are allowed with no call in flight (needed for channels held open between bursts, wasteful for clients that reconnect per call).</p></div>

> **🤖 Explore with your agent**
>
> "In examples/17-streaming-at-scale, find where TrackingService.WatchShipment builds its events for bkg_demo on the Quarkus and Python stacks. Confirm no event is built before it is requested, then add a bkg_slow mode with 500 ms between six events on the same demand-driven path, without copying the bkg_eager list-building loop."
>
> Check: run `docker compose -p ch17-streaming run --rm python python -m app.slow_consumer quarkus:9000 bkg_slow` and confirm the server-stamped `at` values are about 500 ms apart; bkg_eager shows deltas under a millisecond.

## Build, run, observe

```bash
cd examples/17-streaming-at-scale
./verify.sh
```

`verify.sh` starts both stacks with `docker compose`. Quarkus listens on `localhost:9170` and Python on `localhost:9171`. It passes when `bkg_demo` delivers six events in order and takes at least 0.6 seconds, the slow consumer sees `at` deltas near 260 ms for `bkg_demo` and near zero for `bkg_eager`, `bkg_quiet` delivers both events across its two-second gap, and `ReportPositions` and `Sync` still answer `UNIMPLEMENTED`. In a recorded run the `bkg_demo` deltas were about 260 ms and the `bkg_eager` deltas well under a millisecond, three orders of magnitude apart from the same event content on the same contract.

The slow consumer (`python/app/slow_consumer.py`) reads one event, prints it as a JSON line with the server-stamped `event.at`, sleeps 0.3 seconds and reads the next, about three times slower than the producer. Run it on the compose network, where swapping `quarkus` for `python` targets the other stack:

```bash
docker compose -p ch17-streaming run --rm python python -m app.slow_consumer quarkus:9000 bkg_demo
```

Experiments:

- Run the slow consumer with `bkg_eager` instead of `bkg_demo`. The `at` deltas collapse to under a millisecond.
- Read `bkg_quiet` and compare total elapsed time with the event stamps. The gap is real, about two seconds.

A grpcurl read of `bkg_demo` looks the same as a four-event read, since pacing is invisible on the wire:

```bash
grpcurl -plaintext -d '{"bookingId":"bkg_demo"}' \
  localhost:9170 shipping.tracking.v1.TrackingService/WatchShipment
```

```
{"event":{"bookingId":"bkg_demo","location":{"unLocode":"USNYC","name":"New York"},"state":"BOOKING_STATE_PENDING","at":"2026-01-02T08:00:00.123456Z","note":"seq=0"}}
{"event":{"bookingId":"bkg_demo","location":{"unLocode":"USNYC","name":"New York"},"state":"BOOKING_STATE_CONFIRMED","at":"2026-01-02T08:00:00.383512Z","note":"seq=1"}}
```

Each `at` lands about 260 ms after the one before it, through all six events.

## For deeper coverage

- [grpc.io: Keepalive guide](https://grpc.io/docs/guides/keepalive/): the PING/ACK mechanics and the client and server options behind the table above.
- Cloud Native Design Patterns, "Stream Processing" chapter: backpressure and flow control beyond one `WatchShipment`-shaped stream.
- Martin Kleppmann & Chris Riccomini, *Designing Data-Intensive Applications*, 2nd ed. (O'Reilly, 2026): the general theory of backpressure and flow control in streaming systems.
- Clément Jean, *gRPC Go for Professionals* (Packt, 2023): streaming and flow-control patterns from this project's bibliography.
