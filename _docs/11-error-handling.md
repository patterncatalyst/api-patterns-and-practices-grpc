---
title: "Error and exception handling"
order: 11
part: "Reliability: Deadlines, Errors & Interceptors"
description: "Canonical status codes as the contract, the rich error model built from google.rpc.Status and its typed details, and the line between a retryable and a non-retryable failure."
duration: "20 min"
---

## Learning objectives

By the end of this chapter you can:

- Classify a `GetQuote` failure into the correct canonical status code (`INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, `INTERNAL`) instead of defaulting to `INTERNAL`.
- Build a rich `google.rpc.Status` carrying typed details (`ErrorInfo`, `BadRequest`, `RetryInfo`) with `StatusProto.toStatusRuntimeException` on Quarkus and `grpc_status.rpc_status.to_status` on Python.
- Decide whether a failure is safe to retry from its code and the call's idempotency, not from a guess.
- Map a gRPC status code and its structured details onto an HTTP response at the REST→gRPC seam.

## Why this matters

`RoutingService.GetQuote` fails in three different ways, and none of them call for the same response. A caller that leaves `destination` empty sent a malformed request; no amount of retrying fixes that. A caller that asks for a quote from a UN/LOCODE this routing engine has no path out of is asking a question with a real, stable answer: no. A caller that happens to land during a transient blip in the routing engine's own dependencies is asking a question that would succeed in two seconds if asked again. gRPC's canonical status codes exist precisely so a client can tell these three apart without parsing a sentence. This chapter builds the rich error model on top of that code, `google.rpc.Status` and its typed details, and draws the line between a failure worth retrying and one that isn't, using the same `GetQuote` anchor Chapter 5 built and Chapter 10 put a deadline on.

## The canonical status codes are the contract

Every gRPC call ends in exactly one of a small, fixed set of canonical codes, defined once in `google.rpc.Code` and reused by every language's generated stub. That fixed vocabulary is the point: a client branches on the code, not on a string, so the server's choice of code *is* the API contract for failure, as binding as a field's type.

{% include excalidraw.html file="11-status-code-taxonomy" alt="The canonical gRPC status codes grouped by what they mean rather than alphabetically. Malformed request: INVALID_ARGUMENT, retry never. State of the world: NOT_FOUND and FAILED_PRECONDITION, retry never. Transient: UNAVAILABLE and DEADLINE_EXCEEDED, retry yes with backoff or only if idempotent. Overload: RESOURCE_EXHAUSTED, a self-imposed 429, retry yes honoring backoff. Auth: UNAUTHENTICATED and PERMISSION_DENIED, retry only after fixing credentials or the grant. Last resort: INTERNAL, no better name for it yet, shown in a dark box to set it apart from the rest. A bottom note warns: don't collapse everything to INTERNAL, it erases the one signal a client acts on: retry, give up, or page someone." caption="Figure 11.1: The canonical status codes grouped by meaning, not alphabetically; INTERNAL is the last resort, not the default." %}

The codes this chapter leans on hardest, mapped onto what `GetQuote` actually does:

- **`OK`**: the quote computed and the caller gets a `Route` and a `Money`. The default outcome, not interesting on its own, but the baseline every other code is defined against.
- **`INVALID_ARGUMENT`**: the request itself is malformed: an empty `origin.un_locode`, a missing `destination`. The request would fail identically no matter how many times or how patiently it's retried, because nothing about the world changed; the request is still wrong.
- **`NOT_FOUND`**: the request is well-formed and names something that doesn't exist: an origin UN/LOCODE this engine can't route from. This is a fact about current state, not a malformed question, and the distinction matters because a client that treats it like `INVALID_ARGUMENT` stops looking for a fix, while a client that treats it like a transient failure wastes a retry budget on an answer that will never change.
- **`FAILED_PRECONDITION`**: the request is well-formed and the target exists, but the system isn't in a state where this operation can succeed right now: confirming a booking whose quote already expired, for instance. Something has to change before a retry could possibly help, which is a different shape of "no" than `NOT_FOUND`'s.
- **`UNAVAILABLE`**: the server, or something it depends on, can't be reached right now. This is gRPC's canonical "try again" code and the one a load balancer or service mesh watches for to decide whether to route around an endpoint.
- **`DEADLINE_EXCEEDED`**: the call didn't finish inside the deadline Chapter 10 set on it. Whether this is retryable depends entirely on what partially happened before the clock ran out, which is why it gets its own rule in the next section rather than a blanket answer here.
- **`RESOURCE_EXHAUSTED`**: the server is shedding load to protect itself, a self-imposed `429` rather than a failure to answer.
- **`UNAUTHENTICATED`** and **`PERMISSION_DENIED`**: the caller's identity is missing or doesn't carry the right grant. Chapter 20 covers the mechanics; the codes exist here because they're canonical, not auth-specific extensions.
- **`INTERNAL`**: something broke in a way the service doesn't have a better name for.

That last one is where most of the damage happens, and the appeal is obvious: it's one line, it always compiles, and it never requires deciding which of the other nine codes actually fits. Collapsing a `NullPointerException` from a malformed field and an unreachable downstream call into the same `INTERNAL` strips every automated caller of the one signal it uses to decide what to do next: retry, give up, or page someone. A service-config retry policy watching for `UNAVAILABLE` never fires; a client that would have surfaced "origin not found" to a user instead shows a generic failure. `INTERNAL` should mean exactly one thing: the server hit a case it doesn't have a name for yet, which is worth logging and worth treating as a bug to fix, not a code to reach for out of convenience.

## The rich error model: google.rpc.Status and its details

A code alone answers "what kind of failure is this," but a client acting on `NOT_FOUND` wants more: a machine-readable reason it can log and alert on, which field was wrong if the problem was the request shape, or how long to wait before trying again. `google.rpc.Status` is the structure that carries all three without inventing a bespoke JSON blob per service: a `code`, a human-readable `message` safe to put in front of a user, and a `details` list of typed, `Any`-packed messages a client unpacks by type.

Three detail types cover nearly every case this book's domain needs:

- **`ErrorInfo`**: a machine-readable `reason` (a short, stable, upper-snake-case string like `ORIGIN_UNROUTABLE`) plus a `domain` naming the system of record for that reason. This is the detail a monitoring system keys alerts on, because `reason` doesn't change when a translator edits the human-readable message.
- **`BadRequest`**: a list of `field_violations`, each naming the offending `field` and a `description` of what's wrong with it. This is what turns "the request is invalid" into "`origin.un_locode` is required," which is the difference between a client guessing and a client fixing the actual problem on the first retry.
- **`RetryInfo`**: a `retry_delay` telling the caller exactly how long to back off before trying again. This is the detail that turns "this is retryable" from a guess based on the code into an instruction with a number attached.

{% include excalidraw.html file="11-rich-error-model" alt="A gRPC error as a code plus a message plus a details list. RoutingService.GetQuote fails and builds a google.rpc.Status with code NOT_FOUND and a safe message. The Status carries three possible detail types in its details array, packed as Any: ErrorInfo with a reason and domain, BadRequest with field violations, and RetryInfo with a retry delay, all riding in the gRPC trailers to the client. The client reads the code and unpacks the details, then branches: UNAVAILABLE, idempotent DEADLINE_EXCEEDED, and RESOURCE_EXHAUSTED go to a retryable path that backs off and retries, while INVALID_ARGUMENT, NOT_FOUND, and FAILED_PRECONDITION go to a non-retryable path that surfaces the failure to the caller now." caption="Figure 11.2: A gRPC error is a code, a message, and typed details; the client branches on the code before it ever reads a detail." %}

The detail types are not declared in `routing.proto`. `ErrorInfo`, `BadRequest`, and `RetryInfo` come from `google/rpc/error_details.proto`, a schema every gRPC ecosystem ships a runtime library for, so a Java client and a Python client unpack the identical bytes using language-native generated classes without this chapter's contract needing to import anything new. On the JVM, `com.google.api.grpc:proto-google-common-protos` supplies `com.google.rpc.Status`, `Code`, `ErrorInfo`, `BadRequest`, and `RetryInfo`, and `io.grpc.protobuf.StatusProto.toStatusRuntimeException(status)` (a class that ships inside `grpc-protobuf`, already on the classpath once `quarkus-grpc` is a dependency) packs that `Status` into a `StatusRuntimeException` whose trailers a client reads off normally. On Python, `grpcio-status` supplies the matching `google.rpc.status_pb2` and `error_details_pb2`, and `grpc_status.rpc_status.to_status(status)` does the same packing for `context.abort_with_status(...)` on a `grpc.aio.ServicerContext`. Two different libraries, two different call shapes, one wire format.

## Implementing rich errors: RoutingService.GetQuote

The example for this chapter makes `GetQuote` fail three deterministic ways and succeed a fourth, so the same request always produces the same code and the same detail type on both stacks. An empty or missing `un_locode` on either `origin` or `destination` returns `INVALID_ARGUMENT` with a `BadRequest` naming the field; a sentinel origin of `ZZZZZ` (unroutable by convention in this example, not a real UN/LOCODE) returns `NOT_FOUND` with an `ErrorInfo` reason of `ORIGIN_UNROUTABLE`; a sentinel origin of `RETRY` returns `UNAVAILABLE` with a `RetryInfo` of two seconds; anything else reaches the same quote formula Chapter 5 built.

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

// origin.unLocode == "ZZZZZ" -> NOT_FOUND + ErrorInfo
return Uni.createFrom().failure(richError(
        Code.NOT_FOUND,
        "origin ZZZZZ is unroutable (ErrorInfo reason=ORIGIN_UNROUTABLE)",
        Any.pack(ErrorInfo.newBuilder()
                .setReason("ORIGIN_UNROUTABLE")
                .setDomain("shipping.routing.v1")
                .build())));
```

```python
async def _abort_rich(context, code, message, detail) -> None:
    rich_status = status_pb2.Status(code=code, message=message, details=[detail])
    await context.abort_with_status(rpc_status.to_status(rich_status))

# origin.un_locode == "ZZZZZ" -> NOT_FOUND + ErrorInfo
await self._abort_rich(
    context,
    code_pb2.NOT_FOUND,
    "origin ZZZZZ is unroutable (ErrorInfo reason=ORIGIN_UNROUTABLE)",
    _pack(error_details_pb2.ErrorInfo(reason="ORIGIN_UNROUTABLE", domain="shipping.routing.v1")),
)
```

Both sides do the same three things in the same order: pick the canonical code, write a message that stays legible even if a client never bothers to unpack the structured detail, and pack exactly one typed detail that a client *can* unpack when it wants to branch on more than the code. `examples/11-error-handling/verify.sh` calls all four input shapes against both stacks and asserts the code with `grpc_expect_code` and the detail text with `grpc_error_output`, which is the chapter's central claim made checkable: two independent implementations, same contract, same four outcomes.

## Retryable vs non-retryable

The code a server picks tells a client what to do next, and getting that mapping backward is worse than being vague, because a client that trusts the code will act on a wrong answer with confidence. `UNAVAILABLE` and `RESOURCE_EXHAUSTED` are usually retryable with backoff: the first because the condition that caused it is often transient, the second because the server is explicitly asking for less traffic for a while, which a client honors by waiting, not by hammering harder. `DEADLINE_EXCEEDED` only belongs in that bucket when the call is idempotent and budget remains; retrying a call that already wrote something risks doing that write twice, since the deadline tells the client the call didn't get an answer in time, not that it didn't execute.

`INVALID_ARGUMENT`, `NOT_FOUND`, and `FAILED_PRECONDITION` are never worth retrying as-is, because none of them describe a glitch reaching the right answer; they describe the answer. Retrying `INVALID_ARGUMENT` sends the identical malformed request into the identical rejection; retrying `NOT_FOUND` asks the identical unanswerable question. The fix for each is a different request or a changed precondition, not a second attempt at the same one.

Idempotency is what turns "the code says retryable" into "it's actually safe to retry here." `GetQuote` is a pure read with no side effect to duplicate, so retrying it on `UNAVAILABLE` or a budget-permitting `DEADLINE_EXCEEDED` costs nothing beyond the extra round trip. A call that reserves inventory or confirms a booking needs an idempotency key or a status check before a retry is safe, because a `DEADLINE_EXCEEDED` on that call might mean the write already landed and only the response got lost: retrying blindly risks a second reservation, not a second attempt at the first one.

None of this has to live in application code on every call site. gRPC's service config supports a declarative **retry policy** (which codes to retry, how many attempts, the backoff multiplier and cap) and a **hedging policy** that sends a second request before the first one returns if it's running slow, taking whichever response arrives first. Both are configured once, on the channel, rather than re-implemented per call. Chapter 18 tunes these policies against real latency numbers; the decision that belongs here is narrower: classify the failure correctly, mark it retryable or not, and let the service config carry out that decision at the transport layer instead of a hand-rolled retry loop around every call.

This is the same **failure class and retryability** axis Chapter 2's five-axis framework introduced, applied for the first time to its full depth: the axis asked which codes are worth retrying, and this chapter answers with the specific codes, the idempotency condition that makes the answer safe, and the declarative mechanism that acts on it.

## The REST→gRPC seam, once

The booking service that calls `GetQuote` over gRPC still answers its own callers over REST, and that boundary is where a canonical gRPC code becomes an HTTP status. `NOT_FOUND` maps to `404`, `INVALID_ARGUMENT` maps to `400`, `UNAVAILABLE` maps to `503` carrying a `Retry-After` header built from the gRPC call's own `RetryInfo`: one mapping table, applied once at the seam, rather than every REST handler reasoning about gRPC codes directly. The `ErrorInfo` reason and the `BadRequest` field violations carry across that seam unchanged, landing in the REST response's `problem+json` body as the same machine-readable `code` and the same per-field detail a gRPC client would have unpacked directly.

## A worked decision: RoutingService.GetQuote's errors

Run `GetQuote`'s error handling through the five axes from Chapter 2, closing on the two questions this chapter adds: which code, and is it retryable.

RPC shape and sync vs. stream are unchanged from Chapter 5: unary, blocking, nothing to retry mid-stream. Deadline and budget are unchanged from Chapter 10: a tight slice of the booking service's own budget, which is exactly why `DEADLINE_EXCEEDED` needs the idempotency caveat rather than a blanket "retryable": a retry that doesn't fit inside the remaining budget isn't worth attempting regardless of the code. Failure class and retryability is this chapter's addition in full: `INVALID_ARGUMENT` for a malformed request, `NOT_FOUND` for an unroutable origin, `UNAVAILABLE` for a transient condition; the first two never retried, the third retried with backoff because the call is a pure read. Concurrency model stays what Chapter 2 set: I/O-bound, served well by virtual threads or `grpc.aio` either way, since none of this chapter's branching does extra computation on the failure path.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p><code>RoutingService.GetQuote</code> picks its code from what actually went wrong, not from convenience: <code>INVALID_ARGUMENT</code> with a <code>BadRequest</code> for a malformed field, <code>NOT_FOUND</code> with an <code>ErrorInfo</code> for an origin that doesn't route, <code>UNAVAILABLE</code> with a <code>RetryInfo</code> for a transient condition, never a blanket <code>INTERNAL</code> that would erase the distinction. Only the last is marked retryable, because the call is a pure read and the condition it reports is expected to clear; the other two describe the request or the world, not a glitch, so retrying them unchanged would waste a client's retry budget on an answer that can't improve. That retryable/non-retryable split is exactly what a service-config retry policy reads to decide whether to retry automatically: the chapter's code choice and its retryability flag are the same decision, read twice.</p></div>

## Where this goes next

The canonical codes and the rich error model apply to every RPC this site builds from here forward, not just `GetQuote`: Chapter 12's interceptors are where cross-cutting error handling (turning an unhandled exception into a `Status` once, instead of at every call site) gets wired in, and Chapter 18's retry and hedging policies tune the backoff numbers this chapter only named. The REST→gRPC seam this chapter touched once gets its full treatment in Chapter 23, where a transcoding gateway has to make the same code-to-status mapping automatic rather than hand-written. For now, the result that matters is checkable: both stacks return the identical code and the identical detail type for the identical input, because both were built from the same contract and the same runtime error-details library, not from two developers independently guessing at what "not found" should mean.

## On the wire

```bash
grpcurl -plaintext -d '{"destination":{"unLocode":"NLRTM"}}' \
  localhost:9110 shipping.routing.v1.RoutingService/GetQuote
```

```
ERROR:
  Code: InvalidArgument
  Message: invalid GetQuoteRequest: origin.un_locode required (see BadRequest details)
```

```bash
grpcurl -plaintext -d '{"origin":{"unLocode":"ZZZZZ"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9110 shipping.routing.v1.RoutingService/GetQuote
```

```
ERROR:
  Code: NotFound
  Message: origin ZZZZZ is unroutable (ErrorInfo reason=ORIGIN_UNROUTABLE)
```

```bash
grpcurl -plaintext -d '{"origin":{"unLocode":"RETRY"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9110 shipping.routing.v1.RoutingService/GetQuote
```

```
ERROR:
  Code: Unavailable
  Message: routing service temporarily unavailable, retry per RetryInfo
```

The `Code` is what a client branches its retry logic on; the `Message` in this chapter's implementation also names the structured `details[]` entry, so the failure is legible from the plain-text message alone and precise when a client unpacks the `BadRequest`, `ErrorInfo`, or `RetryInfo` riding in the same trailers. `examples/11-error-handling/verify.sh` asserts both.

## For deeper coverage

- [grpc.io: Error handling](https://grpc.io/docs/guides/error/): the canonical status codes and how a server and client are expected to use them.
- [`google/rpc/error_details.proto`](https://github.com/googleapis/googleapis/blob/master/google/rpc/error_details.proto): the canonical source for `ErrorInfo`, `BadRequest`, and `RetryInfo`, the three detail types this chapter packs into a `Status`.
- Cloud Native Design Patterns, Appendix E, "API Error Handling": the same stable-code/safe-message/retryable-flag contract applied across REST, gRPC, Kafka, and GraphQL.
- Sam Newman, *Building Microservices*, 2nd ed., O'Reilly, 2021: the broader case for treating failure classification as part of a service's contract, not an afterthought.
