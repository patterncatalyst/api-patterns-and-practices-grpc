---
title: "Debugging gRPC"
order: 26
part: "Testing & Debugging"
description: "Reflection and channelz, common failure modes, decoding frames, and GRPC_TRACE and GRPC_VERBOSITY."
duration: "20 min read"
---

Chapter 25 proved a service behaves correctly. This chapter is about the moment it doesn't — a call comes back wrong, or not at all, and the question is no longer "does it work" but "where, exactly, did this fail." `RoutingService.GetQuote` is the RPC under test again, the same formula every unary chapter has shipped, but this chapter is not really about `GetQuote`. It is about four shapes a gRPC failure takes, how to tell them apart from the client side without adding a debugger to the server, and the three tools — reflection, channelz, and the `GRPC_TRACE`/`GRPC_VERBOSITY` environment variables — that answer "why" once a failure has a name.

The code is in `examples/26-debugging/`. The run script there (`verify.sh`) builds and starts both stacks, reproduces all four failure modes against each one, then runs the diagnosis pass; its `README.md` covers what it does and how to drive it by hand.

{% include excalidraw.html file="26-debug-failure-modes" alt="A table with four rows, one per failure mode, each showing symptom, cause, and fix. Row one: UNIMPLEMENTED, FindOptimalRoute call fails; cause, method never wired, declared in the proto with no server code; fix, implement it or route elsewhere, check reflection describe first. Row two: DEADLINE_EXCEEDED, GetQuote call fails; cause, budget less than work, a one second client deadline against a two second server delay; fix, raise the deadline or the budget, or speed up the slow path. Row three: UNAVAILABLE, RPC fails with no response; cause, cold or closed channel, nothing listening at the target; fix, fix the target address or wait for the server to start. Row four: TLS handshake failure, dial fails with no status code, the error text reads Failed to dial target host; cause, a TLS client talking to a plaintext server, or the reverse; fix, match the plaintext flag to the server, or add real TLS rather than flipping a flag." caption="Figure 26.1 — four failure modes, read left to right: what you see, why it happens, and what actually fixes it." %}

## Not every failure is a status code

Every error chapter before this one — Chapter 11's rich errors, Chapter 19's TLS rejections, Chapter 20's `UNAUTHENTICATED`/`PERMISSION_DENIED` — assumed a call reached gRPC's own status machinery: a server received a request, decided it could not satisfy it, and returned a `Status` with a canonical code. That assumption holds for exactly one of this chapter's four failure modes. `UNIMPLEMENTED` and `DEADLINE_EXCEEDED` are real statuses, returned by a server (or, for the deadline, by the runtime on the caller's behalf) that successfully exchanged HTTP/2 frames with a client. `UNAVAILABLE` on a cold channel and a TLS/plaintext mismatch are not — they happen before a connection exists at all, which is exactly why `grpcurl` reports them with no `Code:` line, the same "Failed to dial target host" prefix Chapter 19 first described for a TLS rejection. Telling these two families apart is the first and most useful diagnostic skill this chapter teaches: if the error text names a code, the server ran and decided something; if it doesn't, the bytes never arrived as a gRPC call at all.

## UNIMPLEMENTED: a method that exists in the contract but not in the code

`contracts/proto/shipping/routing/v1/routing.proto` declares five RPCs on `RoutingService`; this chapter's servers, like every one before it, implement only `GetQuote`. Calling `FindOptimalRoute` fails on both stacks with the same code and two different messages, because the two stacks reach `UNIMPLEMENTED` by different paths. Quarkus's `RoutingServiceImpl` throws it explicitly:

```java
@Override
public Uni<Routing.FindOptimalRouteResponse> findOptimalRoute(Routing.FindOptimalRouteRequest request) {
    return Uni.createFrom().failure(unimplemented("FindOptimalRoute"));
}

private static StatusRuntimeException unimplemented(String method) {
    return Status.UNIMPLEMENTED
            .withDescription(method + " lands in a later chapter")
            .asRuntimeException();
}
```

Python's `RoutingServiceServicer` never overrides `FindOptimalRoute` at all — the generated `routing_pb2_grpc.RoutingServiceServicer` base class already implements every method with a default that sets `UNIMPLEMENTED` and a stock message, so a subclass that overrides nothing still returns that status. Both are equally correct; the difference is purely cosmetic, and it is a useful one to notice in a traceback, because a custom message like `"FindOptimalRoute lands in a later chapter"` tells a caller this was a deliberate, documented gap, while `"Method not implemented!"` tells them only that nobody wrote the code — worth knowing which one you're looking at before filing a bug against someone else's service.

## DEADLINE_EXCEEDED: a budget that can't cover the work

Chapter 10 taught deadline propagation with a real downstream hop; this chapter needs only a deadline to have something to lose against, so `GetQuote` here carries a configurable artificial delay instead — `QUOTE_DELAY_MS`, 2000ms by default, read on both stacks and applied right before the response is built. On Quarkus, the delay is a Mutiny operator, not a blocking sleep:

```java
@ConfigProperty(name = "ch26.quote-delay-ms", defaultValue = "2000")
long quoteDelayMs;
// ...
return Uni.createFrom().item(response)
        .onItem().delayIt().by(Duration.ofMillis(quoteDelayMs));
```

`.delayIt()` schedules the emission on Mutiny's worker pool rather than parking the event-loop thread the way a `Thread.sleep()` call in this method would — the request waits, but the server keeps serving everything else while it does. Python reaches the same effect with a plain coroutine sleep, which is non-blocking by construction on an `asyncio` event loop:

```python
_QUOTE_DELAY_MS = int(os.environ.get("QUOTE_DELAY_MS", "2000"))
# ...
if _QUOTE_DELAY_MS > 0:
    await asyncio.sleep(_QUOTE_DELAY_MS / 1000)
return routing_pb2.GetQuoteResponse(quote=quote, route=route)
```

With the delay fixed at 2000ms, a 1-second client deadline (`grpcurl -max-time 1`) cannot possibly be satisfied — the call fails `DEADLINE_EXCEEDED` on both stacks every time, not occasionally, because the race is 1000ms of budget against 2000ms of unavoidable work. A 5-second deadline clears it with room to spare. Nothing about the server's correctness changed between those two calls; only how much time the caller was willing to wait did. That is the entire diagnostic value of this failure mode: `DEADLINE_EXCEEDED` almost never means "the server is broken" — it means "the budget and the work disagree," and the fix is to change one of those two numbers, not to go looking for a bug in `QuoteCalculator`.

## UNAVAILABLE on a cold channel — and why grpcurl can't show it

`UNAVAILABLE` is gRPC's catch-all for "no usable connection to the target," and this chapter reproduces the simplest version of it: a channel aimed at a port nothing is listening on. `compose.yaml` never publishes anything on port 9999 on either container, so a call against `quarkus:9999` or `python:9999` is refused by the operating system every single run — deterministic, not a race against a server that hasn't finished starting yet.

Reproducing this with `grpcurl` demonstrates the same gap Chapter 19 already found for a TLS mismatch: `grpcurl` dials **blocking**, before it ever attempts an RPC, so against a closed port it reports a raw dial failure — `Failed to dial target host "...": connection refused` — with no `Code:` line, because the call never reached gRPC's status machinery at all. A real application client built the way every unary chapter in this book has built one behaves differently. `grpc.aio.insecure_channel(target)` returns immediately without dialing anything; the channel only attempts to connect the first time a call is actually made on it. That first call against a dead target therefore surfaces the condition **as a status** — `grpc.StatusCode.UNAVAILABLE` — because the attempt and the failure both happen inside the RPC itself, not before it.

`examples/26-debugging/python/app/unavailable_probe.py` makes exactly that call:

```python
async def run(target: str) -> int:
    channel = grpc.aio.insecure_channel(target)
    try:
        stub = routing_pb2_grpc.RoutingServiceStub(channel)
        try:
            await stub.GetQuote(_REQUEST, timeout=5)
        except grpc.aio.AioRpcError as exc:
            if exc.code() == grpc.StatusCode.UNAVAILABLE:
                return 0
            return 1
    finally:
        await channel.close()
```

`verify.sh` runs this script from the already-built Python image — `docker compose run --rm --entrypoint python python -m app.unavailable_probe quarkus:9999` — against each stack's own dead port in turn, so the assertion is a real `grpc.StatusCode.UNAVAILABLE`, not a text match on a CLI tool's dial-failure wording. The lesson generalizes past this one script: whatever client library is making the call, if it builds a channel lazily (and most do), a cold or closed channel shows up as an application-visible status the caller's own error-handling code already knows how to catch — it is `grpcurl`'s particular dialing strategy that makes this one failure mode look, on the command line, indistinguishable from a TLS mismatch.

## TLS handshake failure: the wrong assumption about plaintext

This chapter's servers are plaintext, exactly like every chapter before Chapter 19. `grpcurl` defaults to TLS unless told otherwise with `-plaintext`, so a call that omits that flag against either server fails before a single byte of `GetQuoteRequest` is deserialized:

```
Failed to dial target host "localhost:9260": tls: first record does not look like a TLS handshake
```

This is the single most common real confusion in gRPC tooling, and the fix is almost never TLS configuration — it's checking that the `-plaintext` flag (or your client library's equivalent, `grpc.insecure_channel` versus `grpc.secure_channel`) actually matches what the server speaks. The same mismatch in the other direction — a plaintext client against a TLS-only server — produces the same family of error, as Chapter 19 showed with three different exact wordings depending on where the handshake dies. All three wordings, and this chapter's, share the one property that actually matters: no `Code:` line, because TLS negotiation happens below gRPC's own framing, and a failure there never reaches it.

<div class="callout callout--warn"><p class="callout__title">Watch out</p><p>Reflection's two implementations disagree about what they can resolve. <code>grpc-java</code>'s reflection service (Quarkus) answers <code>grpcurl describe shipping.routing.v1.RoutingService.GetQuote</code> — a full method name — directly. <code>grpcio-reflection</code> (Python) only resolves service and message symbols; the identical method-level <code>describe</code> call against the Python stack fails with <code>Symbol not found: shipping.routing.v1.RoutingService.GetQuote</code>, confirmed while writing this chapter. Neither behavior is a bug — the v1alpha reflection protocol never mandated method-level symbol resolution — but it means a <code>describe</code> script written and tested against one stack can silently stop working against the other. <code>describe shipping.routing.v1.RoutingService</code> (the service, not the method) resolves identically on both, which is why <code>verify.sh</code> asserts that form.</p></div>

## How the code works: channelz, and the two probe scripts

This chapter's Python server adds one registration to the same `grpc.aio.server()` every prior chapter built, right alongside `RoutingServiceServicer`:

```python
from grpc_channelz.v1 import channelz, channelz_pb2, channelz_pb2_grpc

server = grpc.aio.server()
routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)
channelz_pb2_grpc.add_ChannelzServicer_to_server(channelz.aio.ChannelzServicer(), server)

service_names = (
    routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name,
    channelz_pb2.DESCRIPTOR.services_by_name["Channelz"].full_name,
    reflection.SERVICE_NAME,
)
reflection.enable_server_reflection(service_names, server)
```

`channelz.aio.ChannelzServicer()` is the asyncio-server variant of the servicer the `grpcio-channelz` package ships (a synchronous `grpc.server()` would instead call the module-level `channelz.add_channelz_servicer(server)`); either way, it is a gRPC service like any other, added to the same server, answering on the same port — there is no separate admin listener to stand up or firewall. The one mistake worth watching for is forgetting the second line in `service_names`: channelz's servicer is registered and will answer a call that names it exactly, but without its full name in the reflection set, `grpcurl` cannot discover or resolve it by name at all, and a `describe grpc.channelz.v1.Channelz` would fail exactly the way an unregistered symbol always does.

`unavailable_probe.py` and `trace_probe.py` (both under `examples/26-debugging/python/app/`) are one-shot clients, not servers — the same shape as Chapter 7's `reuse_client.py`, run from the already-built Python image via `docker compose run --entrypoint python`, never shipped as a second image. `unavailable_probe.py`'s full logic is above; `trace_probe.py` is simpler still — it builds a channel, makes exactly one `GetQuote` call, and exits, because its entire job is to exist as something `GRPC_TRACE`/`GRPC_VERBOSITY` can act on when `verify.sh` sets them in the container environment it runs in. Both scripts import the generated `routing_pb2`/`routing_pb2_grpc` the same way the production server does, from `PYTHONPATH=/app/generated:/app` — nothing about them requires a special build step beyond the one the server already needs.

## Build, run, observe

```bash
cd examples/26-debugging && ./verify.sh
```

Expect `PASS` after roughly two minutes of build time (first run) or a few seconds (cached): both stacks come up, the baseline `GetQuote` correctness check passes on each, all four failure modes above reproduce and assert on each, and the diagnosis pass (reflection on both, channelz on Python, `GRPC_TRACE`/`GRPC_VERBOSITY` on both) completes last. Real output from each step is in `examples/26-debugging/README.md` and in the "On the wire" section below.

{% include excalidraw.html file="26-diagnosis-toolbox" alt="Three columns, one per diagnosis tool. Column one, Reflection: server reflection via grpcurl list and describe; reveals services, methods, and message shapes with no proto file needed; Quarkus has full support for service, method, and message describe; Python supports service and message describe only, method-level describe returns Symbol not found. Column two, channelz: the grpc channelz v1 Channelz GetServers call; reveals live servers, sockets, and calls started, succeeded, and failed counts; Quarkus has no support, absent from quarkus-grpc 3.40.x, shown with a dashed box; Python has full support, registered on the same port as the same server. Column three, GRPC_TRACE and GRPC_VERBOSITY: environment variables read by the calling library, not the server; reveals C-core transport and call activity written to stderr; grpcurl, built on grpc-go, is silent and uses GRPC_GO_LOG_VERBOSITY_LEVEL instead, shown with a dashed box; grpc-python, built on the C-core, is verbose, and the exact lines are illustrative and vary by release." caption="Figure 26.2 — what each diagnosis tool reveals, and where it does and doesn't apply across the two stacks." %}

## Diagnosis: reflection, channelz, and GRPC_TRACE

Reflection is unchanged from every prior chapter — both stacks answer `grpcurl list` and `grpcurl describe shipping.routing.v1.RoutingService` without a local copy of the `.proto` file, which is the whole reason a tool like `grpcurl` is useful against a service you didn't build. Channelz goes one layer deeper than reflection: instead of describing the *shape* of a service, `grpc.channelz.v1.Channelz/GetServers` reports what the running server actually did — how many calls started, succeeded, and failed, what socket it's listening on — all without touching `RoutingServiceImpl` or `RoutingServiceServicer` at all. This chapter's Python server exposes it; its Quarkus server does not, because `quarkus-grpc` 3.40.x has no channelz support at all — it appears nowhere in either the gRPC reference guide or the service-implementation guide, confirmed by searching both before writing this chapter. That gap is a property of the extension, not a configuration this book skipped: a Quarkus deployment's equivalent diagnostic surface is the combination this chapter already covers for it — reflection to confirm shape, and structured logs (`LOG.infof` in `RoutingServiceImpl`) to confirm behavior — plus the Micrometer-based gRPC metrics Chapter 21 covered, which report aggregate call counts and latencies without channelz's live per-connection detail.

`GRPC_TRACE` and `GRPC_VERBOSITY` sit outside both of those: they are environment variables the **calling** library reads, not a service the target server exposes, so they work identically against either stack's `GetQuote` — what varies is which client library is doing the calling. `grpc-python`, like `grpc-java` and the C++ core, wraps the same underlying C-core gRPC implementation, and `GRPC_VERBOSITY=DEBUG` with `GRPC_TRACE=api,call_error,connectivity_state` makes that core log every call, every connectivity-state transition, on stderr. `grpcurl` cannot demonstrate this at all, for the same reason it dials differently than `grpc.aio` does: it's built on `grpc-go`, a from-scratch Go implementation with its own logging surface (`GRPC_GO_LOG_VERBOSITY_LEVEL`, `GRPC_GO_LOG_SEVERITY_LEVEL`) that ignores `GRPC_TRACE` entirely. `trace_probe.py` exists specifically to have a C-core-backed caller available for this demonstration.

## Cross-check

Independent of the Python probe's own assertion, a connection attempt at the TCP level — no gRPC involved at all — confirms the same fact the UNAVAILABLE repro depends on:

```bash
docker compose -p ch26-debugging exec quarkus sh -c "echo > /dev/tcp/quarkus/9999"
# sh: connect: Connection refused
# sh: line 1: /dev/tcp/quarkus/9999: Connection refused
```

A shell built-in that knows nothing about gRPC, protobuf, or status codes gets refused at exactly the same TCP layer `unavailable_probe.py` does — confirming the failure is what this chapter claims it is (nothing listening on that port) rather than some gRPC-specific misbehavior that only looks like a connection problem.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Start every unexplained gRPC failure with reflection — <code>grpcurl describe &lt;service&gt;</code> against the target costs one command and tells you whether the method you're calling exists at all, which rules out <code>UNIMPLEMENTED</code> in one step. If the error text contains a <code>Code:</code> line, the server ran: treat <code>DEADLINE_EXCEEDED</code> as a budget-versus-work problem first (what did the deadline say, how long did the call actually take) before suspecting application logic. If it doesn't contain a <code>Code:</code> line, nothing reached the server: check the obvious transport mismatch first — plaintext versus TLS, wrong port, wrong network — before reaching for certificates or firewalls. Reach for channelz when you need live connection and call-count data from a running Python service without redeploying it with new logging; reach for <code>GRPC_TRACE</code>/<code>GRPC_VERBOSITY</code> only as a last resort on a C-core-backed caller (grpc-python, grpc-java, grpc-c++), since the volume of output is real and the exact lines are not a stable contract across releases.</p></div>

## What you learned

- Only two of this chapter's four failure modes are real gRPC statuses (`UNIMPLEMENTED`, `DEADLINE_EXCEEDED`); the other two (a cold channel, a TLS/plaintext mismatch) fail before a connection exists, which is why their error text never contains a `Code:` line — that absence is itself the diagnostic signal.
- `grpcurl`'s blocking dial and `grpc.aio`'s lazy channel disagree about how a dead target shows up: a CLI dial failure with no status code, versus an application-visible `grpc.StatusCode.UNAVAILABLE` on the first real RPC — the same underlying condition, reported two different ways by two different client designs.
- channelz and `GRPC_TRACE`/`GRPC_VERBOSITY` answer different questions at different layers: channelz asks the server what it's doing right now; the trace variables ask the calling library's C-core what it's doing on the wire — and both have real gaps (no channelz in `quarkus-grpc` 3.40.x; no `GRPC_TRACE` support in `grpcurl`'s Go-based client) worth knowing before you go looking for output that was never going to appear.
- Reflection's own symbol resolution isn't identical across implementations — service- and message-level `describe` are portable across `grpc-java` and `grpcio-reflection`; method-level `describe` is not.

Chapter 27 puts every piece this book has built — contracts, both language stacks, TLS, auth, observability, and now debugging — into one running system end to end.

## On the wire

The four failure modes, real output from an authoring-machine run:

```bash
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"preferSpeed":false}' \
  localhost:9260 shipping.routing.v1.RoutingService/FindOptimalRoute
# ERROR:
#   Code: Unimplemented
#   Message: FindOptimalRoute lands in a later chapter
```

```bash
grpcurl -plaintext -max-time 1 -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1200.5}]}' \
  localhost:9260 shipping.routing.v1.RoutingService/GetQuote
# ERROR:
#   Code: DeadlineExceeded
#   Message: context deadline exceeded
```

```bash
docker compose run --rm --entrypoint python python -m app.unavailable_probe quarkus:9999
# unavailable_probe: target=quarkus:9999 code=StatusCode.UNAVAILABLE
#   details='failed to connect to all addresses; last error: UNKNOWN:
#   ipv4:172.19.0.3:9999: Failed to connect to remote host: Connection refused'
# unavailable_probe: ok — UNAVAILABLE on a cold/closed channel
```

```bash
grpcurl -d '{}' localhost:9260 shipping.routing.v1.RoutingService/GetQuote
# Failed to dial target host "localhost:9260": tls: first record does not look like a TLS handshake
```

The diagnosis pass, in order: reflection, channelz, trace.

```bash
grpcurl -plaintext localhost:9260 describe shipping.routing.v1.RoutingService
# service RoutingService {
#   rpc FindOptimalRoute ( .shipping.routing.v1.FindOptimalRouteRequest ) returns ( .shipping.routing.v1.FindOptimalRouteResponse );
#   rpc GetQuote ( .shipping.routing.v1.GetQuoteRequest ) returns ( .shipping.routing.v1.GetQuoteResponse );
#   ...
# }

grpcurl -plaintext -d '{}' localhost:9261 grpc.channelz.v1.Channelz/GetServers
# {
#   "server": [
#     {
#       "ref": { "server_id": "2" },
#       "data": {
#         "trace": { "creation_timestamp": "2026-10-14T11:47:17.543483636Z", "events": [...] },
#         "calls_started": "3",
#         "calls_failed": "1",
#         "last_call_started_timestamp": "2026-10-14T11:47:20.335483678Z"
#       },
#       "listen_socket": [{ "socket_id": "3", "name": "chttp2 listener ipv4:0.0.0.0:9000" }]
#     }
#   ],
#   "end": true
# }

docker compose run --rm -e GRPC_TRACE=api,call_error,connectivity_state -e GRPC_VERBOSITY=DEBUG \
  --entrypoint python python -m app.trace_probe quarkus:9000
# I1014 11:46:31.754228       1 channel_create.cc:249] grpc_channel_create(target=quarkus:9000, creds=0x55bd30d982f0, args=0x7f2b0c5676d0)
# I1014 11:46:31.755093      13 connectivity_state.cc:150] ConnectivityStateTracker client_channel[0x55bd30f81888]: IDLE -> CONNECTING (started resolving, OK)
# I1014 11:46:31.795887      17 connectivity_state.cc:150] ConnectivityStateTracker client_channel[0x55bd30f81888]: CONNECTING -> READY (helper, OK)
# trace_probe: GetQuote ok, quote.amount=3001.25
```

---

*Verification status: <span class="status status--verified">verified</span>.
`examples/26-debugging/verify.sh` was run end to end against both stacks: the
baseline `GetQuote` correctness check passed on both; `FindOptimalRoute`
failed `UNIMPLEMENTED` on both; a 1-second deadline against the
artificially-delayed `GetQuote` failed `DEADLINE_EXCEEDED` on both (a 5-second
deadline succeeded on both); a call against each stack's own closed port
9999 failed with `grpc.StatusCode.UNAVAILABLE`; a TLS-defaulting `grpcurl`
call against each plaintext server failed at the handshake
(`tls: first record does not look like a TLS handshake`); reflection's
service-level `list`/`describe` succeeded on both, and the method-level
`describe` asymmetry between `grpc-java` and `grpcio-reflection` documented
above was reproduced directly, not inferred; channelz's `GetServers`
returned live server data on the Python stack; and `GRPC_TRACE`/
`GRPC_VERBOSITY` produced non-empty C-core trace output from a grpc-python
caller against both stacks. The `GRPC_TRACE`/`GRPC_VERBOSITY` log lines
quoted above are copied verbatim (four lines selected out of 60+ total) from
one real captured run — a reader's own run will show the same four kinds of
line with different timestamps, thread IDs, and object addresses, since
those vary every run by construction, and `verify.sh` asserts only that
output appeared at all, not these exact bytes.*
