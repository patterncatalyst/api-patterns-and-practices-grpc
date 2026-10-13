# Ch8 — Server-streaming: TrackingService.WatchShipment

The reference both-stack implementation of
`shipping.tracking.v1.TrackingService.WatchShipment` — one request, a stream
of `TrackingEvent` responses. The contract — not either codebase — is the
source of truth:

- `contracts/proto/shipping/tracking/v1/tracking.proto` — the
  `TrackingService` and its three RPCs (only `WatchShipment` is implemented
  here; `ReportPositions` and `Sync` land in Chapter 9 and return
  `UNIMPLEMENTED`).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Location` and
  `BookingState` the events carry.

Quarkus (`quarkus/`, host port 9080) and Python (`python/`, host port 9081)
independently implement the identical RPC, generated from the **same**
`.proto` files, streaming the same deterministic 4-event sequence for any
`bookingId`. `verify.sh` calls `WatchShipment` on **both** stacks via
`grpcurl` and asserts **event count, per-event field semantics, and
order** — not just a gRPC `OK` status.

## Run it

```bash
cd examples/08-server-streaming
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, calls `WatchShipment` against
`localhost:9080` (Quarkus) and `localhost:9081` (Python), asserts the
response stream below, confirms `ReportPositions`/`Sync` answer
`UNIMPLEMENTED`, and tears the stack down again. Prints `PASS` only if every
assertion holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build
grpcurl -plaintext localhost:9080 list                      # reflection: list services
grpcurl -plaintext -d '{"bookingId":"bkg_demo"}' \
  localhost:9080 shipping.tracking.v1.TrackingService/WatchShipment
docker compose down -v
```

`grpcurl` prints one JSON object per streamed message and keeps printing
until the server half-closes — there's no "give me N messages" flag,
because the RPC itself decides how many frames the stream carries. Swap
`9080` for `9081` to hit the Python stack instead — same request, same
4-event stream, same numbers.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `WatchShipment` fine without a collector; export
failures are async and never block the stream):

```bash
docker compose --profile observability up --build
```

## The event sequence

`WatchShipment` streams back the same 4 `TrackingEvent`s on both stacks, in
this exact order, regardless of the `bookingId` in the request (the request
only sets `event.booking_id`; every other field is fixed, so the stream is
reproducible run to run):

| # | `state` | `location` | `at` | `note` |
|---|---|---|---|---|
| 1 | `BOOKING_STATE_PENDING` | USNYC (New York) | `2026-01-02T08:00:00Z` | Booking accepted; container released to terminal |
| 2 | `BOOKING_STATE_CONFIRMED` | USNYC (New York) | `2026-01-02T14:00:00Z` | Export customs cleared; loaded onboard MAERSK vessel |
| 3 | `BOOKING_STATE_IN_TRANSIT` | NLRTM (Rotterdam) | `2026-01-15T09:30:00Z` | Vessel arrived at Rotterdam; awaiting discharge |
| 4 | `BOOKING_STATE_DELIVERED` | NLRTM (Rotterdam) | `2026-01-16T11:00:00Z` | Container discharged and delivered to consignee |

Both implementations build this sequence from the same fixed table
(`TrackingEvents.java` / `app/events.py`) rather than computing it from
wall-clock time or any external state, so the two stacks' streams are
byte-for-byte comparable on every run, not just independently plausible.
After the 4th event, the server ends the stream (half-close) — there is no
5th event and no trailing error.

## The other two RPCs

`TrackingService` declares three RPCs; only `WatchShipment` has a real
implementation here:

| RPC | Shape | Status in this chapter |
|---|---|---|
| `WatchShipment` | server-streaming | implemented (this chapter) |
| `ReportPositions` | client-streaming | `UNIMPLEMENTED` — Chapter 9 |
| `Sync` | bidirectional | `UNIMPLEMENTED` — Chapter 9 |

On Quarkus, the generated Mutiny `TrackingService` interface declares all
three RPCs as abstract methods, so `TrackingServiceImpl` implements all
three explicitly — the two unimplemented ones return
`Status.UNIMPLEMENTED.asRuntimeException()` without touching the client (or
bidirectional) stream they're handed. On Python, the generated
`TrackingServiceServicer` base class already sets `UNIMPLEMENTED` and raises
for any method a subclass doesn't override, so the Python side only defines
`WatchShipment` — the rest fall through to that generated default.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) specifically so it can `COPY` the two proto files this
service needs straight from `contracts/proto/` at build time — the same
mechanics Chapter 5's `05-contract-first` example established:

- **Quarkus**: the Containerfile copies `types.proto` and `tracking.proto`
  into `src/main/proto/shipping/{type,tracking}/v1/` inside the build stage,
  then runs `mvn package` with `<packaging>quarkus</packaging>` driving the
  `quarkus-grpc` extension's code generation before `compile`.
- **Python**: the Containerfile copies the same two files into a `proto/`
  staging directory, then runs
  `python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated ...`
  to produce `generated/shipping/{type,tracking}/v1/*_pb2{,_grpc}.py`, which
  `PYTHONPATH=/app/generated:/app` makes importable as
  `from shipping.tracking.v1 import tracking_pb2`.

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
`python/proto/`) are gitignored (see `./.gitignore`) — they are
build-time-only, never committed.

## On the wire

Server reflection is enabled on both stacks, so `grpcurl` needs no local
`.proto` copy:

```bash
grpcurl -plaintext localhost:9080 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.tracking.v1.TrackingService

grpcurl -plaintext localhost:9080 describe shipping.tracking.v1.TrackingService
```

`verify.sh` asserts, from `grpc_call`'s concatenated stream output, via
`json_stream_count`/`json_stream_field` (see `../_lib/lib.sh`):

| Check | Expected |
|---|---|
| stream length | `4` |
| `event[0].state` | `"BOOKING_STATE_PENDING"` |
| `event[0].booking_id` | `"bkg_demo"` |
| `event[0].location.un_locode` | `"USNYC"` |
| `event[1].state` | `"BOOKING_STATE_CONFIRMED"` |
| `event[2].state` | `"BOOKING_STATE_IN_TRANSIT"` |
| `event[2].location.un_locode` | `"NLRTM"` |
| `event[3].state` | `"BOOKING_STATE_DELIVERED"` |
| `event[3].booking_id` | `"bkg_demo"` |
| `ReportPositions`, `Sync` | gRPC status `UNIMPLEMENTED` |

grpcurl prints response field names using the proto's own snake_case names
(`booking_id`, `un_locode`) by default — not the lowerCamelCase JSON name
used on the way *in* for the request above (`bookingId`). Both spellings are
the same field; protojson accepts either on unmarshal but this grpcurl
build's marshaler emits the proto name on the way out.

for both `localhost:9080` and `localhost:9081` — same stream, same field
values, same order, from two independently generated implementations.

## Diagram

`architecture.svg` / `architecture.excalidraw` (generated with
`scripts/generate_diagram.py`) show the request/response topology for this
example: a client calling `WatchShipment` on each stack over its own port,
and the opt-in `otel-lgtm` sink. For the RPC's wire mechanics — one HTTP/2
stream, four ordered `TrackingEvent` frames, the server's half-close — see
Figure 8.1 in `_docs/08-server-streaming.md`.
