"""Ch21 observability ANCHOR — the REST front door this chapter adds: the ONE
place in this example a client crosses the REST-to-gRPC seam this book keeps
coming back to. `opentelemetry-instrumentation-fastapi` is installed by the
`opentelemetry-instrument` wrapper (see ../Containerfile) and patches
`fastapi.FastAPI.__init__` itself at process startup, so the `FastAPI()`
instance `create_app` builds below gets its tracing middleware wired in — no
code in this file calls an instrumentor. That middleware starts a span BEFORE
`booking_quote` runs; `trace.get_current_span()` inside the handler reads that
span's trace id. The `RoutingServiceStub` passed in is built on a channel
`opentelemetry-instrumentation-grpc`'s client interceptor has ALSO already
wrapped (same zero-code mechanism), so calling it injects a W3C `traceparent`
carrying that same trace id into the outgoing gRPC call's metadata. Neither
injection nor extraction is code in this file: both sides of the propagation
are the OpenTelemetry auto-instrumentation doing exactly what it is for.

No proto field changes: `booking_quote` builds the identical
`shipping.routing.v1.RoutingService.GetQuoteRequest` any other gRPC client
would, over gRPC, to the same `RoutingServiceServicer` every other chapter's
example calls directly.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import Response
from opentelemetry import trace
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.models import BookingQuoteRequest, BookingQuoteResponse, Leg, Money, Route

logger = logging.getLogger("ch21-observability-python")


def create_app(routing_stub: routing_pb2_grpc.RoutingServiceStub) -> FastAPI:
    app = FastAPI(title="ch21-observability-python booking front door")

    @app.post("/booking/quote", response_model=BookingQuoteResponse)
    async def booking_quote(request: BookingQuoteRequest) -> BookingQuoteResponse:
        trace_id = format(trace.get_current_span().get_span_context().trace_id, "032x")

        logger.info(
            "booking_quote trace_id=%s %s -> %s cargoKg=%.1f",
            trace_id,
            request.origin,
            request.destination,
            request.cargo_kg,
        )

        grpc_request = routing_pb2.GetQuoteRequest(
            origin=types_pb2.Location(un_locode=request.origin),
            destination=types_pb2.Location(un_locode=request.destination),
            cargo=[types_pb2.Cargo(weight_kg=request.cargo_kg)],
        )
        resp = await routing_stub.GetQuote(grpc_request)

        return BookingQuoteResponse(
            trace_id=trace_id,
            quote=Money(currency=resp.quote.currency, amount=resp.quote.amount),
            route=Route(
                id=resp.route.id,
                legs=[Leg(carrier=leg.carrier) for leg in resp.route.legs],
            ),
        )

    @app.get("/metrics")
    async def metrics() -> Response:
        return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return app
