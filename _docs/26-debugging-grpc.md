---
title: "Debugging gRPC"
order: 26
part: "Testing & Debugging"
description: "Tell a status from a failure before any connection exists, then use reflection, channelz and GRPC_TRACE to find the cause."
duration: "15 min read"
---

## Learning objectives

By the end of this chapter you can:

- Tell a real gRPC status (`UNIMPLEMENTED`, `DEADLINE_EXCEEDED`) from a failure that happens before a connection exists (a cold channel, a TLS/plaintext mismatch) by checking whether the error carries a `Code:` line.
- Diagnose `DEADLINE_EXCEEDED` as a budget-versus-work problem with `grpcurl -max-time`.
- Discover a service's shape with server reflection and no local `.proto`, and know where Java and Python reflection differ.
- Read live connection and call counts from `grpc.channelz.v1.Channelz/GetServers` on a Python service.
- Turn on `GRPC_TRACE` and `GRPC_VERBOSITY` for a C-core caller to see call and connectivity-state activity.

## Why this matters

A call comes back wrong, or not at all, and the question is where it failed. `RoutingService.GetQuote` is the RPC under test, with an artificial delay so a deadline has something to lose against. gRPC failures take four shapes, and the client side can tell them apart without a debugger on the server. Reflection, channelz and the `GRPC_TRACE` and `GRPC_VERBOSITY` environment variables then explain why.

{% include excalidraw.html file="26-debug-failure-modes" alt="A table with four rows, one per failure mode, each showing symptom, cause, and fix. Row one: UNIMPLEMENTED, FindOptimalRoute call fails; cause, method never wired, declared in the proto with no server code; fix, implement it or route elsewhere, check reflection describe first. Row two: DEADLINE_EXCEEDED, GetQuote call fails; cause, budget less than work, a one second client deadline against a two second server delay; fix, raise the deadline or the budget, or speed up the slow path. Row three: UNAVAILABLE, RPC fails with no response; cause, cold or closed channel, nothing listening at the target; fix, fix the target address or wait for the server to start. Row four: TLS handshake failure, dial fails with no status code, the error text reads Failed to dial target host; cause, a TLS client talking to a plaintext server, or the reverse; fix, match the plaintext flag to the server, or add real TLS rather than flipping a flag." caption="Figure 26.1: Four failure modes, each with what you see, why it happens and what fixes it." %}

## Not every failure is a status code

Two of the four failures are statuses. `UNIMPLEMENTED` and `DEADLINE_EXCEEDED` come from a server, or from the caller's runtime for the deadline, that exchanged HTTP/2 frames with a client. A cold channel and a TLS/plaintext mismatch happen before a connection exists, so `grpcurl` reports them with a `Failed to dial target host` prefix and no `Code:` line.

If the error names a code, the server ran and decided something. If it doesn't, the bytes never arrived as a gRPC call. Make that distinction first.

## UNIMPLEMENTED: in the contract, not in the code

`routing.proto` declares five RPCs on `RoutingService`, and the servers implement only `GetQuote`. Calling `FindOptimalRoute` fails with `UNIMPLEMENTED` on both stacks, with different messages because they get there differently. Quarkus throws it explicitly:

```java
    @Override
    public Uni<Routing.FindOptimalRouteResponse> findOptimalRoute(Routing.FindOptimalRouteRequest request) {
        return Uni.createFrom().failure(unimplemented("FindOptimalRoute"));
    }
```

```java
    private static StatusRuntimeException unimplemented(String method) {
        return Status.UNIMPLEMENTED
                .withDescription(method + " lands in a later chapter")
                .asRuntimeException();
    }
```

In Python the generated `RoutingServiceServicer` base class already answers every method with `UNIMPLEMENTED` and the stock message `Method not implemented!`, so a subclass that overrides nothing returns it. A custom message marks a deliberate, documented gap. The stock one only says nobody wrote the code. Know which you're looking at before filing a bug against someone else's service.

## DEADLINE_EXCEEDED: a budget that can't cover the work

`GetQuote` waits `QUOTE_DELAY_MS` (2,000 ms by default) before it responds; Quarkus reads it through the `ch26.quote-delay-ms` config property, Python straight from the environment. On Quarkus the delay is a Mutiny operator, which schedules the emission on a worker pool instead of parking the event-loop thread the way `Thread.sleep()` would:

```java
        return Uni.createFrom().item(response)
                .onItem().delayIt().by(Duration.ofMillis(quoteDelayMs));
```

Python uses a coroutine sleep, which doesn't block the `asyncio` event loop:

```python
        if _QUOTE_DELAY_MS > 0:
            await asyncio.sleep(_QUOTE_DELAY_MS / 1000)

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)
```

A 1-second deadline (`grpcurl -max-time 1`) against 2,000 ms of work fails every time, not occasionally. A 5-second deadline succeeds. The server is correct in both calls. `DEADLINE_EXCEEDED` almost never means the server is broken. It means the budget and the work disagree, so change one of those two numbers instead of hunting for a bug in the quote formula.

## UNAVAILABLE on a cold channel

`UNAVAILABLE` means there is no usable connection to the target. The simplest repro is a channel aimed at port 9999, where nothing listens, so the operating system refuses every attempt.

`grpcurl` dials blocking before it issues an RPC, so against a closed port it prints a raw `connection refused` dial error with no `Code:` line, which looks like a TLS mismatch. An application client behaves differently. `grpc.aio.insecure_channel(target)` returns without dialing, and the first call is what connects. The failure then arrives as a status on the call:

```python
async def run(target: str) -> int:
    channel = grpc.aio.insecure_channel(target)
    try:
        stub = routing_pb2_grpc.RoutingServiceStub(channel)
        try:
            await stub.GetQuote(_REQUEST, timeout=5)
        except grpc.aio.AioRpcError as exc:
            print(f"unavailable_probe: target={target} code={exc.code()} details={exc.details()!r}")
            if exc.code() == grpc.StatusCode.UNAVAILABLE:
                print("unavailable_probe: ok, UNAVAILABLE on a cold/closed channel")
                return 0
            print(f"unavailable_probe: FAIL, expected UNAVAILABLE, got {exc.code()}", file=sys.stderr)
            return 1
        print("unavailable_probe: FAIL, call against a dead target unexpectedly succeeded", file=sys.stderr)
        return 1
    finally:
        await channel.close()
```

Most client libraries build channels lazily, so a cold or closed channel reaches your error handling as `grpc.StatusCode.UNAVAILABLE`, which the code already knows how to catch. Only the CLI's dialing strategy makes it look like a transport error.

## TLS handshake failure: the wrong assumption about plaintext

The servers are plaintext. `grpcurl` assumes TLS unless told `-plaintext`, so omitting the flag fails before any request is deserialized:

```
Failed to dial target host "localhost:9260": tls: first record does not look like a TLS handshake
```

This is the most common confusion in gRPC tooling, and the fix is rarely TLS configuration. Check that `-plaintext`, or `grpc.insecure_channel` versus `grpc.secure_channel` in a client library, matches what the server speaks. A plaintext client against a TLS-only server fails the same way with different wording. In every case there is no `Code:` line, because TLS negotiation happens below gRPC framing.

## Diagnosis tools

{% include excalidraw.html file="26-diagnosis-toolbox" alt="Three columns, one per diagnosis tool. Column one, Reflection: server reflection via grpcurl list and describe; reveals services, methods, and message shapes with no proto file needed; Quarkus has full support for service, method, and message describe; Python supports service and message describe only, method-level describe returns Symbol not found. Column two, channelz: the grpc channelz v1 Channelz GetServers call; reveals live servers, sockets, and calls started, succeeded, and failed counts; Quarkus has no support, shown with a dashed box; Python has full support, registered on the same port as the same server. Column three, GRPC_TRACE and GRPC_VERBOSITY: environment variables read by the calling library, not the server; reveals C-core transport and call activity written to stderr; grpcurl, built on grpc-go, is silent and uses GRPC_GO_LOG_VERBOSITY_LEVEL instead, shown with a dashed box; grpc-python, built on the C-core, is verbose, and the exact lines are illustrative and vary by release." caption="Figure 26.2: What each diagnosis tool reveals, and where it applies on each stack." %}

| Tool | Answers | Quarkus | Python |
|---|---|---|---|
| Reflection (`grpcurl list`, `describe`) | What services, methods and messages exist | Service, method and message symbols | Service and message symbols only |
| channelz (`Channelz/GetServers`) | What the running server did: sockets, calls started, succeeded, failed | Not available in `quarkus-grpc` | Registered on the same port |
| `GRPC_TRACE`, `GRPC_VERBOSITY` | What the calling library does on the wire | Works against it; set on the caller | Works against it; set on the caller |

### Reflection

`grpcurl describe shipping.routing.v1.RoutingService` resolves identically on both stacks. A method-level `describe shipping.routing.v1.RoutingService.GetQuote` works on `grpc-java` and fails on `grpcio-reflection` with `Symbol not found`. Neither is a bug, because the reflection protocol never required method-level resolution, but a script written against one stack can stop working against the other. Describe the service, not the method.

### channelz

channelz reports the server's own view: listening sockets and calls started, succeeded and failed. It doesn't touch the business logic. On Python it is one more servicer on the same `grpc.aio` server, so there is no separate admin port:

```python
    channelz_pb2_grpc.add_ChannelzServicer_to_server(channelz.aio.ChannelzServicer(), server)

    service_names = (
        routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name,
        channelz_pb2.DESCRIPTOR.services_by_name["Channelz"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)
```

Add the channelz name to the reflection set too. The servicer answers a call that names it exactly, but without the name `grpcurl` can't discover or describe it. A synchronous `grpc.server()` registers it with `channelz.add_channelz_servicer(server)` instead.

`quarkus-grpc` has no channelz support. A Quarkus service gets its diagnostic surface from reflection, structured logs and the gRPC metrics from Micrometer, which report aggregate counts and latencies without per-connection detail.

### GRPC_TRACE and GRPC_VERBOSITY

These variables configure the calling library, not the server, so they work against either stack; what matters is the client. `grpc-python` wraps the C-core gRPC implementation, and `GRPC_VERBOSITY=DEBUG` with `GRPC_TRACE=api,call_error,connectivity_state` logs each call and connectivity-state transition to stderr. `grpcurl` is built on `grpc-go`, which ignores both and uses `GRPC_GO_LOG_VERBOSITY_LEVEL` and `GRPC_GO_LOG_SEVERITY_LEVEL`. The output is large and its exact lines vary between releases, so narrow the tracer list and treat it as a last resort.

| Symptom | First step |
|---|---|
| Error text has no `Code:` line | Check plaintext versus TLS, then port and network, before certificates or firewalls |
| `UNIMPLEMENTED` | `grpcurl describe <service>` to see whether the method exists |
| `DEADLINE_EXCEEDED` | Compare the deadline to how long the call takes |
| Need live call counts from a Python service without redeploying | channelz |
| Wire-level detail from a C-core caller | `GRPC_TRACE`, narrowed to a few tracers |

> **🤖 Explore with your agent**
>
> "In examples/26-debugging, call RoutingService.GetQuote on the Quarkus service (9260) and the Python service (9261) with grpcurl -max-time 1, then -max-time 5. Classify each result as a status or a failure before a connection exists using the Code: line rule, and say whether QUOTE_DELAY_MS or the client deadline should change."
>
> Check: the 1-second calls fail with `Code: DeadlineExceeded` on both stacks, the 5-second calls return the quote, and the reply names the budget against the 2,000 ms delay as the cause.

## Build, run, observe

```bash
cd examples/26-debugging && ./verify.sh
```

`verify.sh` builds and starts both stacks (Quarkus on 9260, Python on 9261), checks the baseline `GetQuote`, reproduces all four failures on each, and runs the diagnosis pass. It prints `PASS` when everything holds, after a couple of minutes on the first run and seconds when cached. `examples/26-debugging/README.md` lists each command to run by hand.

By hand:

- Run `docker compose run --rm --entrypoint python python -m app.unavailable_probe quarkus:9999`. The probe reports `StatusCode.UNAVAILABLE`.
- Run `grpcurl -plaintext -d '{}' localhost:9261 grpc.channelz.v1.Channelz/GetServers`. The reply carries the listening socket and `calls_started` and `calls_failed` counts.
- Run the trace probe with tracing on: `docker compose run --rm -e GRPC_TRACE=api,call_error,connectivity_state -e GRPC_VERBOSITY=DEBUG --entrypoint python python -m app.trace_probe quarkus:9000`. Channel creation and the `IDLE` to `CONNECTING` to `READY` transitions appear on stderr before `trace_probe: GetQuote ok`.
- Confirm the cold-channel cause with no gRPC involved: `docker compose -p ch26-debugging exec quarkus sh -c "echo > /dev/tcp/quarkus/9999"` is refused at the TCP layer.

Experiments:

- **Drop `-plaintext`.** Call either port without it: the call fails with `tls: first record does not look like a TLS handshake` and no `Code:` line.
- **Describe a method.** Run `grpcurl -plaintext localhost:9261 describe shipping.routing.v1.RoutingService.GetQuote`: Python answers `Symbol not found`, and the same call on 9260 resolves.
- **Remove the delay.** Set `QUOTE_DELAY_MS=0` in `compose.yaml` and recreate the stacks: the `-max-time 1` call now returns the quote, because the work fits the budget.

---

## For deeper coverage

- Sam Newman, *Building Microservices*, 2nd ed. (O'Reilly, 2021): resilient inter-service calls and the failure handling these four modes fall under.
- Cloud Native Design Patterns, Appendix M, "Failure Modes."
- [grpc.io: Debugging](https://grpc.io/docs/guides/debugging/): channelz, health checking, and CSDS tooling for inspecting a running gRPC server.
- [grpc.io: Reflection](https://grpc.io/docs/guides/reflection/): the protocol `grpcurl list` and `describe` rely on.
