---
title: "Client-streaming and bidirectional"
order: 9
part: "HTTP/2 & the Four RPC Types"
description: "TrackingService.ReportPositions and .Sync: folding a stream of requests into one answer, and running two independent directions on one connection."
duration: "17 min read"
---

## Learning objectives

By the end of this chapter you can:

- Implement `ReportPositions` (client-streaming) by folding an inbound `Multi` or `request_iterator` into one response on both stacks.
- Explain how a client signals "done sending" with a half-close, without closing the whole RPC.
- Implement `Sync` (bidirectional streaming) and say why one bidirectional stream beats two streaming calls bolted together.
- Replace `collect().asList()` with an incremental fold so the handler doesn't buffer the whole stream.
- Choose client-streaming or bidirectional over unary or server-streaming.

## Why this matters

`WatchShipment` fits the case where the server has more to say than the client: one request, many responses. `TrackingService` declares two more shapes that invert or remove that asymmetry. `ReportPositions` takes many requests and returns one response. `Sync` lets both sides send whenever they have something to say, independently, on the same connection. Four shapes exist because four relationships between request count and response count exist.

## Client-streaming: folding a sequence into one answer

A telemetry agent tracking a container doesn't have one position report to send. It has a batch accumulated since the last upload, and it wants one acknowledgment for the batch instead of a round trip per report. The proto names the shape:

```protobuf
rpc ReportPositions(stream ReportPositionsRequest) returns (ReportPositionsResponse);
```

`stream` appears on the request side only. The client sends as many `ReportPositionsRequest` messages as it has, each wrapping a `TrackingEvent`. The server reads them all, and when the client signals it is done, sends one `ReportPositionsResponse` carrying `accepted_count`. Three requests in, one response out, and the response describes the batch.

Use client-streaming when many small units share one acknowledgment:

| Case | Why it fits |
| --- | --- |
| Bulk ingest | A batch commits together and gets one summary, not a status per record |
| Telemetry upload | Readings accumulate client-side and flush as a stream; the server says how many it got |
| Chunked file upload | A stream of chunks, one response after the last |

In each, the server has nothing useful to say until the sequence ends, and nothing about item 2 depends on a reply to item 1. N round trips would be pure overhead.

## Half-close: how "done sending" is signaled

The client needs to say "that's everything" without closing the RPC, because the server still owes a response. HTTP/2 lets each endpoint close its half of a stream independently. The client sets the `END_STREAM` flag on its final `DATA` frame. There is no sentinel value in the schema and no empty terminator message. The client's write side is now closed, but the stream stays open until the server writes its response and its own `END_STREAM`.

{% include excalidraw.html file="09-half-close-sequence" alt="Sequence diagram of an HTTP/2 half-close in a client-streaming call. A client sends three DATA frames to TrackingService: req 1, req 2, and req 3 carrying the END_STREAM flag. The client's write side is closed with no separate done-sending message. The server finishes reading buffered frames, then sends its own HEADERS and DATA frames with the response, followed by its own END_STREAM. Both halves are closed and the RPC is complete." caption="Figure 9.1: Half-close ends the client's writes; the server reads to completion, then closes its own half with the response." %}

A client-streaming handler therefore reads as "consume everything, then produce one value." On Quarkus, a collector over the inbound `Multi<ReportPositionsRequest>` completes when the stream completes, which on the wire is the client's `END_STREAM`. On Python, `async for` over `request_iterator` ends when the iterator is exhausted, which `grpc.aio` ties to the same flag. `accepted_count` is the number of frames that arrived before the half-close, not an estimate or a fixed batch size.

HTTP/2 keeps frames on one stream in order, so a handler that cares about sequence, such as one where only the last position matters, can rely on items arriving in send order.

## Bidirectional: two directions, one stream

`Sync` doesn't pick a direction:

```protobuf
rpc Sync(stream SyncRequest) returns (stream SyncResponse);
```

`stream` appears on both sides. After the call opens, the client sends `SyncRequest` messages and the server sends `SyncResponse` messages, in any order and at any pace, on one HTTP/2 stream. Neither direction waits for the other. Each closes its own half with the same half-close mechanism.

The protocol guarantees order within each direction: the server sees requests in send order and the client sees responses in send order. It places no ordering relationship between the two directions. `Sync` answers each request with one response echoing its event as soon as the request arrives, but that is the handler's convention. A server could send three responses before reading a second request, read every request before writing anything, or correlate by an ID carried in the message.

Bidirectional is worth its cost, a connection held open and state kept on both ends, when the interaction is a conversation instead of a transaction:

- Event reconciliation, where either side can raise a discrepancy whenever it notices one.
- Negotiation, as in `RoutingService.NegotiateRoute`, where carrier and shipper propose and counter route terms until both agree or one gives up. It has the same `stream ... returns (stream ...)` shape in a different domain.
- Any real-time interactive session.

Two independent calls, one client-streaming and one server-streaming, are usually a worse fit, not a cheaper one: they cost two lifecycles and drop the correlation that a single stream carries.

{% include excalidraw.html file="09-client-bidi-streaming" alt="Two panels. Left, client-streaming (ReportPositions): a client sends req 1, req 2 and req 3 to TrackingService, then a half-close, and one ReportPositionsResponse folds all three with accepted_count = 3. Right, bidirectional (Sync): a client and TrackingService exchange interleaved arrows, req 1 then resp 1 then req 2 then resp 2, over one connection, with independent read and write directions and order preserved within each." caption="Figure 9.2: Client-streaming folds many requests into one response; bidirectional runs two independently paced directions on one stream." %}

## The generated shapes

The placement of `stream` in the proto fixes the signature.

| Shape | Quarkus (Mutiny) | Python (`grpc.aio`) |
| --- | --- | --- |
| Client-streaming | `Multi` parameter, `Uni` return | `request_iterator` consumed with `async for`, then `return` one message |
| Bidirectional | `Multi` parameter, `Multi` return | async generator: iterates `request_iterator` and `yield`s responses |

A bidirectional Python method keeps running, and keeps reading, after its first `yield`.

{% include codetabs.html langs="Quarkus|Python" %}

```java
    @Override
    public Uni<Tracking.ReportPositionsResponse> reportPositions(Multi<Tracking.ReportPositionsRequest> request) {
        return request.collect().asList()
                .onItem().transform(reports -> {
                    LOG.infof("ReportPositions: folded %d position report(s) into one ack", reports.size());
                    return Tracking.ReportPositionsResponse.newBuilder()
                            .setAcceptedCount(reports.size())
                            .build();
                });
    }
```

```python
    async def ReportPositions(
        self,
        request_iterator,
        context: grpc.aio.ServicerContext,
    ) -> tracking_pb2.ReportPositionsResponse:
        # Client streaming: the server reads the inbound stream to
        # exhaustion (`async for` only ends when the client half-closes
        # (signals "done sending")), folding every ReportPositionsRequest
        # into a single count, then returns ONE response. Nothing is sent
        # back to the client until the stream is fully consumed.
        accepted_count = 0
        async for _ in request_iterator:
            accepted_count += 1

        logger.info("ReportPositions: folded %d position report(s) into one ack", accepted_count)
        return tracking_pb2.ReportPositionsResponse(accepted_count=accepted_count)
```

### Fold, don't buffer

Both handlers reach the same `accepted_count` at different memory cost. `collect().asList()` holds every `ReportPositionsRequest` in one `List` before the transform runs. That is free for three items. For a stream with no size limit, such as an agent replaying a day of reports after an outage, memory grows with whatever the client sends. The Python loop holds one integer.

The Quarkus fix keeps the same shape: replace `collect().asList()` with a fold, such as `collect().with(Collectors.counting())` or an `onItem().scan(...)` accumulator, so the running result is all that stays in memory. Don't buffer what you can fold.

{% include codetabs.html langs="Quarkus|Python" %}

```java
    @Override
    public Multi<Tracking.SyncResponse> sync(Multi<Tracking.SyncRequest> request) {
        return request.onItem().transform(req ->
                Tracking.SyncResponse.newBuilder()
                        .setEvent(req.getEvent())
                        .build());
    }
```

```python
    async def Sync(
        self,
        request_iterator,
        context: grpc.aio.ServicerContext,
    ):
        # Bidirectional: read and write are independent directions on the
        # same stream. This handler happens to respond to each request as
        # it arrives (`yield` inside the loop), so one SyncResponse goes out
        # per SyncRequest that comes in, in arrival order, but the two
        # directions aren't lockstepped by the protocol itself, only by
        # this handler's choice to answer immediately.
        async for request in request_iterator:
            yield tracking_pb2.SyncResponse(event=request.event)
```

### Stopping early

These handlers read until the client's stream ends. A handler isn't required to. A bulk-ingest handler that validates each request may reject the batch at the first bad `TrackingEvent` and return an error before the client's `END_STREAM`. Sends the client issues after that fail instead of queueing, because the server's read side is gone. In `Sync`, either side can abort mid-conversation, with `context.abort(...)`, an early-completing `Multi`, or a client cancel, and the other side's next send surfaces it as a failure on its own stream.

## Choosing a shape

| Decision | `ReportPositions` | `Sync` |
| --- | --- | --- |
| Shape | Client-streaming: a batch, one acknowledgment. N unary calls pay N round trips and N header sets for no per-item answer. | Bidirectional: a conversation. Two half-duplex calls need two connections and no protocol-level correlation. |
| Deadline | A deadline can cover the whole batch, because the call ends at the client's half-close. | An open-ended conversation resists one deadline; use keepalive or an application idle timeout. |
| Retry | A failure before the half-close, such as `UNAVAILABLE`, is usually safe to retry whole, because nothing committed until the one response. | The application decides what survives a reconnect. gRPC retry can't resume a bidirectional stream from message 40. |
| Threads | Use the reactive or `async` style: a blocked thread is pinned for the whole call, not one round trip. | Same, for either direction. |

> **🤖 Explore with your agent**
>
> "In examples/09-client-and-bidi-streaming, change `reportPositions` in `TrackingServiceImpl.java` to fold the inbound `Multi<ReportPositionsRequest>` into `accepted_count` without `collect().asList()`, so it never holds the list. Leave the Python `ReportPositions` and both `Sync` handlers unchanged."
>
> Check: the three-message `ReportPositions` call against `localhost:9090` still returns `accepted_count` 3, and `grep -n 'asList' examples/09-client-and-bidi-streaming/quarkus/src/main/java/com/patterncatalyst/shipping/tracking/TrackingServiceImpl.java` finds nothing.

## Build, run, observe

Quarkus listens on host port 9090 and Python on 9091. `WatchShipment` answers `UNIMPLEMENTED` on both, because it belongs to the server-streaming example.

```bash
cd examples/09-client-and-bidi-streaming
./verify.sh
```

`verify.sh` starts both services, sends a three-message client stream to `ReportPositions` and a two-message stream to `Sync` on each, and prints `PASS` when both stacks answer the same way. To drive it by hand, run `docker compose up --build`. `grpcurl` reads newline-delimited JSON from `-d @`, sends each message in order, and half-closes when stdin ends:

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
# { "event": { "booking_id": "bkg_demo", "note": "s1" } }
# { "event": { "booking_id": "bkg_demo", "note": "s2" } }
```

Port 9091 answers identically: `accepted_count` 3, then two `SyncResponse` messages in the same order.

- **Send two reports instead of three.** `accepted_count` is 2: it counts frames that arrived before the half-close.
- **Send three `Sync` messages.** Three responses come back, one per request, in order.

## For deeper coverage

- Clément Jean, *gRPC Go for Professionals* (Packt, 2023): the four RPC shapes a `.proto` file can declare, including the `stream` placements behind `ReportPositions` and `Sync`.
- [grpc.io: Core concepts, client-streaming and bidirectional-streaming RPC](https://grpc.io/docs/what-is-grpc/core-concepts/): the half-close and independent-direction mechanics.
- *Cloud Native Design Patterns*, "Balancing Coupling" chapter: the coupling cost of a long-lived bidirectional stream against two independent request/response calls.
- [Quarkus gRPC: writing a gRPC service](https://quarkus.io/guides/grpc-service-implementation): the `Multi`-in, `Uni`-or-`Multi`-out signatures.
