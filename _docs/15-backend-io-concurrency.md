---
title: "Backend I/O concurrency"
order: 15
part: "Concurrency & Long-Running Work"
description: "Quarkus event loop versus @Blocking worker pool versus @RunOnVirtualThread, Python grpc.aio versus a thread pool and the GIL, and measuring what an execution model changes under concurrent blocking I/O."
duration: "18 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why a Quarkus gRPC server's small, fixed event-loop pool lets one blocking call stall every other caller scheduled on it, whatever the idle CPU.
- Choose between the event loop, `@Blocking`'s worker pool and `@RunOnVirtualThread`'s per-call virtual thread for a blocking call.
- Name `@RunOnVirtualThread`'s caveats (native-code pinning and `ThreadLocal`-based pooling) instead of treating it as a universal upgrade.
- Offload a blocking call in Python with `asyncio.to_thread` instead of calling it in-line on `grpc.aio`'s single event loop.
- Say when the GIL bottlenecks concurrent work and when it doesn't, separating I/O-bound from CPU-bound.

## Why this matters

A server that can stop work when told to is only half the story. It also has to start enough work at once. `RoutingService.FindOptimalRoute` is backed by a database lookup and a file read that together take about 400 milliseconds, and the decision is which thread runs those 400 milliseconds. Get it right and eight callers finish in the time one would take. Get it wrong and a service with CPU to spare queues requests one behind another, because the thread meant to accept the ninth connection spent the window waiting on a disk.

{% include excalidraw.html file="15-jvm-execution-models" alt="Three lanes under one FindOptimalRoute entry. Event loop (default): the Vert.x event loop runs the body directly, and blocking I/O occupies it for about 400 milliseconds while every other call on that loop queues. @Blocking: the call is dispatched to the Vert.x worker pool (about 20 threads by default), where 8 concurrent calls overlap. @RunOnVirtualThread: a fresh virtual thread per call, cheap to block but still pinned by native-code calls and ThreadLocal-heavy libraries." caption="Figure 15.1: Three Quarkus gRPC execution models for the same blocking call. A method must never block the event loop, @Blocking offloads onto the worker pool, and @RunOnVirtualThread uses a virtual thread per call." %}

## The event loop is shared, not slow

A Quarkus gRPC server runs incoming calls on a small, fixed pool of **event-loop threads**; Vert.x defaults to twice the host's CPU count. The pool is small by design, so a few threads can serve thousands of connections. A call that returns control quickly, even while work continues elsewhere (a driver's async callback, a completed `Uni`), lets that thread pick up the next waiting call. A call that blocks the thread outright (`Thread.sleep`, a synchronous JDBC query, a blocking file read) takes it out of rotation for every other caller on the same loop.

This is a different failure from a missed deadline. A slow dependency gives one cause and one victim. A blocked event loop is a **throughput** problem whose victims are whoever happened to be scheduled on the same thread, usually unrelated endpoints and customers, since the assignment is arbitrary from the caller's side. Making the I/O faster isn't the fix: 400 milliseconds is 400 milliseconds whichever thread waits. The fix is choosing which thread that is.

## Quarkus: three execution models

Every method on a `@GrpcService` runs on the event loop by default. Quarkus assumes your code doesn't block, and the burden of saying otherwise is yours.

| Model | What happens | Cost and caveats |
| --- | --- | --- |
| Event loop (default) | Runs on a Vert.x event-loop thread | Never block here |
| `@Blocking` (`io.smallrye.common.annotation.Blocking`) | Quarkus dispatches every invocation onto the Vert.x worker pool (about 20 threads by default) before the body runs | A synchronous database call, file read or `Thread.sleep` is as safe as in a thread-per-request server; the fixed pool gives backpressure |
| `@RunOnVirtualThread` | A fresh virtual thread per invocation | Blocking on ordinary I/O unmounts from the carrier, so far more calls can be in flight than the pool allows; caveats below |

Virtual threads have two caveats:

- **Pinning.** Before Java 24 a `synchronized` block pinned the virtual thread to its carrier for the block's duration. JEP 491 removed that. What remains is native code: a virtual thread that calls into JNI or the Foreign Function & Memory API and blocks there still pins its carrier, because the JVM can't see what a native frame is doing. A JDBC driver's native networking layer or a library wrapping a C extension can bring back the problem virtual threads exist to solve, and the calling code looks the same whether it pins or not.
- **`ThreadLocal` pooling.** A library that pools a parser, buffer or formatter in a `ThreadLocal` pools nothing once every call gets a disposable virtual thread. The pool becomes an allocation per call, which is correct but potentially expensive.

The default mode is `@Blocking`. A method carries one execution-model annotation, so a demo-only flag in `request.origin.name` selects the other two at request time. The `"virtual"` branch starts `Thread.ofVirtual()` by hand, reproducing what `@RunOnVirtualThread` does when it is a method's only annotation. With that annotation alone, the body would be one line, `return Uni.createFrom().item(() -> buildResponse(request));`, with no manual dispatch. The `"starving"` branch runs the identical lookup directly on an event-loop thread via `Context.runOnContext`. That is the live wrong answer to compare against.

Vert.x defaults to twice the CPU count in event loops, so on a four-core host eight starving calls would mostly land on eight different loops and never contend. The service captures one `io.vertx.core.Context` on the first starving call and reuses it, so every starving call shares one thread at any core count. Setting `quarkus.vertx.event-loops-pool-size=1` globally was tried and rejected: the backed-up loop slowed an unrelated batch of correct-model calls run right after. Pin only the path being demonstrated, not the server's whole concurrency budget.

{% include excalidraw.html file="15-thread-exhaustion-overlap" alt="Two timelines for the same 8 concurrent FindOptimalRoute calls, each about 400 milliseconds of blocking I/O. Starving: 8 calls queued end to end on one thread, about 3.2 seconds total. Offloaded: 8 calls overlapping across worker threads, about 0.45 seconds total." caption="Figure 15.2: The same 8 concurrent calls and the same total work, queued on one thread versus overlapped across many. The work never gets cheaper; where it runs decides whether eight callers wait in line or finish together." %}

## Python: `grpc.aio`, `asyncio.to_thread` and the GIL

`grpc.aio` runs every handler as a coroutine on one `asyncio` event loop, so one thread executes Python bytecode for all concurrent calls. A handler that calls a blocking function with no `await` runs it to completion before any other coroutine on that loop gets a turn, including an unrelated RPC to a different method. The starving mode calls `blocking_lookup` in-line in the `async def` handler, and the 400 milliseconds are 400 milliseconds the loop does nothing else.

The default mode hands the same function to `asyncio.to_thread`, which schedules it on the loop's default executor (`min(32, cpu_count + 4)` threads) and suspends the coroutine. The `await` is what lets the loop serve other coroutines while the I/O is in flight. It has the same shape as `@Blocking`: one explicit hop off the scarce thread onto a pool sized for blocking work, made at the call site that needs it.

The GIL matters less here than it seems:

| Work | GIL | Eight concurrent `to_thread` calls |
| --- | --- | --- |
| I/O-bound (`time.sleep`, file or socket read) | Released for the call's duration | Overlap: each thread blocks on its own I/O |
| CPU-bound (a pure Python loop) | Held throughout | Serialize on the GIL, however many threads or cores |

`asyncio.to_thread` suits this lookup because the GIL is out of the way for the slow part. It wouldn't rescue CPU-bound work, because threads don't buy parallelism the interpreter loop refuses to grant.

Python 3.14 has an official **free-threaded** build (PEP 703) that removes the GIL, which would let CPU-bound work scale across threads. It is a separate interpreter artifact, and `grpcio` support is still settling, so the project's CI and container image run the standard GIL build and no free-threaded measurement was taken. The overlap result holds on either build because the lookup is I/O-bound, and releasing the GIL during I/O is not what free-threading changes.

{% include excalidraw.html file="15-python-gil-concurrency" alt="grpc.aio's single event loop dispatching via asyncio.to_thread to a ThreadPoolExecutor, then two bands. I/O-bound (time.sleep, file or socket read): the GIL is released and 8 concurrent offloaded calls overlap. CPU-bound (pure Python loop): the GIL is held and 8 concurrent calls serialize regardless of thread count. A footer notes that the starving mode, calling blocking_lookup in-line with no await, blocks the event loop the way CPU-bound work blocks the GIL." caption="Figure 15.3: grpc.aio's single event loop, the thread pool asyncio.to_thread offloads onto, and why the GIL releases for I/O but not for CPU-bound work." %}

## The dispatch on both stacks

Both stacks run the same simulated lookup in every mode (`PricingCache.lookup` in Java, `blocking_lookup` in Python): a 200 millisecond sleep standing in for a database round trip, a real blocking read of a small bundled cache file (`pricing-cache.txt` or `pricing_cache.txt`, five rows), then a second 200 millisecond sleep standing in for a network-attached store. Two named delays around a real read keep both dependency hops visible as seams to replace with real calls. A pair with no match falls back to the first row. Only the thread differs.

{% include codetabs.html langs="Quarkus|Python" %}

```java
    @Blocking
    @Override
    public Uni<Routing.FindOptimalRouteResponse> findOptimalRoute(Routing.FindOptimalRouteRequest request) {
        String mode = request.getOrigin().getName();
        String originCode = request.getOrigin().getUnLocode();
        String destCode = request.getDestination().getUnLocode();

        Supplier<Routing.FindOptimalRouteResponse> work = () -> buildResponse(originCode, destCode);

        LOG.infof("FindOptimalRoute: origin=%s destination=%s mode='%s' thread=%s",
                originCode, destCode, mode.isEmpty() ? "(default)" : mode, Thread.currentThread());

        return switch (mode) {
            case MODE_STARVING -> onEventLoop(work);
            case MODE_VIRTUAL -> onVirtualThread(work);
            default -> Uni.createFrom().item(work);
        };
    }

    /**
     * STARVING contrast path. {@link Context#runOnContext(Runnable)}
     * schedules the given block onto {@link #starvingContext()}'s one fixed
     * event loop; running the blocking lookup INSIDE that block, rather
     * than just a cheap completion signal, is what makes this the starving
     * path: the event loop thread is occupied for the whole ~400ms, not
     * handed back immediately. This is the same primitive the Quarkus
     * "duplicated context" reference guide uses to hop code onto an event
     * loop from a worker thread ({@code context.runOnContext(runnable)});
     * the difference here is deliberately reusing ONE context across every
     * call instead of each call's own current context (see the class
     * Javadoc on {@link #MODE_STARVING}).
     */
    private Uni<Routing.FindOptimalRouteResponse> onEventLoop(Supplier<Routing.FindOptimalRouteResponse> work) {
        Context context = starvingContext();
        return Uni.createFrom().emitter(emitter -> context.runOnContext(ignored -> {
            try {
                emitter.complete(work.get());
            } catch (RuntimeException e) {
                emitter.fail(e);
            }
        }));
    }

    /**
     * Illustrative virtual-thread path: starts one fresh virtual thread per
     * call and runs the lookup there. {@code @RunOnVirtualThread} does the
     * same dispatch automatically when it is the method's execution-model
     * annotation; this demo reproduces it with {@link Thread#ofVirtual()}
     * directly because one shared method needs to switch models at
     * request time, which a method-level annotation cannot do.
     */
    private static Uni<Routing.FindOptimalRouteResponse> onVirtualThread(
            Supplier<Routing.FindOptimalRouteResponse> work) {
        return Uni.createFrom().emitter(emitter -> Thread.ofVirtual().start(() -> {
            try {
                emitter.complete(work.get());
            } catch (RuntimeException e) {
                emitter.fail(e);
            }
        }));
    }
```

```python
    async def FindOptimalRoute(
        self,
        request: routing_pb2.FindOptimalRouteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.FindOptimalRouteResponse:
        mode = request.origin.name
        origin_code = request.origin.un_locode
        dest_code = request.destination.un_locode

        logger.info(
            "FindOptimalRoute: origin=%s destination=%s mode='%s'",
            origin_code,
            dest_code,
            mode or "(default)",
        )

        if mode == MODE_STARVING:
            # STARVING: call the blocking function in-line, on THIS
            # coroutine, on grpc.aio's one event-loop thread. No await
            # point is reached until the ~400ms of work is already done, so
            # nothing else scheduled on this loop runs in the meantime.
            route = blocking_lookup(origin_code, dest_code)
        else:
            # CORRECT: hand the same blocking call to the default
            # thread-pool executor and await its future. The event loop is
            # free the instant this line suspends.
            route = await asyncio.to_thread(blocking_lookup, origin_code, dest_code)

        return routing_pb2.FindOptimalRouteResponse(route=route)
```

On Quarkus, `@Blocking` has already moved the call onto a worker thread, so the default branch runs the lookup right there. The `"starving"` branch hops back onto the shared event loop, the one place blocking work doesn't belong. On Python the whole decision is one `await`, and the starving line has no syntax that warns it will block every other call on the server. An `asyncio` codebase defends against that by convention and review, since the language doesn't make a blocking call look different from a non-blocking one.

The other seven RPCs return `UNIMPLEMENTED`: overridden explicitly on Quarkus, and inherited from the generated `RoutingServiceServicer` base class on Python.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Pick the execution model from the shape of the work. I/O-bound work (a query, a file read, a downstream RPC) is offloaded off the scarce thread: <code>@Blocking</code> or <code>@RunOnVirtualThread</code> on Quarkus, <code>asyncio.to_thread</code> or <code>run_in_executor</code> on Python. Reach for <code>@Blocking</code> first: it is simpler to reason about, and a fixed pool's backpressure (callers wait once every worker is busy instead of the server accepting unbounded work) is often what real load calls for. Use <code>@RunOnVirtualThread</code> when the pool's size caps the in-flight blocking calls you need, after auditing dependencies for native-code calls and <code>ThreadLocal</code>-heavy pooling. CPU-bound work is the case offloading doesn't help: on the JVM it still needs a thread, and on Python it meets the GIL whatever the executor, unless you target a free-threaded build. Worse than choosing wrong is not choosing: an unannotated Quarkus method that blocks, or a coroutine with a bare blocking call and no <code>await</code>, starves every other caller on the thread with no error pointing at the cause.</p></div>

> **🤖 Explore with your agent**
>
> "In `examples/15-backend-io-concurrency`, review `FindOptimalRoute` in `RoutingServiceImpl.java` and `python/app/routing_service.py`. For each Quarkus mode (default, `starving`, `virtual`) and each Python mode (default, `starving`), name the thread that runs the 400 millisecond lookup and the other callers it can stall. Then run `./verify.sh` and report the three batch timings."
>
> Check: the reply names the Vert.x worker pool, the shared event-loop context and a virtual thread on Quarkus, and `asyncio`'s default executor versus the single event loop on Python; `./verify.sh` ends with `PASS`.

## Build, run, observe

```bash
cd examples/15-backend-io-concurrency && ./verify.sh
```

`verify.sh` starts both stacks with `docker compose` (Quarkus on 9150, Python on 9151). It checks that one default call returns the expected `route.id` and `route.price`, that eight concurrent default calls all succeed with identical values in well under the 3.2 seconds eight serial calls would take (bound 2.5 seconds), and that eight concurrent starving calls take at least twice as long as the default batch. On Quarkus it also runs the `"virtual"` mode and checks the same overlap bound. By hand:

```bash
# Default model: offloaded, returns in about 400ms.
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9150 shipping.routing.v1.RoutingService/FindOptimalRoute
```

```
{
  "route": {
    "id": "rte_001",
    "legs": [{ "carrier": "MAERSK", "origin": {"unLocode":"USNYC"}, "destination": {"unLocode":"NLRTM"} }],
    "price": { "currency": "USD", "amount": "1200.00" }
  }
}
```

```bash
# Starving model: same request, same ~400ms of work, run on the shared event loop.
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC","name":"starving"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9150 shipping.routing.v1.RoutingService/FindOptimalRoute
```

A single call looks identical in both modes, so the difference only shows under concurrency. The assertions are loose and relative (a fixed bound and a factor of two), so they hold on slow and fast hardware alike.

Experiments:

- Send eight starving calls at once, then eight default calls: the first batch queues behind one thread, the second overlaps.
- Send `"name":"virtual"` to port 9150: the same lookup runs on a virtual thread per call and overlaps.
- Run a load tool such as [`ghz`](https://ghz.sh/) at the default endpoint, then again with `"name":"starving"` in the payload, and compare p50 and p99 latency and throughput.

## For deeper coverage

- [Quarkus: Reactive architecture](https://quarkus.io/guides/quarkus-reactive-architecture): the event-loop and worker-pool split that `@Blocking` and `@RunOnVirtualThread` dispatch onto.
- [Python: `asyncio.to_thread`](https://docs.python.org/3/library/asyncio-task.html#asyncio.to_thread): the offload mechanism the Python default path uses, and the executor it schedules onto.
- Cloud Native Design Patterns, "Anti-Patterns": blocking the one shared resource everyone depends on is the "coupling sneaking back in" failure shape that starving mode makes visible.
- Hüseyin Babal, *gRPC Microservices in Go*, Packt: performance and scaling patterns for a gRPC service under concurrent load.
