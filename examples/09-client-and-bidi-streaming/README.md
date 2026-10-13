# Ch9 — Client-streaming and bidirectional: TrackingService.{ReportPositions,Sync}

The reference both-stack implementation of `shipping.tracking.v1.TrackingService`'s
two remaining RPC shapes — client streaming and bidirectional streaming. The
contract — not either codebase — is the source of truth:

- `contracts/proto/shipping/tracking/v1/tracking.proto` — `TrackingService`
  and its three RPCs. This example implements `ReportPositions` (client
  streaming) and `Sync` (bidirectional); `WatchShipment` (server streaming,
  Ch8's RPC) returns `UNIMPLEMENTED` here, kept out of scope so this chapter
  registers one service and builds reliably on both stacks.
- `contracts/proto/shipping/type/v1/types.proto` — the shared `TrackingEvent`
  payload the request/response messages carry.

Quarkus (`quarkus/`, host port 9090) and Python (`python/`, host port 9091)
independently implement both RPCs identically, generated from the **same**
`.proto` files. `verify.sh` drives **both** stacks over `grpcurl`'s stream
support (`-d @`, reading newline-delimited JSON request messages from
stdin) and asserts **response field semantics** — the folded count, the
number of streamed responses — not just a gRPC `OK` status.

## Run it

```bash
cd examples/09-client-and-bidi-streaming
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, sends a 3-message client stream to
`ReportPositions` and a 2-message bidirectional stream to `Sync` against
`localhost:9090` (Quarkus) and `localhost:9091` (Python), asserts the
responses below, and tears the stack down again. Prints `PASS` only if
every assertion holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build

# Client streaming: 3 requests in, 1 response out.
printf '%s\n' \
  '{"event":{"bookingId":"bkg_demo","note":"p1"}}' \
  '{"event":{"bookingId":"bkg_demo","note":"p2"}}' \
  '{"event":{"bookingId":"bkg_demo","note":"p3"}}' \
  | grpcurl -plaintext -d @ localhost:9090 shipping.tracking.v1.TrackingService/ReportPositions

# Bidirectional: 2 requests in, 2 responses out, one per request.
printf '%s\n' \
  '{"event":{"bookingId":"bkg_demo","note":"s1"}}' \
  '{"event":{"bookingId":"bkg_demo","note":"s2"}}' \
  | grpcurl -plaintext -d @ localhost:9090 shipping.tracking.v1.TrackingService/Sync

docker compose down -v
```

Swap `9090` for `9091` to hit the Python stack instead — same requests, same
response shapes, same counts.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `ReportPositions`/`Sync` fine without a collector;
export failures are async and never block a response):

```bash
docker compose --profile observability up --build
```

## The message formulas

Both RPCs are implemented identically on both stacks:

```
ReportPositionsResponse.accepted_count = count(ReportPositionsRequest messages received)
SyncResponse.event (per response)      = SyncRequest.event (of the matching request, same order)
```

`ReportPositions` buffers nothing but a count: the server reads the
client's stream to exhaustion (the client's half-close is the signal that
no more requests are coming) and then sends exactly one
`ReportPositionsResponse`. `Sync` buffers nothing at all: each
`SyncResponse` goes out as soon as its matching `SyncRequest` arrives,
preserving arrival order, so N requests in produce N responses out in the
same order — proven by `verify.sh`'s `json_stream_count` assertion.

## The other RPC

`TrackingService` declares three RPCs; this example implements two:

| RPC | Status in this example |
|---|---|
| `WatchShipment` (server streaming) | `UNIMPLEMENTED` — Ch8's RPC |
| `ReportPositions` (client streaming) | implemented (this chapter) |
| `Sync` (bidirectional) | implemented (this chapter) |

On Quarkus, the generated Mutiny `TrackingService` interface declares all
three RPCs as abstract methods, so `TrackingServiceImpl` implements all
three explicitly — `watchShipment` just returns
`Multi.createFrom().failure(Status.UNIMPLEMENTED...)`. On Python, the
generated `TrackingServiceServicer` base class already sets `UNIMPLEMENTED`
and raises for any method a subclass doesn't override, so the Python side
only defines `ReportPositions` and `Sync` — `WatchShipment` falls through
to that generated default (the same pattern Ch5/Ch7's `RoutingServiceServicer`
uses for its own unimplemented methods).

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) specifically so it can `COPY` the two proto files this
service needs straight from `contracts/proto/` at build time — the same
mechanics `examples/05-contract-first` established:

- **Quarkus**: the Containerfile copies `types.proto` and `tracking.proto`
  into `src/main/proto/shipping/{type,tracking}/v1/` inside the build
  stage. The module's `pom.xml` declares `<packaging>quarkus</packaging>`,
  which binds the `quarkus-grpc` extension's proto-to-Mutiny code
  generation to the `generate-sources` phase, before `compile` runs.
- **Python**: the Containerfile copies the same two files into a `proto/`
  staging directory, then runs
  `python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated ...`
  to produce `generated/shipping/{type,tracking}/v1/*_pb2{,_grpc}.py`, which
  `PYTHONPATH=/app/generated:/app` makes importable as
  `from shipping.tracking.v1 import tracking_pb2`. `grpcio-tools` lives in a
  `dev` dependency group and never ships in the runtime image.

For a local, non-container `mvn`/`uv` run, copy the same two files into the
same two destinations by hand first:

```bash
# Quarkus
mkdir -p quarkus/src/main/proto/shipping/{type,tracking}/v1
cp ../../contracts/proto/shipping/type/v1/types.proto       quarkus/src/main/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/tracking/v1/tracking.proto quarkus/src/main/proto/shipping/tracking/v1/

# Python
mkdir -p python/proto/shipping/{type,tracking}/v1 python/generated
cp ../../contracts/proto/shipping/type/v1/types.proto        python/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/tracking/v1/tracking.proto python/proto/shipping/tracking/v1/
cd python && uv sync --group dev && \
  .venv/bin/python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated \
    proto/shipping/type/v1/types.proto proto/shipping/tracking/v1/tracking.proto
```

Both copy destinations (`quarkus/src/main/proto/`, `python/generated/`,
`python/proto/`) are gitignored (see `../.gitignore`) — they are
build-time-only, never committed.

## On the wire

Server reflection is enabled on both stacks (`enable-reflection-service=true`
on Quarkus; `grpc_reflection.v1alpha.reflection` on Python), so `grpcurl`
needs no local `.proto` copy:

```bash
grpcurl -plaintext localhost:9090 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.tracking.v1.TrackingService

grpcurl -plaintext localhost:9090 describe shipping.tracking.v1.TrackingService
```

`verify.sh` asserts these exact responses:

| Call | Expected |
|---|---|
| `ReportPositions` (3 requests) | one response, `accepted_count` = `3` |
| `Sync` (2 requests) | 2 streamed responses, one per request |

grpcurl's JSON output uses the proto's original (snake_case) field names,
not camelCase — `accepted_count`, not `acceptedCount` — which is why the
assertion reads `.accepted_count`.

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show the two services sharing one `Multi`
inbound stream each: `ReportPositions` collects it into one outbound
`Uni`/single response, `Sync` maps it 1:1 into an outbound stream, both
built from one proto and one `TrackingService` registration per stack.
