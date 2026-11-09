---
title: "Observability"
order: 21
part: "Observability, Mesh & Load Balancing"
description: "OpenTelemetry traces across a REST-to-gRPC seam, Prometheus metrics and the standard grpc.health.v1.Health check, with no contract change and no manual propagation code."
duration: "18 min read"
---

## Learning objectives

By the end of this chapter you can:

- Trace a `POST /booking/quote` request across a REST-to-gRPC seam and a second gRPC hop as one trace with three spans, with no manual propagation code on either stack.
- Say what traces, metrics and health each answer, and name the standard protocol behind each: OpenTelemetry, the Prometheus text format and `grpc.health.v1.Health`.
- Register `grpc.health.v1.Health` on both stacks, and choose `grpc_health.v1.health.aio.HealthServicer` under `grpc.aio`.
- Read gRPC server metrics that `quarkus-micrometer-registry-prometheus` produces automatically and that a `prometheus-client` `MetricsInterceptor` produces by hand.
- Confirm a propagated trace id against Tempo's stored trace.

## Why this matters

A log line per call says what happened to one call, to one engineer, in one terminal. It does not say where the time went across three services, whether this error rate is new, or whether this instance can take traffic. Those are three questions with three signals, and none of them touches the `shipping.routing.v1.RoutingService` or `shipping.quote.v1.QuoteService` protos. Tracing and metrics ride in gRPC metadata and the OpenTelemetry and Micrometer SDKs, and health is gRPC's own standard service.

{% include excalidraw.html file="21-otel-trace-seam" alt="A band labeled trace 4bf92f3577b34da6a3ce929d0e0e4736 contains three horizontal span bars drawn as a waterfall. The widest bar at the top, drawn in an amber accent style, is labeled POST slash booking slash quote, REST root span. A narrower bar below and indented, drawn in a plain white box style, is labeled RoutingService slash GetQuote, gRPC server span, child. A still narrower bar below that and further indented, drawn in a dark filled ink style, is labeled QuoteService slash GetQuote, gRPC server span, grandchild. A short vertical arrow connects the bottom of the first bar to the top of the second, labeled child span same trace-id, and a second short vertical arrow connects the bottom of the second bar to the top of the third, labeled the same way. A bold note above the whole band reads one REST request arrow one trace arrow three spans, same trace-id throughout." caption="Figure 21.1: one REST request produces one trace with three nested spans (REST, RoutingService, QuoteService) sharing a trace id." %}

## Three signals

| Signal | Question | Standard | Retention |
| --- | --- | --- | --- |
| Trace | Where did this request's time go, across how many hops? | OpenTelemetry | Hours to days |
| Metrics | In aggregate, how many calls, how fast, how many failed? | Prometheus text format | Months |
| Health | Can this instance take a request right now? | `grpc.health.v1.Health` | None |

A trace is a tree of spans linked by a trace id and parent/child relationships. A metric has no idea which request it came from, which is what makes it cheap to keep. Health carries no history: a load balancer asks before each routing decision, only to avoid sending traffic somewhere that cannot answer.

## The REST-to-gRPC seam

`POST /booking/quote` accepts JSON (`origin`, `destination`, `cargoKg`), builds a `GetQuoteRequest`, and calls `RoutingService.GetQuote` over gRPC, which calls `QuoteService.GetQuote` over a second hop. Both stacks render camelCase JSON, so one request body and one set of assertions work against both.

**Quarkus.** `quarkus-opentelemetry` instruments `quarkus-rest` and `quarkus-grpc` by default (`quarkus.otel.instrument.rest` and `quarkus.otel.instrument.grpc` are `true`). A span exists when a request reaches `BookingResource.quote`; the client-side gRPC instrumentation injects a W3C `traceparent` into outgoing metadata, and the server-side span is already a child of the REST span. The same happens on the next hop. The only tracing code is `Span.current().getSpanContext().getTraceId()` in each handler, which logs the id and propagates nothing.

**Python.** The process runs under the `opentelemetry-instrument` wrapper (the `ENTRYPOINT` in `python/Containerfile`), which finds every installed instrumentation package at startup and patches the entry points. `opentelemetry-instrumentation-grpc` wraps the `grpc.aio` server and client channel, and `opentelemetry-instrumentation-fastapi` patches `FastAPI.__init__`, so the app picks up tracing middleware with no instrumentor call.

{% include excalidraw.html file="21-trace-context-in-metadata" alt="On the left, a box labeled Client, instrumented stub. An arrow labeled 1 HEADERS colon traceparent 00 dash trace-id dash span-id dash 01, drawn in amber, travels right to a box labeled gRPC server, extracts traceparent. A second, dashed arrow labeled 2 DATA, sent after colon GetQuoteRequest bytes, travels along the same path below it, showing the message body arriving in a separate, later frame. A downward arrow labeled extract arrow start child span connects the gRPC server box to a box below it, drawn in a dark filled ink style, labeled Child span, continues parent trace-id. A bold note above the diagram states that traceparent travels as an HPACK header on HEADERS, ahead of the DATA frame carrying the message, and a second note below the child span box states same trace-id, new span-id, what verify.sh's log grep confirms." caption="Figure 21.2: the W3C traceparent rides as a header on the HEADERS frame, ahead of the DATA frame. The server extracts it and starts a child span in the same trace." %}

## Trace context is a metadata header

`traceparent` is one more entry in the metadata map the auth interceptors read for `authorization`. The [W3C Trace Context](https://www.w3.org/TR/trace-context/) spec defines it as a version, a 32-hex-character trace id, a 16-hex-character parent span id and a flags byte, joined by hyphens. HTTP/2 sends HEADERS before DATA, so a server can start a span before it deserializes the body. Metadata is per call: a reused channel attaches a fresh `traceparent` to each call, because each call belongs to its own trace.

Both services run in one process per stack, so their spans share one OpenTelemetry resource and one `service.name`. In Tempo the two are told apart by each span's `rpc.service` attribute (`shipping.routing.v1.RoutingService` versus `shipping.quote.v1.QuoteService`), which the gRPC semantic-convention instrumentation sets on both stacks. Deploy `QuoteService` as its own process and the traces show two `service.name` values with no code change.

## Metrics

On Quarkus, adding `quarkus-micrometer-registry-prometheus` is the whole implementation. The Quarkus gRPC guide states that "gRPC server metrics are automatically enabled when the application also uses the `quarkus-micrometer` extension". `GET /q/metrics` answers with `grpc_server_processing_duration_seconds_count{method="GetQuote",service="shipping.routing.v1.RoutingService",...}` and its sibling series after the first call.

`grpcio` ships no Prometheus binder, so `app/metrics.py` writes the same shape with `prometheus-client`:

```python
GRPC_SERVER_HANDLED_TOTAL = Counter(
    "grpc_server_handled_total",
    "Total number of gRPC calls completed on the server, regardless of success or failure.",
    ["grpc_service", "grpc_method", "grpc_code"],
)
GRPC_SERVER_HANDLING_SECONDS = Histogram(
    "grpc_server_handling_seconds",
    "Histogram of response latency (seconds) of gRPC calls handled on the server.",
    ["grpc_service", "grpc_method"],
)
```

`MetricsInterceptor` resolves the real handler, wraps its `unary_unary` behavior in a `try`/`finally` and records both series whether the call succeeds or not. Only unary handlers are wrapped because `GetQuote` is the only shape either service implements; covering streaming means wrapping all four handler shapes, as the auth interceptor's `_with_logging` does. A `GET /metrics` route on the FastAPI app returns `prometheus_client.generate_latest()` in the same text format as `/q/metrics`, so a scraper cannot tell the stacks apart.

## Health

`grpc.health.v1.Health` has a unary `Check` taking an optional service name and returning `SERVING`, `NOT_SERVING` or `UNKNOWN`, and a streaming `Watch` for callers that want pushed changes. Gateways, meshes and Kubernetes gRPC probes already call it, which is the argument against a bespoke `/healthz`.

Quarkus registers the service automatically for every `@GrpcService` bean. Python uses `grpcio-health-checking`, and the class matters. `grpc_health.v1.health.HealthServicer` is the synchronous implementation for a threaded `grpc.Server`. Registered on a `grpc.aio` server it raises a `TypeError` as soon as asyncio-aware code, such as `MetricsInterceptor`, awaits a response that was never a coroutine. The two classes look interchangeable from an import statement. Use the asyncio-native `health.aio.HealthServicer`, whose `set` is a coroutine:

```python
    health_servicer = health_aio.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    for service_name in ("", routing_full_name, quote_full_name):
        await health_servicer.set(service_name, health_pb2.HealthCheckResponse.SERVING)
```

The empty name is the server as a whole; the full proto names answer when a caller names one service.

{% include excalidraw.html file="21-observability-surfaces" alt="A central box drawn in an amber accent style, labeled RoutingService plus QuoteService plus REST front door, sits in the middle of the diagram. An arrow labeled OTLP spans, push, travels from its upper left toward a box in the upper left labeled Tempo, traces. A second arrow labeled GET slash metrics, pull, travels from its upper right toward a box in the upper right labeled Prometheus, metrics. A third, double-headed arrow labeled Health slash Check arrow SERVING connects the central box downward to a box below it, drawn in a light blue user style, labeled grpcurl slash orchestrator, health checks. A bold note above the whole diagram reads three independent observability surfaces riding on the same process." caption="Figure 21.3: three independent surfaces on one process: traces pushed to Tempo, metrics pulled by Prometheus, health answered over grpc.health.v1.Health/Check." %}

## Wiring in Compose

Python's `serve()` runs the `grpc.aio` server and a `uvicorn.Server` for FastAPI in one event loop with `asyncio.gather`; Quarkus manages both its gRPC and HTTP servers itself, on ports 9000 and 8080. In Python one `grpc.aio.insecure_channel` to `localhost:9000` builds both loopback stubs, `QuoteServiceStub` and `RoutingServiceStub`, since a channel serves any number of stubs.

Earlier examples gated `lgtm` behind `profiles: ["observability"]`. Here it is always on, and both stacks use `depends_on: condition: service_healthy` so neither serves before Tempo, Prometheus and the OTLP collector are ready. The `grafana/otel-lgtm:0.36.0` image has `curl` but not `wget`, so its healthcheck uses `curl -fsS`; a `wget -qO-` check fails once something depends on it.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Trace the boundaries where ownership of a request changes hands, such as a REST-to-gRPC seam or a downstream hop, and let auto-instrumentation propagate. Write span code by hand only where it cannot see the hop, such as a message queue or a background job scheduled from inside a span. Measure what on-call will query: request count, error rate and latency distribution per method. Use <code>grpc.health.v1.Health</code> for liveness and readiness, never a REST endpoint reinventing it. Before a trace-everything stack reaches production, sample: a head-based sampler keeps a fixed percentage, and a tail-based one in the OpenTelemetry Collector keeps every error plus a sample of the rest.</p></div>

> **🤖 Explore with your agent**
>
> "Review `examples/21-observability` against the rule: trace the boundaries where ownership of a request changes hands and let auto-instrumentation propagate. List every line in `python/app/` and the Quarkus `BookingResource`, `RoutingServiceImpl` and `QuoteServiceImpl` that touches tracing, metrics or health, flag any that injects or extracts `traceparent` by hand, and say what `MetricsInterceptor` in `app/metrics.py` would need to also cover a server-streaming RPC."
>
> Check: the reply finds only trace-id reads (`Span.current()`, `trace.get_current_span()`), and `curl -s localhost:8211/metrics | grep grpc_server_handled_total` shows a `GetQuote` series after one `POST /booking/quote`.

## Build, run, observe

```bash
cd examples/21-observability
./verify.sh
```

The script starts both stacks and the LGTM stack, lists services over reflection (`grpc.health.v1.Health` appears next to both shipping services), checks `Health/Check`, posts the same `/booking/quote` body to each stack, and confirms the trace id in the response matches the handlers' logs. It prints `PASS` when both stacks agree. Quarkus is on `9210` and `8210`, Python on `9211` and `8211`.

```bash
grpcurl -plaintext -d '{"service":""}' localhost:9210 grpc.health.v1.Health/Check
curl -s -X POST localhost:8210/booking/quote -H 'content-type: application/json' \
  -d '{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}'
```

The first returns `"status": "SERVING"`. The second returns the quote (`USD 2500.00`) and a `traceId`. Look the trace up in Tempo, which ingested it through the OTLP collector independently of the app's logs, or open Grafana at `http://localhost:3000` (Explore, Tempo) and paste the id:

```bash
TRACE_ID="$(curl -s -X POST localhost:8210/booking/quote -H 'content-type: application/json' \
  -d '{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["traceId"])')"
sleep 5
curl -s "http://localhost:3200/api/traces/${TRACE_ID}" | python3 -m json.tool
```

The stored trace contains spans for both `rpc.service` values under the id the REST response and the logs reported. Three observers agreeing on one id is stronger than any one of them. Tempo's ingest lags by a few seconds, hence the `sleep`.

Experiments:

- **Use the synchronous health servicer.** Register `grpc_health.v1.health.HealthServicer` instead of `health.aio.HealthServicer` in `python/app/main.py`: the first `Health/Check` on the Python stack fails with a `TypeError` (`object can't be awaited`).

## What you learned

- Traces, metrics and health answer three different questions, each with a vendor-neutral standard.
- A `traceparent` is a metadata entry. Propagating across a REST-to-gRPC seam and a second hop needed no injection or extraction code, only instrumentation wired in once.
- Quarkus wires tracing and metrics in through extensions. `grpcio` has no metrics binder, so Python uses a hand-written interceptor with the same resolve-then-wrap shape as the auth interceptor.
- `SERVING` says only that an instance accepts gRPC calls now. It says nothing about whether the business logic is correct.
- Under `grpc.aio`, use `health.aio.HealthServicer`.

## For deeper coverage

- Charity Majors, Liz Fong-Jones and George Miranda, *Observability Engineering*, O'Reilly, 2022: the three-signals framing.
- Cloud Native Design Patterns, "Observability" chapter: the same model across a full platform.
- [OpenTelemetry: Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/): the `rpc.service` and `rpc.method` attributes.
- [grpc.io: Health checking](https://grpc.io/docs/guides/health-checking/): the `grpc.health.v1.Health` protocol both stacks implement.
