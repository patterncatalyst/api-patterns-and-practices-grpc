---
title: "Server-streaming"
order: 8
part: "HTTP/2 & the Four RPC Types"
description: "WatchShipment as the live-tracking hot path: one request opening a stream of ordered TrackingEvents, the half-close that ends it, and the Multi and async-generator shapes on each stack."
duration: "15 min read"
---

## Learning objectives

By the end of this chapter you can:

- Choose a server-streaming RPC over polling a unary call on a timer.
- Trace a server-streaming call on HTTP/2: one stream, one `DATA` frame per event, guaranteed order, and a half-close instead of a sentinel value.
- Implement a server-streaming handler with Quarkus's `Multi<T>` and Python's async generator.
- Name what a short, fixed stream leaves open: flow control and keepalive on a long-lived stream.

## Why this matters

A unary call opens one HTTP/2 stream, carries one request and one response, and closes. `TrackingService.WatchShipment` keeps the channel and the stub but changes what rides the stream: the server sends a sequence of `TrackingEvent`s over the life of a voyage, and the caller reads them as they arrive. This is the second of the four RPC shapes. It is the booking UI's live-tracking call, made once to watch a shipment move from booked to delivered.

## When one response isn't the shape

Picture the alternative: the UI polls `GetShipmentStatus` every few seconds for a voyage that can run two weeks. Most polls return the answer the previous poll did. Each one costs a round trip and a server-side lookup. An event that happens three seconds after a poll waits up to a full interval before the UI sees it, and shortening the interval to catch events sooner multiplies the polls that find nothing.

`WatchShipment` inverts that. The caller opens the stream once and the server pushes each event the moment it has one. There is no interval to tune, no wasted call, and the only lag is network latency.

{% include excalidraw.html file="08-polling-vs-streaming" alt="Side-by-side comparison of polling and server-streaming. On the left, a client repeats a unary GetShipmentStatus call on a timer; three of four polls return the same unchanged answer, and the fourth catches an event up to one interval after it posted. On the right, the same client opens one WatchShipment stream and the server pushes each TrackingEvent (CONFIRMED, IN_TRANSIT, DELIVERED) the instant it posts." caption="Figure 8.1: Polling wastes calls and adds staleness; one server-stream pushes each event as it posts." %}

Use server-streaming when the caller wants a sequence of facts as they happen and the number of items isn't known up front:

| Interaction | Why it streams |
| --- | --- |
| Live feed (`WatchShipment`) | Events arrive over days; the caller wants each at once |
| Progress of a long-running job | Each update is a message; completion ends the stream |
| Changelog the caller tails | Re-fetching the whole log repeats work |
| Result set too large for one response | The caller starts on the first rows while the rest are produced |

## One stream, many frames, one half-close

Every gRPC call maps to one HTTP/2 stream. A server-streaming call changes how long the stream stays open and how many `DATA` frames cross it. The client sends a `HEADERS` frame naming the method and a `DATA` frame carrying `WatchShipmentRequest`. The server then sends one `DATA` frame per `TrackingEvent` on the same stream, with no new connection, handshake or stream per event. `PENDING`, `CONFIRMED`, `IN_TRANSIT` and `DELIVERED` are four frames on one stream.

Two guarantees keep the caller simple:

- **Order.** Frames on one stream arrive in the order they were sent, so the server needs no sequence number and the caller no reordering. The frame order is the event order.
- **Completion.** The server ends the stream by closing its end, a **half-close**, instead of sending a sentinel value. The client's read loop sees the stream end. A trailer carries the final gRPC status: `OK` when tracking finished, an error code if something failed mid-stream. Streaming reuses the status vocabulary unary calls use.

A half-close doesn't announce a count. The caller reads until the stream ends, whether that is four events or four hundred. A count-first design would force the server to know the total before sending the first event, which defeats streaming over buffering a whole history into one response.

{% include excalidraw.html file="08-server-streaming" alt="A client sends one WatchShipmentRequest, opening a single HTTP/2 stream. Four ordered TrackingEvent DATA frames flow from server to client (PENDING at USNYC, CONFIRMED at USNYC, IN_TRANSIT at NLRTM, DELIVERED at NLRTM), followed by the server's half-close. The client reads to completion with no trailing error." caption="Figure 8.2: WatchShipment: one request, one stream, four ordered TrackingEvent frames, one half-close." %}

## The generated shapes

A client is still a channel and a stub. What changes is the type the generated method returns, because a sequence of values over time needs a different container than one value.

- **Quarkus.** `quarkus-grpc` generates a method returning `Multi<WatchShipmentResponse>`, Mutiny's type for zero or more items followed by completion or failure. Each item the `Multi` emits is one `DATA` frame. The `Multi` completing is the half-close, so there is no separate end-of-stream call.
- **Python.** `grpc.aio` uses a language feature: the handler is an `async def` that **yields** each response. Each `yield` sends one frame, and the generator returning sends the half-close.

{% include codetabs.html langs="Quarkus|Python" %}

```java
    @Override
    public Multi<Tracking.WatchShipmentResponse> watchShipment(Tracking.WatchShipmentRequest request) {
        String bookingId = request.getBookingId();
        LOG.infof("WatchShipment: opening stream for bookingId=%s", bookingId);

        // Multi.createFrom().items(...) emits the four TrackingEvents, in
        // the exact order supplied, as DATA frames on the one HTTP/2 stream
        // this call opened; the Multi completing is what sends the server's
        // half-close, so no explicit "end of stream" call is needed.
        return Multi.createFrom().items(TrackingEvents.sequence(bookingId).stream())
                .map(event -> Tracking.WatchShipmentResponse.newBuilder().setEvent(event).build());
    }
```

```python
    async def WatchShipment(
        self,
        request: tracking_pb2.WatchShipmentRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[tracking_pb2.WatchShipmentResponse]:
        logger.info("WatchShipment: opening stream for bookingId=%s", request.booking_id)

        # Each `yield` sends one WatchShipmentResponse as a DATA frame on the
        # one HTTP/2 stream this call opened, in the order yielded; the
        # async generator returning is what sends grpc.aio's half-close,
        # so no explicit "end of stream" call is needed.
        for event in sequence(request.booking_id):
            yield tracking_pb2.WatchShipmentResponse(event=event)
```

The type system on Quarkus and the generator protocol on Python both force a streaming handler to produce a sequence. A unary handler returns exactly one value: a `Uni`, or `async def` with `return`.

## What a short stream skips

Two concerns appear only when a stream is large or long-lived.

**Backpressure.** If the server produces events faster than the client reads them, HTTP/2's per-stream flow-control window stops the sender once the receiver's buffer is full, and resumes it when the receiver acknowledges. The output doesn't pile up unbounded in server memory. A four-event stream never reaches that window. A high-volume feed does, and then window size, a slow consumer and an unbounded `Multi` or generator become decisions.

**Keepalive.** A stream that finishes in milliseconds never has to prove it's alive. A stream held open for the days of a voyage does: load balancers, NAT devices and firewalls often close a TCP connection they have seen no traffic on, and neither endpoint learns of it until the next write fails. gRPC keepalive pings generate traffic on an idle stream to hold the connection open, at the cost of the pings' own overhead.

## Deadline, retry and threads for a stream

| Question | Answer for `WatchShipment` |
| --- | --- |
| Deadline | It bounds how long the stream may stay open, not one round trip. Set it generously or omit it for a long watch, and rely on keepalive. |
| Retry | An `UNAVAILABLE` that closes the stream mid-voyage is safe to retry by reopening with the same `bookingId`, because the call is a pure read. `INVALID_ARGUMENT` for a malformed `bookingId` never is. |
| Threads | `Multi` and the async generator let the runtime schedule other work between events instead of pinning a thread for the stream's whole life, which matters when a stream lasts days. |

> **🤖 Explore with your agent**
>
> "In examples/08-server-streaming, add a `limit` field to `WatchShipmentRequest` and make `WatchShipment` on both stacks (the `Multi` in `TrackingServiceImpl.java` and the async generator in `app/tracking_service.py`) stop after that many `TrackingEvent`s by completing the stream, never by sending a sentinel event. Keep the event order unchanged and keep `ReportPositions` and `Sync` returning `UNIMPLEMENTED`."
>
> Check: `grpcurl -plaintext -d '{"bookingId":"bkg_demo","limit":2}' localhost:9080 shipping.tracking.v1.TrackingService/WatchShipment` prints exactly the first two events, and port 9081 prints the same two.

## Build, run, observe

Both stacks implement the same RPC from the same `.proto` file and stream the same four-event sequence for any `bookingId`. Quarkus listens on host port 9080 and Python on 9081.

```bash
cd examples/08-server-streaming
./verify.sh
```

`verify.sh` starts both services, calls `WatchShipment` on each, and prints `PASS` when both stacks return four events in order and answer `UNIMPLEMENTED` for `ReportPositions` and `Sync`. To call it by hand, run `docker compose up --build` and then:

```bash
grpcurl -plaintext -d '{"bookingId":"bkg_demo"}' \
  localhost:9080 shipping.tracking.v1.TrackingService/WatchShipment
```

`grpcurl` prints one JSON object per message and keeps printing until the server's half-close ends the call. The reply is four events (`BOOKING_STATE_PENDING` and `BOOKING_STATE_CONFIRMED` at USNYC, then `BOOKING_STATE_IN_TRANSIT` and `BOOKING_STATE_DELIVERED` at NLRTM), then the stream ends with no fifth message and no trailing error. Port 9081 returns the same four events in the same order.

- **Change the `bookingId`.** Only `event.booking_id` changes; the states, locations and order are fixed.
- **Call `ReportPositions` or `Sync`.** Both return `UNIMPLEMENTED` until the client-streaming and bidirectional RPCs are implemented.

## For deeper coverage

- Hüseyin Babal, *gRPC Microservices in Go* (Packt): worked server-streaming service patterns, including the live-feed case `WatchShipment` implements.
- [grpc.io: Core concepts, server-streaming RPC](https://grpc.io/docs/what-is-grpc/core-concepts/): the half-close and ordering guarantees.
- [Quarkus gRPC: writing a gRPC service](https://quarkus.io/guides/grpc-service-implementation): `Multi<T>`-returning handlers on the Mutiny code generation.
- *Cloud Native Design Patterns*, "Event-Driven" chapter: decoupled facts pushed as they happen, the same push-over-poll argument.
