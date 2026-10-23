---
title: "HTTP/2 foundation and why gRPC is fast"
order: 6
part: "HTTP/2 & the Four RPC Types"
description: "Streams, frames, multiplexing, and HPACK: the HTTP/2 machinery gRPC rides on, and a measured comparison of binary protobuf against proto3 JSON on the same message."
duration: "20 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain how HTTP/2 multiplexes many streams over one TCP connection and map a gRPC call onto its stream and `HEADERS`/`DATA` frames.
- Explain what HPACK buys a gRPC channel, and why the benefit is scoped to one connection's lifetime.
- State the three additive reasons gRPC is fast: binary protobuf's per-message cost, one persistent connection, and multiplexing.
- Hand-decode a nested message's bytes on the wire, including why a wire-type key never needs to track nesting depth.
- Recognize the Kubernetes caveat a single long-lived multiplexed connection creates for an L4 load balancer.

## Why this matters

Chapter 5 generated stubs on both stacks and called `RoutingService.GetQuote` over a real connection for the first time. Nothing about that call's binary framing, its one TCP connection, or its header compression got a name yet: the example worked, which is the point of an example, but "it worked" isn't the same claim as "it's fast." gRPC is a contract (Chapter 3), a code-generation pipeline (Chapter 5), and a transport. This chapter is the transport: HTTP/2's binary framing, its streams, the single connection that carries all of them, and the header compression that keeps a connection's overhead from growing with every call. Chapter 3 already measured protobuf's byte-for-byte advantage over JSON in isolation; this chapter adds the connection-level advantage layered on top of it, and gives you a number for both, measured against the same `GetQuoteResponse` this site has used as its anchor example since Chapter 2.

## One connection, many streams

HTTP/1.1 ties one request to one connection for the duration of that request. A browser or client library works around this by opening several connections in parallel (six per origin is a common browser limit), and even then, a slow response on one connection blocks every request queued behind it on that same connection, a problem usually called head-of-line blocking at the application layer. Each connection also pays its own TCP handshake and, on an encrypted channel, its own TLS handshake: real cost before a single byte of the request itself moves.

HTTP/2 replaces that model with one long-lived connection carrying many concurrent **streams**. A stream is a bidirectional sequence of **frames**: HTTP/2's basic unit, each one a small binary header plus a payload, tagged with a stream identifier and a frame type (`HEADERS`, `DATA`, `SETTINGS`, and a handful of others). Every gRPC RPC maps to exactly one HTTP/2 stream: a unary call like `GetQuote` opens a stream, sends a `HEADERS` frame carrying the method path and metadata, sends one or more `DATA` frames carrying the serialized request, and closes its end; the server's `HEADERS` and `DATA` frames carrying the response ride back on that same stream before it closes for good. A streaming call (`WatchShipment` from Chapter 2, implemented in Chapter 8) keeps the stream open and sends additional `DATA` frames as events arrive, with no new connection, no new handshake, and no new stream identifier for each event.

Because a stream is just an identifier frames carry, nothing stops many streams from interleaving their frames on one connection. The gRPC channel a client builds once (the stub factory both stacks construct in Chapter 5) opens one TCP connection and reuses it for every call issued through that channel, whether that's one `GetQuote` a minute or a thousand concurrent calls from a hundred request-handling threads. `GetQuote`, `FindOptimalRoute`, and `ListRoutes` can all have frames in flight on the same socket at the same moment; the server reads frames off that one socket, dispatches each one to the handler for its stream identifier, and writes response frames back onto the same socket as each handler produces them, in whatever order they finish. A slow `ListRoutes` call does not hold up a fast `GetQuote` behind it, because there is no "behind it": they're different streams on the same wire, not a queue.

{% include excalidraw.html file="06-http2-multiplexing" alt="One TCP connection between a client and server carrying three interleaved HTTP/2 streams (stream 5 for GetQuote, stream 7 for ListRoutes, stream 9 for FindOptimalRoute) with their HEADERS and DATA frames numbered in actual send order across the lanes, showing frames from different streams arriving out of per-stream order on the wire, plus an HPACK header table box that the streams' HEADERS frames reference instead of resending full header text." caption="Figure 6.1: Three RPCs, three streams, one connection: frames interleave on the wire; HPACK keeps their headers from repeating." %}

This is what "multiplexing" means on a gRPC channel, and it's worth being precise about what it does and does not buy. It removes the connection-per-request cost and the connection-count ceiling HTTP/1.1 clients work around with parallel sockets. It does not remove contention for the socket's own send buffer or the kernel's TCP flow-control window: two congested streams can still slow each other down at that lower layer, a limit Chapter 17 covers through per-stream flow-control windows and what a server does about a consumer that can't keep up. Multiplexing solves head-of-line blocking at the HTTP layer, where it was a protocol choice, not at the TCP layer, where it's a property of the one shared connection underneath every stream.

## HPACK: paying for headers once

Every HTTP request carries headers: in gRPC's case, at minimum the method path (`/shipping.routing.v1.RoutingService/GetQuote`), the content type (`application/grpc+proto`), and any per-call metadata like an authorization token or a deadline. On HTTP/1.1, every one of those header lines is sent as literal text on every request, repeated call after call, connection after connection. For a service fielding a high volume of short unary calls (exactly `GetQuote`'s profile) that repeated header text can rival or exceed the size of the request body it precedes.

HTTP/2 fixes this with **HPACK**, a header-compression scheme built around a table instead of a text format. Each side of a connection keeps a header table: a static table of common header fields defined by the spec, plus a dynamic table built from headers actually seen on this connection. The first time a `HEADERS` frame sends a given header name and value, HPACK can add it to the dynamic table; after that, later frames referencing the same header send a small integer index into the table instead of the header text again. A gRPC channel's method path doesn't change between calls to the same method, so after the first `GetQuote` call on a connection, every subsequent `GetQuote` call's `HEADERS` frame can reference that path by index rather than spelling it out. The win compounds with call volume on one connection: a connection handling ten `GetQuote` calls pays for the header text roughly once, not ten times.

This is a connection-scoped benefit, which is why the persistent connection from the previous section matters here too: HPACK's dynamic table lives for the life of the connection, so a client that reopens a connection per call resets the table on every call along with it. The two advantages aren't independent facts about HTTP/2; they're the same design decision (reuse one connection) paying off twice.

## Why gRPC is fast

Put the two preceding sections together with the wire-format work Chapter 3 already did, and "gRPC is fast" stops being a slogan with three concrete, additive reasons behind it.

**Binary protobuf costs less than JSON per message**, independent of the transport. Chapter 3 walked through why: a protobuf field is identified by a one- or two-byte tag instead of a quoted string key, numeric values use VARINT or fixed-width binary encoding instead of decimal text, and a protobuf parser does fixed-size reads driven by lengths the format carries rather than scanning for `"`, `:`, and `,`. That advantage exists whether the bytes travel over HTTP/1.1, HTTP/2, or a Unix socket; it's a property of the message, not the connection.

**One persistent connection avoids repeated handshake cost.** A gRPC channel opens its TCP connection (and, under TLS, negotiates that connection's certificates and cipher suite) once, then reuses it for every call made through that channel for as long as the channel lives. A service issuing many calls per second to the same peer, which describes the booking service's relationship to `RoutingService` under load, pays that setup cost once instead of once per request. HTTP/1.1 keep-alive narrows this gap for a single client holding one connection open, but gRPC's multiplexing (next point) means one connection serves unlimited concurrent calls rather than one connection per in-flight request.

**Multiplexing keeps a busy hot path from serializing on connection count.** Because many streams share one connection, a service issuing a burst of concurrent `GetQuote` calls (the booking service's routing hot path during a traffic spike) doesn't need a new connection per concurrent call, doesn't exhaust a connection pool sized for a fixed number of parallel sockets, and doesn't have one slow call hold up others queued behind it on the same socket. The ceiling moves from "how many connections can this process hold open" to "how much the shared connection's own flow-control window and send buffer can carry," a materially higher ceiling for the kind of short, frequent, internal call this book keeps returning to.

This list leaves out two things. It says nothing about CPU time spent executing a handler or database round trips: HTTP/2 and protobuf shrink the plumbing, not the business logic running at either end. And it says nothing about large payloads: a `GetQuote` response carrying a few hundred bytes benefits enormously from avoiding a JSON header block comparable in size to the payload itself; a bulk export running into megabytes keeps the protobuf-versus-JSON gap but the connection-level gains shrink toward irrelevant, since one handshake and a few kilobytes of header overhead stop mattering against a payload three orders of magnitude larger. The pattern holds exactly where this book's shipping domain lives (short, frequent, internal calls) and weakens as a payload's own size comes to dominate the total.

This is also where the REST→gRPC seam from Chapter 2 cashes out concretely. The booking service's call into `RoutingService.GetQuote` was chosen as unary, synchronous, and tightly deadlined because it's an internal, server-to-server call the booking service's own framework doesn't need to expose to a browser. Everything in this chapter is why that choice pays off at runtime, past the wire-format argument alone: the booking service holds one multiplexed connection to `RoutingService` open across its whole process lifetime, every `GetQuote` call it issues rides a fresh stream on that same connection with no new handshake, and HPACK keeps the per-call header cost from growing with call volume. None of that would be available if the booking service called `RoutingService` over plain REST on HTTP/1.1 instead: it would still get protobuf's wire-format advantage, since nothing stops serving protobuf-encoded bodies over HTTP/1.1, but it would lose the connection reuse and the header compression this chapter adds on top.

## Decoding a response on the wire

Chapter 3 hand-decoded a standalone `Money` down to its fourteen bytes. The same math applies unchanged to a larger message with `Money` nested inside it, because a key byte encodes a field number and a wire type, never how deep the field sits in the message tree. `GetQuoteResponse` carries exactly two fields: `quote`, a `Money`, at tag 1; `route`, a `Route`, at tag 2. Both are message types, which means both use wire type 2 (LEN, length-delimited), the same wire type Chapter 3 used for `Money`'s two string fields, because protobuf only has four wire types total and a nested message is encoded the same way a string is: a length, then that many bytes.

Serializing a `GetQuoteResponse` carrying `quote = Money{currency: "USD", amount: "1250.00"}` and a one-leg `Route` starts like this:

```text
0A 0E 0A 03 55 53 44 12 07 31 32 35 30 2E 30 30 12 ...
```

The first byte, `0x0A`, is `(1 << 3) | 2` (field 1, `quote`, wire type 2), the outer message's own tag-1 key. The next byte is a length: the embedded `Money` serializes to fourteen bytes, so `0x0E` says "read fourteen bytes as the value of this field." Those fourteen bytes are exactly the `Money` bytes Chapter 3 already decoded: `0x0A` again (not a coincidence, but the same formula applied one level down, since `Money`'s own field 1, `currency`, produces an identical key byte regardless of what message it's nested inside), followed by a three-byte length, `USD`, then the `0x12` key for `Money`'s field 2 (`amount`), a seven-byte length, and `1250.00`. Immediately after those fourteen bytes end, the next key byte belongs to `GetQuoteResponse`'s own field 2 (`route`): `(2 << 3) | 2 = 0x12`, the same key value `Money.amount` used, because wire-type keys are scoped to one message's own field numbers, not global across a serialized stream.

{% include excalidraw.html file="06-nested-message-bytes" alt="A GetQuoteResponse message on the wire showing nesting: the outer key byte 0x0A and length byte 0x0E for field 1 (quote) wrap fourteen bytes that are themselves a complete Money message (its own 0x0A key for currency, a length, the three bytes of USD, its own 0x12 key for amount, a length, and the seven bytes of 1250.00), with the outer message's field 2 (route) key, 0x12, immediately following. A diagram above the byte row shows GetQuoteResponse containing Money as a nested field 1 while Route sits beside it as a sibling field 2, with an arrow showing the same key-byte pattern recursing one level down inside Money. Callouts note that a nested message costs exactly one extra key byte and one length byte beyond its own contents, and that a parser never needs to track its nesting depth, because every key only encodes the current message's own field number and wire type." caption="Figure 6.2: nesting costs one key + length prefix per level; the parser never tracks depth." %}

Three facts fall out of this, easy to miss until you've read bytes this way once: a nested message costs exactly one extra key byte and one length byte beyond what its contents cost standalone; two fields at different nesting depths can produce the identical key byte, since the key only ever encodes `(this message's field number, this field's wire type)`; and a parser never needs to know how deep it is in a message tree to decode the next field: it reads a key, dispatches on wire type, and recurses if that wire type is LEN and the schema says the field is a message. This example's `verify.sh` builds exactly this `GetQuoteResponse` and asserts these byte positions against the real serialized output.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Run the single-connection model through Chapter 2's five axes for the call this book keeps anchoring to: <code>RoutingService.GetQuote</code> on the booking service's routing hot path. RPC shape and sync-vs-stream are unchanged by this chapter (<code>GetQuote</code> is still unary and still blocking), but concurrency model and deadline/budget both tighten because of what's covered here. Concurrency model: a channel held open for the booking service's process lifetime means a burst of concurrent <code>GetQuote</code> calls multiplexes over one connection instead of contending for a pool of sockets sized ahead of time, which is exactly the I/O-bound, high-call-volume profile this axis flagged as suited to virtual threads or <code>grpc.aio</code> in Chapter 2. Deadline and budget: because there's no per-call handshake to budget for, a tight deadline carved from the booking service's own request budget spends its time on the actual round trip, not on connection setup eaten into that same slice. The same model bites under a different topology, though: a Kubernetes `Service` backed by a standard L4 load balancer balances TCP connections, not RPCs, so one long-lived multiplexed connection concentrates every call behind it onto whatever pod happened to receive that connection, the opposite of the even distribution a stateless HTTP/1.1 client gets automatically from a new connection per request. Chapter 22 measures that failure mode and the client-side load-balancing and service-mesh fixes for it directly; the decision here is only that the same design that makes a single connection fast under one process is the design a naive Kubernetes deployment has to work around.</p></div>

## Where this goes next

Chapter 7 puts a real server and a real client stub around `GetQuote`'s unary shape (the first RPC type this site implements end to end on both stacks), running against the connection and framing model this chapter just named. Chapter 8 and Chapter 9 build the three streaming shapes on top of the same multiplexed connection, where a stream's lifetime stops being "one request, one response" and starts mattering in its own right. Chapter 17 returns to the flow-control window flagged in passing here, with the backpressure story a slow consumer on a long-lived stream actually needs. Chapter 22 picks up the Decision callout's Kubernetes caveat and works through client-side load balancing and a service mesh's sidecar proxy as the two answers to a single connection's distribution problem. And Chapter 24 takes the comparison this chapter started (gRPC's binary framing and persistent connection against REST's cacheable, stateless one) and measures it end to end against gRPC over HTTP/3, where the transport underneath changes again.

## On the wire

Run `examples/06-http2-foundation/verify.sh` yourself. It builds the `GetQuoteResponse` just decoded, compiles it two ways, and checks both the size claim and the byte-level claim against real output rather than this chapter's prose:

```bash
cd examples/06-http2-foundation
./verify.sh
```

Expect a tail close to this; the exact byte counts are deterministic for a given `protobuf` version, not an estimate:

```text
protobuf bytes : 122
proto3 JSON bytes: 363
ratio (JSON / protobuf): 2.98x
ok — protobuf encoding (122 bytes) is smaller than proto3 JSON (363 bytes)
ok — byte 0 is 0x0A = (1 << 3) | 2 -> field 1 (quote), wire type 2 (LEN)
ok — the embedded Money length fits one varint byte (no continuation bit)
ok — byte at the embedded Money's start is 0x0A again -> its own field 1 (currency), wire type 2
ok — the embedded Money decodes to currency=USD, amount=1250.00
ok — byte 16 is 0x12 -> field 2 (route), wire type 2 (LEN)
```

The size comparison serializes the same message two ways (`SerializeToString()` for protobuf, `google.protobuf.json_format.MessageToJson()` for proto3 JSON) and asserts the protobuf form is smaller, which is the message-level third of "gRPC is fast" from this chapter, measured rather than assumed. The byte checks that follow are the hand-decode from the previous section, run against the real serialized bytes instead of the worked numbers in the prose. Neither check touches a live connection: this example stays consistent with the site's other docker-free companions, with no server and no port, because HTTP/2's own multiplexing and HPACK behavior need two processes holding a connection open to observe directly: a measurement this book leaves to a packet capture, not a CI assertion.

## For deeper coverage

- [RFC 9113: HTTP/2](https://www.rfc-editor.org/rfc/rfc9113): the streams, frames, and frame types (`HEADERS`, `DATA`, `SETTINGS`) this chapter builds on.
- [RFC 7541: HPACK: Header Compression for HTTP/2](https://www.rfc-editor.org/rfc/rfc7541): the static/dynamic table mechanism behind this chapter's header-compression section.
- Sam Newman, *Building Microservices*, 2nd ed. (O'Reilly, 2021): inter-service communication trade-offs, including when a binary, multiplexed protocol like gRPC earns its cost over REST.
- *Cloud Native Design Patterns*, "Communications" chapter: the four interaction styles, including why gRPC is the default for internal, server-to-server calls like the one this chapter measures.
