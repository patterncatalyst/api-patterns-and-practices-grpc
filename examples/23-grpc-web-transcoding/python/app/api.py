"""Ch23 grpc-web & JSON/HTTP transcoding — the hand-written REST shim this
chapter contrasts against Envoy's generic grpc_json_transcoder
(../../envoy/). This module is purpose-built for ONE RPC: `booking_quote`
knows the `BookingQuoteRequest`/`BookingQuoteResponse` JSON shape, builds the
`GetQuoteRequest` by hand, and shapes the response by hand. Every new RPC
this book ever exposes over REST needs a handler like this one, written and
maintained by a human. Envoy's transcoder, by contrast, derives its JSON
mapping from the proto descriptor alone — see the chapter prose for the
trade-off between the two.

No proto field changes: `booking_quote` builds the identical
`shipping.routing.v1.RoutingService.GetQuoteRequest` any other gRPC client
would, over gRPC, to the same `RoutingServiceServicer` every other chapter's
example calls directly.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.models import BookingQuoteRequest, BookingQuoteResponse, Leg, Money, Route

logger = logging.getLogger("ch23-grpc-web-python")


def create_app(routing_stub: routing_pb2_grpc.RoutingServiceStub) -> FastAPI:
    app = FastAPI(title="ch23-grpc-web-python booking front door")

    @app.post("/booking/quote", response_model=BookingQuoteResponse)
    async def booking_quote(request: BookingQuoteRequest) -> BookingQuoteResponse:
        logger.info(
            "booking_quote %s -> %s cargoKg=%.1f",
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
            quote=Money(currency=resp.quote.currency, amount=resp.quote.amount),
            route=Route(
                id=resp.route.id,
                legs=[Leg(carrier=leg.carrier) for leg in resp.route.legs],
            ),
        )

    return app
