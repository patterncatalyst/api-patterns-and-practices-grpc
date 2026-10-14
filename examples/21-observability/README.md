# Ch21 — Observability ANCHOR: tracing, metrics, and health across the REST→gRPC seam

The reference both-stack implementation of OpenTelemetry tracing and
Micrometer/Prometheus metrics riding across a real REST-to-gRPC hop, plus a
built-in gRPC health check:

- `contracts/proto/shipping/routing/v1/routing.proto` — `RoutingService.GetQuote`,
  the gRPC call a REST handler makes.
- `contracts/proto/shipping/quote/v1/quote.proto` — `QuoteService.GetQuote`, the
  DOWNSTREAM call `RoutingService.GetQuote` makes (the Ch10 shape, minus the
  deadline plumbing — this chapter's point is tracing and metrics, not deadlines).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages (same as every prior chapter).

No contract change anywhere in this chapter: tracing and metrics ride
entirely in gRPC metadata and in the OTel/Micrometer SDKs' own machinery, and
health is served by the library's standard `grpc.health.v1.Health` — not a
single proto field moves.

Quarkus (`quarkus/`, gRPC port 9210, REST port 8210) and Python (`python/`,
gRPC port 9211, REST port 8211) each run **one process implementing both
services**, exactly like Ch10 — `RoutingServiceImpl`/`RoutingServiceServicer`
calls `QuoteServiceImpl`/`QuoteServiceServicer` over a loopback channel back
to the container's own gRPC port — PLUS a minimal REST endpoint,
`POST /booking/quote`, that calls `RoutingService.GetQuote` over its own
loopback channel.

## The experiment: one REST call, one trace, two logged handlers

`POST /booking/quote` is the one place in this example a client crosses the
REST→gRPC seam this book keeps returning to. OpenTelemetry's REST
instrumentation starts a span the moment the request arrives; its gRPC
instrumentation (server AND client) injects a W3C `traceparent` into the
outgoing `RoutingService.GetQuote` call's metadata automatically, and extracts
it automatically on the other end before `RoutingServiceImpl`/
`RoutingServiceServicer` runs; the same thing happens again one hop further
in, when `RoutingService.GetQuote` calls DOWNSTREAM `QuoteService.GetQuote`.
One REST request produces ONE trace with three spans — REST, `RoutingService`,
`QuoteService` — all sharing the same trace id, and NONE of that propagation
is application code: it is what `quarkus-opentelemetry` and
`opentelemetry-instrument` are for.

Both handlers log the trace id they're running under. `verify.sh`'s hard
assertion greps `docker compose logs` for that SAME trace id appearing in
BOTH the Routing handler's log line and the Quote handler's log line, inside
the SAME container — the strongest available proof, short of opening Tempo,
that the `traceparent` really crossed the loopback gRPC hop rather than two
independent, unrelated spans happening to run close together in time.

## Run it

```bash
cd examples/21-observability
./verify.sh
```

Unlike every prior chapter, the Grafana LGTM observability stack is **not**
opt-in here — this chapter's whole point is tracing, metrics, and health, so
`docker compose up` brings `lgtm` up by default alongside both app stacks.
`verify.sh`:

1. Brings the whole stack up (`quarkus`, `python`, `lgtm`) and waits for
   `lgtm`'s own health endpoint, budgeted for its cold start.
2. Against **each** of `localhost:9210`/`localhost:8210` (Quarkus) and
   `localhost:9211`/`localhost:8211` (Python):
   - **Functional (hard):** `POST /booking/quote` with
     `{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}` returns the
     Ch5/Ch10/Ch18/Ch20 quote formula's answer — `USD 2500.00`,
     `rte_USNYC-NLRTM`, carrier `MAERSK` — not just a `200`.
   - **Trace continuity (hard):** the response's `traceId` appears in a
     Routing-handler log line AND a Quote-handler log line in that stack's
     own `docker compose logs` output.
   - **Tempo ingestion (soft):** a bounded-retry poll of
     `http://localhost:3200/api/traces/<traceId>` looks for spans from at
     least two distinct service identifiers. Kept loose — Tempo's ingest
     has lag, and CI retries the whole script up to three times, so this
     check logs a warning rather than failing the build on its own.
   - **Metrics (hard):** that stack's OWN metrics endpoint (`/q/metrics` on
     Quarkus, `/metrics` on Python — never Mimir, so no scrape-interval wait)
     shows a gRPC server metric with a nonzero count.
   - **Health (hard):** `grpcurl -d '{"service":""}' ... grpc.health.v1.Health/Check`
     answers `{"status":"SERVING"}`.

Prints `PASS` only if every assertion holds for both stacks.

To poke at it by hand instead:

```bash
docker compose up --build

curl -s -X POST localhost:8210/booking/quote -H 'content-type: application/json' \
  -d '{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}' | python3 -m json.tool

docker compose logs quarkus | grep -E 'RoutingServiceImpl.GetQuote|QuoteServiceImpl.GetQuote'

open http://localhost:3000   # Grafana, anonymous admin — Explore -> Tempo -> paste the traceId
curl -s localhost:8210/q/metrics | grep grpc_server_processing_duration_seconds_count

grpcurl -plaintext -d '{"service":""}' localhost:9210 grpc.health.v1.Health/Check

docker compose down -v
```

Swap `8210`/`9210` for `8211`/`9211` to hit the Python stack — identical
request, identical formula, identical trace/metrics/health shape.

## How the pieces fit together

**Quarkus.** `quarkus-opentelemetry` instruments `quarkus-rest` AND
`quarkus-grpc` automatically (`quarkus.otel.instrument.rest` /
`.grpc`, both default `true`) — `BookingResource.quote` needs no manual
`Tracer` code beyond reading `Span.current().getSpanContext().getTraceId()`
to log and return it. `quarkus-micrometer-registry-prometheus` turns on
`quarkus-grpc`'s server metrics binder automatically the moment it's on the
classpath (confirmed against the Quarkus 3.40 gRPC guide:
"gRPC server metrics are automatically enabled when the application also
uses the `quarkus-micrometer` extension") and publishes them, alongside every
other Micrometer metric, at `/q/metrics`. The `grpc.health.v1.Health`
service is likewise automatic: quarkus-grpc registers it for every
`@GrpcService` bean present, with no separate dependency and no enable
flag — this was confirmed directly against the Quarkus gRPC service-
implementation guide rather than assumed.

**Python.** `grpcio` has no equivalent auto-wiring for ANY of the three
pieces, so each is wired by hand, with the shapes kept as close to the
Quarkus side's automatic behavior as possible:

- **Tracing** still needs no manual span code: running under
  `opentelemetry-instrument` (see `Containerfile`) auto-instruments the
  `grpc.aio` server, the `grpc.aio` client channel, and — new this
  chapter — the FastAPI app, via `opentelemetry-instrumentation-fastapi`'s
  zero-code patch of `fastapi.FastAPI.__init__`. `app/api.py` and
  `app/routing_service.py`/`app/quote_service.py` only call
  `trace.get_current_span()` to read the trace id already running.
- **Metrics** need a hand-rolled interceptor (`app/metrics.py`) — there is no
  `grpcio` Prometheus binder in the standard library the way Micrometer ships
  one for Quarkus. `MetricsInterceptor` follows the exact resolve-then-wrap
  shape Ch12's `AuthLoggingInterceptor` and Ch20's `AuthzInterceptor`
  established, wrapping (not replacing) each unary handler's behavior
  function to record a `grpc_server_handled_total` counter and a
  `grpc_server_handling_seconds` histogram, using the same metric- and
  label-naming convention the grpc-ecosystem community's Go/Java Prometheus
  interceptors use.
- **Health** needs the `grpcio-health-checking` package and a few lines in
  `app/main.py`: a `health.HealthServicer()` registered on the server, with
  `SERVING` set for the overall server (`""`) and for each implemented
  service by its fully-qualified proto name.

**The REST front door, on both stacks**, is the thinnest possible booking
endpoint: one origin, one destination, one cargo weight,
built directly into a `GetQuoteRequest` and handed to the exact same
`RoutingService.GetQuote` every other chapter's example calls over gRPC
directly. Response field names are camelCase on both stacks — Jackson's
default for the Quarkus records, and `pydantic.alias_generators.to_camel` on
the Python `CamelModel` base — so `verify.sh` issues the identical JSON
request and parses the identical JSON response shape against either stack.

## Why Tempo's soft check looks for `rpc.service`, not just `service.name`

Both services share ONE OpenTelemetry resource (one `service.name`) per
stack, because this chapter keeps the Ch10 topology: `RoutingService`
and `QuoteService` run in the SAME process. That means a single stack's trace
never carries two distinct resource `service.name` values; the ONLY proof
dividing it into "two services" is each span's own `rpc.service` attribute
(`shipping.routing.v1.RoutingService` vs `shipping.quote.v1.QuoteService`),
set automatically by the gRPC semantic-convention instrumentation on both
stacks with zero extra code. `verify.sh`'s Tempo check counts distinct values
across EITHER attribute: a real deployment where `QuoteService` is its own
deployable unit would show two distinct `service.name` resources instead,
with no code change at all — the loopback topology is this book's
teaching-budget compromise, not a limit of OpenTelemetry itself.

## Proto code generation: `contracts/` is the only source of truth

Same pattern as every prior chapter. Neither module commits generated or
copied `.proto`/stub files; each `Containerfile` builds with the **repo
root** as its Docker build context so it can `COPY` the three proto files
this module needs (`types.proto`, `routing.proto`, `quote.proto`) straight
from `contracts/proto/` at build time. For a local, non-container `mvn`/`uv`
run, copy the same three files by hand first:

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
```

Both copy destinations (`quarkus/src/main/proto/`, `python/proto/`,
`python/generated/`) are gitignored (see `../.gitignore`) — build-time-only,
never committed.

## On the wire

Server reflection is enabled on both stacks for both services:

```bash
grpcurl -plaintext localhost:9210 list
# grpc.health.v1.Health
# grpc.reflection.v1.ServerReflection
# grpc.reflection.v1alpha.ServerReflection
# shipping.quote.v1.QuoteService
# shipping.routing.v1.RoutingService
```

Health answers `SERVING` with no arguments needed beyond the empty service
name (the overall server):

```bash
grpcurl -plaintext -d '{"service":""}' localhost:9210 grpc.health.v1.Health/Check
```

```
{
  "status": "SERVING"
}
```

The traced booking call:

```bash
curl -s -X POST localhost:8210/booking/quote -H 'content-type: application/json' \
  -d '{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}'
```

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "quote": { "currency": "USD", "amount": "2500.00" },
  "route": { "id": "rte_USNYC-NLRTM", "legs": [ { "carrier": "MAERSK" } ] }
}
```

And the pointer a reader follows from that `traceId` straight into Grafana's
Tempo datasource, once the trace has ingested:

```bash
curl -s http://localhost:3200/api/traces/4bf92f3577b34da6a3ce929d0e0e4736 | python3 -m json.tool
```

`verify.sh` asserts these exact fields (`1000kg * 2.50 = "2500.00"`, the same
formula every prior anchor uses) from both stacks, plus the trace-id
continuity, the metrics, and the health check.

## Diagrams

Three figures (`assets/diagrams/21-*`, generated with
`scripts/generate_diagram.py`):

- `21-otel-trace-seam` — the one trace, three spans: REST booking root span
  -> gRPC `GetQuote` span -> `QuoteService` span, all sharing one trace id.
- `21-trace-context-in-metadata` — the W3C `traceparent` riding as an HPACK
  metadata header on the HEADERS frame, extracted by the server so its child
  span continues the parent trace id.
- `21-observability-surfaces` — the three surfaces this chapter wires up:
  traces -> Tempo, metrics -> Prometheus, health -> `grpc.health.v1.Health/Check`.
