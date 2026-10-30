---
title: "Async and long-running jobs over gRPC"
order: 16
part: "Concurrency & Long-Running Work"
description: "The server-owned Operation pattern with progress streaming, cancellation, and a rerunnable reconcile job."
duration: "24 min read"
---

## Learning objectives

By the end of this chapter you can:

- Design a server-owned `Operation` record (`id`, `kind`, `done`, `progress_pct`, `message`) as a handle to work that outlives the RPC that started it.
- Explain why `GetOperation`, `WatchOperation`, and `CancelOperation` belong on a dedicated `OperationsService` instead of `RoutingService`, and the quarkus-grpc source-breakage that forces the split.
- Choose between client-paced polling (`GetOperation`) and server-paced streaming (`WatchOperation`) for a long-running job.
- Distinguish server-owned cancellation (`CancelOperation`) from request-scoped cancellation (closing a watch stream), and implement a cooperative, `done`-checking cancellation guard.
- Build a rerunnable reconcile RPC like `RecomputeRoutes`, and explain why "rerunnable" is a different property than single-call idempotency.

## Why this matters

`RecomputeRoutes` has sat in `routing.proto` since Chapter 5's contract, returning `UNIMPLEMENTED` through every chapter that called `RoutingService` for something else: the one RPC in the service whose job was never a single request-response round trip but a background job that outlives the call that started it. This chapter gives it a body, and gives it three companions: `GetOperation`, `WatchOperation`, and `CancelOperation`, all added to the contract for this chapter, all operating on the same server-owned record, `shipping.type.v1.Operation`, and all three declared on a brand-new service, `OperationsService`, rather than tacked onto `RoutingService` itself. Chapter 15 asked how a server keeps answering other requests while one request's work is I/O-bound; this chapter asks a related but different question: what happens when a request's work doesn't finish inside the request at all, when the answer to "is this done yet" is "not yet, check back," and the client needs something to check back *with*.

## Why a call can't just wait

A unary RPC's contract is that the response is the answer: the client asks, the server computes or fetches, the response carries the result, and the call is over. That contract holds as long as "compute the result" fits inside a deadline a caller is willing to wait on, milliseconds to a few seconds, the range every previous chapter's examples have lived in. `RecomputeRoutes` reruns a routing optimization across however many lanes and carriers the catalog holds; on a real fleet, that's work measured in minutes, the kind no caller should block a thread, a connection, and a deadline waiting on. Stretching the unary deadline to cover the job's worst case doesn't fix this; it just changes which specific long wait is painful, and it gives up any way for the caller to check progress, change their mind, or walk away and come back later without losing the request entirely.

The fix is not a bigger deadline; it's a different RPC shape. `RecomputeRoutes` answers immediately, the same way every other RPC in this book has, but what it answers *with* is not the finished result: it's a handle to the still-running work, `shipping.type.v1.Operation`, a message this book's shared types file has carried since Chapter 2 for exactly this chapter (`id`, `kind`, `done`, `progress_pct`, `message`). The call that creates an `Operation` and the calls that check on it afterward are three separate RPCs, because "start this job," "how's it going," and "stop that job" are three different questions with three different cardinalities: one `RecomputeRoutes` per job, but as many `GetOperation` or `WatchOperation` calls as a client wants before the job finishes.

## The server-owned Operation record

`Operation` is small. `id` is an opaque, server-generated identifier (this chapter's examples prefix it `op_`, the same convention `Booking` and `Cargo` use for their own ids), and it is the only thing a client needs to remember between `RecomputeRoutes` and any later `GetOperation` or `WatchOperation` call; everything else about the job lives on the server, keyed by that id. `kind` names what the operation is doing (`"recompute_routes"` in this chapter's example), useful once a service has more than one kind of background job sharing one lookup surface. `done` is the single boolean a client checks to know whether to keep polling or watching; `progress_pct` is a best-effort number between 0 and 100 a UI can render as a progress bar, with no contract that it advances linearly, only that it starts below 100 and ends at exactly 100 the moment `done` becomes true. `message` carries a human-readable status line: what step the job is on, or, after a cancellation, why it stopped before reaching 100%.

{% include excalidraw.html file="16-operation-lifecycle" alt="A timeline diagram. Top band: a Client calls RecomputeRoutes on a RecomputeRoutes handler, which creates an Operation and returns immediately, labeled op_7f3a. Bottom band, labeled server-owned, outlives the call above: the same operation id shown at four points in time: done=false progress_pct=0, done=false progress_pct=40, done=false progress_pct=80, done=true progress_pct=100, connected by arrows labeled job advances and terminal. A caption below reads: the call that started the job returns long before the job finishes; the Operation record is the only thing that outlives it." caption="Figure 16.1: RecomputeRoutes returns instantly; the Operation record it creates keeps living, and keeps changing, after the call that created it has already returned." %}

What makes this a *server-owned* record, rather than just a response message with some extra fields, is where it lives and who can change it. A client cannot set `progress_pct` or flip `done`; those fields only ever change inside the process that owns the job, in response to the job's own progress or to a `CancelOperation` call the server itself processes. Compare that to the request-scoped cancellation Chapter 10 covered: cancelling a `GetQuote` call cancels exactly that call's in-flight work, because the work and the call were the same lifetime. `RecomputeRoutes`'s job has a lifetime of its own, independent of the RPC that started it and independent of any RPC that later asks about it, which is exactly why cancelling it needs its own RPC, `CancelOperation`, rather than relying on a client simply hanging up.

## A dedicated OperationsService, not three more RoutingService RPCs

The obvious first draft of this contract puts `GetOperation`, `WatchOperation`, and `CancelOperation` right where `RecomputeRoutes` already lives: three more RPCs on `RoutingService`. That draft shipped, briefly, in this book's working copy of the contract, and it broke every existing `RoutingService` implementor in the repository the moment it landed, without changing a single wire-compatible thing about the service. The reason is specific to how Quarkus generates gRPC server code: `quarkus-grpc` turns each `service` block into a *fully abstract* Java interface, one abstract method per RPC, and every `@GrpcService` bean that implements it has to override every method. Chapters 4, 5, 7, 10, 11, 12, 13, and 15 each ship their own `RoutingServiceImpl`, built against whatever shape `RoutingService` had when that chapter was written. Add three RPCs to the interface, and all of those earlier beans stop compiling, not because anything they do is wrong, but because Java requires a class implementing an interface to implement the whole interface, and the interface just grew three methods none of those classes know anything about.

The distinction is precise: adding `GetOperation`, `WatchOperation`, and `CancelOperation` to `RoutingService` is **wire-safe** (`buf breaking` has nothing to say about it, because a new RPC on an existing service never breaks a client compiled against the old `.proto`), but it is **source-breaking** for every Quarkus implementor of that service, because quarkus-grpc's codegen contract is "implement all of it," not "implement whatever you use." A contract-breakage checker that only watches the wire format, which is what `buf breaking` watches, has no way to catch this; the only way to see it coming is to know how the server framework turns a `service` block into code.

The fix is the one this chapter's contract now ships: move the three lookup RPCs off `RoutingService` entirely, onto their own service, `OperationsService`, declared in the same `routing.proto` file. `RoutingService` goes back to exactly the five RPCs it has had since Chapter 5: every existing `RoutingServiceImpl` compiles unchanged, because the interface it implements never grew. `OperationsService` is a new interface with exactly three methods, implemented by a new, separate bean (`OperationsServiceImpl` on Quarkus; a second servicer class on Python) that shares the same `OperationRegistry` the `RoutingServiceImpl` bean populates via CDI injection, rather than being the same bean wearing two hats.

This reasoning holds beyond the Java-specific trigger: it's the shape Google's own AIP-151 guidance and the `google.longrunning.Operations` service it standardizes both already prescribe: long-running-operation lookups belong on a dedicated Operations service, decoupled from whatever service created the job, precisely so that adding an operation kind to any resource-owning service never has to touch that service's own RPC surface. This chapter's `OperationsService` is a narrower, single-tenant version of that idea (one kind of job, one creating service), but it's standing on the same reasoning: a job's lifecycle lookup surface is a different concern from the service that started the job, and keeping them on separate `service` blocks is what lets each grow independently. The two scoped `buf:lint:ignore` exceptions below now sit above `OperationsService`'s three declarations rather than `RoutingService`'s, for the identical reason: this is where those three RPCs live now.

## Returning Operation directly, and the lint exception that allows it

Every other RPC in this contract follows the rule Chapter 13 named outright: a dedicated `FooRequest` in, a dedicated `FooResponse` out, never a bare domain type, so a response envelope can grow a field later without changing any RPC's wire signature. `GetOperation`, `WatchOperation`, and `CancelOperation` break that rule: each returns `shipping.type.v1.Operation` directly, not a `GetOperationResponse` wrapping one. This matches the shape Google's AIP-151 (long-running operations) and the `google.longrunning.Operation` message it's modeled on both use: the operation *is* the response, because there is nothing else the caller of a lookup, a watch, or a cancel needs back, and wrapping it in a single-field envelope would add nesting every caller has to unwrap for no corresponding flexibility.

`routing.proto` pays for that choice with two explicit, scoped lint exceptions, visible right above each of the three declarations:

```protobuf
// buf:lint:ignore RPC_REQUEST_RESPONSE_UNIQUE
// buf:lint:ignore RPC_RESPONSE_STANDARD_NAME
rpc GetOperation(GetOperationRequest) returns (shipping.type.v1.Operation);
```

`RPC_RESPONSE_STANDARD_NAME` catches exactly what this design does: a response message whose name doesn't follow the `<RpcName>Response` convention. `RPC_REQUEST_RESPONSE_UNIQUE` catches three RPCs sharing one response type when that's usually a copy-paste mistake. Here it's the point, since `GetOperation`, `WatchOperation`, and `CancelOperation` all legitimately answer the identical question ("what does this operation look like right now") and should return the identical shape. `buf:lint:ignore` is scoped to the single rule named above it, not a blanket suppression for the file or the RPC; a reader auditing this contract's exceptions later sees precisely which two rules were judged inapplicable here, and why.

<div class="callout callout--warn"><p class="callout__title">A lint exception is not a loophole</p><p>Ignoring a <code>buf lint</code> rule should read as an event, not a habit. The two exceptions above exist because this chapter's design reuses one well-known type as three RPCs' response: a named deviation from the envelope convention, not an escape hatch for skipping the convention when writing the wrapper felt like extra work. A reviewer should expect to see the reasoning next to the exception, as the comment above does here, and should treat a new <code>buf:lint:ignore</code> anywhere else in this contract as a question to ask before it merges, not a line to skim past.</p></div>

## Polling: GetOperation

`OperationsService.GetOperation` is the simplest of the three lookup RPCs: a client sends an `operation_id`, the server looks up the matching record and returns its current snapshot. Nothing about this call differs in kind from any other unary RPC in this book: a plain read, idempotent, safe to retry, safe to call as many times as a client wants. What makes it belong to this chapter rather than Chapter 7's is only what it's reading: a value that changes on its own, driven by a background job, between one call and the next. Two identical `GetOperation` calls in a row may return the identical response; that's correct, not a bug, since polling a record that hasn't changed yet is supposed to return what's there. An unknown `operation_id` (never created, or evicted by whatever retention policy a real service applies to old, completed operations) returns `NOT_FOUND`, the same status Chapter 11 reaches for whenever a looked-up resource doesn't exist, with nothing operation-specific layered on top of the generic code.

## Watching: WatchOperation as a server stream

`GetOperation` makes the client decide how often to ask. `OperationsService.WatchOperation` flips that: the client asks once, the server decides how often to answer, pushing a new `Operation` snapshot down one open HTTP/2 stream every time there's a meaningful update, until the operation reaches a terminal state and the server closes the stream. This is the identical RPC shape Chapter 8 built for `WatchShipment` (a single request, a sequence of response messages, ended by the server's own half-close rather than any explicit "stop" message), applied here to a value that's computed and mutated in place by a background job instead of read from a fixed, pre-built event table.

{% include excalidraw.html file="16-poll-vs-watch" alt="Two side-by-side panels. Left panel, labeled Poll: GetOperation (client-paced): a Client box and an Operation box connected by three separate bidirectional arrows labeled GetOperation to 0 percent, GetOperation to 40 percent, and GetOperation to 100 percent. Right panel, labeled Watch: WatchOperation (server-paced stream): a Client box and an Operation box connected by one arrow labeled WatchOperation opened once, with three dashed arrows flowing back from Operation to Client labeled snapshot 0 percent, snapshot 40 percent, and snapshot 100 percent done. A caption under the left panel reads REST seam: GET /operations/id; a caption under the right panel reads no REST analog without SSE or websockets." caption="Figure 16.2: Polling makes the client pay for every round trip it wants; watching makes the server push exactly the updates worth sending, over one connection." %}

The REST analog sharpens the contrast. A paginated REST client hits `GET /operations/{id}` on whatever interval it chooses; Figure 16.2 marks that as the seam between the two worlds. There is no equally direct REST analog for `WatchOperation`: a REST API reaching for the same server-push behavior needs Server-Sent Events or a WebSocket bolted onto the collection resource, a second protocol layered on top of the first, where `WatchOperation` is an ordinary server-streaming RPC the same protocol already supports natively, no different in mechanism from `WatchShipment`, which is why Chapter 8 already paid for understanding it.

Backpressure matters more here than it did for `WatchShipment`'s fixed four-event sequence, since an operation that runs for minutes could push far more snapshots than any consumer wants. This chapter's examples keep the poll interval short enough that the total snapshot count per call stays small, but a production `WatchOperation` would emit only when `progress_pct` or `message` actually changed, not on a blind timer, the same discipline Chapter 17 covers for streaming at scale.

## Cancelling: the operation, not just the watch

{% include codetabs.html langs="Quarkus|Python" %}

```java
synchronized boolean cancel() {
    if (done) {
        return false; // already terminal; a late or duplicate cancel is a no-op
    }
    this.done = true;
    this.message = "operation cancelled by client request at " + progressPct + "% progress";
    return true;
}
```

```python
def cancel(self) -> bool:
    if self.done:
        return False  # already terminal; a late or duplicate cancel is a no-op
    self.done = True
    self.message = f"operation cancelled by client request at {self.progress_pct}% progress"
    return True
```

`OperationsService.CancelOperation` moves the server-owned record to a terminal state directly: `done` flips to `true`, `message` names the cancellation, and `progress_pct` is left exactly where it was, below 100, because the job stopped short of finishing rather than finishing early. The background job checks the same `done` flag between steps and stops advancing once it sees the operation already terminal; it never races the cancel to decide the final state, because `cancel()` and the job's own `complete()` both go through the identical guarded transition shown above, and whichever runs first wins outright. This is cooperative cancellation, the same caveat Chapter 10 named for a downstream call's deadline: `CancelOperation` guarantees the *record* reflects the cancellation immediately, but the job's own loop has to notice and actually return; one stuck inside a single long blocking call between checks would keep running underneath a `done=true` record until that call finally yields.

{% include excalidraw.html file="16-cancel-and-rerun" alt="Three stacked panels. Top panel, labeled Cancel the Operation (server-owned): a Client calls CancelOperation with an operation_id, which transitions the Operation to done=true, progress_pct under 100, message mentioning cancelled. Middle panel, labeled Cancel the watch stream (request-scoped): a Client closes a WatchOperation stream, while the Operation itself, shown as a dashed ghost box, keeps running unaffected by the stream closing. Bottom panel, labeled Rerunnable reconcile: a Client starts two separate RecomputeRoutes runs, op_aaa and op_bbb, both reaching done=true, 100 percent, converging on a box labeled same terminal shape both times, the reconcile job is rerunnable. A caption below reads: server-owned cancellation stops the job; request-scoped cancellation only stops the client from watching it." caption="Figure 16.3: Cancelling the Operation stops the job; cancelling the watch only stops one client from watching it, and rerunning RecomputeRoutes always converges on the same terminal shape." %}

That gap is also the distinction worth separating from request-scoped cancellation. A client can stop watching an operation at any point (close the `WatchOperation` stream, let its own deadline expire, or simply stop reading), and nothing about the job changes: the background work keeps running, keeps advancing `progress_pct`, and keeps heading toward `done=true` whether or not anyone is watching, because watching was never what kept it alive. Chapter 10 built the opposite case: cancelling `RoutingService.GetQuote`'s inbound call stopped the downstream `QuoteService.GetQuote` work underneath it outright, because that work's entire lifetime *was* the call's lifetime. `RecomputeRoutes`'s job has no such tie to any one call; its lifetime is the operation's own, bounded only by completion or an explicit `CancelOperation`: the whole reason this chapter needed a fourth RPC that Chapter 10's deadline machinery alone could never express.

## RecomputeRoutes as a rerunnable reconcile job

`RecomputeRoutes` takes a `reason` string and nothing else: no partial state to merge, no prior run's id to resume. That's deliberate: calling it a second time doesn't continue the first run; it starts an entirely new operation that recomputes the same routing state from scratch and lands on the same kind of terminal result every time, the way a reconcile loop in an orchestration system re-derives a desired state from current inputs rather than replaying a history of prior adjustments. Two sequential `RecomputeRoutes` calls in this chapter's example produce two different operation ids, because they are two different jobs, and each independently reaches `done=true` at `progress_pct=100`. That's what "rerunnable" means here, and it's what makes `RecomputeRoutes` safe to call again after a timeout or simple operator judgment that recomputing can't hurt.

That property is worth separating from the idempotency Chapter 10 and Chapter 11 used for a single RPC: a `GetQuote` retry is idempotent because resending the identical request produces the identical response with no accumulating side effect. `RecomputeRoutes` is not idempotent in that narrow sense; each call creates a new `Operation`, which is itself a side effect. What makes it safe to rerun is a different, adjacent property: the *job* it schedules is pure with respect to its inputs, recomputing the same answer from the same state regardless of how many times it last ran, so a reconcile job built this way can be called on a schedule, or after a suspected inconsistency, without anyone reasoning about what state a prior, possibly-interrupted run left behind.

## How the code works

Both stacks keep an in-memory registry mapping an `op_`-prefixed id to a mutable operation record (`OperationRegistry` / `OperationState` on both Quarkus and Python). A real service would back this with a durable store so an operation survives a server restart, but the client-visible contract of create-poll-watch-cancel-by-id is identical either way, which is the point of keeping this detail swappable rather than baked into the RPC shapes themselves. Each stack constructs exactly one `OperationRegistry` and shares it between the two service implementations: on Quarkus, CDI injects the same `@ApplicationScoped` singleton into both the `RoutingServiceImpl` bean and the separate `OperationsServiceImpl` bean; on Python, `app/main.py` constructs one `OperationRegistry` and passes it into both the `RoutingServiceServicer` and `OperationsServiceServicer` constructors before registering both on the same `grpc.aio` server. Two services, two beans or servicer classes, one shared record store.

**`RecomputeRoutes` returns before the job runs.** On Quarkus, `RoutingServiceImpl`'s handler creates an `OperationState`, hands the actual work to `Infrastructure.getDefaultExecutor()` (Mutiny's own worker-thread pool, the same pool a method marked `@Blocking` runs on) and returns the freshly-created, `done=false` snapshot without waiting on that submitted work. On Python, `RoutingServiceServicer`'s handler creates the equivalent record and calls `asyncio.create_task(...)`, scheduling the job as an independent task on the same event loop rather than awaiting it, so the enclosing coroutine returns immediately while the task keeps running after it, and it holds a strong reference to that task in an instance-level `set`, discarded via a done-callback once the task finishes, because `asyncio` itself holds only a weak reference to a scheduled task and an unreferenced one can be garbage-collected mid-job. Both share the shape Chapter 15 named for I/O-bound work generally: the thread, or event-loop iteration, handling the inbound RPC is never the one doing the actual job, so a slow `RecomputeRoutes` job can't starve every other RPC this process answers concurrently.

**The job advances a few fixed, bounded steps, checking for cancellation at each one.** Both stacks implement the same loop: sleep a fixed interval, check whether the record has already gone terminal (a `CancelOperation` beat the next step to it), and if not, advance `progress_pct` and `message`. The job this chapter's example runs is short: five steps for the ordinary `reason`, twenty slower steps when `reason` names a `"slow"` variant, so the example's own verification can watch a real operation progress and cancel a real one mid-flight inside a few seconds. A production reconcile job replaces the fixed sleep-and-step loop with whatever the real recomputation does, checking the same cancellation flag between its own natural unit of work.

**`WatchOperation` streams by polling the same record the job mutates.** It's implemented on the `OperationsService` side (`OperationsServiceImpl` on Quarkus, `OperationsServiceServicer` on Python), reading the identical `OperationState` the other service's `RecomputeRoutes` handler is advancing. On Quarkus, a `Multi` built from `Multi.createFrom().emitter(...)` loops on the worker pool, not the event loop, emitting a fresh snapshot, sleeping briefly, and completing the stream the moment a snapshot comes back `done`. On Python, an async generator does the identical thing with `yield` in place of an emitter call and `asyncio.sleep` in place of a thread sleep; returning from the loop sends the stream's half-close, the mechanic Chapter 8's `WatchShipment` already established for a fixed sequence rather than a live, mutating record. Neither implementation needs a separate notification channel between the job and the watcher; both read the exact same state object the job itself is advancing, so a snapshot is never stale by more than one poll interval.

**`GetOperation` and `CancelOperation` are both single, synchronous reads or writes against that same record**, also on the `OperationsService` side, the identical snapshot-or-mutate logic the job itself uses, called from a different RPC on a different service bean entirely. The three Operation RPCs and the background job are four independent entry points into one shared piece of mutable state, which is why each stack's `OperationState` type exists as its own small class rather than scattering `done`/`progress_pct`/`message` across whichever handler touches them first, and why that state lives in its own `OperationRegistry`, CDI-shared or constructor-shared, rather than as a private field on either service bean.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Reach for <code>GetOperation</code> when a client wants a point-in-time answer on its own schedule (a UI refresh button, a batch script checking back every few seconds) and the extra plumbing of a long-lived stream isn't worth it for a job the client doesn't mind polling a handful of times. Reach for <code>WatchOperation</code> when the client wants every meaningful update as it happens without paying for a round trip it doesn't need, and can afford to hold one connection open for the operation's duration: the same trade-off Chapter 8 named for <code>WatchShipment</code> against repeated unary calls, applied here to a value a background job mutates instead of a fixed event table. Cancellation splits along the same server-owned/request-scoped line Chapter 10 drew for deadlines: closing a <code>WatchOperation</code> stream only stops that one client from watching, because the stream's lifetime was never the job's lifetime to begin with, while <code>CancelOperation</code> reaches into the job itself and is the only one of the two that actually stops it. This contract puts all three lookup RPCs on a dedicated <code>OperationsService</code> rather than on <code>RoutingService</code> itself (the AIP-151 / <code>google.longrunning.Operations</code> shape) because the alternative, three more RPCs bolted onto <code>RoutingService</code>, is wire-compatible but not source-compatible: quarkus-grpc generates a fully abstract interface per service, so every existing <code>RoutingServiceImpl</code> across this book's other chapters would have had to grow overrides it has no reason to implement, just because one chapter needed a lookup surface for one kind of background job. A dedicated <code>OperationsService</code> costs three RPC declarations and one extra bean or servicer class; it buys a lookup surface that can grow its own RPCs, or even absorb a second kind of operation later, without ever touching <code>RoutingService</code>'s interface again.</p></div>

## Build, run, observe

```bash
cd examples/16-async-long-running-jobs && ./verify.sh
```

The run script there builds and starts both stacks and asserts every claim this chapter makes: `RoutingService.RecomputeRoutes` returns a fresh, non-terminal `Operation`; `OperationsService.GetOperation` converges to `done=true`/`progress_pct=100` on a bounded poll loop; `OperationsService.WatchOperation` streams at least two snapshots ending in that same terminal state; `OperationsService.CancelOperation` stops a slow variant of the job before it finishes naturally, leaving `progress_pct` below 100 and a message that names the cancellation; two independent `RecomputeRoutes` calls each converge on their own terminal state; and a `RoutingService` RPC this chapter doesn't implement still answers `UNIMPLEMENTED`. Its `README.md` covers the exact assertions and how to drive each RPC by hand.

## What you learned

- A unary RPC's contract, where the response is the finished answer, breaks down once a job's real duration exceeds what any caller should block a deadline on; the fix is a different shape, not a longer deadline: return a server-owned handle immediately, and let the client poll or watch it.
- `shipping.type.v1.Operation` is small (`id`, `kind`, `done`, `progress_pct`, `message`) and is returned directly from `GetOperation`/`WatchOperation`/`CancelOperation` rather than wrapped in a per-RPC envelope: the AIP-151 long-running-operation shape, paid for here with two scoped, commented `buf:lint:ignore` exceptions rather than a silent convention break.
- Those three lookup RPCs live on a dedicated `OperationsService`, not on `RoutingService` itself: adding an RPC to a service is wire-safe but can be source-breaking for every existing implementor under a framework (quarkus-grpc) that generates a fully abstract per-service interface. It's a failure mode `buf breaking` has no way to see, because it only watches the wire. A dedicated Operations service, the AIP-151 / `google.longrunning.Operations` shape, sidesteps the problem entirely by never touching the interface that already has implementors.
- `GetOperation` (client-paced polling) and `WatchOperation` (server-paced streaming) answer the same question on two different cadences; `CancelOperation` reaches into the server-owned job itself, which is a different and stronger act than merely closing a `WatchOperation` stream, the request-scoped cancellation Chapter 10 already covered.
- `RecomputeRoutes` is rerunnable, not idempotent in the single-RPC sense: each call creates a new operation, but the job it schedules recomputes the same kind of result from current state every time, which is what makes calling it again always safe.

Chapter 17 turns from one background job's lifecycle to a stream carrying far more messages than this chapter's handful of progress snapshots: flow control and backpressure at scale, the concern this chapter's bounded, fast example schedule stayed small enough to avoid needing.

## On the wire

Start a job and read back its freshly-created, non-terminal `Operation`:

```bash
grpcurl -plaintext -d '{"reason":"reconcile"}' \
  localhost:9160 shipping.routing.v1.RoutingService/RecomputeRoutes
```

```
{
  "operation": {
    "id": "op_7f3a9c1e4b2d4a0f9b3c",
    "kind": "recompute_routes",
    "message": "started"
  }
}
```

`done` and `progress_pct` are absent, not `false`/`0` written out. proto3's JSON mapping omits a field at its zero value the same way Chapter 13 noted for `next_page_token`, so "the field doesn't appear" is itself the signal this operation just started. Poll it with the id from the response above:

```bash
grpcurl -plaintext -d '{"operationId":"op_7f3a9c1e4b2d4a0f9b3c"}' \
  localhost:9160 shipping.routing.v1.OperationsService/GetOperation
```

```
{
  "id": "op_7f3a9c1e4b2d4a0f9b3c",
  "kind": "recompute_routes",
  "progress_pct": 40,
  "message": "recomputing routes (40%)"
}
```

Watch the same operation instead of polling it, and grpcurl prints one JSON object per pushed snapshot until the stream's half-close:

```bash
grpcurl -plaintext -d '{"operationId":"op_7f3a9c1e4b2d4a0f9b3c"}' \
  localhost:9160 shipping.routing.v1.OperationsService/WatchOperation
```

```
{"id":"op_7f3a9c1e4b2d4a0f9b3c","kind":"recompute_routes","progress_pct":20,"message":"recomputing routes (20%)"}
{"id":"op_7f3a9c1e4b2d4a0f9b3c","kind":"recompute_routes","progress_pct":60,"message":"recomputing routes (60%)"}
{"id":"op_7f3a9c1e4b2d4a0f9b3c","kind":"recompute_routes","done":true,"progress_pct":100,"message":"recompute complete: routes reconciled"}
```

Finally, start the slower variant and cancel it before it finishes on its own:

```bash
grpcurl -plaintext -d '{"reason":"slow reroute"}' \
  localhost:9160 shipping.routing.v1.RoutingService/RecomputeRoutes
# ... read the id from the response, then, a moment later:
grpcurl -plaintext -d '{"operationId":"op_<id-from-above>"}' \
  localhost:9160 shipping.routing.v1.OperationsService/CancelOperation
```

```
{
  "id": "op_<id-from-above>",
  "kind": "recompute_routes",
  "done": true,
  "progress_pct": 25,
  "message": "operation cancelled by client request at 25% progress"
}
```

`done` is `true` and `progress_pct` stopped short of 100: the server-owned job actually stopped, not merely a client that stopped asking. Swap `9160` for `9161` and every one of these four calls behaves identically against the Python stack; `examples/16-async-long-running-jobs/verify.sh` asserts exactly that, for both stacks, on every run.

## For deeper coverage

- [AIP-151: Long-running operations](https://google.aip.dev/151): the `google.longrunning.Operations` shape this chapter's `OperationsService` narrows to one creating service and one job kind.
- Cloud Native Design Patterns, "Workflows and Jobs" chapter: background-job and reconcile-loop patterns beyond this chapter's single `RecomputeRoutes` example.
- [grpc.io: Core concepts: server streaming](https://grpc.io/docs/what-is-grpc/core-concepts/#server-streaming-rpc): the RPC shape `WatchOperation` reuses from Chapter 8's `WatchShipment`.
- Chris Richardson, *Microservices Patterns*, Manning, 2018: asynchronous messaging and saga coordination for work that outlives a single request.
