---
title: "The gRPC decision framework"
order: 2
part: "Why gRPC, and the Decision Lens"
description: "Five axes for classifying any call — RPC shape, sync vs. stream, deadline and budget, failure class, and concurrency model — the lens every later chapter applies in a Decision callout."
duration: "16 min read"
---

`RoutingService.GetQuote` is a single request that returns a single response in well under a second. `TrackingService.WatchShipment` opens a connection that stays open for hours, pushing an event every time a container's position changes. `RoutingService.RecomputeRoutes` kicks off work that might take minutes and hands back an `Operation` to poll instead of an answer. All three are gRPC methods against the same Protobuf contract, served by the same two stacks, and they are three different shapes, not variations on one — treating them as interchangeable is how a service ends up blocking a thread for an hour or polling a stream that was never going to produce a second message.


This chapter names the five questions that tell you which shape an interaction needs: RPC shape, sync call vs. stream, deadline and budget, failure class and retryability, and concurrency model. Every chapter from here forward ends with a short callout labeled **Decision** that runs its topic through these same five axes, so the vocabulary defined here gets reused, not re-derived. Chapter 1 established why gRPC exists as a protocol; this chapter establishes how to decide what gRPC should do with any one call in the shipping domain.

## RPC shape

The first question is the one that eliminates the most options fastest: does this interaction produce exactly one response, a sequence of responses, a sequence of requests, or both at once? Protobuf's service definitions name all four shapes directly, and the shipping contract uses every one of them for a reason tied to the interaction, not to variety for its own sake.

```protobuf
rpc GetQuote(GetQuoteRequest) returns (GetQuoteResponse);                 // unary
rpc WatchShipment(WatchShipmentRequest) returns (stream WatchShipmentResponse); // server-streaming
rpc ReportPositions(stream ReportPositionsRequest) returns (ReportPositionsResponse); // client-streaming
rpc NegotiateRoute(stream NegotiateRouteRequest) returns (stream NegotiateRouteResponse); // bidirectional
```

`RoutingService.GetQuote` is unary because pricing a shipment is a single question with a single, immediately-known answer: given an origin, a destination, and a cargo manifest, what does the route cost. Nothing produces more than one value, so a stream would add bookkeeping — flow control, ordering, a half-close protocol — for no benefit. `TrackingService.WatchShipment` is server-streaming because a shipment's location is a sequence of facts arriving over the life of a voyage, and the caller wants each one as it happens rather than re-asking on a timer. `TrackingService.ReportPositions` inverts that: a telemetry agent has many position reports to hand off and wants one acknowledgment, which is client-streaming, not a loop of unary calls paying a round trip per report. `RoutingService.NegotiateRoute` is bidirectional because negotiation is a back-and-forth where either side sends at a time of its own choosing, which fits a conversation, not a transaction.

Picking the shape first matters because the remaining four axes behave differently depending on it. A deadline on a unary call bounds one round trip; a deadline on a streaming call bounds how long the stream may stay open — a different number entirely.

{% include excalidraw.html file="02-four-rpc-shapes" alt="A two-by-two grid crossing request cardinality against response cardinality to produce the four RPC shapes. Top-left, single request and single response, is unary, tagged with RoutingService.GetQuote. Top-right, single request and a stream of responses, is server-streaming, tagged with TrackingService.WatchShipment. Bottom-left, a stream of requests and a single response, is client-streaming, tagged with TrackingService.ReportPositions. Bottom-right, a stream of requests and a stream of responses, is bidirectional, tagged with RoutingService.NegotiateRoute." caption="Figure 2.1 — request cardinality crossed with response cardinality resolves to the four RPC shapes." %}

## Sync call vs. stream

RPC shape answers *what pattern* the interaction follows; this axis asks a narrower, operational question: does the caller block waiting for one value, or hold a connection open and consume values as they arrive? The cost of each should drive the choice, not a preference for one style.

A synchronous unary call like `GetQuote` costs one round trip and releases every resource it held — the HTTP/2 stream, any buffers, any connection state — the moment the response arrives; the caller's code can treat it like a function call. A stream costs something continuous: the server holds state for the life of the connection, and both sides need a story for a network blip mid-stream rather than before or after one exchange. `WatchShipment` is worth that cost because the alternative — polling a tracking endpoint every few seconds for a voyage that can last weeks — wastes far more connections and still delivers events late. A reroute kicked off by `RecomputeRoutes` is worth neither a blocking call nor a stream; it returns an `Operation` immediately and lets the caller poll or subscribe on its own terms, decoupling the work's duration from any one connection's.

Default to a synchronous unary call — it's the cheapest shape to run and to reason about. Reach for a stream only when the interaction is a sequence over time the caller needs as it happens, and for an async operation when the work is long but nobody needs to watch it live.

## Deadline & budget

Every gRPC call in this system carries a deadline, which is not an afterthought bolted onto a request that would otherwise run forever — it's the caller stating, up front, the longest an answer is still useful. A `GetQuote` call that completes correctly in eleven seconds is still a failure if the booking flow that triggered it only had three seconds of patience, because the customer has already seen a timeout by the time the quote arrives.

The harder part of this axis is dividing a budget across a chain of calls, not setting one deadline in isolation. When the REST booking service accepts a `POST /bookings/{id}/confirmation` request, it has a total budget for that HTTP response — say two seconds, after which its own caller gives up. That budget has to cover the booking service's own processing, the hop to `RoutingService.GetQuote`, and whatever `GetQuote` spends calling `QuoteService.GetQuote` downstream. The REST→gRPC seam is exactly this moment: the booking service carves a slice out of the budget it already has rather than inventing a fresh one, so a three-hop chain shares one clock instead of three independent ones that together blow through the caller's patience. Chapter 10 covers deadline propagation end to end; the decision here is simpler — name the deadline as a fraction of the budget you were given.

A deadline that's too tight fails calls that would have succeeded; one that's too loose lets a slow dependency hold the whole chain hostage. The fix is sizing the slice correctly, informed by what the downstream call actually costs under normal load.

## Failure class & retryability

Not every failure means the same thing, and treating them the same is how a client retries a bug into a storm or gives up on a problem that would have gone away a second later. gRPC's canonical status codes let a caller tell these apart without parsing an error string. `UNAVAILABLE` says the server or network couldn't be reached right now — retry, with backoff, since the condition is often transient. `DEADLINE_EXCEEDED` is retryable only if the call is idempotent and budget remains; retrying a non-idempotent call that already partially executed risks doing the work twice. `RESOURCE_EXHAUSTED` says the server is shedding load to protect itself, which calls for backoff, not an immediate resend that adds to the pressure.

Other codes aren't retryable, because retrying doesn't change the outcome: `INVALID_ARGUMENT` means the request is malformed and will fail the same way again; `NOT_FOUND` and `ALREADY_EXISTS` describe the state of the world rather than a glitch reaching it; `FAILED_PRECONDITION` and `PERMISSION_DENIED` mean something has to change first. `GetQuote` is a pure read, safe to retry on `UNAVAILABLE` or `DEADLINE_EXCEEDED` with no idempotency bookkeeping. `RecomputeRoutes`, by contrast, starts work; retrying it blindly risks kicking off two recomputations, which is why an idempotency key and a status check against the `Operation` matter more there. Chapter 11 builds the full rich-error-model story; this axis just asks you to classify the failure before deciding whether to retry it.

## Concurrency model

The last axis is about the server, not the caller: given a method called many times concurrently, how does it execute those calls without blocking on I/O it doesn't need to block on, or spawning more threads than the machine can schedule. The right model follows the shape of the work, not a single house default.

On Quarkus, a blocking model — one thread per in-flight call — is simplest to reason about and fine as long as the pool is sized for the load, but becomes a liability once a downstream call like `QuoteService.GetQuote` is slow, because every blocked thread can't serve another request. A reactive model on Mutiny and Vert.x's event loop avoids that by never blocking a thread on I/O, at the cost of code written and read differently. Virtual threads split the difference: code stays in the familiar blocking style, but the runtime multiplexes thousands of them over a few OS threads, so a call waiting on `QuoteService` doesn't pin a scarce resource — exactly the case `GetQuote`'s I/O-bound fan-out suits.

On Python the same question is framed by the GIL: a synchronous `grpcio` server on a thread pool gets real concurrency for I/O-bound work, since threads release the GIL while waiting on a socket, but gains nothing from more threads than cores for CPU-bound work. `grpc.aio`'s asyncio server avoids the thread-pool ceiling entirely, running many concurrent calls on one thread as long as none block in-line. Real computation — scoring route candidates against live capacity — needs a worker pool regardless, because no async or virtual-thread trick makes CPU-bound work run faster by waiting less. Chapter 15 covers each stack's concurrency story; the decision here is whether a method's bottleneck is waiting or computing.

{% include excalidraw.html file="02-decision-framework" alt="Five labeled axes — RPC shape, sync call vs. stream, deadline and budget, failure class and retryability, and concurrency model — each feeding into a central decision box, which resolves to concrete example calls: RoutingService.GetQuote as a unary call with a tight deadline, TrackingService.WatchShipment as server-streaming, TrackingService.ReportPositions as client-streaming, and RoutingService.RecomputeRoutes as an async call returning an Operation." caption="Figure 2.2 — The five decision axes, reused in every Decision callout that follows." %}

## The REST→gRPC seam, and the cross-protocol question

The booking service's own decision to call `RoutingService.GetQuote` over gRPC, rather than computing a quote inline or calling out over plain REST, is itself an application of the first three axes. RPC shape says the interaction is a single question with a single answer, ruling out a stream. Sync vs. stream says the booking service wants to block until it has a price. Deadline and budget says it has a budget for its own REST response and has to carve a slice of it for the outbound call. Those three answers are why this boundary is gRPC and not another REST call: a unary, blocking, tightly-bounded, server-to-server request between two services the same organization deploys together is the case gRPC's binary framing and generated stubs were built for, where the REST site's own framework would land on REST for the opposite profile — a call serving a diverse, external client population that needs to be cacheable and loosely versioned.

That contrast generalizes past this one seam. gRPC, REST over HTTP/2, and WebSockets all move data between two parties, but disagree on what's built in. gRPC gives you generated stubs, a deadline on every call, and a canonical status-code vocabulary with no extra work; REST over HTTP/2 gives you a cacheable contract any browser or proxy already speaks, with none of gRPC's call semantics; a raw WebSocket gives you a full-duplex byte stream and nothing else — no deadlines, no status codes, no generated contract. Streaming interactions like `WatchShipment` could theoretically run on any of the three, and the choice turns on how much of gRPC's built-in machinery the interaction needs against how much client diversity it has to serve. Chapter 24 measures this trade-off directly, including where gRPC-over-HTTP/3 changes the calculus; this chapter's job is only to flag that the choice is downstream of the same five axes.

## The Decision callout, going forward

From this chapter on, every chapter ends with a callout labeled **Decision**. It is always the same move: take the chapter's topic, run it against the five axes above, and state in a few sentences where it lands and why. It is not a summary — it's the chapter's argument translated into shared vocabulary, so reading every Decision callout on the site in sequence reconstructs the book's reasoning without re-reading the prose that built it. When Chapter 8's Decision callout calls an interaction "server-streaming, long-lived, and tolerant of `UNAVAILABLE` retries on reconnect," it invokes RPC shape, sync vs. stream, and failure class by name, trusting this chapter already defined what those terms mean. Read this chapter once, and the short box at the bottom of every chapter after it becomes a checkable claim instead of a slogan.

## A worked decision: RoutingService.GetQuote

Apply the five axes to the method this site keeps returning to as its anchor: `RoutingService.GetQuote`, the call the booking service makes to price a shipment before confirming it.

RPC shape first. `GetQuote` takes an origin, a destination, and a cargo manifest, and returns one `Money` figure and one `Route`. There's no sequence of values and no reason to send more than one request, so the shape is unary.

Sync vs. stream follows directly: because the shape is unary, the natural mode is a synchronous call the booking service blocks on, not a stream. There's nothing to consume incrementally, and the booking service needs the quote before it can proceed.

Deadline and budget is where this call earns "tight." The booking service's REST request has a user-facing budget of a couple of seconds, and `GetQuote` sits ahead of a second hop into `QuoteService.GetQuote`. That leaves `GetQuote` a deadline of a few hundred milliseconds — tight enough that a slow downstream lookup fails fast instead of consuming the rest of the budget.

Failure class and retryability follow from what the call does: `GetQuote` performs no writes, so it's safe to retry on `UNAVAILABLE` or a budget-permitting `DEADLINE_EXCEEDED` with no idempotency bookkeeping. An `INVALID_ARGUMENT` — a malformed `Location` or an empty cargo list — is never worth retrying, since the same request produces the same rejection.

Concurrency model closes the loop. `GetQuote`'s work is dominated by the round trip to `QuoteService`, not by computation, making it I/O-bound on both stacks: Quarkus serves it well on virtual threads, Python serves it well on `grpc.aio`, because in both cases the server waits on a socket rather than computing and neither model should pin a thread for that wait.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p><code>RoutingService.GetQuote</code> is unary, because pricing a shipment is one question with one answer. It's a synchronous call the booking service blocks on, because there's nothing to stream and the caller needs the price before it can proceed. Its deadline is a tight slice of the booking service's own request budget, propagated rather than invented, because it sits mid-chain ahead of a second hop into <code>QuoteService</code>. Its failures split cleanly: <code>UNAVAILABLE</code> and budget-permitting <code>DEADLINE_EXCEEDED</code> are safe to retry because the call is a pure read, while <code>INVALID_ARGUMENT</code> never is. And because the work is I/O-bound rather than CPU-bound, it runs on whichever concurrency model avoids pinning a thread for the wait — virtual threads on Quarkus, <code>grpc.aio</code> on Python — rather than a thread-per-call model sized for compute it doesn't do.</p></div>

## Where this goes next

The five axes named here don't require Protocol Buffers or Buf to make sense in the abstract, but every concrete example in this site runs through both, so Chapter 3 goes deep on the contract language — messages, field numbers, the wire encoding that makes gRPC's binary framing cheaper than JSON — and Chapter 4 covers the well-known types that map to and from JSON at the edges. Chapter 5 turns `GetQuote` from a worked example into a running one: both stacks generate stubs from the same `.proto` file and get asserted against the contract in CI, the earliest point where "unary, tight deadline, I/O-bound" becomes a thing you can call with `grpcurl` and watch succeed. Deadlines get their full treatment in Chapter 10, the rich error model in Chapter 11, backend concurrency in Chapter 15, and the cross-protocol comparison seeded here gets measured in full in Chapter 24. Every one of those chapters closes with the same Decision callout this one just taught you how to read.
