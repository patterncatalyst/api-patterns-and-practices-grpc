---
title: "Deadlines, timeouts and cancellation"
order: 10
part: "Reliability: Deadlines, Errors & Interceptors"
description: "A deadline as an absolute budget that travels with a call, propagated down a chain, and the cancellation that follows when it runs out."
duration: "21 min read"
---

Every `RoutingService.GetQuote` call this site has shown so far ran to completion in milliseconds, so nothing about timing has mattered yet. Chapter 2 named "deadline and budget" as one of the five axes a call's shape has to answer, and flagged this exact call as the one with the tightest version of that answer — a slice of the booking service's own REST budget, carved off before a downstream hop. This chapter makes that carving real. `RoutingService.GetQuote` now calls a second service, `QuoteService.GetQuote`, over its own gRPC hop, and that downstream service is slow enough — an artificial two-second delay — that the caller's deadline decides the outcome. A generous deadline gets a quote. A tight one gets `DEADLINE_EXCEEDED`, in well under two seconds, because the server on the other end of that hop finds out its answer no longer matters and stops producing it.

## Deadline, not timeout

A timeout is a duration: "wait three seconds." A deadline is a point in time: "answer by 14:32:07.500." The distinction looks pedantic until a call crosses more than one hop, which is exactly what `GetQuote` does in this chapter. A timeout measured independently at each hop resets the clock every time a new duration starts counting down, so a chain of three three-second timeouts can legally take nine seconds end to end, even though the caller who started the chain only ever had three seconds of patience. A deadline fixes a moment on the wall clock once, at the top of the chain, and every hop downstream inherits the same moment — asking not "how long may I run" but "how much of the time I was already given is left."

gRPC's wire representation makes this concrete. A client that sets a deadline sends a `grpc-timeout` header carrying a relative duration from the moment the call leaves the client — relative because clocks across machines don't agree closely enough to send an absolute timestamp — and the server converts it immediately into an absolute `Deadline` on the call's own context. From that point forward, inside the server handling the call, "how much time is left" is a well-defined question with one answer, not something each layer of the handler has to re-derive from a duration it was separately configured with.

The rule this site holds every call to — set a deadline on every call — follows directly from what happens without one. gRPC permits a client to send no deadline at all, and a server that calls a dependency the same way has no way to bound how long it waits for an answer that may never come: a downstream service wedged on a lock, a connection that's technically open but has stopped making progress, a network partition that never resolves cleanly. Nothing in gRPC's framing forces that call to give up on its own: the request stays open and the resources backing it (a thread, a coroutine, a connection slot) stay allocated as long as the other end stays silent. One hung call costs one slot; a service that leaks slots this way under load eventually has none left, and the failure mode is not "this request is slow" but "nothing can serve a new request." A deadline bounds that wait on a schedule the caller chose.

## Propagating a deadline down a chain

The REST→gRPC seam Chapter 2 introduced is where a deadline usually starts its life in this system. A customer's `POST /bookings/{id}/confirmation` lands on the booking service's REST handler with a budget that handler owns outright — call it two seconds, after which its own HTTP response is itself judged too slow by whatever's waiting on it. That budget has to cover everything the handler does before it can answer: its own processing, the call to `RoutingService.GetQuote`, and whatever `GetQuote` spends on its own downstream call to `QuoteService.GetQuote`. The REST handler converts its remaining HTTP budget into a gRPC deadline on the `GetQuote` call rather than inventing a fresh one — a budget crossing a protocol boundary, carried as data rather than re-decided twice.

`RoutingService.GetQuote` receives that deadline as a `Deadline` attached to its own call context, the one grpc-java (and its Python equivalent) populated from the inbound `grpc-timeout` header. What happens next is this chapter's subject: `GetQuote` has its own downstream call to make, and the deadline it hands that call can't be the one it received unchanged. Some budget is already spent reaching this point, and more belongs to the work of building the downstream request and assembling a response once one returns. The correct downstream deadline is the remaining budget minus a margin for this method's own overhead; reusing the inbound deadline directly leaves no room on either side of the downstream call.

{% include excalidraw.html file="10-deadline-propagation" alt="Two lanes showing the same three-hop chain — booking service, RoutingService.GetQuote, QuoteService.GetQuote — once with a 10-second client deadline and once with a 1-second one. In the generous lane, RoutingService carves a downstream slice of about 9.9 seconds, QuoteService's 2-second artificial delay completes inside it, and OK responses flow back up both hops. In the tight lane, RoutingService carves a downstream slice of about 0.9 seconds, QuoteService's call is cancelled partway through its 2-second delay before it can finish, and DEADLINE_EXCEEDED flows back up both hops instead." caption="Figure 10.1 — The same downstream delay, two different outcomes, decided entirely by how much budget the client handed over up front." %}

Carving the slice correctly pays off when the remaining budget is too small to be worth spending. If `GetQuote` has only a few milliseconds left by the time it would call `QuoteService`, starting that call means paying for a round trip whose answer arrives after the deadline it needed to beat. Failing with `DEADLINE_EXCEEDED` immediately when the budget is exhausted or negative costs nothing — the call was going to fail either way, and failing without a round trip frees the slot sooner. This chapter's example implements that check on both stacks.

## Carving the downstream slice: RoutingService.GetQuote calls QuoteService.GetQuote

Neither stack reaches for a fixed, per-client timeout to size the downstream call, because a static duration can't distinguish a caller with nine seconds left from one with ninety milliseconds left. Quarkus does offer `quarkus.grpc.clients."service-name".deadline`, a duration applied to every call a stub makes, but the Quarkus documentation calls out that it isn't meant as a request-scoped timeout — a fixed ceiling, not a propagated budget. Both stacks read the actual remaining time instead and derive the downstream deadline from it.

On Quarkus, `Context.current().getDeadline()` returns the `Deadline` grpc-java attached to the inbound call — the same mechanism that makes a deadline "ambient" to a call's handling code rather than something that has to be threaded through every method signature by hand. `RoutingServiceImpl` reads that deadline's remaining time, subtracts a small margin for its own overhead, and passes what's left to the injected `@GrpcClient` stub's `withDeadlineAfter` method before invoking `QuoteService.GetQuote`:

{% include codetabs.html langs="Quarkus|Python" %}

```java
Deadline inbound = Context.current().getDeadline();
long downstreamBudgetMs = inbound != null
        ? inbound.timeRemaining(TimeUnit.MILLISECONDS) - DOWNSTREAM_MARGIN_MS
        : DEFAULT_DOWNSTREAM_BUDGET_MS;

if (downstreamBudgetMs <= 0) {
    return Uni.createFrom().failure(Status.DEADLINE_EXCEEDED
            .withDescription("no budget remaining to call QuoteService.GetQuote")
            .asRuntimeException());
}

return quoteClient.withDeadlineAfter(downstreamBudgetMs, TimeUnit.MILLISECONDS)
        .getQuote(downstreamRequest)
        .onItem().transform(quoteResponse -> buildResponse(origin, destination, quoteResponse.getQuote()));
```
```python
remaining = context.time_remaining()
if remaining is None:
    downstream_timeout = _DEFAULT_DOWNSTREAM_TIMEOUT_S
else:
    downstream_timeout = remaining - _DOWNSTREAM_MARGIN_S
    if downstream_timeout <= 0:
        await context.abort(
            grpc.StatusCode.DEADLINE_EXCEEDED,
            "no budget remaining to call QuoteService.GetQuote",
        )

quote_response = await self._quote_stub.GetQuote(downstream_request, timeout=downstream_timeout)
```

Python's `grpc.aio.ServicerContext.time_remaining()` answers the same question in seconds rather than a `Deadline` object, including the same `None` case for a caller that set no deadline at all — gRPC never requires one, and a handler that assumes it always has a number to subtract from will crash on exactly the caller least likely to notice anything is wrong. Both snippets fall back to a fixed default only in that no-deadline case, never as the general path — a caller who sent a deadline always gets a downstream slice derived from it.

Both handlers also show the fail-fast case from the previous section directly: when the computed downstream budget is zero or negative, neither stack dials `QuoteService` at all. Quarkus returns an already-failed `Uni` carrying `Status.DEADLINE_EXCEEDED`; Python calls `context.abort` with the same code — both answers reach the original caller immediately, without a wasted round trip to a call that had no chance of finishing in time.

## Cancellation: when the clock runs out, the work stops

Setting the downstream deadline correctly is half the story; the other half is what `QuoteService` does once that deadline actually expires mid-call. An expired gRPC deadline cancels the call rather than silently abandoning it from the caller's side alone, and a well-behaved server treats that cancellation as an instruction to stop working, not a fact it can ignore because no one is listening for the answer anymore. A server that keeps computing an answer nobody will receive wastes exactly the resources a deadline exists to protect.

Each stack observes that cancellation through its own idiom, because each represents "a unit of in-flight asynchronous work" differently. On Quarkus, `QuoteServiceImpl`'s artificial two-second delay is a Mutiny `Uni` pipeline — `Uni.createFrom().item(...).onItem().delayIt().by(Duration.ofSeconds(2))` — rather than a blocked thread sleeping on a timer it can't wake early from. When the downstream deadline expires, grpc-java cancels the client call; that propagates server-side as the subscriber on this `Uni` going away, and Mutiny tears down the delay's underlying timer the moment nothing is listening for its result, instead of letting it run out its full two seconds into the void. `RoutingServiceImpl` can also check `Context.current().isCancelled()` directly, which it does when logging a failed downstream call.

Python's equivalent is `asyncio`'s own cancellation model. `QuoteServiceServicer`'s delay is `await asyncio.sleep(2.0)` inside a coroutine running as an `asyncio.Task`. When `grpc.aio` cancels that task in response to the expired deadline, `asyncio.sleep` raises `asyncio.CancelledError` at the point of cancellation rather than running out its remaining duration, immediately unwinding the coroutine's `await`. A handler that wraps the sleep in `try`/`except asyncio.CancelledError` sees that exception the moment it happens, can log the early exit, and re-raises it to let the cancellation keep propagating — the pattern `QuoteServiceServicer` uses. `RoutingServiceServicer`, the caller of that coroutine, observes the same event as a `grpc.aio.AioRpcError` with code `DEADLINE_EXCEEDED` raised from the awaited downstream call, and can check `context.cancelled()` to confirm whether its own inbound call triggered the chain.

What both mechanisms share is the shape of the fix, not the API: a server that models in-flight work as a cancellable abstraction — a reactive pipeline, an awaitable coroutine — has the runtime deliver a cancelled-downstream-call signal as an event the handler can act on directly. A server that instead blocks a thread on `Thread.sleep` or an equivalent synchronous wait has no way to interrupt that wait early, no matter how aggressively the caller above it cancels. Chapter 15 returns to this distinction under the heading of backend I/O concurrency; this chapter's version of it is narrower and more concrete: the two-second delay in this example is abandoned mid-flight under a tight deadline, confirmed by the log line each stack emits when it happens, not merely declared abandoned in the client's error message while the server quietly finishes the work regardless.

{% include excalidraw.html file="10-cancellation-propagation" alt="Two stacked lanes showing the same event — a client's deadline expiring and cancelling the call — with two different server outcomes. In the top, green-tinted lane, QuoteServiceImpl models its two-second delay as a Mutiny Uni pipeline or an asyncio Task; the cancellation arrives as an event, the subscriber or task goes away, and the work is torn down mid-flight at about 0.9 seconds, shown as a dashed, faded box. In the bottom, red-tinted lane, a naive QuoteServiceImpl blocks a thread on Thread.sleep(2000); the same cancellation signal arrives but there is no hook to interrupt the wait, so the sleep keeps running for its full two seconds, shown as a solid dark box, and the result it eventually computes is discarded because nobody is still listening for it." caption="Figure 10.2 — a cancelled call either tears down the server's in-flight work immediately or lets a blocked thread run to completion for no one." %}

## Retryability and DEADLINE_EXCEEDED

`DEADLINE_EXCEEDED` sits in an odd spot in gRPC's retry taxonomy, because whether it's worth retrying depends on information the error code alone doesn't carry. Chapter 2 named the rule in passing and Chapter 11 builds the full retryable/non-retryable framework on top of it; this chapter is where the rule has a concrete call to test it against. Retrying it only makes sense when two conditions both hold: the call is idempotent, so running it again doesn't double an effect that already happened, and there's budget remaining to retry with, since a second attempt against the same exhausted clock fails identically for the same reason the first one did.

`GetQuote` satisfies the first condition cleanly — it's a pure read with no side effect to duplicate, so retrying it is never unsafe in the way retrying `RecomputeRoutes` or a payment confirmation would be. It doesn't automatically satisfy the second: a caller whose own deadline has already elapsed by the time `GetQuote` returns `DEADLINE_EXCEEDED` has no budget left to spend on a retry, no matter how safe that retry would otherwise be. A `DEADLINE_EXCEEDED` worth retrying is one where the caller's own clock still has room — a transient slowdown that ate into the first attempt's budget without exhausting the caller's — which is why a retry policy keyed on this code has to check the caller's remaining time, not just the code on the failed response, before deciding to try again.

## The REST→gRPC seam, revisited

Chapter 2 described this seam before anything ran; Chapter 5 made `GetQuote` itself run; this chapter is where the seam's deadline half becomes a claim worth checking rather than a diagram. The booking service's REST handler still converts its own remaining HTTP budget into the gRPC deadline it sets on `GetQuote` — nothing about that conversion changed. What's new is that the conversion now has a second hop depending on it: `GetQuote`'s own downstream call inherits a slice of whatever deadline crossed that REST boundary, so a REST handler that sets too generous a deadline hands `QuoteService` enough room to also run long, and one that sets too tight a deadline starves `GetQuote` of enough budget to ever reach its own downstream call. The REST→gRPC seam was always the point where one budget becomes another; this chapter shows what happens two hops past that seam when the arithmetic doesn't leave enough for the second hop.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Run this chapter's downstream call through Chapter 2's five axes. RPC shape and sync vs. stream are unchanged from Ch5 — <code>GetQuote</code> is still a single unary question with a single unary answer, called synchronously, on both legs of this chain. Deadline and budget is where this chapter does its work: the inbound deadline on <code>RoutingService.GetQuote</code> is not reused unmodified on the call to <code>QuoteService.GetQuote</code>; it's reduced by a margin covering this method's own overhead, and checked against zero before the downstream call is attempted at all, so a budget too small to be worth spending fails immediately rather than after a doomed round trip. Failure class and retryability follow the rule this chapter named concretely: <code>DEADLINE_EXCEEDED</code> from this idempotent read is safe to retry only when the caller's own remaining budget can still cover another attempt, never on the strength of the code alone. Concurrency model is why both stacks implement the two-second delay as a cancellable abstraction — a Mutiny pipeline, an <code>asyncio</code> coroutine — rather than a blocked thread: only a cancellable representation of in-flight work lets a downstream deadline's expiry actually stop that work, instead of merely stopping the caller from waiting on it.</p></div>

## Where this goes next

The downstream call this chapter adds — `RoutingService.GetQuote` to `QuoteService.GetQuote` — stays in place for the reliability chapters that follow to build on. Chapter 11 returns to this exact call to show what a rich `google.rpc.Status` looks like when `QuoteService` itself rejects a request, rather than merely running out of time to answer one. Chapter 12 wraps a client interceptor around the downstream call this chapter hand-wrote inline, so the deadline-carving logic here becomes something every outbound call gets automatically rather than something every handler repeats. Chapter 17 comes back to the artificial two-second delay under load, once a slow downstream dependency isn't a single call away from timing out but one of many competing for a shared pool of concurrent calls. And Chapter 22's service mesh chapter adds a second way to bound a slow call — a mesh-level timeout enforced outside either service's own code — which this chapter's application-level deadline continues to complement rather than replace.

## On the wire

`verify.sh` runs the identical `GetQuote` request against both stacks twice, once with a tight client deadline and once with a generous one, using `grpcurl`'s `-max-time` flag to set it:

```bash
# Tight: 1s deadline, QuoteService needs ~2s -> fails fast, not after 2s.
grpcurl -plaintext -max-time 1 -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"},
  "cargo": [{"weightKg": 1000}]
}' localhost:9100 shipping.routing.v1.RoutingService/GetQuote
# ERROR: Code: DeadlineExceeded

# Generous: 10s deadline, comfortably more than QuoteService needs -> OK.
grpcurl -plaintext -max-time 10 -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"},
  "cargo": [{"weightKg": 1000}]
}' localhost:9100 shipping.routing.v1.RoutingService/GetQuote
# { "quote": { "currency": "USD", "amount": "2500.00" }, "route": { "id": "rte_USNYC-NLRTM", ... } }
```

Swap port `9100` for `9101` and the Python stack answers identically: the same tight deadline fails with the same code, the same generous one returns the same quote — `1000kg × 2.50 = "2500.00"`, the same formula every earlier chapter's `GetQuote` has used. `verify.sh` asserts both outcomes against both stacks before it prints `PASS`: `DEADLINE_EXCEEDED` for the 1-second call, and `quote.currency`, `quote.amount`, `route.id`, `route.legs[0].carrier`, and `route.price.amount` for the 10-second one. `QuoteService`'s own two-second delay never changes between these two calls — the only thing that changes is how much of it the caller's deadline can afford, which is the whole chapter in one assertion.
