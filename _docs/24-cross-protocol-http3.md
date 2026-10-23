---
title: "Cross-protocol choices and HTTP/3"
order: 24
part: "Browsers, Transcoding & Cross-Protocol"
description: "gRPC versus REST-over-HTTP/2 versus WebSockets, and gRPC over HTTP/3, tier-gated and measured."
duration: "22 min read"
---

## Learning objectives

By the end of this chapter you can:

- Choose between gRPC, REST-over-HTTP/2 (SSE/chunked), and WebSockets for a new streaming interaction based on who controls both ends, which direction data flows, and how much contract discipline the team wants.
- Explain what QUIC's independent per-stream delivery fixes (HTTP/2's transport-level head-of-line blocking) and what it does not fix, since gRPC's own framing is defined specifically in terms of HTTP/2.
- State precisely why "gRPC over HTTP/3" is a distinct, not-yet-implemented transport binding in both `grpc-java` and `grpcio`, rather than a free upgrade of the existing HTTP/2 implementation.
- Run a `ghz` load-test baseline against `GetQuote` and assert loose, relative latency/throughput bounds instead of hardware-specific absolutes.
- Treat an HTTP/3 transport probe (`aioquic` against Caddy) as capability-gated and non-fatal in CI, distinct from a correctness gate that must never be skipped.

## Why this matters

Every prior chapter in this part answered a narrower question than the one this one closes with: given that a call is already gRPC, how does a browser, a REST client, or a JSON caller reach it? This chapter steps back a level, to the choice that happens before any of that: when a team is deciding how a new streaming interaction should travel across the wire at all, gRPC is one option among at least three realistic ones, and the right answer depends on who is calling, how many directions data flows, and what tooling the team already trusts. It also closes with the question every engineer asks the moment they hear "HTTP/3 fixes TCP's problems": does gRPC get to use it yet? As of this writing, no: grpc-java and grpcio both still speak gRPC exclusively over HTTP/2, and this chapter states that directly instead of hedging around it. `RoutingService.GetQuote`, unchanged from every earlier chapter, is still the call this chapter measures; nothing in the proto contract moves.

The code is in `examples/24-cross-protocol-http3/`. The run script there (`verify.sh`) builds and starts both stacks, proves `GetQuote` correct over native gRPC, runs a real `ghz` load-test baseline against it, and then runs a separate, clearly-labeled HTTP/3 transport probe that is non-fatal if it can't complete; its `README.md` covers what it does and how to drive it by hand.

{% include excalidraw.html file="24-http3-crossprotocol" alt="Two side-by-side panels. The left panel, labeled HTTP/2 over TCP, one connection, shows a single TCP connection carrying three independent streams A, B, and C, with an arrow from all three streams into a box reading '1 lost TCP segment leads to ALL 3 streams stall for it', captioned transport-level head-of-line blocking, TCP not HTTP. The right panel, labeled HTTP/3 over QUIC, independent streams, shows a QUIC connection over UDP carrying the same three streams, where stream B shows '1 lost packet, retransmits alone' while streams A and C are annotated flows normally, captioned no cross-stream head-of-line blocking, plus 0-RTT resumption, plus connection migration." caption="Figure 24.1: one lost TCP segment stalls every multiplexed HTTP/2 stream sharing that connection; QUIC's independent per-stream delivery means a lost packet only stalls the one stream it belongs to." %}

## Three ways to carry a streaming call

A team choosing how a new streaming interaction should travel across the wire is really choosing among three mature, production-proven options, and each one optimizes for a different caller.

**gRPC** gives up nothing on the server-to-server path: a protobuf contract generated into real client and server code, four RPC shapes (this book's Part 3) covering unary, server-streaming, client-streaming, and bidirectional exchange, and HTTP/2 flow control that applies backpressure end to end: a slow consumer's stalled stream throttles how fast the producer on the other end of that same stream is allowed to send. The cost is reach: a browser cannot speak native gRPC at all (Chapter 23 covered grpc-web and JSON transcoding as the two ways around that), and anyone debugging a call without a `.proto` file in hand is working blind, because the wire format is binary and self-describing only with a schema or server reflection.

**REST over HTTP/2**, specifically server-sent events or chunked transfer encoding layered over a conventional REST API, trades gRPC's typed contract for universal reach: any browser's `fetch` or `EventSource` API consumes it with zero extra tooling, any engineer with `curl` can watch it happen live, and an OpenAPI document (even if hand-maintained and prone to drifting from the implementation) describes the shape well enough for most integrations. What it does not give you is a second direction: SSE and chunked responses are server-to-client only, so a bidirectional interaction (a client that needs to both send a continuous stream and receive one) has no clean expression in plain REST, and backpressure has to be built by hand at the application layer, because HTTP/1.1-style chunked transfer has no flow-control primitive of its own.

**WebSockets** split the difference in the other direction: full-duplex, free-form messages, natively supported in every browser with no proxy or shim required, and nothing resembling a schema anywhere in the protocol itself. That absence of a schema is WebSockets' entire design point, a raw bidirectional pipe the application is free to put anything on, not a defect introduced by sloppy engineering. It means a WebSocket endpoint's message shapes live entirely in whatever documentation or out-of-band convention the team maintains, with no `buf breaking` equivalent to catch an incompatible change before it reaches a deployed client. Backpressure, like REST's, is the application's problem to solve, not the protocol's.

{% include excalidraw.html file="24-protocol-decision-matrix" alt="A three-column comparison. The gRPC over HTTP/2 column lists Protobuf generated and CI-enforced contract, native support for all four streaming shapes, browser reach that needs grpc-web and a proxy, end-to-end HTTP/2 flow control, and grpcurl/buf/generated-stub tooling. The REST over HTTP/2 column lists an OpenAPI contract that is usually hand-maintained, one-direction SSE or chunked streaming, native browser fetch and EventSource reach, application-level-only backpressure, and curl/Postman/OpenAPI-codegen tooling. The WebSockets column lists no built-in contract defined out of band, full-duplex free-form messages, native browser WebSocket API reach, manual application-implemented backpressure, and wscat/browser-devtools tooling." caption="Figure 24.2: the same five questions, asked of all three transports: what's the contract, which directions does data flow, who can call it without extra tooling, who enforces backpressure, and what do you debug it with." %}

None of these three is categorically "faster" or "better": they are optimized for different callers, and the deciding question is almost always who is on the other end of the call, not a raw throughput number. A payments service calling another internal service wants gRPC's typed contract and native bidirectional streaming, and controls both ends of the wire so grpc-web's extra hop never enters the picture. A public API serving a web dashboard wants REST-over-HTTP/2's zero-tooling reach for a one-directional feed (a live price ticker, a progress stream) where the client is a browser `fetch` call and nothing more exotic. A collaborative editor or a multiplayer game wants WebSockets' full duplex and accepts the schema-discipline cost, because the message shapes change often enough during development that generated-stub regeneration would be more friction than help. This book's shipping domain leans toward the first case for exactly the reason Chapter 2's decision framework gave at the very start: two backend services, high call volume, a shared team maintaining both ends of the contract. That is the profile gRPC was built for.

## HTTP/3: what QUIC actually fixes, and why that's not the same as "gRPC gets faster"

Figure 24.1 above is the whole story HTTP/3 tells for a transport under packet loss: TCP, the protocol every HTTP/1.1 and HTTP/2 connection rides on, delivers bytes to the application in strict order, which means a single lost TCP segment stalls every one of HTTP/2's multiplexed streams sharing that connection, even the ones whose data already arrived intact: a transport-level head-of-line block that has nothing to do with HTTP and everything to do with TCP's ordering guarantee. QUIC, the transport HTTP/3 is built on, runs over UDP instead and tracks each stream's delivery independently, so a lost packet belonging to stream B stalls stream B's retransmission and nothing else; streams A and C keep flowing while B catches up. QUIC adds two more properties that show up in almost every HTTP/3 pitch: 0-RTT connection resumption, which lets a client that has talked to a server before skip a full round trip on a repeat connection, and connection migration, where a client's address can change (a phone moving from Wi-Fi to cellular) without tearing down and rebuilding the connection, because QUIC identifies a connection by a connection ID rather than the client's IP and port tuple.

<div class="callout callout--warn"><p class="callout__title">Watch out</p><p>Every one of those three properties is a fix for a TCP-level problem, and none of them says anything about which application protocol rides on top of QUIC. HTTP/3 is HTTP semantics (the same request/response model, the same status codes, the same headers) carried over QUIC instead of over TCP, and gRPC's own wire format, the binary framing Chapter 6 covered in depth, is defined in terms of HTTP/2 specifically: HTTP/2 trailers for the final status, HTTP/2 flow control for per-stream backpressure, and an HTTP/2 stream per RPC. "gRPC over HTTP/3" is a distinct transport binding that has to be specified and implemented separately, not a free upgrade of an existing HTTP/2 implementation, the same way gRPC-over-HTTP/2 itself had to be specified and implemented once.</p></div>

That distinct transport binding does not exist natively in either stack this book builds on, as of this writing. grpc-java and grpcio (the two reference implementations behind every Quarkus and Python example in this book) both still speak gRPC exclusively over HTTP/2; neither project ships a QUIC-based transport a `GrpcService` or a `grpc.aio.server()` can bind to instead. That is not a gap specific to these two implementations: it reflects where the broader gRPC ecosystem stands today, and it is why this chapter treats HTTP/3 as a transport worth understanding and demonstrating in isolation, never as something this book's `RoutingService` can be switched onto. Every gRPC call in this book, including the one two sections below, travels over HTTP/2, and that remains true for the foreseeable future on these two stacks.

{% include excalidraw.html file="24-h2-everywhere-h3-where-it-stands" alt="Three horizontal tiers. Tier 1, native gRPC over HTTP/2, shows grpc-java on Quarkus and grpcio on Python both marked available, this book's default, annotated CI-gated hard every chapter. Tier 2, HTTP/3 as a transport not gRPC, shows Caddy plus an aioquic probe and a browser fetch over QUIC both marked available, annotated capability-gated non-fatal in CI. Tier 3, gRPC directly over HTTP/3, shows grpc-java and grpcio both marked not yet, no native h3 transport, annotated checked against upstream January 2026." caption="Figure 24.3: where this chapter's two transports stand: native gRPC over HTTP/2 is this book's hard-gated default everywhere; HTTP/3 is demonstrated as a transport only; gRPC directly over HTTP/3 is not available in either reference implementation yet." %}

This is also why this chapter's example keeps the two transports in entirely separate services rather than trying to bolt one onto the other. `quarkus` and `python` each run a lean `RoutingService` server that answers `GetQuote` over native gRPC, HTTP/2, the only transport either stack has. A third service, `caddy`, serves one static JSON file over HTTPS and has nothing to do with either `RoutingService`; it exists only because Caddy turns HTTP/3 on automatically for any site it serves over TLS, which makes it a convenient, real endpoint for a QUIC client to talk to. Reusing one for the other (pointing an HTTP/3 client at a gRPC server that can't speak HTTP/3, or claiming a JSON fetch over QUIC says anything about gRPC's performance) would misrepresent what either half of this example proves.

## How the code works

**The server: the leanest `RoutingService` in the book.** `quarkus/src/main/java/.../RoutingServiceImpl.java` and `python/app/routing_service.py` implement exactly one RPC, `GetQuote`, with the identical formula every chapter since Chapter 7 has used: `quote.amount = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)`, a single `MAERSK` leg, a route id built from the two UN/LOCODEs. `FindOptimalRoute`, `ListRoutes`, `NegotiateRoute`, and `RecomputeRoutes` all return `UNIMPLEMENTED`, the same discipline every prior chapter's example has followed for methods out of scope. There is no `ListRoutes` catalog here the way Chapter 18 built one, and no REST front door the way Chapter 21's `QuoteService` loopback added one: this chapter's subject is the transport a call travels over, not a new capability, so the server stays as small as the proto contract allows while still answering something real.

**`ghz`, fed the proto directly, same pattern as Chapter 18's.** `ghz` has no server-reflection client, so `compose.yaml` mounts `contracts/proto/` read-only into a dedicated, profiled-off `ghz` service and `verify.sh` invokes it with `docker compose run --rm ghz`, naming the method and feeding it the compiled `.proto` plus its import path:

```bash
docker compose run --rm ghz --insecure \
  --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \
  --call shipping.routing.v1.RoutingService.GetQuote \
  -d '{...}' -c 10 -n 300 -O json quarkus:9000
```

`verify.sh` parses the JSON result and asserts three loose, relative bounds, the identical discipline Chapter 18 established: zero errors, a 99th-percentile latency under a generous 1.5-second ceiling, and a throughput over a 20-requests-per-second floor. A real run on this book's dev box landed Quarkus at `rps=1888.1 p99=12.6ms` and Python at `rps=5117.6 p99=4.6ms`, both comfortably inside those bounds, and both entirely over native gRPC/HTTP2, the only transport either call ever travels on in this chapter.

**`caddy` and `h3_probe.py`: a transport probe kept separate.** `caddy/Caddyfile` declares one site, `caddy:8443, localhost:8443`, with `tls internal`, Caddy's own non-ACME issuer, which mints a fresh self-signed CA and a leaf certificate for exactly the hostnames the site block names, inside the container, on every start. Naming both hostnames matters: the probe connects to the service by its compose network name (`caddy`), and the certificate has to carry that name as a SAN for the TLS handshake to have something to validate against, same as any TLS certificate needs the name a client dials to appear somewhere in it. Caddy enables HTTP/3 automatically the moment a site is served over TLS (no separate directive, no experimental flag, true since Caddy 2.6), so this one plain `file_server` block, with nothing resembling application logic behind it, is enough to give a QUIC client something real to negotiate with.

`python/app/h3_probe.py` is that QUIC client, built on `aioquic`, the Python ecosystem's QUIC and HTTP/3 implementation, used here entirely independently of `grpcio`. It opens a `QuicConfiguration` advertising the `h3` ALPN token (the TLS extension that tells a server which application protocol the client wants: `h2` for HTTP/2, `h3` for HTTP/3, negotiated during the same TLS handshake QUIC carries), drives one GET request over an `H3Connection`, and records two things: whether `HandshakeCompleted` fired, and whether the response status came back `200`. Certificate verification is explicitly disabled (`verify_mode=ssl.CERT_NONE`): Caddy's internal CA is regenerated on every container start, and distributing that one-off CA to the probe would add real machinery to teach nothing new, since Chapter 19 and Chapter 20 already cover TLS trust chains and mutual authentication at the depth this book commits to. This script proves a protocol can run, not that a certificate chain is trustworthy.

```
h3_probe: QUIC handshake_completed=True alpn=h3 status=200 body='{"service": "ch24-cross-protocol-http3-caddy", "transport": "HTTP/3 over QUIC", ...}'
h3_probe: HTTP/3 transport confirmed over QUIC — this is the transport, not gRPC-over-HTTP/3 (no gRPC call was made)
```

`verify.sh`'s `run_h3_probe` treats this step differently from everything before it: it retries the probe a few times to absorb Caddy's own cold start (minting a certificate, binding a UDP socket takes a moment), but any failure after that (a sandboxed network that blocks inter-container UDP, which some CI runners and corporate networks do, since QUIC rides on UDP and UDP is blocked far more often than TCP) logs a clear `SKIP` with a documented fallback command and lets the script continue. Nothing about this step ever fails the build; it is capability-gated by design, exactly because "can this sandbox route UDP between two containers" is a property of the environment, not of the code being verified.

## Build, run, observe

```bash
cd examples/24-cross-protocol-http3 && ./verify.sh
```

`verify.sh` brings all three services up with `docker compose`, verifies `GetQuote` on both stacks via `grpcurl`, runs `ghz` against `GetQuote` on each stack and asserts its loose bounds, then runs the HTTP/3 transport probe and logs its result either way without failing on it. A real run on this book's dev box:

```
lib.sh: ok — quarkus quote.amount: '3001.25'
lib.sh: ok — quarkus route.id: 'rte_USNYC-NLRTM'
lib.sh: info — quarkus ghz (h2): errors=0 rps=1888.0997659832508 p99=0.012580479s
lib.sh: ok — python quote.amount: '3001.25'
lib.sh: info — python ghz (h2): errors=0 rps=5117.610187947304 p99=0.004636686s
lib.sh: ok — h3 transport confirmed: a real QUIC handshake completed and Caddy answered HTTP/3 with 200.
PASS — Ch24 cross-protocol-http3: ...
```

## Cross-check

Point `curl` at the same `GetQuote` correctness `grpcurl` already confirmed, from a completely independent tool, to rule out a `grpcurl`-specific quirk: `grpcurl -plaintext -d '{...}' localhost:9240 shipping.routing.v1.RoutingService/GetQuote` and the Python stack's identical call against `localhost:9241` should return byte-identical `quote` and `route` fields, since both stacks compute the same formula from the same request. For the HTTP/3 half, a `curl` build with HTTP/3 support compiled in (`curl --http3-only -k https://localhost:8443/transport.json`, checking `curl --version` for `HTTP3` in its feature list first, since not every distribution's curl ships it) is a second, independent way to confirm the same QUIC handshake `h3_probe.py` completes, from a tool that has nothing to do with `aioquic`.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Choose gRPC when both ends of a call are services your team controls, the interaction needs a typed, CI-enforced contract, and any of the four RPC shapes (especially bidirectional streaming) fits the problem; the up-front cost is browser reach, which Chapter 23's grpc-web and transcoding patterns close when a browser client later shows up. Choose REST over HTTP/2 (SSE or chunked) when the consumer is a browser or a loosely-coupled external caller, the data only needs to flow one direction, and the integration cost of a generated stub outweighs the benefit of one. Choose WebSockets when you need full-duplex exchange with a browser and the message shapes are too fluid, or too close to the UI's own event model, to justify a generated contract. Do not choose a transport based on an HTTP/3 timeline: HTTP/2 is the gRPC transport everywhere today, on every stack this book builds on, and that stays true until grpc-java and grpcio (or whichever implementation a reader depends on) ship a native QUIC transport binding: a decision worth revisiting when that lands, not before.</p></div>

## What you learned

- gRPC, REST-over-HTTP/2, and WebSockets each optimize for a different caller (typed server-to-server contracts, universal one-directional browser reach, and schema-free full-duplex exchange, respectively), and the right choice follows from who calls and which direction data flows, not from a throughput benchmark.
- QUIC's independent per-stream delivery fixes HTTP/2's transport-level head-of-line blocking (one lost TCP segment stalling every multiplexed stream), and adds 0-RTT resumption and connection migration: real fixes, but fixes to TCP's problems, not automatic upgrades to whatever application protocol happens to ride on top.
- gRPC-over-HTTP/3 is a distinct transport binding, specified and implemented separately from gRPC-over-HTTP/2, and neither grpc-java nor grpcio implements it natively as of this writing: every gRPC call in this book, including this chapter's own `GetQuote`, travels over HTTP/2, and a correctness-plus-measured-baseline check against that call is the only thing this chapter's CI gate enforces; the HTTP/3 transport probe against an unrelated static file is demonstrated, logged, and never allowed to fail the build.

Chapter 25 turns from choosing and measuring a transport to proving a gRPC service conforms to its contract at all: a testing strategy spanning unit tests against generated stubs, integration tests against a real server, and the CLI tools (`grpcurl`, `buf`, `ghz` among them) this book has used throughout.

## On the wire

Native gRPC, HTTP/2, both stacks: the only transport `RoutingService.GetQuote` travels on anywhere in this book:

```bash
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC", "name": "New York"},
  "destination": {"unLocode": "NLRTM", "name": "Rotterdam"},
  "cargo": [{"weightKg": 1200.5, "description": "Palletized electronics", "cargoType": "GENERAL"}]
}' localhost:9240 shipping.routing.v1.RoutingService/GetQuote
```

```
{
  "quote": { "currency": "USD", "amount": "3001.25" },
  "route": { "id": "rte_USNYC-NLRTM", "legs": [{ "carrier": "MAERSK", ... }], "price": {...} }
}
```

A real `ghz` run against that same call (`-c 10 -n 300`):

```
Quarkus:  rps=1888.10  p99=12.58ms  errors=0
Python:   rps=5117.61  p99=4.64ms   errors=0
```

And, entirely separately, the HTTP/3 **transport** probe against Caddy, not a gRPC call:

```bash
curl -k --http3-only https://localhost:8443/transport.json
# (or, the deterministic CI equivalent:)
docker compose run --rm --entrypoint python python -m app.h3_probe caddy 8443 --path /transport.json
```

```
h3_probe: QUIC handshake_completed=True alpn=h3 status=200
h3_probe: HTTP/3 transport confirmed over QUIC — this is the transport, not gRPC-over-HTTP/3
```

---

## For deeper coverage

- Gough, J., Bryant, D. & Auburn, M., *Mastering API Architecture* (O'Reilly, 2022): the broader transport/style decision this chapter's three-way comparison narrows to gRPC/REST/WebSockets.
- Cloud Native Design Patterns, "Appendix A: Protocols in Depth" chapter, for the same decision framed across REST, gRPC, and GraphQL.
- [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114) and [RFC 9000: QUIC](https://www.rfc-editor.org/rfc/rfc9000), the specs behind what this chapter's probe negotiates.
