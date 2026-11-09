---
title: "Cross-protocol choices and HTTP/3"
order: 24
part: "Browsers, Transcoding & Cross-Protocol"
description: "gRPC, REST over HTTP/2 and WebSockets each suit a different caller, and gRPC over HTTP/3 is not available in grpc-java or grpcio. Measure the HTTP/2 baseline and probe HTTP/3 separately."
duration: "22 min read"
---

## Learning objectives

By the end of this chapter you can:

- Choose between gRPC, REST over HTTP/2 (SSE or chunked) and WebSockets for a streaming interaction, based on who controls both ends, which direction data flows and how much contract discipline the team wants.
- Explain what QUIC's independent per-stream delivery fixes (transport-level head-of-line blocking) and what it leaves alone, since gRPC's framing is defined in terms of HTTP/2.
- State why "gRPC over HTTP/3" is a separate transport binding that neither `grpc-java` nor `grpcio` implements, not a free upgrade.
- Run a `ghz` load-test baseline against `GetQuote` and assert loose, relative bounds instead of hardware-specific absolutes.
- Treat an HTTP/3 transport probe (`aioquic` against Caddy) as capability-gated and non-fatal in CI, distinct from a correctness gate that is never skipped.

## Why this matters

Before any question of browsers or JSON callers comes the choice of how a new streaming interaction travels at all. gRPC is one of at least three realistic options, and the right one depends on who is calling, which way data flows and what tooling the team trusts.

Then comes the question every engineer asks on hearing "HTTP/3 fixes TCP's problems": does gRPC get to use it? Not yet. `grpc-java` and `grpcio` speak gRPC only over HTTP/2. `RoutingService.GetQuote` stays unchanged and is the call measured here; the proto contract doesn't move.

{% include excalidraw.html file="24-http3-crossprotocol" alt="Two side-by-side panels. The left panel, labeled HTTP/2 over TCP, one connection, shows a single TCP connection carrying three independent streams A, B, and C, with an arrow from all three streams into a box reading '1 lost TCP segment leads to ALL 3 streams stall for it', captioned transport-level head-of-line blocking, TCP not HTTP. The right panel, labeled HTTP/3 over QUIC, independent streams, shows a QUIC connection over UDP carrying the same three streams, where stream B shows '1 lost packet, retransmits alone' while streams A and C are annotated flows normally, captioned no cross-stream head-of-line blocking, plus 0-RTT resumption, plus connection migration." caption="Figure 24.1: one lost TCP segment stalls every multiplexed HTTP/2 stream sharing that connection; QUIC's independent per-stream delivery means a lost packet only stalls the one stream it belongs to." %}

## Three ways to carry a streaming call

| | gRPC | REST over HTTP/2 (SSE, chunked) | WebSockets |
|---|---|---|---|
| Contract | Protobuf, generated and CI-enforced | OpenAPI, usually hand-maintained | None; defined out of band |
| Directions | Unary, server, client and bidirectional streaming | Server to client only | Full duplex, free-form messages |
| Browser reach | Needs grpc-web or transcoding and a proxy | Native `fetch` and `EventSource` | Native `WebSocket` API |
| Backpressure | End-to-end HTTP/2 flow control | Application-level only | Application-level only |

{% include excalidraw.html file="24-protocol-decision-matrix" alt="A three-column comparison. The gRPC over HTTP/2 column lists Protobuf generated and CI-enforced contract, native support for all four streaming shapes, browser reach that needs grpc-web and a proxy, end-to-end HTTP/2 flow control, and grpcurl/buf/generated-stub tooling. The REST over HTTP/2 column lists an OpenAPI contract that is usually hand-maintained, one-direction SSE or chunked streaming, native browser fetch and EventSource reach, application-level-only backpressure, and curl/Postman/OpenAPI-codegen tooling. The WebSockets column lists no built-in contract defined out of band, full-duplex free-form messages, native browser WebSocket API reach, manual application-implemented backpressure, and wscat/browser-devtools tooling." caption="Figure 24.2: the same five questions, asked of all three transports: what's the contract, which directions does data flow, who can call it without extra tooling, who enforces backpressure, and what do you debug it with." %}

gRPC gives up nothing server to server. A slow consumer's stalled stream throttles the producer on the same stream. The cost is reach, and debugging without a `.proto` or server reflection, because the wire format is binary.

REST over HTTP/2 trades the typed contract for reach: any browser consumes it and anyone with `curl` can watch it. It has no second direction, so a bidirectional interaction has no clean expression, and chunked transfer has no flow-control primitive.

WebSockets are a raw bidirectional pipe, and the missing schema is the design point. Message shapes live in documentation, and nothing like `buf breaking` catches an incompatible change before it reaches a deployed client.

None is categorically faster. The deciding question is who is on the other end:

| Choose | When |
|---|---|
| gRPC | Both ends are services your team controls, the interaction needs a typed contract, and any of the four RPC shapes fits. Browser reach comes later through grpc-web or transcoding. |
| REST over HTTP/2 | The consumer is a browser or a loosely coupled external caller, data flows one way (a price ticker, a progress stream), and a generated stub costs more than it returns. |
| WebSockets | A browser needs full duplex and message shapes are too fluid, or too close to the UI's event model, to justify a generated contract (a collaborative editor, a game). |

The shipping domain is the first case: two backend services, high call volume, one team on both ends of the contract.

## HTTP/3: what QUIC fixes

TCP delivers bytes in strict order, so one lost segment stalls every HTTP/2 stream multiplexed on that connection, including streams whose data already arrived. That is transport-level head-of-line blocking, and it belongs to TCP, not HTTP. QUIC runs over UDP and tracks each stream's delivery independently, so a lost packet stalls only its own stream. QUIC adds two more properties:

- **0-RTT resumption:** a client that has talked to the server before skips a round trip on reconnect.
- **Connection migration:** a client's address can change (Wi-Fi to cellular) without rebuilding the connection, because QUIC identifies it by connection ID rather than by IP and port.

<div class="callout callout--warn"><p class="callout__title">Watch out</p><p>All three properties fix TCP-level problems. They say nothing about the application protocol on top. HTTP/3 is HTTP semantics carried over QUIC, and gRPC's wire format is defined in terms of HTTP/2: trailers for the final status, HTTP/2 flow control for backpressure and one HTTP/2 stream per RPC. "gRPC over HTTP/3" is a distinct transport binding that has to be specified and implemented separately.</p></div>

Neither `grpc-java` nor `grpcio` ships that binding, so no `GrpcService` or `grpc.aio.server()` can bind to a QUIC transport. HTTP/3 is worth understanding and demonstrating on its own, but `RoutingService` can't be switched onto it. Don't choose a gRPC transport on an HTTP/3 timeline: HTTP/2 is the gRPC transport on both stacks today, and the decision is worth revisiting when `grpc-java` and `grpcio` (or whichever implementation a service depends on) ship a native QUIC binding, not before.

{% include excalidraw.html file="24-h2-everywhere-h3-where-it-stands" alt="Three horizontal tiers. Tier 1, native gRPC over HTTP/2, shows grpc-java on Quarkus and grpcio on Python both marked available, the default, annotated CI-gated hard. Tier 2, HTTP/3 as a transport not gRPC, shows Caddy plus an aioquic probe and a browser fetch over QUIC both marked available, annotated capability-gated non-fatal in CI. Tier 3, gRPC directly over HTTP/3, shows grpc-java and grpcio both marked not yet, no native h3 transport, annotated checked against upstream January 2026." caption="Figure 24.3: where the two transports stand. Native gRPC over HTTP/2 is the hard-gated default; HTTP/3 is demonstrated as a transport only; gRPC directly over HTTP/3 is not available in either reference implementation yet." %}

The two transports therefore sit in separate services:

- `quarkus` and `python` each run a lean `RoutingService` that answers `GetQuote` over native gRPC on HTTP/2. The other four RPCs return `UNIMPLEMENTED`, because the subject is the transport, not a new capability.
- `caddy` serves one static JSON file over HTTPS. Caddy turns HTTP/3 on for any site served over TLS (no directive or flag, since Caddy 2.6), which makes it a real endpoint for a QUIC client. It has nothing to do with `RoutingService`.

Pointing an HTTP/3 client at a gRPC server that can't speak it, or reading a JSON fetch over QUIC as evidence about gRPC performance, would misrepresent both halves.

## Measuring the HTTP/2 baseline

`ghz` has no server-reflection client, so Compose mounts `contracts/proto/` read-only into a profiled-off `ghz` service. `verify.sh` runs it once per stack, against `quarkus:9000` and `python:9000` inside the Compose network, with concurrency 10 and 300 requests:

```bash
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm ghz \
    --insecure \
    --proto /contracts/shipping/routing/v1/routing.proto \
    --import-paths /contracts \
    --call shipping.routing.v1.RoutingService.GetQuote \
    -d "$GETQUOTE_REQUEST" \
    -c "$GHZ_CONCURRENCY" -n "$GHZ_TOTAL" -O json \
    "$in_network_target" > "$out_file"
```

The assertions are loose and relative: zero errors, 99th-percentile latency under a generous 1.5 seconds and throughput over a floor of 20 requests per second. Hardware-specific absolutes make a gate flaky. One recorded run:

| Stack | Requests per second | p99 | Errors |
|---|---|---|---|
| Quarkus | 1888.10 | 12.58 ms | 0 |
| Python | 5117.61 | 4.64 ms | 0 |

Both ran over native gRPC on HTTP/2, the only transport either call uses here.

## The HTTP/3 probe

`caddy/Caddyfile` declares one site, `caddy:8443, localhost:8443`, with `tls internal`. Caddy's own issuer mints a self-signed CA and a leaf certificate for exactly those names on every start. Both names matter: the probe dials the Compose service name `caddy`, so the certificate must carry it as a SAN.

`python/app/h3_probe.py` is the QUIC client, built on `aioquic` and independent of `grpcio`. It advertises the `h3` ALPN token, the TLS extension that tells the server which application protocol the client wants (`h2` for HTTP/2, `h3` for HTTP/3), sends one GET over an `H3Connection`, and records whether the handshake completed and the status was 200. Certificate verification is off (`ssl.CERT_NONE`), because the CA is regenerated on every start. The probe shows a protocol can run, not that a chain is trustworthy.

A passing probe reports `handshake_completed=True alpn=h3 status=200` and states that it confirms the transport, not gRPC over HTTP/3, because no gRPC call was made.

This step is capability-gated. The probe retries a few times to absorb Caddy's cold start. After that, any failure logs a `SKIP` with a fallback command and the script continues. QUIC rides on UDP, and some CI runners and corporate networks block inter-container UDP. Whether a sandbox routes UDP is a property of the environment, not of the code under test, so this step never fails the build.

> **🤖 Explore with your agent**
>
> "In examples/24-cross-protocol-http3, review the GetQuote ghz assertions in verify.sh against the rule that gates stay loose and relative, and propose a threshold for p99 and throughput that would still pass on a slower CI runner. Then confirm that nothing in the h3_probe step can fail the build, and that no gRPC call is made over the caddy service."
>
> Check: `./verify.sh` still prints PASS on both stacks, and the h3 step logs either the transport confirmation or a SKIP, never a failure.

## Build, run, observe

```bash
cd examples/24-cross-protocol-http3 && ./verify.sh
```

The script starts all three services, calls `GetQuote` on both stacks with `grpcurl`, runs `ghz` on each stack and asserts its bounds, then runs the HTTP/3 probe and logs its result either way. On a passing run both stacks return `quote.amount` `3001.25` and route `rte_USNYC-NLRTM`, the `ghz` baselines meet their bounds, and the probe confirms the QUIC handshake with a 200 from Caddy:

```
lib.sh: info, quarkus ghz (h2): errors=0 rps=1888.0997659832508 p99=0.012580479s
lib.sh: ok, quarkus ghz (h2) p99 latency vs generous ceiling: 0.012580479 < 1.5
lib.sh: ok, quarkus ghz (h2) throughput vs low floor: 1888.0997659832508 > 20
lib.sh: ok, h3 transport confirmed: a real QUIC handshake completed and Caddy
          answered HTTP/3 with 200. This is the transport, not gRPC-over-HTTP/3.
```

The gRPC ports are 9240 (Quarkus) and 9241 (Python); Caddy listens on 8443 over both TCP and UDP. By hand:

- Call `GetQuote`: `grpcurl -plaintext -d '{...}' localhost:9240 shipping.routing.v1.RoutingService/GetQuote`. The same call on 9241 returns identical `quote` and `route` fields, since both stacks compute the same formula (1200.5 kg from `USNYC` to `NLRTM` gives `3001.25`).
- Confirm the QUIC handshake with a second tool: `curl -k --http3-only https://localhost:8443/transport.json`. Check `curl --version` for `HTTP3` first, since not every distribution builds it in.
- Run the probe: `docker compose run --rm --entrypoint python python -m app.h3_probe caddy 8443 --path /transport.json`.

Experiments:

- **Block UDP.** Run where inter-container UDP is blocked, as on some sandboxed CI runners: after its retries the probe logs `SKIP` with the fallback commands, and the script still prints `PASS`.

---

## For deeper coverage

- Gough, J., Bryant, D. & Auburn, M., *Mastering API Architecture* (O'Reilly, 2022): the broader transport and style decision this comparison narrows to gRPC, REST and WebSockets.
- Cloud Native Design Patterns, "Appendix A: Protocols in Depth", for the same decision across REST, gRPC and GraphQL.
- [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114) and [RFC 9000: QUIC](https://www.rfc-editor.org/rfc/rfc9000), the specs behind what the probe negotiates.
