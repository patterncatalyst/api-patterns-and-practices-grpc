# Ch17 — Streaming at scale: `TrackingService.WatchShipment` as a demand-driven feed

The reference both-stack implementation of
`shipping.tracking.v1.TrackingService.WatchShipment` serving a **demand-driven**
live feed instead of Chapter 8's fixed four-event list — the contract is
unchanged (zero contract changes this iteration; `WatchShipment` is the same
RPC Chapter 8 implemented), only *how* the server produces its events
changes. The contract — not either codebase — is the source of truth:

- `contracts/proto/shipping/tracking/v1/tracking.proto` — the
  `TrackingService` and its three RPCs (only `WatchShipment` is implemented
  here; `ReportPositions` and `Sync` return `UNIMPLEMENTED`, same as every
  prior chapter).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Location` and
  `BookingState` the events carry.

Quarkus (`quarkus/`, host port 9170) and Python (`python/`, host port 9171)
independently implement the identical RPC, generated from the **same**
`.proto` files. `verify.sh` calls `WatchShipment` on **both** stacks, runs the
bundled slow consumer against both, and asserts timing claims as well as
field semantics — not just a gRPC `OK` status.

## The three demo-only modes

`WatchShipmentRequest.booking_id` is a demo-only mode selector for this
example — it carries no domain meaning beyond picking a feed shape, the same
trick Chapter 15 used with `origin.name` to switch execution models without
touching the frozen contract:

| `booking_id` | Shape | What it demonstrates |
|---|---|---|
| `bkg_demo` (or any other/unset value) | 6 events, demand-driven, ~260ms apart | The headline case: nothing is built until the consumer is ready for it. |
| `bkg_eager` | The same 6 events, pre-materialized | The contrast: all 6 built and stamped in one tight loop before the first one streams, every `event.at` within microseconds of the others. |
| `bkg_quiet` | 2 events, demand-driven, ~2s gap | Keepalive: a stream that sits quiet for seconds and still delivers its final event. |

The 6-event sequence extends Chapter 8's `PENDING -> CONFIRMED -> IN_TRANSIT -> DELIVERED`
progression with two extra `IN_TRANSIT` waypoints (a second port call at
Rotterdam, then a transshipment leg through Hamburg) before the Singapore
delivery, so there's enough length to show a measurable production cadence:

| # | `state` | `location` | `note` |
|---|---|---|---|
| 0 | `BOOKING_STATE_PENDING` | USNYC (New York) | `seq=0` |
| 1 | `BOOKING_STATE_CONFIRMED` | USNYC (New York) | `seq=1` |
| 2 | `BOOKING_STATE_IN_TRANSIT` | NLRTM (Rotterdam) | `seq=2` |
| 3 | `BOOKING_STATE_IN_TRANSIT` | DEHAM (Hamburg) | `seq=3` |
| 4 | `BOOKING_STATE_IN_TRANSIT` | SGSIN (Singapore) | `seq=4` |
| 5 | `BOOKING_STATE_DELIVERED` | SGSIN (Singapore) | `seq=5` |

Unlike Chapter 8, `event.at` is **not** a fixed historical timestamp — it is
the server's real wall-clock instant at the moment that event was built, and
`event.note` is a bare `seq=<i>` marker rather than narrative text, so
`verify.sh` (and the bundled slow consumer) can read production order and
production time straight off the wire. `bkg_quiet` collapses straight from
`PENDING` to `DELIVERED` with no intermediate states — a simplification
specific to this demo-only mode, whose subject is the quiet gap, not a
realistic voyage.

### Why ~260ms, not ~150ms

A demand-driven producer paces itself independent of how fast any particular
consumer reads — that's the whole point of "demand-driven" rather than
"consumer-adaptive." This example's production cadence (260ms between
events) is picked to clear `verify.sh`'s own margins with room to spare: the
incremental-delivery check wants the whole 6-event `bkg_demo` stream to take
at least ~0.6s (5 gaps x 260ms ~= 1.3s), and the backpressure check wants
consecutive server-stamped `at` deltas of at least ~200ms (260ms clears that
with a comfortable buffer against container-to-container timing jitter).

## Run it

```bash
cd examples/17-streaming-at-scale
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, and against **each** of `localhost:9170`
(Quarkus) and `localhost:9171` (Python):

1. Reads `bkg_demo`'s full 6-event stream and asserts exact count, order, and
   per-event fields (state, location, `booking_id`, `note`).
2. Times that same call and asserts the whole stream took at least ~0.6s —
   proof the events arrived spread over time, not buffered and dumped.
3. **The headline check.** Runs the bundled slow consumer
   (`python/app/slow_consumer.py`, one read every ~300ms) against both
   `bkg_demo` and `bkg_eager`, parses the server-stamped `event.at` values
   each prints, and asserts: `bkg_demo`'s consecutive deltas are at least
   ~200ms (the demand-driven producer paces itself, comfortably inside what
   a ~300ms-per-read consumer can keep up with); `bkg_eager`'s deltas are
   all within microseconds of each other; and the relative gate
   `eager_spread * 3 < backpressure_spread` holds (the same shape as
   Chapter 15's starve-vs-scale check).
4. Reads `bkg_quiet` and asserts both events arrive — including the one
   after the ~2s gap — and the call's total elapsed time is at least ~1.9s,
   proving the gap was real and the stream wasn't dropped.
5. Confirms `ReportPositions` and `Sync` both answer `UNIMPLEMENTED`.

Prints `PASS` only if every assertion holds for **both** stacks. A real run
measured:

```
lib.sh: info — quarkus: slow_consumer vs bkg_demo: min_delta=0.2607s spread=1.3061s
lib.sh: ok — quarkus slow_consumer vs bkg_demo consecutive server-stamped at deltas (producer paced, not raced ahead): 0.2607s >= 0.2s
lib.sh: info — quarkus: slow_consumer vs bkg_eager: min_delta=4.05e-06s spread=7.89e-05s
lib.sh: ok — quarkus backpressure relative gate (eager_spread * 3 < backpressure_spread): 7.89e-05s * 3 < 1.3061s
```

To poke at it by hand instead:

```bash
docker compose up --build

# Demand-driven: 6 events, ~260ms apart.
grpcurl -plaintext -d '{"bookingId":"bkg_demo"}' \
  localhost:9170 shipping.tracking.v1.TrackingService/WatchShipment

# Eager: the same 6 events, all stamped within microseconds of each other.
grpcurl -plaintext -d '{"bookingId":"bkg_eager"}' \
  localhost:9170 shipping.tracking.v1.TrackingService/WatchShipment

# Quiet: 2 events, ~2s gap between them.
grpcurl -plaintext -d '{"bookingId":"bkg_quiet"}' \
  localhost:9170 shipping.tracking.v1.TrackingService/WatchShipment

# The bundled slow consumer, against either stack over the compose network
# (service name + container port 9000, not the host-mapped 9170/9171):
docker compose -p ch17-streaming run --rm python \
  python -m app.slow_consumer quarkus:9000 bkg_demo
docker compose -p ch17-streaming run --rm python \
  python -m app.slow_consumer python:9000 bkg_eager

docker compose down -v
```

Swap `9170` for `9171` (or `quarkus:9000` for `python:9000`) to hit the
Python stack instead — same requests, same modes, same numbers.

The Grafana LGTM observability stack is opt-in and off by default. Unlike
every other chapter's compose file, `OTEL_EXPORTER_OTLP_ENDPOINT` is **not**
hardcoded to the `lgtm` service's address here: this chapter's pacing is
timing-sensitive, and a hostname that fails DNS resolution (which `lgtm`
does whenever the `observability` profile is off) makes the OpenTelemetry
SDK's periodic batch span exporter block an event-loop thread for several
seconds per retry attempt — long enough to visibly disrupt the ~260ms
production cadence this example is built to demonstrate. Left unset, each
app's own default (`http://localhost:4317`) fails fast with a plain
connection-refused instead. To exercise the `observability` profile, pass
the endpoint explicitly so it resolves:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4317 \
  docker compose --profile observability up --build
```

## Server keepalive

Both stacks configure keepalive on their gRPC server, covered in depth in
`_docs/17-streaming-at-scale.md`'s "Keepalive on a long-lived stream"
section:

- **Quarkus** (`quarkus/src/main/resources/application.properties`):
  `quarkus.grpc.server.netty.keep-alive-time=30s`,
  `quarkus.grpc.server.netty.permit-keep-alive-time=10s`,
  `quarkus.grpc.server.netty.permit-keep-alive-without-calls=true`. These sit
  one level deeper than the top-level `quarkus.grpc.server.*` properties
  used elsewhere in this book — confirmed against the actual
  `io.quarkus:quarkus-grpc:3.40.1` jar
  (`GrpcServerConfiguration$GrpcServerNettyConfig`), which applies them to
  grpc-java's `NettyServerBuilder` under the default separate-server mode
  (`quarkus.grpc.server.use-separate-server=true`).
- **Python** (`python/app/main.py`): the equivalent four channel-argument
  options (`grpc.keepalive_time_ms`, `grpc.keepalive_timeout_ms`,
  `grpc.keepalive_permit_without_calls`,
  `grpc.http2.min_ping_interval_without_data_ms`) passed to
  `grpc.aio.server(options=...)`.

HTTP/2 flow-control window sizes and keepalive's survival against a real
middlebox's idle-connection reaping are illustrative only (see the chapter's
figures and "On the wire" box) — `verify.sh` never gates on either, since
neither is something a loopback compose network can exercise
deterministically.

## The demand-driven Multi, and a real timing subtlety

`quarkus/.../TrackingServiceImpl.java`'s `demandDrivenMulti` builds a `Multi`
from `Multi.createFrom().emitter(...)`, pacing each production step with
`Vertx.setTimer` (never a blocking sleep) and continuing to the next
waypoint only while `MultiEmitter.requested()` shows outstanding demand.
Getting this right against the *actual* generated `quarkus-grpc` bridge
surfaced a real subtlety: the bridge's subscriber calls
`Subscription.request(256)` (its fixed prefetch batch) during `onSubscribe`,
which happens *before* the `Multi.createFrom().emitter(...)` consumer lambda
— where `MultiEmitter.onRequest` gets registered — ever runs. That initial
`request(256)` still lands in `emitter.requested()`, but no `onRequest`
callback fires for it, since none was registered yet at the moment it
happened. The fix, visible in `demandDrivenMulti`, is a `maybeStart` check
run both immediately (to catch that already-landed prefetch demand) and on
every later `onRequest` call (to catch demand granted afterward). See the
chapter's "How the code works" section for the full walkthrough.

Python's async-generator equivalent
(`python/app/tracking_service.py`'s `_demand_driven_sequence`) needs no
equivalent fix: an `async def ... yield` generator is pull-based by
construction, with no separate demand-registration step to race against.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) so it can `COPY` the two proto files this service needs
straight from `contracts/proto/` at build time — the same mechanics every
prior chapter's example has used:

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

Both copy destinations are gitignored (see `.gitignore`) — build-time-only,
never committed.

## On the wire

Server reflection is enabled on both stacks:

```bash
grpcurl -plaintext localhost:9170 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.tracking.v1.TrackingService
```

See `_docs/17-streaming-at-scale.md`'s "On the wire" box for a sample
`bkg_demo` read with its ~260ms-apart `at` timestamps, and a note on where a
real HTTP/2 frame-level trace (`GODEBUG=http2debug=2`, or `grpcurl -v`) would
show the flow-control mechanics Figure 17.1 describes — illustrative only,
not something this example's `verify.sh` asserts on.

## Diagrams

Three paired figures in `assets/diagrams/` (generated with
`scripts/generate_diagram.py`), all embedded in the chapter:
`17-http2-flow-control-window` (per-stream and connection windows, and what
a stalled consumer does to them), `17-slow-consumer-backpressure`
(demand-paced vs. eager/buffered production, Mutiny demand vs.
async-generator pull side by side), and `17-keepalive-quiet-stream`
(keepalive PING/ACK holding a quiet stream open vs. an idle connection
reaped without it).

## Verification status

**Verified** by an actual run of `./verify.sh` against both stacks, built
and executed in this iteration — see `_docs/17-streaming-at-scale.md`'s
verification-status footer for the specific risk factors (timing margins on
different hardware, and the `MultiEmitter.onRequest` prefetch-timing detail
tied to the pinned `quarkus-grpc` 3.40.1 release) that a reader's own run
should confirm.
