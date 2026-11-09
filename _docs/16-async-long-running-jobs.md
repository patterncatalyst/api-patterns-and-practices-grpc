---
title: "Async and long-running jobs over gRPC"
order: 16
part: "Concurrency & Long-Running Work"
description: "A server-owned Operation lets an RPC return a handle to a job that outlives the call, with polling, streaming progress, cancellation and a rerunnable reconcile job."
duration: "24 min read"
---

## Learning objectives

By the end of this chapter you can:

- Model a server-owned `Operation` (`id`, `kind`, `done`, `progress_pct`, `message`) as a handle to work that outlives the RPC that started it.
- Put `GetOperation`, `WatchOperation` and `CancelOperation` on a dedicated `OperationsService`, and say why quarkus-grpc forces the split.
- Choose between client-paced polling and server-paced streaming for a long job.
- Tell server-owned cancellation from request-scoped cancellation, and guard it cooperatively.
- Build a rerunnable reconcile RPC and say how rerunnable differs from idempotent.

## Why this matters

`RecomputeRoutes` reruns a routing optimization across every lane and carrier in the catalog. On a real fleet that takes minutes, which is too long for a caller to hold a thread, a connection and a deadline. Raising the deadline doesn't fix it: the caller still can't check progress, change its mind, or walk away and come back. The RPC has to return something other than the result.

{% include excalidraw.html file="16-operation-lifecycle" alt="A timeline diagram. Top band: a Client calls RecomputeRoutes on a RecomputeRoutes handler, which creates an Operation and returns immediately, labeled op_7f3a. Bottom band, labeled server-owned, outlives the call above: the same operation id shown at four points in time: done=false progress_pct=0, done=false progress_pct=40, done=false progress_pct=80, done=true progress_pct=100, connected by arrows labeled job advances and terminal. A caption below reads: the call that started the job returns long before the job finishes; the Operation record is the only thing that outlives it." caption="Figure 16.1: RecomputeRoutes returns instantly; the Operation record it creates keeps living, and keeps changing, after the call that created it has already returned." %}

## Pattern: Long-Running Operation

### The problem

A unary RPC's response is the answer. That holds while the work fits inside a deadline a caller will wait on, and breaks when the job runs for minutes. The client then needs something to check back with, a way to stop the job, and a job that survives its own request.

### The solution

**A long-running operation is a server-owned record: the starting RPC returns it immediately, and separate RPCs read, watch or cancel it by id.**

Start, check and stop are three different questions with different cardinalities: one `RecomputeRoutes` per job, but as many `GetOperation` or `WatchOperation` calls as the client wants before the job finishes. This is the shape of Google's AIP-151 and the `google.longrunning.Operations` service.

### How Quarkus and Python model it

`shipping.type.v1.Operation` is small:

| Field | Meaning |
|---|---|
| `id` | Opaque, server-generated (`op_` prefix). The only thing a client keeps between calls. |
| `kind` | What the job is (`recompute_routes`). Useful once several kinds of job share one lookup surface. |
| `done` | The one boolean that says whether to keep polling or watching. |
| `progress_pct` | Best effort, 0 to 100. It need not advance linearly, but it ends at exactly 100 when `done` becomes true. |
| `message` | A status line; after a cancellation, why the job stopped short. |

A client can't set `progress_pct` or flip `done`. Those change only inside the process that owns the job, driven by the job or by a `CancelOperation` the server itself processes. Both stacks keep an in-memory `OperationRegistry` of `OperationState` records keyed by id. A real service backs it with a durable store so operations survive a restart; the create, poll, watch and cancel contract is the same either way.

Each stack builds one registry and shares it between two service implementations. On Quarkus, CDI injects the same `@ApplicationScoped` singleton into `RoutingServiceImpl` and `OperationsServiceImpl`. On Python, `app/main.py` passes one `OperationRegistry` to both servicers before registering them on the same `grpc.aio` server.

`RecomputeRoutes` creates the record and returns the `done=false` snapshot without waiting for the job:

- **Quarkus:** the handler submits the work to `Infrastructure.getDefaultExecutor()`, the worker pool `@Blocking` methods use.
- **Python:** the handler calls `asyncio.create_task(...)`. It keeps a strong reference to the task in an instance-level `set` and discards it in a done-callback, because `asyncio` holds only a weak reference to a scheduled task and an unreferenced one can be garbage-collected mid-job.

In both cases the thread or event-loop turn that handled the RPC is never the one doing the job, so a slow recompute can't starve other calls. The job runs a bounded loop: sleep, check whether the record has gone terminal, otherwise advance `progress_pct` and `message`. It takes five 200 millisecond steps for an ordinary `reason` and twenty when `reason` contains `slow`, a window long enough for a real cancellation to land mid-flight.

## A dedicated OperationsService

The obvious draft puts the three lookup RPCs next to `RecomputeRoutes` on `RoutingService`. That change is wire-safe: `buf breaking` has nothing to report, because a new RPC on an existing service never breaks a client built against the old `.proto`. It is source-breaking for every Quarkus implementor. quarkus-grpc turns each `service` block into a fully abstract Java interface with one method per RPC, so three new RPCs stop every existing `RoutingServiceImpl` from compiling. A checker that watches only the wire can't see this; you have to know how the framework generates code.

The fix is a separate `OperationsService` with exactly three methods, declared in the same `routing.proto`. `RoutingService` keeps the five RPCs it had, and every existing implementor compiles unchanged. A new bean (`OperationsServiceImpl` on Quarkus, a second servicer on Python) implements the new service and shares the registry.

This is also what AIP-151 prescribes: operation lookups live on a service decoupled from the one that created the job, so adding a job kind to any resource-owning service never touches that service's RPC surface. Here it is a narrower version, with one job kind and one creating service.

## Returning Operation directly

Every other RPC in the contract takes a dedicated `FooRequest` and returns a dedicated `FooResponse`, so an envelope can grow a field without changing a signature. The three operation RPCs return `shipping.type.v1.Operation` directly, as AIP-151 does. The operation is the response, and a single-field wrapper would add nesting with no flexibility. Two scoped lint exceptions sit above each declaration:

```protobuf
  // buf:lint:ignore RPC_REQUEST_RESPONSE_UNIQUE
  // buf:lint:ignore RPC_RESPONSE_STANDARD_NAME
  rpc GetOperation(GetOperationRequest) returns (shipping.type.v1.Operation);
```

`RPC_RESPONSE_STANDARD_NAME` flags a response not named `<RpcName>Response`. `RPC_REQUEST_RESPONSE_UNIQUE` flags several RPCs sharing one response type, which is usually a copy-paste mistake and here is the point: all three answer "what does this operation look like right now." Each `buf:lint:ignore` suppresses one named rule on one RPC, so a later reader sees which rules were judged inapplicable.

<div class="callout callout--warn"><p class="callout__title">A lint exception is not a loophole</p><p>Keep the reasoning next to the exception, as the comment above does. Treat a new <code>buf:lint:ignore</code> anywhere else in the contract as a question to ask before it merges.</p></div>

## Polling and watching

`GetOperation` takes an `operation_id` and returns the current snapshot. It is a plain idempotent read. Two identical calls may return identical responses, because the record may not have changed. An unknown or evicted id returns `NOT_FOUND`, with nothing operation-specific layered on the generic code.

`WatchOperation` flips the pacing: the client asks once, and the server pushes a snapshot down one HTTP/2 stream on each meaningful update, then closes the stream when the operation is terminal. It is ordinary server streaming, the same shape as `WatchShipment`, applied to a record a background job mutates.

{% include excalidraw.html file="16-poll-vs-watch" alt="Two side-by-side panels. Left panel, labeled Poll: GetOperation (client-paced): a Client box and an Operation box connected by three separate bidirectional arrows labeled GetOperation to 0 percent, GetOperation to 40 percent, and GetOperation to 100 percent. Right panel, labeled Watch: WatchOperation (server-paced stream): a Client box and an Operation box connected by one arrow labeled WatchOperation opened once, with three dashed arrows flowing back from Operation to Client labeled snapshot 0 percent, snapshot 40 percent, and snapshot 100 percent done. A caption under the left panel reads REST seam: GET /operations/id; a caption under the right panel reads no REST analog without SSE or websockets." caption="Figure 16.2: Polling makes the client pay for every round trip it wants; watching makes the server push exactly the updates worth sending, over one connection." %}

A REST client polls `GET /operations/{id}` at an interval it picks. REST has no direct equivalent of `WatchOperation`; it needs Server-Sent Events or a WebSocket, a second protocol on top of the first.

Both stacks implement the watch by reading the record the job mutates, so no notification channel connects job and watcher and a snapshot is never staler than one poll interval:

- **Quarkus:** a `Multi` from `Multi.createFrom().emitter(...)` loops on the worker pool, emits a snapshot, sleeps briefly, and completes once a snapshot is `done`.
- **Python:** an async generator does the same with `yield` and `asyncio.sleep`; returning from the loop half-closes the stream.

A minutes-long job could push far more snapshots than a consumer wants. The demo keeps the interval short; a production watch emits only when `progress_pct` or `message` changed, not on a timer.

| | `GetOperation` | `WatchOperation` |
|---|---|---|
| Pacing | Client decides how often to ask | Server pushes each meaningful update |
| Cost | One round trip per look | One open stream for the job's duration |
| Use it when | A UI refresh button, or a script checking back every few seconds | The client wants every update without wasted round trips |

## Cancelling the operation, not just the watch

{% include codetabs.html langs="Quarkus|Python" %}

```java
    synchronized boolean cancel() {
        if (done) {
            return false;
        }
        this.done = true;
        this.message = "operation cancelled by client request at " + progressPct + "% progress";
        return true;
    }
```

```python
    def cancel(self) -> bool:
        """Called by CancelOperation. Returns True if this call is the one
        that moved the operation to terminal; False if it was already done
        (the cancel arrived too late, or twice)."""
        if self.done:
            return False
        self.done = True
        self.message = f"operation cancelled by client request at {self.progress_pct}% progress"
        return True
```

`CancelOperation` moves the record to a terminal state: `done` becomes `true`, `message` names the cancellation, and `progress_pct` stays where it was, below 100, because the job stopped short. The job checks `done` between steps and stops advancing. It never races the cancel for the final state, because `cancel()` and the job's own `complete()` go through the same guarded transition and the first one wins. A late or duplicate cancel is a no-op.

This is cooperative cancellation. The record reflects the cancel immediately, but the job's loop has to notice and return. A job stuck in one long blocking call between checks keeps running under a `done=true` record until that call yields.

{% include excalidraw.html file="16-cancel-and-rerun" alt="Three stacked panels. Top panel, labeled Cancel the Operation (server-owned): a Client calls CancelOperation with an operation_id, which transitions the Operation to done=true, progress_pct under 100, message mentioning cancelled. Middle panel, labeled Cancel the watch stream (request-scoped): a Client closes a WatchOperation stream, while the Operation itself, shown as a dashed ghost box, keeps running unaffected by the stream closing. Bottom panel, labeled Rerunnable reconcile: a Client starts two separate RecomputeRoutes runs, op_aaa and op_bbb, both reaching done=true, 100 percent, converging on a box labeled same terminal shape both times, the reconcile job is rerunnable. A caption below reads: server-owned cancellation stops the job; request-scoped cancellation only stops the client from watching it." caption="Figure 16.3: Cancelling the Operation stops the job; cancelling the watch only stops one client from watching it, and rerunning RecomputeRoutes always converges on the same terminal shape." %}

Closing a `WatchOperation` stream, letting its deadline expire or simply not reading changes nothing about the job. It keeps advancing toward `done=true` whether or not anyone watches. That differs from a downstream call under a deadline: cancelling an inbound `GetQuote` stops the `QuoteService.GetQuote` work beneath it, because that work's lifetime was the call's. The job's lifetime is the operation's own, ended only by completion or `CancelOperation`.

| Action | Effect on the job |
|---|---|
| `CancelOperation` | Stops it |
| Close or abandon `WatchOperation` | None; one client stops watching |

## RecomputeRoutes as a rerunnable reconcile job

`RecomputeRoutes` takes a `reason` and nothing else: no partial state to merge, no prior run to resume. A second call doesn't continue the first. It starts a new operation with a new id that recomputes routing state from scratch and reaches the same kind of terminal result, the way a reconcile loop re-derives desired state from current inputs instead of replaying history.

That is rerunnable, which isn't idempotency in the single-RPC sense. A `GetQuote` retry is idempotent because the same request yields the same response with no accumulating side effect. Each `RecomputeRoutes` call creates a new `Operation`, which is a side effect. What makes it safe to repeat is that the job is pure with respect to its inputs: it can run on a schedule, or after a suspected inconsistency, without anyone reasoning about what an interrupted earlier run left behind.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Return an <code>Operation</code> instead of a result once a job outlasts any deadline a caller should hold. Use <code>GetOperation</code> when the client wants a point-in-time answer on its own schedule and a long-lived stream isn't worth the plumbing; use <code>WatchOperation</code> when it wants every meaningful update and can hold one connection open for the job's duration. Only <code>CancelOperation</code> stops the job; closing a watch stream stops one client watching. Put the lookup RPCs on a dedicated <code>OperationsService</code>: three RPC declarations and one extra bean or servicer buy a lookup surface that can grow, or absorb a second job kind, without touching <code>RoutingService</code>'s generated interface.</p></div>

> **🤖 Explore with your agent**
>
> "In examples/16-async-long-running-jobs, read OperationsService in routing.proto and OperationState in the Quarkus and Python stacks. Check that CancelOperation leaves progress_pct below 100 and that a second cancel on the same op id is a no-op, and that WatchOperation closes its stream once done is true. Fix any place where the job could overwrite a cancelled record."
>
> Check: run `./verify.sh` in examples/16-async-long-running-jobs, then call `OperationsService/CancelOperation` twice with grpcurl and confirm both replies are identical.

## Build, run, observe

```bash
cd examples/16-async-long-running-jobs && ./verify.sh
```

`verify.sh` builds and starts both stacks. Quarkus listens on `9160` and Python on `9161`. It passes when `RecomputeRoutes` returns a non-terminal `Operation`, `GetOperation` converges to `done=true` at `progress_pct=100`, `WatchOperation` streams at least two snapshots ending in that state, `CancelOperation` stops the slow variant below 100, and two `RecomputeRoutes` calls each finish with their own id.

Start a job and read back its non-terminal `Operation`:

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

`done` and `progress_pct` are absent because proto3's JSON mapping omits a field at its zero value. Absence is the signal that the job just started. Poll with the returned id:

```bash
grpcurl -plaintext -d '{"operationId":"op_7f3a9c1e4b2d4a0f9b3c"}' \
  localhost:9160 shipping.routing.v1.OperationsService/GetOperation
```

Watch it instead, and grpcurl prints one object per snapshot until the half-close:

```bash
grpcurl -plaintext -d '{"operationId":"op_7f3a9c1e4b2d4a0f9b3c"}' \
  localhost:9160 shipping.routing.v1.OperationsService/WatchOperation
```

```
{"id":"op_7f3a9c1e4b2d4a0f9b3c","kind":"recompute_routes","progress_pct":20,"message":"recomputing routes (20%)"}
{"id":"op_7f3a9c1e4b2d4a0f9b3c","kind":"recompute_routes","progress_pct":60,"message":"recomputing routes (60%)"}
{"id":"op_7f3a9c1e4b2d4a0f9b3c","kind":"recompute_routes","done":true,"progress_pct":100,"message":"recompute complete: routes reconciled"}
```

Start `{"reason":"slow reroute"}` and cancel it with `OperationsService/CancelOperation`. The reply has `done: true`, `progress_pct` below 100 (25 in one run) and the message `operation cancelled by client request at 25% progress`. Swap `9160` for `9161` to run every call against the Python stack.

Experiments:

- Send `CancelOperation` twice for the same id. The second call returns the same terminal record unchanged.
- Cancel after the job has finished. The record keeps `progress_pct` 100 and its completion message.
- Call `GetOperation` with an id that never existed. The status is `NOT_FOUND`.

## For deeper coverage

- [AIP-151: Long-running operations](https://google.aip.dev/151): the `google.longrunning.Operations` shape that `OperationsService` narrows to one creating service and one job kind.
- Cloud Native Design Patterns, "Workflows and Jobs" chapter: background-job and reconcile-loop patterns beyond a single `RecomputeRoutes`.
- [grpc.io: Core concepts: server streaming](https://grpc.io/docs/what-is-grpc/core-concepts/#server-streaming-rpc): the RPC shape `WatchOperation` reuses from `WatchShipment`.
- Chris Richardson, *Microservices Patterns*, Manning, 2018: asynchronous messaging and saga coordination for work that outlives a single request.
