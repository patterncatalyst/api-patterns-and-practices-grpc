"""Ch27 final project — the REST front door: the ONE place in this example a
client crosses the REST-to-gRPC seam this book keeps coming back to. The
`RoutingServiceStub` passed in is built on the SAME mTLS loopback channel +
internal bearer token shape app/routing_service.py uses to reach
QuoteService — the front door "holds the client cert and a valid JWT" the
same way any other caller of this port must.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from opentelemetry import trace

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.models import BookingQuoteRequest, BookingQuoteResponse, Leg, Money, Route
from app.security import INTERNAL_METADATA

logger = logging.getLogger("ch27-final-project-python")


def create_app(routing_stub: routing_pb2_grpc.RoutingServiceStub) -> FastAPI:
    app = FastAPI(title="ch27-final-project-python booking front door")

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
        resp = await routing_stub.GetQuote(grpc_request, metadata=INTERNAL_METADATA)

        return BookingQuoteResponse(
            trace_id=trace_id,
            quote=Money(currency=resp.quote.currency, amount=resp.quote.amount),
            route=Route(
                id=resp.route.id,
                legs=[Leg(carrier=leg.carrier) for leg in resp.route.legs],
            ),
        )

    return app
