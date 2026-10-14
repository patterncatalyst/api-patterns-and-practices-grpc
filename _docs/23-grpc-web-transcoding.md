---
title: "gRPC-Web and JSON transcoding"
order: 23
part: "Browsers, Transcoding & Cross-Protocol"
description: "The browser problem, grpc-gateway and Envoy transcoding, and the REST to gRPC interop seam made concrete."
duration: "24 min read"
---

Chapter 22 put `RoutingService.GetQuote` behind three replicas and a mesh, and every fix in that chapter assumed the caller already speaks gRPC: a client holding one long-lived HTTP/2 channel, reused across calls, exactly as Chapter 7 built it. This chapter's caller cannot make that assumption true. A browser's `fetch()` and `XMLHttpRequest` cannot open a raw HTTP/2 stream, cannot send gRPC's binary length-prefixed frames, and cannot read the HTTP/2 trailers gRPC uses to carry its final status — three separate gaps, not one. Nothing about `RoutingService` changes to close them: the fix lives entirely in a proxy sitting in front of the exact same server every prior chapter has called directly, and this chapter builds that proxy twice, once per stack, and drives it four different ways against the identical `GetQuote` RPC.

The code is in `examples/23-grpc-web-transcoding/`. The run script there (`verify.sh`) builds and brings up both app stacks and both Envoy proxies, then checks all four paths; its `README.md` covers what it does and how to drive it by hand.

{% include excalidraw.html file="23-grpc-web-transcoding-seam" alt="A browser running a grpc-web client and a JSON or HTTP client both send requests to one Envoy listener running a grpc_web filter and a grpc_json_transcoder filter. A separate REST booking service sends a request directly, bypassing Envoy. All three arrows converge on one box labeled RoutingService.GetQuote, native gRPC, port 9000." caption="Figure 23.1 — three doors, one RPC: a browser and a JSON client arrive through Envoy's grpc_web and grpc_json_transcoder filters; the hand-written REST shim calls GetQuote directly." %}

## The browser problem

gRPC's wire format is simple to describe and awkward for a browser to produce. A unary call is one HTTP/2 stream: a HEADERS frame carrying the method and any metadata, one or more DATA frames each holding a 1-byte compression flag, a 4-byte big-endian length, and a serialized protobuf message, and a second HEADERS frame — sent as HTTP/2 trailers, after the body — carrying the final `grpc-status` and `grpc-message`. Every piece of that depends on controlling the HTTP/2 stream directly: choosing frame types, writing raw bytes to the wire, and reading trailers that arrive after the response body has already been delivered to the caller.

A browser's JavaScript networking APIs do not offer any of that. `fetch()` and `XMLHttpRequest` speak HTTP in terms of a request/response pair with a status code, a set of response headers available before the body, and a body you read as text, JSON, or bytes — there is no API surface for an HTTP/2 trailer, because the Fetch spec does not expose one, and there is no way to hand the browser a raw frame to put on the wire. This is not a bug anyone intends to fix: HTTP/2 trailers exist for exactly the kind of use gRPC makes of them — a status that can only be known after the body streams out — and browsers simply were not built to surface them to page script.

Two unrelated fixes close this gap for two unrelated audiences, and this chapter builds both in front of the same server:

- **grpc-web** keeps gRPC's framing idea but repacks it into something a browser's networking stack can actually send and receive: the same length-prefixed message frame, plus a second length-prefixed frame carrying the trailer's `grpc-status`/`grpc-message` as plain text, both inside one ordinary HTTP/1.1 (or HTTP/2, but without needing trailers) response body. A browser only ever sees a normal response with a byte-string body; it never needs to touch an HTTP/2 trailer.
- **JSON/HTTP transcoding** does not try to make gRPC framing reachable at all. It converts a conventional REST-shaped request — a URL, an HTTP verb, a plain JSON body — directly into a native gRPC call on the caller's behalf, and converts the gRPC response back into JSON. The caller never speaks any gRPC-flavored protocol; from its point of view, it called a JSON API.

Chapter 21 already solved one version of this problem by hand: `BookingResource`/`booking_quote` is a REST endpoint purpose-built for one RPC, written by a person who knows `GetQuoteRequest`'s shape and translates a `BookingQuoteRequest` into it field by field. That approach works, and this chapter keeps it running unchanged specifically so it can sit next to the two new approaches for comparison. What it cannot do is generalize: every new RPC this book ever adds needs its own hand-written handler, in every language this book's stacks are written in, forever. The two mechanisms this chapter adds exist to remove that per-RPC, per-language tax — at the cost of real trade-offs between the two, covered below.

## Envoy as the one place both fixes live

Both mechanisms in this chapter are filters in Envoy's HTTP connection manager, not application code, and both read the same input: a `FileDescriptorSet`, a binary snapshot of the proto schema, built once at image-build time and baked into the Envoy image. `examples/23-grpc-web-transcoding/envoy/Containerfile` builds it with `buf build contracts/proto -o descriptor.binpb` — a command run directly against this book's frozen contracts at authoring time, with the output inspected to confirm it holds not only `routing.proto`, `quote.proto`, and `types.proto`, but their transitive imports too: `google/protobuf/field_mask.proto` (imported by `routing.proto`) and `google/protobuf/timestamp.proto` (imported by `types.proto`). Leaving those two files out would not break the build — `buf build` simply would not compile without them — but it illustrates the real requirement: `grpc_json_transcoder` has to resolve every field of every message it transcodes, and a `Timestamp` or `FieldMask` field appearing anywhere in the schema means the descriptor needs those well-known types present, not just the three `shipping/*` files a reader might assume are "the proto."

One Envoy container runs per stack (`envoy-quarkus`, `envoy-python`), each with its own static config whose only difference is the upstream address — `quarkus:9000` or `python:9000`. Both configs run the identical filter chain on one listener:

```
grpc_web            # application/grpc-web+proto -> application/grpc
grpc_json_transcoder # application/json -> application/grpc, via the baked-in descriptor
router              # forwards to the "app" cluster over real HTTP/2
```

Order matters here in a way that is easy to miss: both filters run on every request, but each only acts on the content-type it cares about. A JSON request's `content-type: application/json` does not match what `grpc_web` is watching for, so it passes through unchanged and reaches `grpc_json_transcoder`, which decodes it against the descriptor and emits a native gRPC call. A grpc-web request's `content-type: application/grpc-web+proto` matches `grpc_web`, which unwraps the framing and emits a native gRPC call with `content-type: application/grpc` — and because that content-type no longer looks like JSON, `grpc_json_transcoder` leaves it alone on its way through. Neither filter needs to know the other exists; the content-type header is the entire coordination mechanism between them, and the `router` filter at the end sees the same shape of request — native gRPC over HTTP/2 to the `app` cluster — no matter which door a request came in through.

{% include excalidraw.html file="23-three-ways-to-reach-grpc" alt="Three columns compare the hand-written REST shim, Envoy's JSON transcoder, and Envoy's grpc-web filter: what each needs, its request URL and content-type, and who it is meant for." caption="Figure 23.2 — the same RPC, three different doors, with real trade-offs between them." %}

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Write a hand-written REST shim like <code>BookingResource</code> when an endpoint needs its own purpose-built request/response shape — a booking form, a dashboard widget — that does not map cleanly onto any one RPC's native fields, or when the team shipping it wants full control over validation, field naming, and versioning independent of the proto. Reach for Envoy's <code>grpc_json_transcoder</code> when the caller is any ordinary JSON/HTTP client — a script, another backend, an internal tool — and the proto's own shape is good enough to expose directly: it needs zero hand-written mapping code per RPC, at the cost of a less readable URL (<code>/shipping.routing.v1.RoutingService/GetQuote</code> instead of something like <code>/v1/quotes</code>) unless a <code>google.api.http</code> annotation is added to the proto itself (see "On the wire" below for why this book does not wire one). Reach for <code>grpc_web</code> specifically when the caller is a browser and nothing else will do — it is strictly more machinery than the transcoder for the same proxy to run, and buys nothing over JSON transcoding for a caller that is not constrained by what <code>fetch()</code>/<code>XHR</code> can actually send.</p></div>

## How the code works

**The app itself is unchanged from Chapter 21.** `RoutingServiceImpl`/`RoutingServiceServicer` still calls `QuoteServiceImpl`/`QuoteServiceServicer` over a loopback channel, and `BookingResource`/`booking_quote` is still the hand-written REST shim — see Chapter 21 for that walkthrough. What is new in this chapter lives in `envoy/` and in one new Python module, `python/app/grpcweb_client.py`.

**The descriptor-build stage**, in `envoy/Containerfile`:

```dockerfile
FROM docker.io/bufbuild/buf:1.73.0 AS descriptor
WORKDIR /work
COPY contracts/proto ./proto
RUN buf build ./proto -o /descriptor.binpb
```

This is the same repo-root build-context trick every app Containerfile in this book already uses — `contracts/proto` is copied in at build time, never committed into this module — pointed at `buf` instead of `mvn` or `protoc`. `buf build` is given a directory, not a `buf.yaml`-governed module, which is enough: buf treats the directory itself as the proto root and resolves every `import` statement inside it, plus the well-known Google types it ships internally, producing one self-contained binary file. The runtime stage then copies that one file, plus one of two static `envoy.yaml` configs, into the distroless Envoy image:

```dockerfile
FROM docker.io/envoyproxy/envoy:distroless-v1.40.0
ARG ENVOY_CONFIG=envoy-quarkus.yaml
COPY --from=descriptor --chown=65532:65532 /descriptor.binpb /etc/envoy/descriptor.binpb
COPY --chown=65532:65532 examples/23-grpc-web-transcoding/envoy/${ENVOY_CONFIG} /etc/envoy/envoy.yaml
```

The base image's own `ENTRYPOINT`/`CMD` already runs `envoy -c /etc/envoy/envoy.yaml` as its baked-in nonroot user — this Containerfile supplies nothing but the two files that command expects to find at that path. `compose.yaml` builds this one Containerfile twice, once per stack, passing a different `ENVOY_CONFIG` build argument each time, which is why two static YAML files exist instead of one templated one: the distroless runtime stage has no shell to run a template engine against at container start, so the choice between `quarkus:9000` and `python:9000` as the upstream address has to be made at build time, by selecting which already-correct file to copy.

**The transcoder filter's configuration** is the part of `envoy.yaml` doing the real work:

```yaml
- name: envoy.filters.http.grpc_json_transcoder
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.filters.http.grpc_json_transcoder.v3.GrpcJsonTranscoder
    proto_descriptor: /etc/envoy/descriptor.binpb
    services:
      - shipping.routing.v1.RoutingService
    auto_mapping: true
    convert_grpc_status: true
```

`proto_descriptor` points at the file the first stage built; `services` names exactly the one service this chapter exposes — `RoutingService`, not `QuoteService`, since nothing outside this process ever calls `QuoteService` directly. `auto_mapping: true` is what makes zero-hand-written-mapping-code true in practice: without it, every RPC the transcoder exposes needs an explicit `google.api.http` rule telling Envoy which URL and HTTP verb map to which method, the same `google.api.http` annotation this book does not add to the shared proto, for the reason covered in "On the wire" below. With `auto_mapping` on, Envoy derives that mapping itself, for every method on the named service, using the same convention native gRPC already uses: `POST /<package>.<Service>/<Method>`, with the entire JSON body bound to the request message. `convert_grpc_status: true` is what turns `GetQuote`'s internal gRPC status codes into the HTTP status codes a JSON client actually understands — `INVALID_ARGUMENT` becomes `400`, `NOT_FOUND` becomes `404`, and so on — the malformed-JSON check in `verify.sh` exercises exactly this mapping.

**`grpcweb_client.py`** is the one piece of new application code this chapter adds. It builds the identical `GetQuoteRequest` every other path in this chapter builds, then frames it by hand:

```python
def frame(message: bytes) -> bytes:
    return struct.pack(">BI", 0x00, len(message)) + message
```

The 5-byte header — one flag byte, always `0x00` for an uncompressed data frame, followed by the message length as a 4-byte unsigned big-endian integer — is grpc-web's entire framing contract for a request. The response comes back the same way, except a real response carries two frames instead of one: a data frame holding the serialized `GetQuoteResponse`, and a second frame whose flag byte has its high bit set (`0x80`) marking it as the trailer, whose payload is plain `key: value\r\n` text carrying `grpc-status` and `grpc-message` — the HTTP/2-trailer information a browser cannot read, repacked into something an ordinary response body can carry:

```python
def _unframe_all(body: bytes) -> list[tuple[int, bytes]]:
    frames = []
    offset = 0
    while offset < len(body):
        flag, length = struct.unpack(">BI", body[offset:offset + 5])
        offset += 5
        payload = body[offset:offset + length]
        offset += length
        frames.append((flag, payload))
    return frames
```

`call_get_quote` POSTs the framed request to Envoy with `content-type: application/grpc-web+proto`, splits the response into its frames, deserializes the data frame's payload as a `GetQuoteResponse`, and checks the trailer frame's `grpc-status` before trusting the result — because a grpc-web proxy answers `200 OK` at the HTTP layer even when the underlying RPC failed; the real outcome rides in that trailer, exactly as it would in a native HTTP/2 trailer. Nothing about this file is a mock or a simulation of grpc-web: it performs the exact bytes a real browser's `grpc-web` JavaScript library would send and parses the exact bytes it would receive, using only the Python standard library's `urllib` and this module's own generated protobuf stubs — which is what makes it something a CI job can run deterministically, with no browser, no headless-Chrome layer, and no flakiness from a UI automation stack that has nothing to do with this chapter's actual subject.

{% include excalidraw.html file="23-grpc-web-framing" alt="Native gRPC over HTTP/2 uses a HEADERS frame, one or more DATA frames, and a trailing HEADERS frame for the final status. grpc-web over HTTP/1.1 packs a DATA frame and a TRAILER frame into one ordinary response body, because a browser's fetch or XHR API cannot read HTTP/2 trailers or open a raw HTTP/2 stream." caption="Figure 23.3 — why a browser cannot just dial native gRPC, and what grpc-web does instead." %}

## Build, run, observe

```bash
cd examples/23-grpc-web-transcoding && ./verify.sh
```

The script brings up both app stacks and both Envoy containers, then drives all four paths against each stack and checks that every one returns `USD 2500.00` for a 1000kg shipment from `USNYC` to `NLRTM`, routed as `rte_USNYC-NLRTM` via `MAERSK` — the same formula every prior anchor chapter has used. Watch for the grpc-web step in particular: it runs `grpcweb_client.py` as a one-shot `docker compose run` against the Envoy service's in-network name (`envoy-quarkus:10000`), not the host-published port, because the client executes inside the compose network rather than from the host the way the `curl` checks do.

## Cross-check

Point `grpcurl` at either app's native gRPC port with server reflection — `grpcurl -plaintext localhost:9230 list` — to confirm `shipping.routing.v1.RoutingService` is exactly the schema the Envoy descriptor was built from, independent of Envoy entirely. If the two ever disagreed — a proto field renamed in the app without rebuilding Envoy's descriptor — the transcoder and grpc-web paths would fail or silently drop a field while the native path kept working, which is exactly the failure mode a baked-in, build-time descriptor is meant to catch early rather than at request time.

## What you learned

- A browser cannot speak native gRPC because `fetch()`/`XHR` cannot send raw HTTP/2 frames or read HTTP/2 trailers — grpc-web repacks both into one ordinary HTTP response body instead.
- `grpc_json_transcoder`'s `auto_mapping` derives a JSON/HTTP mapping for every method on a named service directly from a proto descriptor, with zero hand-written per-RPC code, using the native `POST /<package>.<Service>/<Method>` URL convention.
- One `FileDescriptorSet`, built once at image-build time with `buf build` and including every transitive import, feeds both the JSON transcoder and gives Envoy everything it needs to resolve every field — without ever touching the app's own reflection service.
- `grpc_web` and `grpc_json_transcoder` coexist on one filter chain by content-type alone: each acts only on the content-type it owns and passes everything else through untouched.

Chapter 24 asks a related but different question: once a request reaches the server over HTTP/2, is HTTP/3 worth reaching for next — and what, precisely, "gRPC over HTTP/3" does and does not mean today.

---

## On the wire

The JSON/HTTP transcoding call:

```bash
curl -s -X POST localhost:10230/shipping.routing.v1.RoutingService/GetQuote \
  -H 'content-type: application/json' \
  -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}'
```

```json
{"quote":{"currency":"USD","amount":"2500.00"},"route":{"id":"rte_USNYC-NLRTM","legs":[{"carrier":"MAERSK","origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}]}}
```

Notice the URL: `/shipping.routing.v1.RoutingService/GetQuote`, not something cleaner like `/v1/quotes`. That shape is `auto_mapping`'s doing — it reuses gRPC's own `/<package>.<Service>/<Method>` addressing rather than inventing REST-style resource paths, because it has no other information to go on. A `google.api.http` annotation on the proto itself — `option (google.api.http) = { post: "/v1/quotes" body: "*" };` on the `GetQuote` RPC — would give Envoy an explicit, readable URL to map instead, and is the standard mechanism Google's own APIs use for exactly this. This book does not wire one in: doing so means importing `google/api/annotations.proto` into `routing.proto`, which pulls a `googleapis` dependency into `contracts/`'s `buf.yaml` and, from there, into every single example's protoc/buf build across every chapter in this book — Chapter 1 through Chapter 22's examples included — for a URL-prettiness improvement that benefits only this one chapter. The teaching point survives either way: `auto_mapping` is what a schema can give with no additional code; a `google.api.http` annotation is what a human has to add on top, chapter by chapter, RPC by RPC, in exchange for a cleaner URL.

The grpc-web call, decoded:

```bash
docker compose run --rm --entrypoint python python -m app.grpcweb_client envoy-quarkus:10000
```

```json
{"quote": {"currency": "USD", "amount": "2500.00"}, "route": {"id": "rte_USNYC-NLRTM", "legs": [{"carrier": "MAERSK", "origin": {"unLocode": "USNYC"}, "destination": {"unLocode": "NLRTM"}}]}}
```

Same URL, same RPC, same answer — the only difference from the JSON call above is the request's `content-type` (`application/grpc-web+proto` instead of `application/json`) and the 5-byte frame wrapped around the serialized protobuf bytes instead of a JSON object. `verify.sh` asserts these exact fields — `quote.currency`, `quote.amount`, `route.id`, `route.legs[0].carrier` — from all four paths, on both stacks, before printing `PASS`.

---

*Verification status: <span class="status status--verified">verified</span>.
`./verify.sh` was run end to end against a real Docker Engine: both app
stacks and both Envoy containers built and started, and native gRPC, the
REST shim, the JSON/HTTP transcoder, and the grpc-web filter all returned the
expected quote on both the Quarkus and the Python stack, including the
non-fatal malformed-JSON -> HTTP 400 check.*
