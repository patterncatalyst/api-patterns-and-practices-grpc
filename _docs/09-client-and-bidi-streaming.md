---
title: "Client-streaming and bidirectional"
order: 9
part: "HTTP/2 & the Four RPC Types"
description: "TrackingService.ReportPositions and .Sync — folding a stream of requests into one answer, and running two independent directions on one connection."
duration: "19 min read"
---

Chapter 8 pointed `TrackingService.WatchShipment` at the shape where the server has more to say than the client does: one request, a sequence of responses, streamed as events happen. The shipping contract names two more shapes on the same service, and both invert that relationship instead of repeating it. `ReportPositions` is the opposite of `WatchShipment` — many requests from the client, one response from the server. `Sync` refuses to pick a direction at all — both sides send whenever they have something to say, on the same connection, independently. Four RPC shapes exist because four distinct relationships between request count and response count exist, and this chapter closes out the set `TrackingService` was built to demonstrate: client-streaming and bidirectional.

## Client-streaming: folding a sequence into one answer

`ReportPositions` exists because a telemetry agent tracking a shipment's container doesn't have one position report to send — it has a batch, accumulated since the last upload, and it wants one acknowledgment for the whole batch rather than a round trip per report. The proto names the shape directly:

```protobuf
rpc ReportPositions(stream ReportPositionsRequest) returns (ReportPositionsResponse);
```

`stream` appears once, on the request side only. The client opens the call and sends as many `ReportPositionsRequest` messages as it has — each one wrapping a `TrackingEvent` — for as long as it has more to send. The server reads every one of them off that single stream, and only when the client signals there's nothing left to read does the server send back its one `ReportPositionsResponse`, carrying `accepted_count`: how many reports it saw. Three requests in, one response out, and the response describes the whole batch rather than any single item in it.

The shape fits whenever many small units of work share one acknowledgment and the caller has no use for a per-item reply. Bulk ingest is the clearest case — a batch of records committed together, answered with one summary rather than one status per record. Telemetry upload is `ReportPositions`'s own case: sensor readings, position reports, or log lines accumulated client-side and flushed as a stream, where the server's only obligation is to say how many it got (or, with a richer response message, which ones it rejected). A chunked file upload fits the same shape — a stream of `DATA`-carrying messages followed by one response once the last chunk arrives — though this chapter's own example stays with position reports because that's what the contract already names. What unifies all three: the client knows up front it has a sequence to send, the server has nothing useful to say until that sequence ends, and paying for N round trips to acknowledge N items would be pure overhead with no payoff, since nothing about item 2 depends on a reply to item 1.

## Half-close: how "done sending" gets signaled

A client-streaming call needs a way for the client to say "that's everything" without closing the whole RPC, because the server still owes a response after the last request arrives. HTTP/2 already has the mechanism: each endpoint's half of a stream can close independently. The client sends its `DATA` frames carrying each `ReportPositionsRequest`, and when it has no more to send, it sets the `END_STREAM` flag on its final frame instead of sending an explicit "done" message of any kind — there's no sentinel value in the protobuf schema, no empty terminator message to send and recognize. That flag is the client's half of the stream closing, commonly called a **half-close**: the client's write side is done, but the stream itself stays open because the server's write side hasn't closed yet. The server keeps that stream's resources — buffers, read state — alive, finishes reading whatever frames already arrived, and only then is free to write its own `HEADERS` and `DATA` frames carrying the response, followed by its own `END_STREAM` on the frame that closes the RPC from both directions at once.

This is why a client-streaming handler on either stack reads as "consume everything, then produce one value," never as "produce a value per request." The Quarkus implementation in this chapter's example makes the half-close concrete: `request.collect().asList()` subscribes to the inbound `Multi<ReportPositionsRequest>` and buffers every item it emits — which, for a `Multi` backed by this inbound stream, only happens once per request, driven by frames actually arriving — until the stream itself signals completion, which on the wire is exactly the client's `END_STREAM` flag. Only then does the `Uni` returned by `collect().asList()` resolve with the full list, and only then does `.onItem().transform()` run to build the one `ReportPositionsResponse`. Python's `grpc.aio` servicer method makes the same mechanics explicit as ordinary control flow: `async for _ in request_iterator` doesn't exit the loop early and doesn't exit it on a timer — it exits precisely when the async iterator is exhausted, which `grpc.aio` ties to the client's half-close on the wire. Either way, the count that ends up in `accepted_count` is a count of frames that actually arrived before the half-close, not an estimate or a fixed batch size — this chapter's `verify.sh` sends exactly three requests and asserts exactly `accepted_count = 3` for precisely that reason.

Ordering matters here too, even though a client-streaming call's visible behavior is "many in, one out." The inbound stream preserves the order the client sent its requests in — HTTP/2 doesn't reorder frames within one stream, only across different streams — so a handler that cares about sequence (a position report where only the last one matters, say) can rely on `request_iterator`/`Multi` delivering items in send order. `ReportPositions`'s own response collapses that order into a count and throws the sequence away, but the guarantee is there underneath for any client-streaming RPC that needs it.

## Bidirectional: two directions, one stream

`Sync` is the shape that doesn't pick a direction at all:

```protobuf
rpc Sync(stream SyncRequest) returns (stream SyncResponse);
```

`stream` appears on both sides. Once the call opens, the client can send `SyncRequest` messages and the server can send `SyncResponse` messages, in whatever order and at whatever pace each side chooses, on the one HTTP/2 stream the call opened. Neither direction waits for the other to finish, because neither direction is "finished" until both sides close their own half — this is the same half-close mechanism `ReportPositions` used for its one-sided stream, just available independently in each direction instead of only the client's.

The handler in this chapter's example answers each `SyncRequest` with one `SyncResponse` echoing its event, as soon as that request arrives — a reasonable default, but a choice the handler makes, not something the protocol requires. A bidirectional stream doesn't enforce any correspondence between requests and responses: a server could send three responses before reading a second request, or read every request to exhaustion before writing anything, or correlate requests and responses by an ID carried in the message rather than by position at all. What the protocol does guarantee is that each direction, read on its own, preserves the order its sender emitted it in — the client's requests arrive at the server in send order, and the server's responses arrive at the client in send order — while placing no ordering relationship between the two directions themselves. `Sync`'s particular choice to answer request-for-request, in order, is a correlation the proto comment and this chapter's implementation establish by convention, not a guarantee built into `stream SyncRequest` / `stream SyncResponse` itself.

Bidirectional is worth its cost — a connection held open for the life of a back-and-forth, state kept on both ends for as long as it runs — when the interaction really is a conversation rather than a transaction with a predictable shape. Event reconciliation is `Sync`'s own case: two sides comparing state over time, each one capable of surfacing a discrepancy whenever it notices one, not on a schedule either side dictates. A negotiation protocol is the sharper example, and the shipping contract carries one: `RoutingService.NegotiateRoute` declares the identical `stream ... returns (stream ...)` shape for a carrier and a shipper proposing and countering route terms back and forth until both sides agree or one gives up — the same two-way, unpredictable-cadence profile `Sync` has, in a different domain. `NegotiateRoute` stays `UNIMPLEMENTED` in this chapter's example (TrackingService, not RoutingService, is what's running), but the shape transfers directly: wherever a real-time interactive session, a multi-round negotiation, or a long-lived duplex connection is the actual requirement, bidirectional is the RPC type built for it, and two independent client-streaming/server-streaming calls bolted together is usually a worse fit, not a cheaper one — it costs two connections and discards a correlation a single bidirectional stream could have carried without either side inventing one.

{% include excalidraw.html file="09-client-bidi-streaming" alt="Two side-by-side panels. Left panel, client-streaming (ReportPositions): a client sends three labeled request arrows (req 1, req 2, req 3) to a TrackingService box, then a dashed half-close line down to a note reading done sending, after which one amber-emphasized response arrow labeled ReportPositionsResponse flows back from the server to a light accent box reading ONE response folds all 3, accepted_count = 3. Right panel, bidirectional (Sync): a client and a TrackingService box exchange interleaved arrows — req 1 forward, then an amber-emphasized resp 1 backward, then req 2 forward, then resp 2 backward — with a dashed vertical line showing both directions riding the same connection, next to a light accent box reading independent read/write directions, order preserved within each." caption="Figure 9.1 — Client-streaming folds many requests into one response; bidirectional runs two independently-paced directions on one stream." %}

## The generated shapes on both stacks

`quarkus-grpc`'s code generation gives `ReportPositions` and `Sync` the Mutiny signatures the proto's two `stream` placements predict directly: a `stream` on the request side alone becomes a `Multi` parameter feeding a `Uni` return; `stream` on both sides becomes a `Multi` parameter feeding a `Multi` return. `grpc_tools.protoc` gives Python's `TrackingServiceServicer` base class an `async def` method for each RPC, but the parameter and the body are what change between the shapes — a client-streaming method's `request_iterator` parameter is consumed with `async for` until exhausted, then the method `return`s a single message, while a bidirectional method is itself an async generator: its body still iterates `request_iterator`, but produces output with `yield` instead of `return`, so the method keeps running (and keeps reading) after emitting its first response rather than ending there.

{% include codetabs.html langs="Quarkus|Python" %}

```java
// Client-streaming: Multi<Request> in, Uni<Response> out.
@Override
public Uni<Tracking.ReportPositionsResponse> reportPositions(Multi<Tracking.ReportPositionsRequest> request) {
    return request.collect().asList()
            .onItem().transform(reports -> Tracking.ReportPositionsResponse.newBuilder()
                    .setAcceptedCount(reports.size())
                    .build());
}
```
```python
# Client-streaming: request_iterator in, one return value out.
async def ReportPositions(self, request_iterator, context):
    accepted_count = 0
    async for _ in request_iterator:
        accepted_count += 1
    return tracking_pb2.ReportPositionsResponse(accepted_count=accepted_count)
```

{% include codetabs.html langs="Quarkus|Python" %}

```java
// Bidirectional: Multi<Request> in, Multi<Response> out — a 1:1 mapping
// operator, so each response goes out as its matching request arrives.
@Override
public Multi<Tracking.SyncResponse> sync(Multi<Tracking.SyncRequest> request) {
    return request.onItem().transform(req ->
            Tracking.SyncResponse.newBuilder().setEvent(req.getEvent()).build());
}
```
```python
# Bidirectional: request_iterator in, yield out — an async generator, not a
# single return.
async def Sync(self, request_iterator, context):
    async for request in request_iterator:
        yield tracking_pb2.SyncResponse(event=request.event)
```

Both pairs run against the same `TrackingService` registration: one `@GrpcService` class on Quarkus, one `add_TrackingServiceServicer_to_server(...)` call on Python, with `WatchShipment` left to answer `UNIMPLEMENTED` on both — Quarkus because the generated `TrackingService` interface requires every method implemented explicitly, Python because the generated servicer base class answers `UNIMPLEMENTED` for anything a subclass doesn't override. This chapter's hands-on example registers only `TrackingService`, and only these two methods, to keep the both-stack build to one moving part per stack rather than two services' worth of streaming code landing at once — the REST→gRPC seam Chapter 2 introduced doesn't change shape here; it's still the same decision about which calls cross a protocol boundary, just not this chapter's subject.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Run both of this chapter's shapes through Chapter 2's five axes. RPC shape is the whole decision for <code>ReportPositions</code>: a telemetry agent has a batch of reports and wants one acknowledgment, which is client-streaming by definition — the alternative, N unary <code>ReportPositions</code>-style calls each carrying one report, pays N round trips and N sets of HTTP/2 header frames for work that has no per-item answer to give back, a straight loss with no corresponding gain. RPC shape decides <code>Sync</code> too, but against a different alternative: two independent half-duplex streams (one client-streaming call for the client's events, one server-streaming call for the server's) would need two connections, two lifecycles to track, and no protocol-level way to correlate a response on one stream with a request on the other, where one bidirectional stream gives both directions, in order, on one connection, with correlation left to the application's own convention rather than invented twice. Sync vs. stream is already answered by RPC shape in both cases — there is nothing to decide once the shape is chosen, since a streaming RPC is inherently consumed as a stream. Deadline and budget diverge sharply between the two: a bounded client-streaming call like <code>ReportPositions</code> can carry a deadline covering the whole batch, since the server knows the call ends when the client's half-close arrives; <code>Sync</code>'s bidirectional, open-ended conversation resists a single deadline entirely, and reaches instead for a keepalive or an application-level idle timeout, the two tools this book leaves to Chapter 10's deadline chapter to name properly. Failure class also splits: <code>ReportPositions</code> failing mid-stream (`UNAVAILABLE` before the half-close) is usually safe to retry whole, since nothing committed until the one response arrived; a <code>Sync</code> session interrupted mid-conversation needs the application to decide what state survives a reconnect, because gRPC's retry machinery has no concept of "resume a bidirectional stream from message 40." Concurrency model favors the reactive/<code>async</code> style for both, more than Chapter 7's unary case did: a thread blocked reading a client-stream to exhaustion, or blocked on either direction of a bidirectional one, is a thread pinned for the entire call's lifetime rather than one round trip, which is precisely the cost Mutiny's <code>Multi</code> and <code>grpc.aio</code>'s async iterators exist to avoid paying.</p></div>

## Where this goes next

The half-close this chapter named for `ReportPositions` and the independent-directions model it named for `Sync` are both HTTP/2 stream behaviors Chapter 6 already built the vocabulary for — nothing here needed a new transport concept, only a new way of using the one Chapter 6 covered. Chapter 10 puts a real deadline on a streaming call for the first time, including the harder question this chapter's Decision callout flagged: what a deadline even means for a connection with no natural end. Chapter 11 returns to failure mid-stream with the full rich-error-model treatment, past the single retryable/non-retryable split this chapter used. Chapter 17 comes back to both RPCs under load — what backpressure looks like when a client-stream's buffer fills faster than a handler drains it, and what a slow consumer does to a bidirectional stream's flow-control window on each side independently. And Chapter 26, the site's complete-project chapter, is where `RoutingService.NegotiateRoute` — mentioned here as the same bidirectional shape in a different domain — finally gets implemented instead of returning `UNIMPLEMENTED`.

## On the wire

`verify.sh` brings both services up, waits for each to answer reflection's `list`, then drives both RPCs with `grpcurl`'s client-stream support: newline-delimited JSON request messages piped to `-d @`, which sends them in order and half-closes once stdin runs out.

```bash
printf '%s\n' \
  '{"event":{"bookingId":"bkg_demo","note":"p1"}}' \
  '{"event":{"bookingId":"bkg_demo","note":"p2"}}' \
  '{"event":{"bookingId":"bkg_demo","note":"p3"}}' \
  | grpcurl -plaintext -d @ localhost:9090 shipping.tracking.v1.TrackingService/ReportPositions
# { "accepted_count": 3 }

printf '%s\n' \
  '{"event":{"bookingId":"bkg_demo","note":"s1"}}' \
  '{"event":{"bookingId":"bkg_demo","note":"s2"}}' \
  | grpcurl -plaintext -d @ localhost:9090 shipping.tracking.v1.TrackingService/Sync
# { "event": { "bookingId": "bkg_demo", "note": "s1" } }
# { "event": { "bookingId": "bkg_demo", "note": "s2" } }
```

Swap `9090` for `9091` and the Python stack answers identically: `accepted_count: 3` for the first call, two `SyncResponse` messages in the same order for the second. `verify.sh` asserts both numbers directly against both stacks — `accepted_count` via a single JSON field read, the `Sync` response count via the shared harness's `json_stream_count` helper, which counts concatenated JSON objects on `grpcurl`'s stdout rather than assuming a fixed shape — so "folds three into one" and "echoes two into two, in order" are checked claims for every chapter rebuild, not a one-time observation written into this prose.
