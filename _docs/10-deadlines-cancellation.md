---
title: "Deadlines, timeouts and cancellation"
order: 10
part: "Reliability: Deadlines, Errors & Interceptors"
description: "A deadline as an absolute budget that travels with a call, carved into a downstream slice, and the cancellation that follows when it runs out."
duration: "18 min read"
---

## Learning objectives

By the end of this chapter you can:

- Distinguish a deadline (a point in time) from a timeout (a duration), and say why only a deadline survives multiple hops.
- Carve a downstream deadline from the inbound one minus a margin (`Context.current().getDeadline()` on Quarkus, `context.time_remaining()` on Python), and fail fast when nothing is left.
- Explain how each stack propagates cancellation to in-flight work, and why a blocked thread can't honor it.
- Retry `DEADLINE_EXCEEDED` only when the call is idempotent and the caller still has budget.

## Why this matters

`RoutingService.GetQuote` now calls a second service, `QuoteService.GetQuote`, over its own gRPC hop, and that service takes two seconds to answer. The caller's deadline decides the outcome. A generous deadline gets a quote. A tight one gets `DEADLINE_EXCEEDED` in well under two seconds, because the server on the far side learns its answer no longer matters and stops producing it. The booking service's REST budget has to be split across every hop behind it, and each hop needs to know how much is left.

## Pattern: Deadline propagation

### The problem

A timeout is a duration: "wait three seconds." A deadline is a point in time: "answer by 14:32:07.500." The difference shows once a call crosses more than one hop. A timeout restarts at each hop, so a chain of three three-second timeouts can take nine seconds although the caller only had three seconds of patience.

Without any deadline the problem is worse. gRPC lets a client send none, and a server calling a dependency the same way has no bound on the wait for a downstream service wedged on a lock, a connection open but making no progress, or a partition that never resolves. The request keeps a thread, coroutine or connection slot for as long as the other end is silent. One hung call costs one slot. Under load, the service runs out of slots and the failure is no longer "this request is slow" but "nothing can serve a new request."

### The solution

**A deadline fixes one moment on the clock at the top of the call chain, and every hop derives its own deadline from the time that remains.**

On the wire, the client sends a `grpc-timeout` header with a relative duration, because clocks across machines disagree. The server converts it at once into an absolute deadline on the call's context. From then on, "how much time is left" has one answer inside the handler, with no per-layer duration to re-derive. Set a deadline on every call.

A customer's `POST /bookings/{id}/confirmation` reaches the booking service's REST handler with a budget it owns outright, say two seconds. That budget covers the handler's own work, the call to `RoutingService.GetQuote`, and whatever `GetQuote` spends on `QuoteService.GetQuote`. The handler converts its remaining HTTP budget into the gRPC deadline on `GetQuote` instead of inventing a fresh one. `GetQuote` then can't pass the inbound deadline downstream unchanged, because some of it is spent and more belongs to building the request and the response. The downstream deadline is the remaining budget minus a margin for this method's own work.

{% include excalidraw.html file="10-deadline-propagation" alt="Two lanes showing the same chain (booking service, RoutingService.GetQuote, QuoteService.GetQuote) with a 10-second client deadline and with a 1-second one. With 10 seconds, RoutingService carves a downstream slice of about 9.9 seconds, QuoteService's 2-second delay completes inside it, and OK flows back. With 1 second, the slice is about 0.9 seconds, the QuoteService call is cancelled partway through its delay, and DEADLINE_EXCEEDED flows back up both hops." caption="Figure 10.1: The same downstream delay, two outcomes, decided by how much budget the client handed over." %}

### How Quarkus and Python model it

A fixed per-client duration can't tell a caller with nine seconds left from one with ninety milliseconds left. Quarkus has `quarkus.grpc.clients."service-name".deadline`, but it is a ceiling applied to every call a stub makes, not a request-scoped budget. Both stacks read the remaining time instead.

On Quarkus, grpc-java attaches the inbound `Deadline` to the call's context, so `Context.current().getDeadline()` reaches it without threading it through method signatures. On Python, `context.time_remaining()` returns seconds, or `None` when the caller set no deadline.

{% include codetabs.html langs="Quarkus|Python" %}

```java
        Deadline inbound = Context.current().getDeadline();
        long downstreamBudgetMs = inbound != null
                ? inbound.timeRemaining(TimeUnit.MILLISECONDS) - DOWNSTREAM_MARGIN_MS
                : DEFAULT_DOWNSTREAM_BUDGET_MS;

        if (downstreamBudgetMs <= 0) {
            // The budget was already gone before this method could even start the
            // downstream call. Failing fast here, with no network round trip at
            // all, is cheaper than letting grpc-java discover the same thing a few
            // milliseconds later over the wire.
            LOG.infof("GetQuote: %s -> %s, no budget left to call QuoteService (inbound deadline already expired)",
                    origin.getUnLocode(), destination.getUnLocode());
            return Uni.createFrom().failure(Status.DEADLINE_EXCEEDED
                    .withDescription("no budget remaining to call QuoteService.GetQuote")
                    .asRuntimeException());
        }
```

```python
        remaining = context.time_remaining()
        if remaining is None:
            downstream_timeout = _DEFAULT_DOWNSTREAM_TIMEOUT_S
        else:
            downstream_timeout = remaining - _DOWNSTREAM_MARGIN_S
            if downstream_timeout <= 0:
                # The budget was already gone before this method could even start
                # the downstream call. Failing fast here, with no network round
                # trip at all, is cheaper than letting grpc.aio discover the same
                # thing a few milliseconds later over the wire.
                logger.info(
                    "GetQuote: %s -> %s, no budget left to call QuoteService "
                    "(inbound deadline already expired)",
                    origin.un_locode,
                    destination.un_locode,
                )
                await context.abort(
                    grpc.StatusCode.DEADLINE_EXCEEDED,
                    "no budget remaining to call QuoteService.GetQuote",
                )
```

The handler then passes what is left to the downstream stub: `withDeadlineAfter(downstreamBudgetMs, TimeUnit.MILLISECONDS)` on Quarkus, `timeout=downstream_timeout` on Python.

Two rules sit in that code:

- **Fail fast.** When the slice is zero or negative, neither stack dials `QuoteService`. A round trip whose answer would arrive after the deadline costs a slot and gains nothing. Quarkus returns an already-failed `Uni` with `DEADLINE_EXCEEDED`; Python calls `context.abort` with the same code.
- **Handle no deadline.** A handler that assumes a number will crash on exactly the caller least likely to notice. Both stacks fall back to a fixed default only when no deadline arrived, so a caller who sent one always gets a slice derived from it.

The REST handler's budget is therefore split by arithmetic. A deadline that is too generous lets `QuoteService` run long. One that is too tight starves `GetQuote` before it reaches its downstream call.

## Cancellation: when the clock runs out, the work stops

An expired deadline cancels the call, and a well-behaved server treats that as an instruction to stop. A server that keeps computing an answer nobody will receive wastes what the deadline exists to protect.

Each stack sees cancellation through its own idiom:

- **Quarkus.** `QuoteServiceImpl` models its two-second delay as a Mutiny pipeline, `Uni.createFrom().item(...).onItem().delayIt().by(Duration.ofSeconds(2))`. When the downstream deadline expires, grpc-java cancels the client call, the subscriber on this `Uni` goes away, and Mutiny tears down the timer immediately. `RoutingServiceImpl` can also check `Context.current().isCancelled()`, which it does when logging a failed downstream call.
- **Python.** `QuoteServiceServicer` awaits `asyncio.sleep(2.0)` inside a task. When `grpc.aio` cancels the task, `asyncio.sleep` raises `asyncio.CancelledError` at once instead of finishing. A handler can catch it to log the early exit, then re-raise so the cancellation keeps propagating. The caller, `RoutingServiceServicer`, sees an `AioRpcError` with `DEADLINE_EXCEEDED` from the awaited downstream call, and `context.cancelled()` tells it whether its own inbound call triggered the chain.

The shared lesson is the abstraction, not the API. In-flight work modeled as a reactive pipeline or an awaitable lets the runtime deliver cancellation as an event the handler can act on. A thread blocked in `Thread.sleep` or any synchronous wait can't be interrupted early, however aggressively the caller cancels.

{% include excalidraw.html file="10-cancellation-propagation" alt="Two lanes showing a client's deadline expiring. In the top lane, QuoteServiceImpl models its two-second delay as a Mutiny Uni or an asyncio task; the cancellation arrives as an event and the work is torn down at about 0.9 seconds. In the bottom lane, a naive implementation blocks a thread on Thread.sleep(2000); the cancellation has no hook to interrupt the wait, so the sleep runs its full two seconds and the result is discarded because nobody is listening." caption="Figure 10.2: A cancelled call either tears down in-flight work at once or lets a blocked thread run to completion for no one." %}

## Retrying DEADLINE_EXCEEDED

The code alone doesn't say whether a retry is worth it. Retry only when both conditions hold:

| Condition | Why |
| --- | --- |
| The call is idempotent | The deadline says no answer arrived in time, not that the call didn't run. Repeating a write may do it twice. |
| The caller has budget left | A second attempt against an exhausted clock fails for the same reason as the first. |

`GetQuote` is a pure read, so the first condition holds. The second doesn't automatically: a caller whose own deadline has elapsed has no budget to spend, however safe the retry would be. A retry policy keyed on this code has to check the caller's remaining time as well as the code.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>RPC shape and sync vs. stream are unchanged: <code>GetQuote</code> is one unary question and one unary answer on both legs of the chain. Deadline and budget: the inbound deadline on <code>RoutingService.GetQuote</code> is never reused as is on the call to <code>QuoteService.GetQuote</code>; it is reduced by a margin for the method's own work and checked against zero before the downstream call starts. Failure class: <code>DEADLINE_EXCEEDED</code> from this idempotent read is retryable only while the caller's own budget covers another attempt. Concurrency model: the two-second delay is a Mutiny pipeline or an <code>asyncio</code> coroutine, never a blocked thread, so a downstream deadline's expiry stops the work instead of only the wait.</p></div>

> **🤖 Explore with your agent**
>
> "In examples/10-deadlines-cancellation, change `DOWNSTREAM_MARGIN_MS` in `RoutingServiceImpl.java` and `_DOWNSTREAM_MARGIN_S` in `app/routing_service.py` from 100 ms to 500 ms. Keep deriving the downstream deadline from the inbound one, never from a fixed per-client duration, and keep the fail-fast branch when the slice is zero or negative."
>
> Check: `grpcurl -plaintext -max-time 1 ... localhost:9100 shipping.routing.v1.RoutingService/GetQuote` still ends in `DeadlineExceeded` in about a second, and the Routing log shows a downstream deadline near 500 ms instead of 900 ms.

## Build, run, observe

`RoutingService.GetQuote` and `QuoteService.GetQuote` run in one process per stack, joined by a loopback gRPC channel, so the hop is real. Quarkus listens on host port 9100 and Python on 9101.

```bash
cd examples/10-deadlines-cancellation
./verify.sh
```

`verify.sh` runs the same request on both stacks twice, once with a tight deadline and once with a generous one, and prints `PASS` when the tight call fails with `DEADLINE_EXCEEDED` and the generous call returns the quote. To run it by hand, start the stacks with `docker compose up --build`, then:

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

Port 9101 answers identically: the same code for the tight call, and for the generous call the same quote, 1000 kg at 2.50, `"2500.00"`. `QuoteService`'s delay never changes between the two calls. Only the budget the caller can afford does.

- **Use a 1-second deadline and read the `QuoteService` log.** The service logs that the downstream deadline expired and it abandoned the delay early, instead of finishing the two seconds.
- **Use a 10-second deadline.** The downstream slice is about 9.9 seconds and the call returns `OK` with the quote.

## For deeper coverage

- Sam Newman, *Building Resilient Distributed Systems: Patterns and Practices for Stable Software* (O'Reilly, 2026): budgets, timeouts, and deadline propagation.
- *Cloud Native Design Patterns*, "Failure Modes" chapter: timeout and cancellation as failure-handling patterns.
- [grpc.io: Deadlines guide](https://grpc.io/docs/guides/deadlines/): the `grpc-timeout` header and per-stack deadline APIs.
- [Quarkus gRPC: client configuration](https://quarkus.io/guides/grpc-service-consumption): `quarkus.grpc.clients."service-name".deadline` and why it is a fixed ceiling, not a propagated budget.
