---
title: "HTTP/2 foundation and why gRPC is fast"
order: 6
part: "HTTP/2 & the Four RPC Types"
description: "Streams, frames, multiplexing and HPACK: the HTTP/2 machinery gRPC rides on, and a measured comparison of binary protobuf against proto3 JSON on the same message."
duration: "15 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain how HTTP/2 multiplexes many streams over one TCP connection and map a gRPC call onto its stream and `HEADERS`/`DATA` frames.
- Explain what HPACK buys a gRPC channel, and why the benefit lasts only as long as the connection.
- State the three additive reasons gRPC is fast: binary protobuf's per-message cost, one persistent connection, and multiplexing.
- Hand-decode a nested message's bytes, including why a key byte never tracks nesting depth.
- Recognize the Kubernetes caveat that one long-lived multiplexed connection creates for an L4 load balancer.

## Why this matters

gRPC is a contract, a code-generation pipeline and a transport. The transport is HTTP/2: binary framing, streams, one connection that carries all of them, and header compression that keeps per-call overhead from growing. On the `GetQuoteResponse` that `RoutingService.GetQuote` returns, protobuf is about a third the size of proto3 JSON, and the connection-level gains stack on top of that.

## One connection, many streams

HTTP/1.1 ties one request to one connection for the duration of the request. Clients work around it by opening several connections in parallel (six per origin is a common browser limit), and a slow response still blocks every request queued behind it on that connection: head-of-line blocking at the application layer. Each connection also pays its own TCP handshake and, on an encrypted channel, its own TLS handshake before a byte of the request moves.

HTTP/2 uses one long-lived connection carrying many concurrent **streams**. A stream is a bidirectional sequence of **frames**, each a small binary header plus a payload tagged with a stream identifier and a type (`HEADERS`, `DATA`, `SETTINGS` and a few others). Every gRPC RPC maps to exactly one stream:

- A unary call like `GetQuote` opens a stream, sends a `HEADERS` frame carrying the method path and metadata, sends one or more `DATA` frames carrying the serialized request, and closes its end.
- The server's `HEADERS` and `DATA` frames come back on the same stream before it closes.
- A streaming call keeps the stream open and sends more `DATA` frames as events arrive, with no new connection, handshake or stream for each event.

Because a stream is only an identifier that frames carry, many streams interleave on one connection. A gRPC channel opens one TCP connection and reuses it for every call through that channel, whether that's one `GetQuote` a minute or a thousand concurrent calls. `GetQuote`, `FindOptimalRoute` and `ListRoutes` can have frames in flight on the same socket at once; the server dispatches each frame to the handler for its stream and writes responses back in whatever order handlers finish. A slow `ListRoutes` doesn't hold up a fast `GetQuote`, because they're different streams and not a queue.

{% include excalidraw.html file="06-http2-multiplexing" alt="One TCP connection between a client and server carrying three interleaved HTTP/2 streams (stream 5 for GetQuote, stream 7 for ListRoutes, stream 9 for FindOptimalRoute) with their HEADERS and DATA frames numbered in actual send order across the lanes, showing frames from different streams arriving out of per-stream order on the wire, plus an HPACK header table box that the streams' HEADERS frames reference instead of resending full header text." caption="Figure 6.1: Three RPCs, three streams, one connection. Frames interleave on the wire and HPACK keeps headers from repeating." %}

Multiplexing removes the connection-per-request cost and the connection-count ceiling. It doesn't remove contention for the socket's send buffer or the TCP flow-control window: two congested streams can still slow each other at that layer. It solves head-of-line blocking at the HTTP layer, where it was a protocol choice, not at the TCP layer, where it's a property of the one shared connection. Per-stream flow-control windows and slow consumers come up with streaming.

## HPACK: paying for headers once

Every gRPC request carries at least the method path (`/shipping.routing.v1.RoutingService/GetQuote`), the content type (`application/grpc+proto`) and any metadata such as an authorization token or a deadline. HTTP/1.1 sends each header line as literal text on every request. For short unary calls like `GetQuote`, that repeated text can rival the body.

**HPACK** compresses headers with tables. Each side keeps a static table of common fields defined by the spec and a dynamic table built from headers seen on this connection. The first time a `HEADERS` frame sends a name and value, HPACK can add it to the dynamic table; later frames send a small integer index instead. The method path doesn't change between calls to one method, so after the first `GetQuote`, each later `HEADERS` frame references the path by index. Ten calls pay for the header text about once.

The dynamic table lives as long as the connection, so a client that reopens a connection per call resets it every time. Connection reuse and header compression are one design decision paying off twice.

## Why gRPC is fast

Three additive reasons:

| Reason | Mechanism | Scope |
|---|---|---|
| Binary protobuf | A field is a one- or two-byte tag, not a quoted string key; numbers use VARINT or fixed-width binary, not decimal text; parsing does length-driven reads instead of scanning for `"`, `:` and `,` | The message, on any transport |
| One persistent connection | TCP and TLS setup once per channel, not once per request; HTTP/1.1 keep-alive narrows the gap for a single client, but serves one in-flight request per connection | The channel's lifetime |
| Multiplexing | A burst of concurrent `GetQuote` calls needs no connection per call, no fixed-size socket pool and no queueing behind a slow call; the ceiling moves from connections held open to the shared connection's flow-control window and send buffer | The connection |

Two limits. HTTP/2 and protobuf shrink the plumbing, not the handler's CPU time or database round trips. And the gains depend on payload size: a `GetQuote` response of a few hundred bytes gains enormously from avoiding a JSON header block as large as the payload, while a multi-megabyte bulk export keeps the protobuf-versus-JSON gap but the connection-level gains shrink toward irrelevant. The pattern holds for short, frequent, internal calls and weakens as payload size dominates.

That is also why the booking service calls `RoutingService.GetQuote` as unary, synchronous and tightly deadlined: it holds one multiplexed connection to `RoutingService` for its process lifetime, every call rides a fresh stream with no handshake, and HPACK keeps per-call header cost flat. Calling over REST on HTTP/1.1 keeps protobuf's size advantage, since nothing stops serving protobuf bodies there, but loses connection reuse and header compression.

## Decoding a response on the wire

A standalone `Money{currency: "USD", amount: "1250.00"}` is fourteen bytes. The same math holds when it's nested in a larger message, because a key byte encodes a field number and a wire type, never depth. `GetQuoteResponse` has two fields: `quote`, a `Money`, at tag 1, and `route`, a `Route`, at tag 2. Both are messages, so both use wire type 2 (LEN, length-delimited), the type `Money`'s string fields use. Protobuf has only four wire types, and a nested message is encoded like a string: a length, then that many bytes.

Serializing a `GetQuoteResponse` with `quote = Money{currency: "USD", amount: "1250.00"}` and a one-leg `Route` starts like this:

```text
0A 0E 0A 03 55 53 44 12 07 31 32 35 30 2E 30 30 12 ...
```

- `0A` is `(1 << 3) | 2`: field 1 (`quote`), wire type 2.
- `0E` is the length: the embedded `Money` is fourteen bytes.
- Those fourteen bytes are a complete `Money`: `0A` again (its own field 1, `currency`, yields the same key regardless of what contains it), a three-byte length, `USD`, then `12` for field 2 (`amount`), a seven-byte length and `1250.00`.
- The next byte, `12`, is `(2 << 3) | 2`: `GetQuoteResponse`'s field 2 (`route`). It equals the key `Money.amount` used, because keys are scoped to one message's field numbers, not global across the stream.

{% include excalidraw.html file="06-nested-message-bytes" alt="A GetQuoteResponse message on the wire showing nesting: the outer key byte 0x0A and length byte 0x0E for field 1 (quote) wrap fourteen bytes that are themselves a complete Money message (its own 0x0A key for currency, a length, the three bytes of USD, its own 0x12 key for amount, a length, and the seven bytes of 1250.00), with the outer message's field 2 (route) key, 0x12, immediately following. A diagram above the byte row shows GetQuoteResponse containing Money as a nested field 1 while Route sits beside it as a sibling field 2, with an arrow showing the same key-byte pattern recursing one level down inside Money. Callouts note that a nested message costs exactly one extra key byte and one length byte beyond its own contents, and that a parser never needs to track its nesting depth, because every key only encodes the current message's own field number and wire type." caption="Figure 6.2: Nesting costs one key and one length prefix per level; the parser never tracks depth." %}

Three consequences:

- A nested message costs exactly one key byte and one length byte beyond its contents.
- Two fields at different depths can produce the same key byte.
- A parser never needs to know its depth. It reads a key, dispatches on wire type, and recurses if the type is LEN and the schema says the field is a message.

## The Kubernetes caveat

A standard L4 load balancer in front of a Kubernetes `Service` balances TCP connections, not RPCs. One long-lived multiplexed connection concentrates every call behind it on whichever pod received that connection, the opposite of the even spread an HTTP/1.1 client gets from a new connection per request. The same design that makes one connection fast makes a naive deployment lopsided. Client-side load balancing and a mesh sidecar are the two fixes.

The connection-level wins also bear on the concurrency model and the deadline budget. Burst traffic multiplexes over one channel instead of contending for a pre-sized socket pool, which suits the I/O-bound profile that virtual threads or `grpc.aio` handle well. And with no per-call handshake, a tight deadline carved from the caller's request budget is spent on the round trip, not on connection setup.

> **🤖 Explore with your agent**
>
> "In examples/06-http2-foundation, extend measure.py to build a `GetQuoteResponse` whose `Route` has three `Leg`s instead of one, and predict before running whether the protobuf-to-JSON size ratio goes up or down and why, using the rule that protobuf uses one-byte tags where proto3 JSON repeats quoted field names. Then decode the first bytes of the new serialization by hand."
>
> Check: run `./verify.sh` in examples/06-http2-foundation and compare the printed `protobuf bytes`, `proto3 JSON bytes` and ratio lines against your prediction.

## Build, run, observe

```bash
cd examples/06-http2-foundation
./verify.sh
```

There is no service and no port. `verify.sh` runs `buf build` on `contracts/` (downloading a pinned `buf` into `.bin/` if none is on `PATH`), generates Python stubs from the real shipping contracts in a throwaway virtualenv, and runs `measure.py`, which serializes one `GetQuoteResponse` with `SerializeToString()` and with `google.protobuf.json_format.MessageToJson()` and decodes the protobuf bytes with the key-byte math above. The counts are deterministic for a given `protobuf` version:

```text
protobuf bytes : 122
proto3 JSON bytes: 363
ratio (JSON / protobuf): 2.98x
ok, protobuf encoding (122 bytes) is smaller than proto3 JSON (363 bytes)
ok, byte 0 is 0x0A = (1 << 3) | 2 -> field 1 (quote), wire type 2 (LEN)
ok, the embedded Money length fits one varint byte (no continuation bit)
ok, byte at the embedded Money's start is 0x0A again -> its own field 1 (currency), wire type 2
ok, the embedded Money decodes to currency=USD, amount=1250.00
ok, byte 16 is 0x12 -> field 2 (route), wire type 2 (LEN)
```

Observing HTTP/2 multiplexing and HPACK directly needs two processes holding a connection open, so use a packet capture; this docker-free example does not.

Experiments:

- Run `./verify.sh` twice: the byte counts don't change between runs or machines.

## For deeper coverage

- [RFC 9113: HTTP/2](https://www.rfc-editor.org/rfc/rfc9113): the streams, frames and frame types (`HEADERS`, `DATA`, `SETTINGS`).
- [RFC 7541: HPACK: Header Compression for HTTP/2](https://www.rfc-editor.org/rfc/rfc7541): the static and dynamic table mechanism.
- Sam Newman, *Building Microservices*, 2nd ed. (O'Reilly, 2021): inter-service communication trade-offs, including when a binary, multiplexed protocol like gRPC earns its cost over REST.
- *Cloud Native Design Patterns*, "Communications" chapter: the four interaction styles, including why gRPC is the default for internal, server-to-server calls.
