# Ch23 — grpc-web & JSON/HTTP transcoding: one RPC, three doors in

The reference both-stack implementation of Envoy's `grpc_json_transcoder` and
`grpc_web` filters sitting in front of the exact same `RoutingService.GetQuote`
every prior chapter calls — plus the hand-written REST shim from Chapter 21,
kept here so all three paths are visible side by side:

- `contracts/proto/shipping/routing/v1/routing.proto` — `RoutingService.GetQuote`,
  reached FOUR ways in this chapter.
- `contracts/proto/shipping/quote/v1/quote.proto` — `QuoteService.GetQuote`,
  the DOWNSTREAM call `RoutingService.GetQuote` makes (the Ch21/Ch10 loopback
  shape, unchanged).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages (same as every prior chapter).

**No contract change anywhere in this chapter.** No `google.api.http`
annotation, no new proto field, no new `.proto` import beyond what
`routing.proto` already imports (`google/protobuf/field_mask.proto`) and
`types.proto` already imports (`google/protobuf/timestamp.proto`). `git diff
main -- contracts/` is empty. Everything new in this chapter lives in front of
the server — in Envoy — not inside it.

## The four doors

Quarkus (`quarkus/`, gRPC port 9230, REST port 8230, Envoy port 10230) and
Python (`python/`, gRPC port 9231, REST port 8231, Envoy port 10231) each run
the **same app as Chapter 21**: one process implementing both
`RoutingService` and `QuoteService` (`RoutingServiceImpl`/`RoutingServiceServicer`
calls `QuoteServiceImpl`/`QuoteServiceServicer` over a loopback channel), plus
the `POST /booking/quote` REST shim. Nothing in that app changed for this
chapter — the only new thing is **one Envoy container per stack**
(`envoy-quarkus`, `envoy-python`), each with its own static config and its own
baked-in proto descriptor, both built from `envoy/Containerfile`.

`RoutingService.GetQuote` is reachable four ways, all converging on the
identical generated service method:

1. **Native gRPC** — `grpcurl` with server reflection, straight to the app's
   own gRPC port (9230/9231). No proxy involved.
2. **The hand-written REST shim** (the Ch21 booking seam) —
   `POST /booking/quote` (8230/8231), a human-written handler that knows this
   one request/response JSON shape and translates it into a `GetQuoteRequest`
   by hand.
3. **Envoy's `grpc_json_transcoder`** — a plain JSON `POST` to the
   RPC-shaped URL, `/shipping.routing.v1.RoutingService/GetQuote`
   (10230/10231), decoded against a `FileDescriptorSet` baked into the Envoy
   image at build time. No hand-written mapping code exists anywhere for
   this path — Envoy derives the JSON shape from the proto alone.
4. **Envoy's `grpc_web` filter** — the same URL, framed as `grpc-web`
   (`content-type: application/grpc-web+proto`) instead of plain JSON. This
   example drives it with `python/app/grpcweb_client.py`, a deterministic
   stand-in for a browser's `grpc-web` JavaScript client (see "Why a
   deterministic client, not a browser" below).

All four return the identical quote for the same request: `USD 2500.00` for
1000kg from `USNYC` to `NLRTM`, route `rte_USNYC-NLRTM`, carrier `MAERSK` —
the same formula every prior anchor chapter uses.

## Run it

```bash
cd examples/23-grpc-web-transcoding
./verify.sh
```

`verify.sh`:

1. Brings up both app stacks and both Envoy containers (`docker compose up
   --build`; LGTM stays opt-in — see "Observability" below).
2. Against **each** stack, asserts all four paths return the SAME
   `quote.currency`, `quote.amount`, `route.id`, and
   `route.legs[0].carrier`:
   - Native gRPC via `grpcurl` (reflection).
   - The REST shim via `curl -X POST .../booking/quote`.
   - The JSON/HTTP transcoder via `curl -X POST
     .../shipping.routing.v1.RoutingService/GetQuote -H 'content-type:
     application/json'`.
   - grpc-web via `docker compose run --rm --entrypoint python python -m
     app.grpcweb_client <envoy-service>:10000`.
3. (Non-fatal, illustrative) feeds malformed JSON to the transcoder and
   checks for an HTTP 4xx via `convert_grpc_status` — logged as a warning,
   never fails the build, since the exact status code Envoy chooses for a
   parse failure isn't a contract this chapter gates on.

Prints `PASS` only if every hard assertion holds for both stacks.

To poke at it by hand instead:

```bash
docker compose up --build

# 1. Native gRPC
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}' \
  localhost:9230 shipping.routing.v1.RoutingService/GetQuote

# 2. The REST shim
curl -s -X POST localhost:8230/booking/quote -H 'content-type: application/json' \
  -d '{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}' | python3 -m json.tool

# 3. Envoy's JSON/HTTP transcoder — same RPC, no hand-written mapping code
curl -s -X POST localhost:10230/shipping.routing.v1.RoutingService/GetQuote \
  -H 'content-type: application/json' \
  -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}' | python3 -m json.tool

# 4. Envoy's grpc-web filter, driven by the deterministic client
docker compose run --rm --entrypoint python python -m app.grpcweb_client envoy-quarkus:10000

docker compose down -v
```

Swap `8230`/`9230`/`10230` for `8231`/`9231`/`10231` to hit the Python stack —
identical request, identical formula, identical result shape.

## Why a deterministic client, not a browser

A real browser-side `grpc-web` call needs the `grpc-web` npm package (or a
code-generated TypeScript client) running inside a page served to an actual
browser — nothing a CI job can drive headlessly without a browser automation
layer that has nothing to do with this chapter's subject. `grpcweb_client.py`
exists to prove the SAME wire mechanics a real browser client uses — the
5-byte grpc-web frame header, the `application/grpc-web+proto` content-type,
unwrapping the response's trailer frame — using only the Python standard
library and this module's own generated protobuf stubs. It performs the
exact bytes-on-the-wire exchange `grpc-web`-in-a-browser would, against the
exact same Envoy `grpc_web` filter a browser would hit. The chapter shows a
browser-side snippet for illustration; this client is what CI runs.

## How the pieces fit together

**The app containers (`quarkus/`, `python/`)** are unchanged from Chapter 21
in every way that matters to this chapter: same `RoutingServiceImpl`/
`RoutingServiceServicer`, same loopback call to `QuoteServiceImpl`/
`QuoteServiceServicer`, same `BookingResource`/`booking_quote` REST shim.
Dropped relative to Ch21: the Micrometer/Prometheus metrics dependency and
the response `traceId` field — this chapter is not about observability, and
the Grafana LGTM stack stays opt-in (`--profile observability`) rather than
the always-on stack Ch21 wires. `quarkus.grpc.server.enable-reflection-service`
stays `true` (needed for the grpcurl-driven native path); this is unrelated
to Envoy's transcoder, which never talks to the app's reflection service —
it reads its own baked-in descriptor instead.

**`envoy/Containerfile`** is a two-stage build:

1. **Descriptor stage** (`docker.io/bufbuild/buf:1.73.0`) — `COPY`s
   `contracts/proto` into the build context and runs `buf build ./proto -o
   /descriptor.binpb`. Confirmed at authoring time (`buf build` applied
   directly against this repo's `contracts/proto/`, then the resulting
   `FileDescriptorSet` inspected): the output contains not just
   `routing.proto`, `quote.proto`, and `types.proto`, but their transitive
   imports too — `google/protobuf/field_mask.proto` (from `routing.proto`)
   and `google/protobuf/timestamp.proto` (from `types.proto`). This matters
   because `grpc_json_transcoder` needs the FULL dependency closure to
   resolve every field's type, not just the two files it's told to serve —
   a descriptor built without `--include-imports` (the `protoc` flag;
   `buf build`'s default output already includes them) would fail to decode
   any message with a `Timestamp` or `FieldMask` field.
2. **Runtime stage** (`docker.io/envoyproxy/envoy:distroless-v1.40.0`) —
   `COPY`s the descriptor plus one of two static configs
   (`envoy-quarkus.yaml` / `envoy-python.yaml`, selected by the
   `ENVOY_CONFIG` build arg `../compose.yaml` passes per service) to
   `/etc/envoy/`. The distroless image's own `ENTRYPOINT`/`CMD` (`envoy -c
   /etc/envoy/envoy.yaml`, running as the image's built-in nonroot UID
   65532) is left untouched — this Containerfile only supplies the two files
   that command already expects at that path.

**`envoy/envoy-quarkus.yaml` / `envoy/envoy-python.yaml`** are identical
except for one line — the upstream cluster's address (`quarkus:9000` vs.
`python:9000`). They're two static files rather than one templated file
because the distroless runtime image has no shell to run a template engine
against at container start. Each config runs ONE filter chain on listener
`10000`:

```
envoy.filters.http.grpc_web            # content-type application/grpc-web+proto -> application/grpc
envoy.filters.http.grpc_json_transcoder # content-type application/json -> application/grpc, via the descriptor
envoy.filters.http.router              # forwards the now-native-gRPC call to the "app" cluster (HTTP/2)
```

A request that's already native gRPC-shaped (because `grpc_web` just
converted it) passes through `grpc_json_transcoder` untouched — that filter
only acts on non-`application/grpc` content types. A plain JSON request never
touches `grpc_web` at all, for the same reason in reverse. Both paths land on
the same `router` filter and the same upstream `app` cluster, configured with
`http2_protocol_options` so the connection to the app is real HTTP/2 gRPC,
never HTTP/1.1.

**`python/app/grpcweb_client.py`** is the only new application code in this
chapter. See "Why a deterministic client, not a browser" above for
what it does and why; see the chapter's "How the code works" section for the
framing format itself.

## Proto code generation: `contracts/` is the only source of truth

Same pattern as every prior chapter — now feeding THREE build pipelines
instead of two: the Quarkus app's Maven build, the Python app's `protoc`
generation, AND Envoy's descriptor build, all COPYing the identical three
proto files from `contracts/proto/` at image-build time. Neither module
commits generated, copied, or compiled proto artifacts (see `.gitignore`).
For a local, non-container run of the app code:

```bash
# Quarkus
mkdir -p quarkus/src/main/proto/shipping/{type,routing,quote}/v1
cp ../../contracts/proto/shipping/type/v1/types.proto      quarkus/src/main/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto quarkus/src/main/proto/shipping/routing/v1/
cp ../../contracts/proto/shipping/quote/v1/quote.proto     quarkus/src/main/proto/shipping/quote/v1/

# Python
mkdir -p python/proto/shipping/{type,routing,quote}/v1 python/generated
cp ../../contracts/proto/shipping/type/v1/types.proto      python/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto python/proto/shipping/routing/v1/
cp ../../contracts/proto/shipping/quote/v1/quote.proto     python/proto/shipping/quote/v1/
cd python && uv sync --group dev && \
  .venv/bin/python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated \
    proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto proto/shipping/quote/v1/quote.proto

# Envoy's descriptor (what a reader would build by hand outside Docker)
buf build ../../contracts/proto -o /tmp/descriptor.binpb
```

## Observability (opt-in, not this chapter's point)

```bash
docker compose --profile observability up --build
```

Brings up the same `grafana/otel-lgtm` image every opt-in chapter uses. Both
apps export OTLP traces when `OTEL_EXPORTER_OTLP_ENDPOINT` resolves; with the
profile off (the default), the exporter just logs failed exports in the
background and every other path in this chapter works exactly the same.

## Diagrams

Three figures (`assets/diagrams/23-*`, generated with
`scripts/generate_diagram.py`):

- `23-grpc-web-transcoding-seam` — a browser (grpc-web) and a JSON/HTTP
  client both arrive at one Envoy listener running `grpc_web` and
  `grpc_json_transcoder`; the REST booking shim calls `GetQuote` natively,
  bypassing Envoy entirely; all three converge on the same
  `RoutingService.GetQuote`.
- `23-three-ways-to-reach-grpc` — three columns (the REST shim, the JSON
  transcoder, grpc-web): what each needs, its URL and content-type, and who
  it's for.
- `23-grpc-web-framing` — native gRPC's HTTP/2 HEADERS/DATA/HEADERS-trailer
  framing, contrasted with grpc-web's DATA-then-TRAILER frames packed into
  one HTTP/1.1 response body, and why a browser's `fetch`/`XHR` can't just
  open a native gRPC channel.

## Verification status

**Verified.** `./verify.sh` was run end to end against a real Docker Engine:
both app stacks and both Envoy containers built and started, and all four
paths (native gRPC, REST shim, JSON/HTTP transcoder, grpc-web) returned the
expected quote on both the Quarkus and the Python stack. The non-fatal
malformed-JSON check also passed (HTTP 400 via `convert_grpc_status`) on both
stacks in that run.
