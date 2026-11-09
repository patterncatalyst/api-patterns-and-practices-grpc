---
title: "The gRPC decision framework"
order: 2
part: "Why gRPC, and the Decision Lens"
description: "Five axes that classify any gRPC call (RPC shape, sync call or stream, deadline and budget, failure class, concurrency model), applied to RoutingService.GetQuote."
duration: "16 min read"
---

## Learning objectives

By the end of this chapter you can:

- Classify any gRPC interaction by its RPC shape: unary, server-streaming, client-streaming or bidirectional.
- Decide whether a call should block synchronously or hold a stream open, based on what the interaction costs.
- Carve a deadline as a slice of an inbound request's own budget instead of inventing one.
- Tell a retryable status code (`UNAVAILABLE`, budget-permitting `DEADLINE_EXCEEDED`) from a non-retryable one (`INVALID_ARGUMENT`, `NOT_FOUND`).
- Pick a concurrency model (blocking, reactive, virtual threads or `grpc.aio`) by whether a method's bottleneck is waiting or computing.

## Why this matters

`RoutingService.GetQuote` is one request and one response in well under a second. `TrackingService.WatchShipment` opens a connection that stays open for hours, pushing an event whenever a container's position changes. `RoutingService.RecomputeRoutes` starts work that may take minutes and returns an `Operation` to poll. All three are gRPC methods on the same contract, and they are three different shapes. Treating them as interchangeable is how a service blocks a thread for an hour or polls a stream that never produces a second message.

Five questions say which shape an interaction needs: RPC shape, sync call or stream, deadline and budget, failure class and retryability, and concurrency model. Later chapters reuse these axes by name whenever they weigh a call's shape, deadline, retries or concurrency.


## RPC shape

The first question eliminates the most options: does the interaction produce one response, a sequence of responses, a sequence of requests, or both at once? Protobuf names all four, and the shipping contract uses each for a reason tied to the interaction.

```protobuf
rpc GetQuote(GetQuoteRequest) returns (GetQuoteResponse);                 // unary
rpc WatchShipment(WatchShipmentRequest) returns (stream WatchShipmentResponse); // server-streaming
rpc ReportPositions(stream ReportPositionsRequest) returns (ReportPositionsResponse); // client-streaming
rpc NegotiateRoute(stream NegotiateRouteRequest) returns (stream NegotiateRouteResponse); // bidirectional
```

| Method | Shape | Why |
|---|---|---|
| `RoutingService.GetQuote` | Unary | Pricing is one question with one immediately known answer. A stream would add flow control, ordering and a half-close protocol for nothing |
| `TrackingService.WatchShipment` | Server-streaming | A shipment's location is a sequence of facts over a voyage, and the caller wants each as it happens, not re-asked on a timer |
| `TrackingService.ReportPositions` | Client-streaming | A telemetry agent hands off many reports and wants one acknowledgment, not a round trip per report |
| `RoutingService.NegotiateRoute` | Bidirectional | Either side sends proposals when it chooses, which fits a conversation, not a transaction |

Pick the shape first, because the other axes depend on it. A deadline on a unary call bounds one round trip. A deadline on a streaming call bounds how long the stream may stay open, a different number entirely.

{% include excalidraw.html file="02-four-rpc-shapes" alt="A two-by-two grid crossing request cardinality against response cardinality to produce the four RPC shapes. Top-left, single request and single response, is unary, tagged with RoutingService.GetQuote. Top-right, single request and a stream of responses, is server-streaming, tagged with TrackingService.WatchShipment. Bottom-left, a stream of requests and a single response, is client-streaming, tagged with TrackingService.ReportPositions. Bottom-right, a stream of requests and a stream of responses, is bidirectional, tagged with RoutingService.NegotiateRoute." caption="Figure 2.1: Request cardinality crossed with response cardinality gives the four RPC shapes." %}

## Sync call or stream

This axis asks whether the caller blocks for one value or holds a connection open and consumes values as they arrive. A unary call costs one round trip and releases the HTTP/2 stream, buffers and connection state when the response lands. A stream costs something continuous: the server holds state for the connection's life, and both sides need a story for a network blip mid-stream.

`WatchShipment` is worth that cost because polling a tracking endpoint every few seconds for a voyage of weeks wastes far more connections and still delivers events late. `RecomputeRoutes` is worth neither a blocking call nor a stream: it returns an `Operation` at once and lets the caller poll or subscribe, decoupling the work's duration from any connection.

Default to a synchronous unary call, the cheapest shape to run and reason about. Use a stream when the caller needs a sequence over time as it happens, and an async operation when the work is long but nobody watches it live.

## Deadline and budget

Every call carries a deadline: the longest an answer is still useful. A `GetQuote` that completes correctly in eleven seconds is a failure if the booking flow only had three, because the customer has already seen a timeout.

The hard part is dividing a budget across a chain. When the REST booking service accepts `POST /bookings/{id}/confirmation`, it has a total budget for the HTTP response, say two seconds. That must cover its own processing, the hop to `RoutingService.GetQuote` and whatever `GetQuote` spends calling `QuoteService.GetQuote`. At the REST to gRPC seam the booking service carves a slice of the budget it already has, so a three-hop chain shares one clock instead of three that together outlast the caller's patience. Name the deadline as a fraction of the budget you were given.

A deadline that's too tight fails calls that would have succeeded. One that's too loose lets a slow dependency hold the chain hostage. Size the slice from what the downstream call costs under normal load.

## Failure class and retryability

Treating every failure alike retries a bug into a storm or abandons a problem that would have cleared in a second. Status codes let a caller tell them apart without parsing an error string.

| Code | Retry? | Why |
|---|---|---|
| `UNAVAILABLE` | Yes, with backoff | The server or network couldn't be reached now; often transient |
| `DEADLINE_EXCEEDED` | Only if idempotent and budget remains | Retrying a non-idempotent call that partly executed risks doing the work twice |
| `RESOURCE_EXHAUSTED` | Back off, don't resend at once | The server is shedding load, and an immediate resend adds pressure |
| `INVALID_ARGUMENT` | No | The request is malformed and fails the same way again |
| `NOT_FOUND`, `ALREADY_EXISTS` | No | They describe the state of the world, not a glitch reaching it |
| `FAILED_PRECONDITION`, `PERMISSION_DENIED` | No | Something has to change first |

`GetQuote` is a pure read, safe to retry on `UNAVAILABLE` or `DEADLINE_EXCEEDED` with no idempotency bookkeeping. `RecomputeRoutes` starts work, and a blind retry risks two recomputations, so it needs an idempotency key and a status check against the `Operation`.

## Concurrency model

The last axis concerns the server: how a method called many times concurrently runs without blocking on I/O it needn't block on, or spawning more threads than the machine can schedule. The right model follows the work, not a house default.

| Stack | Model | Fits |
|---|---|---|
| Quarkus | Blocking, one thread per call | Simplest; fine while the pool is sized for load, a liability once a downstream like `QuoteService.GetQuote` is slow |
| Quarkus | Reactive (Mutiny, Vert.x event loop) | Never blocks a thread on I/O, at the cost of differently written code |
| Quarkus | Virtual threads | Blocking style, with thousands multiplexed over a few OS threads; suits I/O-bound fan-out |
| Python | `grpcio` on a thread pool | Real concurrency for I/O-bound work, since threads release the GIL on a socket wait; no gain beyond core count for CPU-bound work |
| Python | `grpc.aio` | Many concurrent calls on one thread, as long as none block in-line |

Real computation, such as scoring route candidates against live capacity, needs a worker pool regardless, because no async or virtual-thread trick makes CPU-bound work faster by waiting less. The question is whether a method's bottleneck is waiting or computing.

{% include excalidraw.html file="02-decision-framework" alt="Five labeled axes: RPC shape, sync call vs. stream, deadline and budget, failure class and retryability, and concurrency model, each feeding into a central decision box, which resolves to concrete example calls: RoutingService.GetQuote as a unary call with a tight deadline, TrackingService.WatchShipment as server-streaming, TrackingService.ReportPositions as client-streaming, and RoutingService.RecomputeRoutes as an async call returning an Operation." caption="Figure 2.2: The five decision axes, each resolving to a concrete shipping call." %}

## The cross-protocol question

The booking service's choice to call `GetQuote` over gRPC applies the first three axes. The shape is a single question with a single answer, so no stream. The booking service wants to block until it has a price. It has a budget to slice for the outbound call. A unary, blocking, tightly bounded request between two services one organization deploys together is what gRPC's binary framing and generated stubs are for. A call serving a diverse external client population that needs caching and loose versioning lands on REST.

The contrast generalizes. gRPC, REST over HTTP/2 and WebSockets all move data between two parties and differ in what's built in.

| Protocol | Built in |
|---|---|
| gRPC | Generated stubs, a deadline on every call, a canonical status-code vocabulary |
| REST over HTTP/2 | A cacheable contract any browser or proxy speaks; no call semantics |
| WebSocket | A full-duplex byte stream; no deadlines, status codes or generated contract |

A streaming interaction like `WatchShipment` could run on any of the three. The choice turns on how much of gRPC's machinery it needs against how much client diversity it must serve.

## A worked decision: RoutingService.GetQuote

- **Shape.** One origin, destination and cargo manifest in; one `Money` and one `Route` out. Unary.
- **Sync or stream.** Nothing to consume incrementally, and the booking service needs the quote before it proceeds. Synchronous.
- **Deadline.** The REST request has a couple of seconds, and `GetQuote` sits ahead of a second hop into `QuoteService`. That leaves it a few hundred milliseconds, so a slow downstream lookup fails fast.
- **Failure class.** No writes, so `UNAVAILABLE` and budget-permitting `DEADLINE_EXCEEDED` are safe to retry. `INVALID_ARGUMENT` (a malformed `Location`, an empty cargo list) never is.
- **Concurrency.** The work is the round trip to `QuoteService`, so it is I/O-bound on both stacks: virtual threads on Quarkus, `grpc.aio` on Python, neither pinning a thread for the wait.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p><code>RoutingService.GetQuote</code> is unary and synchronous: one question, one answer, and the caller needs the price before it can proceed. Its deadline is a tight slice of the booking service's request budget, propagated rather than invented, because a second hop into <code>QuoteService</code> follows. <code>UNAVAILABLE</code> and budget-permitting <code>DEADLINE_EXCEEDED</code> are safe to retry because the call is a pure read; <code>INVALID_ARGUMENT</code> never is. The work is I/O-bound, so it runs on virtual threads (Quarkus) or <code>grpc.aio</code> (Python) instead of a thread-per-call model sized for compute it doesn't do.</p></div>

> **🤖 Explore with your agent**
>
> "Open contracts/proto/shipping/tracking/v1/tracking.proto and contracts/proto/shipping/routing/v1/routing.proto. For TrackingService.WatchShipment, TrackingService.ReportPositions and RoutingService.RecomputeRoutes, apply the five axes (RPC shape, sync or stream, deadline slice of a two-second booking budget, retryable status codes, concurrency model) and write a Decision callout for each in the format of the GetQuote one: only a sequence over time becomes a stream, and a call that starts work gets an idempotency key before it is retried."
>
> Check: each answer names its RPC shape as declared in the proto (server-streaming, client-streaming, unary returning an Operation) and says whether a retry is safe.

## For deeper coverage

- Sam Newman, *Building Microservices*, 2nd ed. (O'Reilly): deadline budgets and failure classification across a chain of inter-service calls.
- Hüseyin Babal, *gRPC Microservices in Go* (Packt): concurrency and performance trade-offs behind the four RPC shapes.
- [grpc.io: Status codes and their use](https://grpc.io/docs/guides/status-codes/): the canonical retryability reference behind the failure-class axis.
- Cloud Native Design Patterns, the *API Error Handling* appendix, for the same stable-code and retryable-flag error contract applied across REST, gRPC, Kafka and GraphQL.
