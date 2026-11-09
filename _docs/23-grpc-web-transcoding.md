---
title: "gRPC-Web and JSON transcoding"
order: 23
part: "Browsers, Transcoding & Cross-Protocol"
description: "A browser can't speak native gRPC. Envoy's grpc_web and grpc_json_transcoder filters close the gap from one descriptor, and a hand-written REST shim is the third door."
duration: "24 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why a browser's `fetch()` and `XMLHttpRequest` can't speak native gRPC (no raw HTTP/2 frame control, no trailer API) and which gap grpc-web and JSON transcoding each close.
- Configure Envoy's `grpc_web` and `grpc_json_transcoder` filters from one build-time `FileDescriptorSet`, including the transitive well-known-type imports.
- Decode a grpc-web response by hand: the 5-byte length-prefixed data frame and the high-bit trailer frame carrying `grpc-status` and `grpc-message`.
- Choose between a hand-written REST shim, `auto_mapping` JSON transcoding and grpc-web for a given caller.

## Why this matters

A gRPC client holds one long-lived HTTP/2 channel and reuses it. A browser can't. `fetch()` and `XMLHttpRequest` can't open a raw HTTP/2 stream, can't send gRPC's binary length-prefixed frames, and can't read the HTTP/2 trailers that carry the final status. That is three gaps, not one.

`RoutingService` doesn't change to close them. A proxy in front of the same server does, and it has to serve more than browsers: scripts and internal tools want plain JSON over HTTP. Envoy is that proxy here, built once per stack, and `GetQuote` is reachable four ways.

{% include excalidraw.html file="23-grpc-web-transcoding-seam" alt="A browser running a grpc-web client and a JSON or HTTP client both send requests to one Envoy listener running a grpc_web filter and a grpc_json_transcoder filter. A separate REST booking service sends a request directly, bypassing Envoy. All three arrows converge on one box labeled RoutingService.GetQuote, native gRPC, port 9000." caption="Figure 23.1: three doors, one RPC. A browser and a JSON client arrive through Envoy's grpc_web and grpc_json_transcoder filters; the hand-written REST shim calls GetQuote directly." %}

## The browser problem

A unary gRPC call is one HTTP/2 stream:

1. A HEADERS frame carries the method and metadata.
2. DATA frames each hold a 1-byte compression flag, a 4-byte big-endian length and a serialized protobuf message.
3. A final HEADERS frame, sent as HTTP/2 trailers after the body, carries `grpc-status` and `grpc-message`.

Producing that requires control of the stream: frame types, raw bytes, and trailers that arrive after the body. A browser's networking API offers a request, a status code, headers before the body and a body read as text, JSON or bytes. The Fetch spec exposes no trailers, and nothing accepts a raw frame. Trailers exist for exactly what gRPC uses them for, a status known only after the body streams out, and browsers don't surface them to page script.

Two fixes serve two audiences:

| | grpc-web | JSON transcoding |
|---|---|---|
| Wire format | Length-prefixed protobuf frames, with the trailer repacked as a second frame in the body | A URL, an HTTP verb and a JSON body |
| Caller speaks | A grpc-web client library | Plain HTTP and JSON |
| Content type | `application/grpc-web+proto` | `application/json` |
| Closes the gap by | Moving the trailer into the body, so no HTTP/2 trailer API is needed | Hiding gRPC from the caller entirely |

The third door predates both. `BookingResource` and `booking_quote` are REST endpoints written for one RPC by someone who maps a `BookingQuoteRequest` onto `GetQuoteRequest` field by field. That works, and it stays running next to the two new paths. It doesn't generalize: every new RPC needs its own handler in every language. The two Envoy filters remove that per-RPC, per-language cost.

## Envoy filters, one descriptor

Both mechanisms are filters in Envoy's HTTP connection manager, not application code. Both read the same input: a `FileDescriptorSet`, a binary snapshot of the proto schema, built once at image-build time and baked into the Envoy image.

```dockerfile
FROM docker.io/bufbuild/buf:1.73.0 AS descriptor

WORKDIR /work
COPY contracts/proto ./proto
RUN buf build ./proto -o /descriptor.binpb
```

`buf build` resolves every import and writes one self-contained file. The descriptor must include the transitive imports, `google/protobuf/field_mask.proto` (imported by `routing.proto`) and `google/protobuf/timestamp.proto` (imported by `types.proto`). `grpc_json_transcoder` has to resolve every field of every message it transcodes, so a `Timestamp` or `FieldMask` anywhere in the schema means those well-known types must be present, not just the `shipping/*` files.

The runtime stage copies the descriptor and one of two static configs into a distroless Envoy image:

```dockerfile
FROM docker.io/envoyproxy/envoy:distroless-v1.40.0

ARG ENVOY_CONFIG=envoy-quarkus.yaml

COPY --from=descriptor --chown=65532:65532 /descriptor.binpb /etc/envoy/descriptor.binpb
COPY --chown=65532:65532 examples/23-grpc-web-transcoding/envoy/${ENVOY_CONFIG} /etc/envoy/envoy.yaml
```

The base image's default command already runs `envoy -c /etc/envoy/envoy.yaml` as a nonroot user. The Compose file builds this one Containerfile twice, with a different `ENVOY_CONFIG` each time. The configs differ only in the upstream address, `quarkus:9000` or `python:9000`. They are two files rather than one template because the distroless image has no shell to render a template at start.

The transcoder is the filter doing the work:

```yaml
                  - name: envoy.filters.http.grpc_json_transcoder
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.grpc_json_transcoder.v3.GrpcJsonTranscoder
                      proto_descriptor: /etc/envoy/descriptor.binpb
                      services:
                        - shipping.routing.v1.RoutingService
                      auto_mapping: true
                      convert_grpc_status: true
                      print_options:
                        add_whitespace: false
                        always_print_primitive_fields: true
```

- `services` names only `RoutingService`. Nothing outside the process calls `QuoteService`.
- `auto_mapping: true` derives a mapping for every method on the service: `POST /<package>.<Service>/<Method>`, with the whole JSON body bound to the request message. Without it, each RPC needs an explicit `google.api.http` rule.
- `convert_grpc_status: true` turns gRPC status codes into HTTP ones: `INVALID_ARGUMENT` becomes 400, `NOT_FOUND` becomes 404.

Each listener runs the same chain: `grpc_web`, then `grpc_json_transcoder`, then `router`, which forwards to the app cluster over HTTP/2. Both filters see every request and each acts only on its own content type. A JSON request passes `grpc_web` untouched and is decoded by the transcoder into a native gRPC call. A request with `application/grpc-web+proto` is unwrapped by `grpc_web` into `application/grpc`, which the transcoder then ignores. The content type is the only coordination between them, and the router sees native gRPC over HTTP/2 whichever door the request used.

### The URL

Transcoding without annotations exposes `/shipping.routing.v1.RoutingService/GetQuote`, not `/v1/quotes`. `auto_mapping` has nothing else to go on, so it reuses gRPC's own addressing. A `google.api.http` option on the RPC, such as `post: "/v1/quotes" body: "*"`, gives Envoy a readable URL, and it is the standard mechanism Google's own APIs use. It also means importing `google/api/annotations.proto` into the shared proto, which adds a `googleapis` dependency to the contracts and to every other example's build. Here the schema stays as it is and the annotation is skipped.

## grpc-web by hand

The client in `python/app/grpcweb_client.py` performs the exact bytes a browser's grpc-web library would send and parses the exact bytes it would receive, with only the standard library's `urllib` and the generated stubs. That makes it runnable in CI with no browser. A request frame is a flag byte, always `0x00` for an uncompressed message, then the length as a 4-byte unsigned big-endian integer:

```python
def frame(message: bytes) -> bytes:
    """Prepend the 5-byte grpc-web frame header to a serialized protobuf
    message: flag 0x00 (uncompressed DATA frame) + the message's length as a
    4-byte unsigned big-endian integer."""
    return struct.pack(">BI", 0x00, len(message)) + message
```

A response carries two frames. The first holds the serialized `GetQuoteResponse`. The second has the high bit set in its flag byte (`0x80`), marking it as the trailer, and its payload is `key: value\r\n` text with `grpc-status` and `grpc-message`. That is the HTTP/2 trailer a browser can't read, moved into the body. The client splits the body into `(flag, payload)` frames and rejects a truncated header or payload:

```python
def _unframe_all(body: bytes) -> list[tuple[int, bytes]]:
    """Split a grpc-web response body into its (flag, payload) frames. A
    response normally carries exactly one DATA frame (the message) followed
    by exactly one TRAILER frame (the final grpc-status/grpc-message, encoded
    as HTTP/1.1-style `key: value\\r\\n` text instead of real HTTP/2
    trailers, which is the whole reason grpc-web needs its own framing instead of
    riding on native gRPC's)."""
    frames: list[tuple[int, bytes]] = []
    offset = 0
    while offset < len(body):
        if len(body) - offset < _FRAME_HEADER_LEN:
            raise ValueError(f"truncated grpc-web frame header at offset {offset}")
        flag, length = struct.unpack(">BI", body[offset : offset + _FRAME_HEADER_LEN])
        offset += _FRAME_HEADER_LEN
        payload = body[offset : offset + length]
        if len(payload) != length:
            raise ValueError(f"truncated grpc-web frame payload at offset {offset}: "
                              f"wanted {length} bytes, got {len(payload)}")
        offset += length
        frames.append((flag, payload))
    return frames
```

A grpc-web proxy answers `200 OK` at the HTTP layer even when the RPC failed, so the client checks the trailer's `grpc-status` before trusting the message. The real outcome is in the trailer, as it is in a native HTTP/2 trailer.

{% include excalidraw.html file="23-grpc-web-framing" alt="Native gRPC over HTTP/2 uses a HEADERS frame, one or more DATA frames, and a trailing HEADERS frame for the final status. grpc-web over HTTP/1.1 packs a DATA frame and a TRAILER frame into one ordinary response body, because a browser's fetch or XHR API cannot read HTTP/2 trailers or open a raw HTTP/2 stream." caption="Figure 23.3: why a browser cannot just dial native gRPC, and what grpc-web does instead." %}

## Choosing a door

{% include excalidraw.html file="23-three-ways-to-reach-grpc" alt="Three columns compare the hand-written REST shim, Envoy's JSON transcoder, and Envoy's grpc-web filter: what each needs, its request URL and content-type, and who it is meant for." caption="Figure 23.2: the same RPC, three different doors, with real trade-offs between them." %}

| Door | Use it when | Cost |
|---|---|---|
| Hand-written REST shim | An endpoint needs its own request and response shape (a booking form, a dashboard widget), or the team wants control over validation, field names and versioning independent of the proto | A handler per RPC, per language |
| `grpc_json_transcoder` | The caller is any ordinary JSON/HTTP client and the proto's shape is good enough to expose | An unreadable URL unless a `google.api.http` annotation is added |
| `grpc_web` | The caller is a browser and nothing else will do | More machinery than the transcoder, and no benefit for a caller not limited by `fetch()` and `XHR` |

> **🤖 Explore with your agent**
>
> "In `examples/23-grpc-web-transcoding`, read the `grpc_json_transcoder` block in `envoy/envoy-quarkus.yaml` and tell me which URL `auto_mapping` exposes for `RoutingService.ListRoutes`, then call it through Envoy on port 10230 with `curl -si`. Draft, but do not apply, a `google.api.http` option mapping `GetQuote` to `POST /v1/quotes`, list every file in `contracts/` and `examples/` that would have to change, and say which door a browser, a backend script and a booking form should each get."
>
> Check: the `curl -si` reply comes from the app (`ListRoutes` is unimplemented, so its gRPC status maps to an HTTP error) rather than an Envoy route miss, and the draft names `google/api/annotations.proto` and the `googleapis` dependency.

## Build, run, observe

```bash
cd examples/23-grpc-web-transcoding && ./verify.sh
```

The script brings up both stacks and both Envoy containers, then calls `GetQuote` four ways on each: native gRPC with `grpcurl`, the REST shim, JSON transcoding and grpc-web. Every path returns `USD 2500.00` for 1000 kg from `USNYC` to `NLRTM`, routed as `rte_USNYC-NLRTM` via `MAERSK`.

| Stack | gRPC | REST | Envoy |
|---|---|---|---|
| Quarkus | 9230 | 8230 | 10230 |
| Python | 9231 | 8231 | 10231 |

JSON transcoding:

```bash
curl -s -X POST localhost:10230/shipping.routing.v1.RoutingService/GetQuote \
  -H 'content-type: application/json' \
  -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}'
```

```json
{"quote":{"currency":"USD","amount":"2500.00"},"route":{"id":"rte_USNYC-NLRTM","legs":[{"carrier":"MAERSK","origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}]}}
```

grpc-web, decoded by the client:

```bash
docker compose run --rm --entrypoint python python -m app.grpcweb_client envoy-quarkus:10000
```

```json
{"quote": {"currency": "USD", "amount": "2500.00"}, "route": {"id": "rte_USNYC-NLRTM", "legs": [{"carrier": "MAERSK", "origin": {"unLocode": "USNYC"}, "destination": {"unLocode": "NLRTM"}}]}}
```

The grpc-web client runs inside the Compose network, so it targets the service name `envoy-quarkus:10000`, not the host-published port.

Same RPC, same answer: only the content type (`application/grpc-web+proto` instead of `application/json`) and the 5-byte frame around the protobuf differ. `grpcurl -plaintext localhost:9230 list` shows `shipping.routing.v1.RoutingService` from the app's own reflection, independent of Envoy, so the native schema can be compared with what the descriptor was built from.

Experiments:

- **Send malformed JSON to the transcoder.** `convert_grpc_status` answers with an HTTP 4xx instead of a gRPC code.
- **Rename a field in the app without rebuilding the Envoy image.** The transcoder and grpc-web paths fail or drop the field while native gRPC keeps working, which is the drift a build-time descriptor exists to surface early.

---

## For deeper coverage

- Cloud Native Design Patterns, "Appendix A: Protocols in Depth", for the REST, gRPC and GraphQL wire-format comparison this browser gap is one instance of.
- [grpc-web](https://github.com/grpc/grpc-web): the project and wire-framing spec the client implements by hand.
- [Envoy: gRPC-JSON transcoder filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/grpc_json_transcoder_filter) reference.
- [Google Cloud Endpoints: gRPC Transcoding](https://cloud.google.com/endpoints/docs/grpc/transcoding): the `google.api.http` annotation mechanism, explained in depth.
