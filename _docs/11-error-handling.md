---
title: "Error and exception handling"
order: 11
part: "Reliability: Deadlines, Errors & Interceptors"
description: "Canonical status codes as the contract, the rich error model built from google.rpc.Status and its typed details, and the line between a retryable and a non-retryable failure."
duration: "17 min"
---

## Learning objectives

By the end of this chapter you can:

- Classify a `GetQuote` failure into the right canonical status code instead of defaulting to `INTERNAL`.
- Build a rich `google.rpc.Status` with typed details (`ErrorInfo`, `BadRequest`, `RetryInfo`) using `StatusProto.toStatusRuntimeException` on Quarkus and `grpc_status.rpc_status.to_status` on Python.
- Decide whether a failure is safe to retry from its code and the call's idempotency.
- Map a gRPC status and its details onto an HTTP response at the REST to gRPC boundary.

## Why this matters

`RoutingService.GetQuote` fails three ways, and each calls for a different response. A caller that leaves `destination` empty sent a malformed request, and no retry fixes that. A caller that asks for a quote from a UN/LOCODE the engine can't route from asks a question with a stable answer: no. A caller that lands during a transient blip in the engine's dependencies asks a question that succeeds if asked again in two seconds. Canonical status codes let a client tell these apart without parsing a sentence. Typed details carry the specifics on top of the code.

## The canonical status codes are the contract

Every call ends in one of a small fixed set of codes, defined once in `google.rpc.Code` and reused by every language's stubs. A client branches on the code, not on a string, so the code the server picks is the API contract for failure, as binding as a field's type.

{% include excalidraw.html file="11-status-code-taxonomy" alt="The canonical gRPC status codes grouped by meaning. Malformed request: INVALID_ARGUMENT, retry never. State of the world: NOT_FOUND and FAILED_PRECONDITION, retry never. Transient: UNAVAILABLE and DEADLINE_EXCEEDED, retry with backoff, or only if idempotent. Overload: RESOURCE_EXHAUSTED, a self-imposed 429, retry honoring backoff. Auth: UNAUTHENTICATED and PERMISSION_DENIED, retry only after fixing credentials or the grant. Last resort: INTERNAL, shown in a dark box." caption="Figure 11.1: The canonical status codes grouped by meaning, not alphabetically; INTERNAL is the last resort, not the default." %}

| Code | Meaning for `GetQuote` | Retry |
| --- | --- | --- |
| `OK` | The quote computed; the caller gets a `Route` and a `Money`. | n/a |
| `INVALID_ARGUMENT` | The request is malformed: empty `origin.un_locode`, missing `destination`. It fails identically however often it is sent. | Never |
| `NOT_FOUND` | The request is well-formed and names something that doesn't exist, such as an origin the engine can't route from. A fact about current state, not a malformed question. | Never |
| `FAILED_PRECONDITION` | The target exists but the system isn't in a state where the operation can succeed, such as confirming a booking whose quote expired. Something must change first. | Never as-is |
| `UNAVAILABLE` | The server or a dependency can't be reached. The canonical "try again" code, and the one a load balancer or mesh watches to route around an endpoint. | With backoff |
| `DEADLINE_EXCEEDED` | The call didn't finish inside its deadline. | Only if idempotent and budget remains |
| `RESOURCE_EXHAUSTED` | The server is shedding load, a self-imposed `429`. | With backoff |
| `UNAUTHENTICATED`, `PERMISSION_DENIED` | The caller's identity is missing or lacks the grant. | After fixing credentials or the grant |
| `INTERNAL` | Something broke that the service has no better name for. | Treat as a bug |

`NOT_FOUND` and `INVALID_ARGUMENT` must stay distinct. A client that treats `NOT_FOUND` like `INVALID_ARGUMENT` stops looking for a fix, and one that treats it as transient wastes retries on an answer that won't change.

`INTERNAL` is where most of the damage happens, because it is one line that always compiles and never requires choosing a code. Collapsing a `NullPointerException` from a malformed field and an unreachable downstream call into `INTERNAL` strips every automated caller of the one signal it acts on: retry, give up, or page someone. A retry policy watching for `UNAVAILABLE` never fires, and a client that would have shown "origin not found" shows a generic failure. Reserve `INTERNAL` for a case the server has no name for, and log it as a bug to fix.

## The rich error model: google.rpc.Status and its details

A code answers "what kind of failure"; a client acting on `NOT_FOUND` also wants a machine-readable reason, the offending field, or how long to wait. `google.rpc.Status` carries all three without a bespoke JSON blob per service: a `code`, a human-readable `message` that is safe to show a user, and a `details` list of typed, `Any`-packed messages that the client unpacks by type.

| Detail | Carries | Use |
| --- | --- | --- |
| `ErrorInfo` | A stable upper-snake-case `reason` such as `ORIGIN_UNROUTABLE`, and a `domain` naming the system of record | Alerting keys on `reason`, which doesn't change when someone edits the message |
| `BadRequest` | `field_violations`, each with a `field` and a `description` | Turns "the request is invalid" into "`origin.un_locode` is required" |
| `RetryInfo` | A `retry_delay` | Turns "retryable" into an instruction with a number |

{% include excalidraw.html file="11-rich-error-model" alt="A gRPC error as a code, a message and a details list. RoutingService.GetQuote builds a google.rpc.Status with code NOT_FOUND and a safe message. The details array holds Any-packed ErrorInfo, BadRequest or RetryInfo and rides in the gRPC trailers to the client. The client reads the code first, then unpacks details. UNAVAILABLE, idempotent DEADLINE_EXCEEDED and RESOURCE_EXHAUSTED take a retryable path that backs off; INVALID_ARGUMENT, NOT_FOUND and FAILED_PRECONDITION take a non-retryable path that surfaces the failure now." caption="Figure 11.2: A gRPC error is a code, a message and typed details; the client branches on the code before it reads a detail." %}

The detail types aren't declared in `routing.proto`. They come from `google/rpc/error_details.proto`, which every gRPC ecosystem ships a runtime library for, so a Java client and a Python client unpack the same bytes with native classes.

| Stack | Library | Packing call |
| --- | --- | --- |
| Quarkus | `com.google.api.grpc:proto-google-common-protos` for `Status`, `Code` and the details; `grpc-protobuf` is already on the classpath | `StatusProto.toStatusRuntimeException(status)` returns a `StatusRuntimeException` whose trailers carry the status |
| Python | `grpcio-status` for `status_pb2` and `error_details_pb2` | `rpc_status.to_status(status)` passed to `context.abort_with_status(...)` |

## Implementing rich errors

`GetQuote` fails three deterministic ways and succeeds a fourth, so the same request gives the same code and detail on both stacks:

| Input | Code | Detail |
| --- | --- | --- |
| Empty or missing `un_locode` on `origin` or `destination` | `INVALID_ARGUMENT` | `BadRequest` naming the field |
| `origin` of `ZZZZZ` (unroutable by convention) | `NOT_FOUND` | `ErrorInfo`, reason `ORIGIN_UNROUTABLE` |
| `origin` of `RETRY` | `UNAVAILABLE` | `RetryInfo` of two seconds |
| Anything else | `OK` | The quote |

{% include codetabs.html langs="Quarkus|Python" %}

```java
    private static StatusRuntimeException richError(Code code, String message, Any detail) {
        com.google.rpc.Status richStatus = com.google.rpc.Status.newBuilder()
                .setCode(code.getNumber())
                .setMessage(message)
                .addDetails(detail)
                .build();
        return StatusProto.toStatusRuntimeException(richStatus);
    }
```

```python
    @staticmethod
    async def _abort_rich(
        context: grpc.aio.ServicerContext,
        code: int,
        message: str,
        detail: any_pb2.Any,
    ) -> None:
        """Builds a google.rpc.Status (canonical code + one rich detail) and hands it to
        context.abort_with_status so it lands in the gRPC trailers, the same place
        grpcurl, or any client library, looks for it. Raises grpc.aio.AbortError;
        callers do not need to return afterwards."""
        rich_status = status_pb2.Status(code=code, message=message, details=[detail])
        await context.abort_with_status(rpc_status.to_status(rich_status))
```

Each branch then names its code, its message and one packed detail:

{% include codetabs.html langs="Quarkus|Python" %}

```java
        if (UNROUTABLE_ORIGIN.equals(origin.getUnLocode())) {
            return Uni.createFrom().failure(richError(
                    Code.NOT_FOUND,
                    "origin " + UNROUTABLE_ORIGIN + " is unroutable (ErrorInfo reason=ORIGIN_UNROUTABLE)",
                    Any.pack(ErrorInfo.newBuilder()
                            .setReason("ORIGIN_UNROUTABLE")
                            .setDomain(ERROR_DOMAIN)
                            .build())));
        }

        if (RETRY_ORIGIN.equals(origin.getUnLocode())) {
            return Uni.createFrom().failure(richError(
                    Code.UNAVAILABLE,
                    "routing service temporarily unavailable, retry per RetryInfo",
                    Any.pack(RetryInfo.newBuilder()
                            .setRetryDelay(Duration.newBuilder().setSeconds(2).build())
                            .build())));
        }
```

```python
        if origin.un_locode == _UNROUTABLE_ORIGIN:
            await self._abort_rich(
                context,
                code_pb2.NOT_FOUND,
                f"origin {_UNROUTABLE_ORIGIN} is unroutable (ErrorInfo reason=ORIGIN_UNROUTABLE)",
                _pack(error_details_pb2.ErrorInfo(reason="ORIGIN_UNROUTABLE", domain=_ERROR_DOMAIN)),
            )

        if origin.un_locode == _RETRY_ORIGIN:
            await self._abort_rich(
                context,
                code_pb2.UNAVAILABLE,
                "routing service temporarily unavailable, retry per RetryInfo",
                _pack(error_details_pb2.RetryInfo(retry_delay=duration_pb2.Duration(seconds=2))),
            )
```

Each handler picks the canonical code, writes a message that stays legible when a client never unpacks the detail, and packs one typed detail for a client that wants to branch on more than the code.

## Retryable and non-retryable

A client that trusts the code acts on it with confidence, so a wrong mapping is worse than a vague one.

- **`UNAVAILABLE` and `RESOURCE_EXHAUSTED`** are usually retryable with backoff. The first is often transient. The second is the server asking for less traffic, which a client honors by waiting.
- **`DEADLINE_EXCEEDED`** is retryable only when the call is idempotent and budget remains. The deadline says no answer arrived in time, not that the call didn't execute.
- **`INVALID_ARGUMENT`, `NOT_FOUND` and `FAILED_PRECONDITION`** are never retried as-is. They describe the answer, not a glitch reaching it. The fix is a different request or a changed precondition.

Idempotency makes "the code says retryable" mean "safe to retry." `GetQuote` is a pure read, so retrying on `UNAVAILABLE` or a budget-permitting `DEADLINE_EXCEEDED` costs only a round trip. A call that reserves inventory or confirms a booking needs an idempotency key or a status check first, because a `DEADLINE_EXCEEDED` there may mean the write landed and only the response was lost.

Retry doesn't belong at every call site. gRPC's service config declares a **retry policy** (which codes, how many attempts, the backoff multiplier and cap) and a **hedging policy** that sends a second request before the first returns and takes whichever answers first. Both are set once on the channel. Classify the failure, mark it retryable or not, and let the transport carry out the decision instead of a hand-rolled loop around every call.

## At the REST boundary

The booking service calls `GetQuote` over gRPC and answers its own callers over REST. A mapping table applied once at that boundary turns a canonical code into an HTTP status:

| gRPC | HTTP |
| --- | --- |
| `INVALID_ARGUMENT` | `400` |
| `NOT_FOUND` | `404` |
| `UNAVAILABLE` | `503`, with a `Retry-After` header built from `RetryInfo` |

The `ErrorInfo` reason and the `BadRequest` field violations cross unchanged, landing in the `problem+json` body as the same machine-readable code and per-field detail a gRPC client would unpack.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>RPC shape, sync vs. stream and concurrency model are unchanged: <code>GetQuote</code> is unary, synchronous and I/O-bound. Deadline and budget: a retry that doesn't fit inside the caller's remaining budget isn't worth attempting whatever the code. Failure class and retryability: <code>INVALID_ARGUMENT</code> with a <code>BadRequest</code> for a malformed field, <code>NOT_FOUND</code> with an <code>ErrorInfo</code> for an origin that doesn't route, <code>UNAVAILABLE</code> with a <code>RetryInfo</code> for a transient condition, never a blanket <code>INTERNAL</code>. Only <code>UNAVAILABLE</code> is retryable, because the call is a pure read and the condition is expected to clear; that split is what a service-config retry policy reads.</p></div>

> **🤖 Explore with your agent**
>
> "In examples/11-error-handling, add a fourth failure to `GetQuote` on both stacks (`RoutingServiceImpl.java` and `app/routing_service.py`): an `origin` of `FULL` returns `RESOURCE_EXHAUSTED` with a `RetryInfo` of five seconds, packed with the same rich-error helper. Pick the canonical code that fits an overloaded server, never `INTERNAL`."
>
> Check: `grpcurl -plaintext -d '{"origin":{"unLocode":"FULL"},"destination":{"unLocode":"NLRTM"}}' localhost:9110 shipping.routing.v1.RoutingService/GetQuote` prints `Code: ResourceExhausted`, and port 9111 prints the same.

## Build, run, observe

Quarkus listens on host port 9110 and Python on 9111.

```bash
cd examples/11-error-handling
./verify.sh
```

`verify.sh` sends all four input shapes to both stacks and prints `PASS` when each returns the same code and the same detail type. To run one by hand, start the stacks with `docker compose up --build`, then:

```bash
grpcurl -plaintext -d '{"destination":{"unLocode":"NLRTM"}}' \
  localhost:9110 shipping.routing.v1.RoutingService/GetQuote
```

```
ERROR:
  Code: InvalidArgument
  Message: invalid GetQuoteRequest: origin.un_locode required (see BadRequest details)
```

The `Code` is what a client branches retry logic on. The message also names the structured `details` entry, so the failure reads from plain text alone and a client can unpack the `BadRequest`, `ErrorInfo` or `RetryInfo` riding in the trailers.

- **Send `origin` `ZZZZZ`.** `Code: NotFound`, message `origin ZZZZZ is unroutable (ErrorInfo reason=ORIGIN_UNROUTABLE)`.
- **Send `origin` `RETRY`.** `Code: Unavailable`, message `routing service temporarily unavailable, retry per RetryInfo`.
- **Send a valid origin and destination.** The call returns `OK` with the quote.

## For deeper coverage

- [grpc.io: Error handling](https://grpc.io/docs/guides/error/): the canonical status codes and how a server and client use them.
- [`google/rpc/error_details.proto`](https://github.com/googleapis/googleapis/blob/master/google/rpc/error_details.proto): the source for `ErrorInfo`, `BadRequest` and `RetryInfo`.
- Cloud Native Design Patterns, Appendix E, "API Error Handling": the same stable-code, safe-message, retryable-flag contract across REST, gRPC, Kafka and GraphQL.
- Sam Newman, *Building Microservices*, 2nd ed., O'Reilly, 2021: failure classification as part of a service's contract.
