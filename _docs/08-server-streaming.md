---
title: "Server-streaming"
order: 8
part: "HTTP/2 & the Four RPC Types"
description: "WatchShipment as the live-tracking hot path: one request opening a stream of ordered TrackingEvents, the half-close that ends it, and the generated Multi/async-generator shapes on each stack."
duration: "20 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why `WatchShipment` server-streaming beats polling `GetShipmentStatus` on a timer for a live-tracking feed.
- Trace a server-streaming call's HTTP/2 mechanics: one stream, one `DATA` frame per event, guaranteed ordering, and a half-close instead of a sentinel value.
- Implement a server-streaming handler with Quarkus's `Multi<T>` and Python's async-generator (`yield`) shapes.
- Identify what this chapter's fixed four-event example leaves open: flow-control backpressure and keepalive on a long-lived stream.

## Why this matters

Chapter 7 traced `GetQuote` from a typed call on one stub, through a reused channel, to a typed call on the other side — one request, one response, one HTTP/2 stream that opens and closes before the caller's code moves past the call. `TrackingService.WatchShipment` keeps the channel and the stub-to-stub shape Chapter 7 built, but changes what rides the stream: instead of one response closing the exchange, the server sends a sequence of `TrackingEvent`s over the life of a voyage, and the caller reads them as they arrive. This is server-streaming, the second of the four RPC shapes Chapter 2 named and the first one this site implements. `WatchShipment` is the shipping domain's live-tracking hot path — the call the booking UI makes once to watch a shipment move from booked to delivered, instead of asking "has anything changed?" on a timer.

## When one response isn't the shape

A sequence of facts arriving over time is a bad fit for a unary call repeated on a schedule. Picture the alternative: the booking UI polls `GetShipmentStatus` every few seconds for a voyage that can run two weeks. Most of those calls return the same answer the previous call did, because nothing changed between an export customs clearance and a vessel's mid-ocean position report three days later — the UI paid a full round trip, a connection's worth of HTTP/2 overhead, and a server-side lookup for information that hadn't moved. Worse, polling trades accuracy for simplicity: an event that happens three seconds after a poll waits up to one full interval before the UI sees it, and tightening the interval to catch events sooner multiplies the wasted calls that found nothing new. `WatchShipment` inverts that relationship. The caller opens the stream once and the server pushes an event the moment it has one — no polling interval to tune, no wasted calls, no lag between an event happening and the caller seeing it bounded by anything but network latency.

{% include excalidraw.html file="08-polling-vs-streaming" alt="Side-by-side comparison of polling versus server-streaming. On the left, a client repeats a unary GetShipmentStatus call on a timer; three of four polls return the same unchanged answer, a wasted round trip each time, and the fourth poll only catches an event up to one interval after it posted. On the right, the same client opens a single WatchShipment server-stream once; the server pushes each TrackingEvent — CONFIRMED, IN_TRANSIT, DELIVERED — the instant it posts, with no polling interval, no wasted calls, and no lag beyond network latency." caption="Figure 8.1 — polling wastes calls and adds staleness; one server-stream pushes each event as it posts." %}

Server-streaming earns its cost here for the same reason Chapter 2's decision framework names: the interaction is a sequence of facts the caller wants as they happen, not a single question with a single answer. A live feed, a progress indicator on a long-running job, a changelog a caller tails rather than re-fetches, a result set too large to buffer into one response and send at once — all of these share the property that drives the shape choice, which is that the number of things to send isn't known up front and the caller benefits from seeing each one as soon as it exists. `WatchShipment` is squarely that case: the number of tracking events a voyage produces isn't fixed when the watch starts, and a booking UI showing a shipment's progress bar wants each state transition the moment it posts, not batched into a later unary response.

## The mechanics: one stream, many frames, one half-close

Chapter 6 established that every gRPC call maps to exactly one HTTP/2 stream, and a server-streaming call doesn't change that mapping — it changes how long the stream stays open and how many `DATA` frames cross it. `WatchShipment` opens a stream the same way `GetQuote` does: the client sends a `HEADERS` frame naming the method and a `DATA` frame carrying the serialized `WatchShipmentRequest`. From there the two calls diverge. A unary call's server sends one `HEADERS`/`DATA` pair back and the stream closes. `WatchShipment`'s server instead sends a `DATA` frame every time it has a `TrackingEvent` to report (one frame per event, as many frames as the voyage produces), all on the *same* stream identifier the request opened, with no new connection, no new handshake, and no new stream per event. The four events a booking moves through in this chapter's example (`PENDING`, `CONFIRMED`, `IN_TRANSIT`, `DELIVERED`) are four `DATA` frames on one stream, not four separate calls.

Two guarantees make that stream usable without extra bookkeeping on the caller's side. First, ordering: HTTP/2 frames on one stream arrive in the order they were sent, so a caller that receives `CONFIRMED` before `PENDING` has a different bug somewhere, not a protocol race to defend against. The server doesn't have to timestamp-sort events for the caller or attach a sequence number for the caller to reorder by — the stream's own frame order *is* the event order, which is why this chapter's example fixes bookingId as the only input and treats the rest of each event as a deterministic, ordered sequence the server just plays back. Second, completion: the server signals "no more events" by closing its end of the stream (a **half-close**) rather than sending a sentinel value the caller has to recognize as meaningful. The client's read loop simply stops getting frames and sees the stream end; a trailer carries the final gRPC status (`OK` if the voyage's tracking finished cleanly, an error code if something went wrong mid-stream), the same status mechanism Chapter 2 covered for unary calls. Nothing about streaming invents a new failure vocabulary — it reuses the one Chapter 2 already named, just attached to a stream's end instead of a single response.

What a half-close does *not* do is tell the caller how many events to expect. `WatchShipment` doesn't return a count up front the way a paginated unary response might return a total; the caller reads until the stream ends and treats that as "done," whether that's four events or four hundred. That's a deliberate trade: a count-first design would need the server to know the total before sending the first event, which defeats the entire reason to stream rather than buffer a shipment's whole history into one response.

## The generated shapes

Chapter 7 named two objects every gRPC client is built from — a channel and a stub — and server-streaming doesn't add a third. What changes is the *type* the generated method returns, on both stacks, because "a sequence of values arriving over time" needs a different container than "one value."

On Quarkus, the `quarkus-grpc` extension's Mutiny code generation turns `rpc WatchShipment(WatchShipmentRequest) returns (stream WatchShipmentResponse)` into a method returning `Multi<WatchShipmentResponse>` rather than `Uni<WatchShipmentResponse>` — Mutiny's type for "zero or more items, then completion or failure," the same `Multi` Chapter 7 mentioned for `NegotiateRoute`'s bidirectional stream. A `@GrpcService` implementing `TrackingService` returns a `Multi` built from this chapter's fixed event list; Mutiny treats every item the `Multi` emits as one `DATA` frame and treats the `Multi` completing as the signal to half-close the gRPC stream — there's no separate "now end the stream" call to make, because completion of the reactive type *is* the end of the response stream.

On Python, `grpc.aio` expresses the same shape with a language feature rather than a library type: a server-streaming handler is declared `async def WatchShipment(self, request, context)` and implemented as an **async generator** — a function whose body `yield`s each response message instead of `return`ing one. Every `yield tracking_pb2.WatchShipmentResponse(...)` sends one `DATA` frame; the generator function returning (falling off the end, same as any Python generator finishing) is what triggers `grpc.aio`'s half-close. Nothing about the servicer's method signature changes between a unary and a server-streaming handler on Python beyond this: `async def` plus `return` for one value, `async def` plus `yield` (possibly in a loop) for a stream of them.

{% include codetabs.html langs="Quarkus|Python" %}

```java
@GrpcService
public class TrackingServiceImpl implements TrackingService {

    @Override
    public Multi<Tracking.WatchShipmentResponse> watchShipment(Tracking.WatchShipmentRequest request) {
        String bookingId = request.getBookingId();

        // Multi.createFrom().items(...) emits the four TrackingEvents, in
        // order, as DATA frames on the one HTTP/2 stream this call opened;
        // the Multi completing is what sends the server's half-close — no
        // explicit "end of stream" call needed.
        return Multi.createFrom().items(TrackingEvents.sequence(bookingId).stream())
                .map(event -> Tracking.WatchShipmentResponse.newBuilder().setEvent(event).build());
    }
}
```

```python
class TrackingServiceServicer(tracking_pb2_grpc.TrackingServiceServicer):
    async def WatchShipment(
        self,
        request: tracking_pb2.WatchShipmentRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[tracking_pb2.WatchShipmentResponse]:
        # Each `yield` sends one WatchShipmentResponse as a DATA frame, in
        # the order yielded; the async generator returning is what sends
        # grpc.aio's half-close — no explicit "end of stream" call needed.
        for event in sequence(request.booking_id):
            yield tracking_pb2.WatchShipmentResponse(event=event)
```

Both shapes carry the same contract: a sequence of responses the runtime drains in order, with completion standing in for an explicit end-of-stream signal. `Multi` and an async generator are different vocabularies for the identical idea — the type system (Quarkus) or the language's own generator protocol (Python) enforces that a server-streaming handler can only produce a sequence, never a single bare value, the same way `Uni`/`async def ... return` enforces exactly one.

## What this preview skips: flow control and long-lived connections

Two questions stay open after this chapter and belong to later ones, because they only bite under conditions this chapter's four-event example never reaches. The first is backpressure: what happens when the server produces events faster than the client consumes them? HTTP/2 answers this at the protocol level with a per-stream flow-control window — the receiver advertises how many bytes of unacknowledged `DATA` it's willing to buffer, and a sender that fills that window stalls until the receiver acknowledges and frees space, rather than the server's output silently piling up in memory somewhere. `WatchShipment`'s four-event stream never approaches that window's limits; a high-volume tracking feed, or a Chapter 17 example that produces events faster than a slow consumer reads them, is where that window's size and what a server does when a client can't keep up become decisions rather than background facts. Chapter 17 covers that tuning in depth — per-stream window sizing, what a server does when a consumer falls behind, the cases where an unbounded `Multi` or generator is the wrong choice.

The second is keepalive. A stream this chapter's example completes in milliseconds never needs to prove it's still alive; a stream a client holds open for the days or weeks a voyage takes does, because network infrastructure between a client and server — load balancers, NAT devices, firewalls — often closes a TCP connection it hasn't seen traffic on recently, with no error delivered to either endpoint until the next attempted write fails. gRPC's keepalive pings exist to generate that traffic on an otherwise-idle long-lived stream, holding the connection open against middleboxes that would otherwise reap it silently. Chapter 18 covers keepalive configuration on both stacks, including the ping interval and timeout values that trade connection liveness against keepalive traffic's own overhead. Both omissions follow the same pattern: this chapter proves the mechanism works correctly for a short, deterministic stream, and later chapters prove it keeps working at the durations and message volumes a production tracking feed actually reaches.

{% include excalidraw.html file="08-server-streaming" alt="A client sends one WatchShipmentRequest, opening a single HTTP/2 stream. On that one stream, four ordered TrackingEvent DATA frames flow from server to client in sequence — PENDING at USNYC, CONFIRMED at USNYC, IN_TRANSIT at NLRTM, DELIVERED at NLRTM — followed by the server's half-close, after which the client reads to completion with no trailing error. A labeled arrow from a server box shows it yielding the four events in order onto the stream." caption="Figure 8.2 — WatchShipment: one request, one stream, four ordered TrackingEvent frames, one half-close." %}

## The REST→gRPC seam

The booking UI's own reason to prefer `WatchShipment` over polling is the same application of Chapter 2's axes Chapter 7 closed with for the quote lookup. RPC shape says a voyage's events are a sequence the caller wants as they happen, ruling out a single response. Sync vs. stream says the caller holds a connection open and consumes values as they arrive rather than blocking for one value or firing requests on a timer. Chapter 2 named this exact seam already: the booking service's REST-facing UI watches a shipment's progress through this stream instead of issuing a `GetShipmentStatus` poll every few seconds, trading a steady trickle of mostly-wasted unary calls for one connection that produces exactly as many messages as the voyage does. That's the same shape of decision as the booking service's gRPC call to `RoutingService.GetQuote` — a protocol choice downstream of what the interaction actually needs, not a default reached for out of habit.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Run <code>WatchShipment</code> through the five axes. RPC shape is server-streaming, because a shipment's state transitions are a sequence of facts produced over the life of a voyage, not a single question with a single answer — the same reasoning that rules out a sequence of repeated unary polls, since the caller wants each event as it posts, not re-asked for on an interval that's always either too eager (wasted calls) or too slow (stale state). Sync vs. stream follows: the caller holds one connection open and consumes events as they arrive, paying the cost of a long-lived stream because the alternative — polling a tracking endpoint for a voyage lasting weeks — wastes far more connections and still delivers events late. Deadline and budget look different here than on a unary call: a deadline on <code>WatchShipment</code> bounds how long the stream may stay open, not one round trip, and a caller watching a voyage for its duration sets that bound generously or omits it, deferring to the keepalive story Chapter 18 covers rather than a short per-call timeout. Failure class and retryability split on where a failure lands: an <code>UNAVAILABLE</code> that closes the stream mid-voyage is safe to retry by reopening <code>WatchShipment</code> with the same <code>bookingId</code>, since the call is a pure read with no side effect to duplicate, while an <code>INVALID_ARGUMENT</code> for a malformed <code>bookingId</code> never is. Concurrency model favors whichever style holds a stream open without pinning a scarce thread for its entire lifetime — Mutiny's <code>Multi</code> on Quarkus and <code>grpc.aio</code>'s async generator on Python both let the runtime schedule other work between events rather than blocking a thread for the stream's whole duration, which matters more here than on a short unary call precisely because a tracking stream's duration is measured in days, not milliseconds.</p></div>

## Where this goes next

Chapter 9 completes the streaming picture this chapter started: client-streaming, where `TrackingService.ReportPositions` takes a stream of requests and folds them into one acknowledgment, and bidirectional streaming, where `Sync` lets both sides send at a time of their own choosing. Both RPCs are already declared on `TrackingService` and return `UNIMPLEMENTED` in this chapter's example for exactly that reason. Chapter 10 puts a real deadline-and-cancellation story on a stream this chapter left open-ended — what it means to cancel a `WatchShipment` call partway through, and how that cancellation propagates to the server mid-stream rather than before or after a single exchange. Chapter 17 returns to the flow-control preview above with the numbers: per-stream window sizing, what a server does when a consumer falls behind, and where an unbounded `Multi` or generator stops being the right default. Chapter 18 turns the keepalive mention into a configured, measured property of a long-lived connection, on both stacks.

## On the wire

`verify.sh` brings both services up, waits for each to answer reflection's `list`, and calls `WatchShipment` with the identical request on both — `grpcurl` prints one JSON object per streamed message and keeps printing until the server's half-close ends the call:

```bash
grpcurl -plaintext -d '{"bookingId":"bkg_demo"}' \
  localhost:9080 shipping.tracking.v1.TrackingService/WatchShipment
```

```
{
  "event": {
    "booking_id": "bkg_demo",
    "location": { "un_locode": "USNYC", "name": "New York" },
    "state": "BOOKING_STATE_PENDING",
    "at": "2026-01-02T08:00:00Z",
    "note": "Booking accepted; container released to terminal"
  }
}
{
  "event": {
    "booking_id": "bkg_demo",
    "location": { "un_locode": "USNYC", "name": "New York" },
    "state": "BOOKING_STATE_CONFIRMED",
    "at": "2026-01-02T14:00:00Z",
    "note": "Export customs cleared; loaded onboard MAERSK vessel"
  }
}
{
  "event": {
    "booking_id": "bkg_demo",
    "location": { "un_locode": "NLRTM", "name": "Rotterdam" },
    "state": "BOOKING_STATE_IN_TRANSIT",
    "at": "2026-01-15T09:30:00Z",
    "note": "Vessel arrived at Rotterdam; awaiting discharge"
  }
}
{
  "event": {
    "booking_id": "bkg_demo",
    "location": { "un_locode": "NLRTM", "name": "Rotterdam" },
    "state": "BOOKING_STATE_DELIVERED",
    "at": "2026-01-16T11:00:00Z",
    "note": "Container discharged and delivered to consignee"
  }
}
```

Four events, in this exact order, then the stream ends — no fifth message, no trailing error. Swap `9080` for `9081` and the same request against the Python stack produces the identical four events in the identical order, proving the same claim Chapter 5 made for `GetQuote`: two independently generated implementations, built from the same `.proto` file, produce byte-for-byte comparable wire output — this time across an entire stream instead of a single response.

## For deeper coverage

- Hüseyin Babal, *gRPC Microservices in Go* (Packt) — worked server-streaming service patterns, including the live-feed case `WatchShipment` implements here.
- [grpc.io — Core concepts: server-streaming RPC](https://grpc.io/docs/what-is-grpc/core-concepts/) — the half-close and ordering guarantees this chapter names.
- [Quarkus gRPC — writing a gRPC service](https://quarkus.io/guides/grpc-service-implementation) — `Multi<T>`-returning handlers on the Mutiny code generation this chapter's Quarkus example uses.
- *Cloud Native Design Patterns* — "Event-Driven" chapter — decoupled facts pushed as they happen, the same push-over-poll argument this chapter makes for `WatchShipment` over `GetShipmentStatus` polling.
