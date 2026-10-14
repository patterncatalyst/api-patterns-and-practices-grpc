"""The Final Project's minikube mesh server — a plaintext, dependency-light
rebuild of the SAME RoutingService.GetQuote -> QuoteService.GetQuote loopback
hop the CI-gated Compose tier runs behind mTLS and a JWT interceptor (see
../../python/app/routing_service.py and quote_service.py), PLUS
NegotiateRoute (bidirectional) and WatchShipment (server streaming), so the
flow this subtree load-balances across is recognizably "the full project,"
not a bare one-RPC stub.

Deliberately plaintext and unauthenticated, mirroring Chapter 22's own
choice: layering mTLS/JWT into the load-balancing teaching point would
obscure it, and Appendix A's OpenShift tier already demonstrates STRICT mesh
mTLS at the platform layer. The one addition beyond plain RPC logic is a
response TRAILER, `x-served-by: <HOSTNAME>`, read by loadclient.py to prove
which pod actually answered — gRPC metadata, not a proto field, so it adds
zero bytes to the contract.

Trace propagation here is deliberately lightweight rather than a full OTel
SDK (no collector runs in this minikube demo): GetQuote mints a 32-hex-digit
id if the caller didn't supply one, forwards it to QuoteService as the
`x-trace-id` metadata key, and both handlers log it — the same
propagate-and-log-on-both-sides shape Chapter 21's OTel trace-id-continuity
check uses, implemented by hand so "capture a traced call" needs nothing
beyond `kubectl logs`.
"""
from __future__ import annotations

import logging
import os
import socket
import uuid

import grpc
from google.protobuf.timestamp_pb2 import Timestamp
from grpc_health.v1 import health_pb2, health_pb2_grpc
from grpc_health.v1.health import aio as health_aio
from grpc_reflection.v1alpha import reflection

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.tracking.v1 import tracking_pb2, tracking_pb2_grpc
from shipping.type.v1 import types_pb2

from app.quote import compute_quote

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch27-finalproject-mesh")

_CARRIER = "MAERSK"
_POD_NAME = os.environ.get("HOSTNAME", socket.gethostname())
_TRACE_ID_KEY = "x-trace-id"
_PRICE_CEILING = 5000.00

_USNYC = types_pb2.Location(un_locode="USNYC", name="New York")
_NLRTM = types_pb2.Location(un_locode="NLRTM", name="Rotterdam")
_WATCH_SEQUENCE = (
    (_USNYC, types_pb2.BOOKING_STATE_PENDING, "Booking accepted; container released to terminal"),
    (_USNYC, types_pb2.BOOKING_STATE_CONFIRMED, "Export customs cleared; loaded onboard MAERSK vessel"),
    (_NLRTM, types_pb2.BOOKING_STATE_IN_TRANSIT, "Vessel arrived at Rotterdam; awaiting discharge"),
    (_NLRTM, types_pb2.BOOKING_STATE_DELIVERED, "Container discharged and delivered to consignee"),
)


def _trace_id_from(context: grpc.aio.ServicerContext) -> str:
    metadata = dict(context.invocation_metadata() or ())
    return metadata.get(_TRACE_ID_KEY, uuid.uuid4().hex)


class QuoteServiceServicer(quote_pb2_grpc.QuoteServiceServicer):
    async def GetQuote(
        self, request: quote_pb2.GetQuoteRequest, context: grpc.aio.ServicerContext
    ) -> quote_pb2.GetQuoteResponse:
        trace_id = _trace_id_from(context)
        quote = compute_quote(request.cargo)
        logger.info(
            "QuoteService.GetQuote trace_id=%s served_by=%s %s -> %s quote=%s %s",
            trace_id, _POD_NAME, request.origin.un_locode, request.destination.un_locode,
            quote.currency, quote.amount,
        )
        return quote_pb2.GetQuoteResponse(quote=quote)


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    def __init__(self, quote_stub: quote_pb2_grpc.QuoteServiceStub) -> None:
        self._quote_stub = quote_stub

    async def GetQuote(
        self, request: routing_pb2.GetQuoteRequest, context: grpc.aio.ServicerContext
    ) -> routing_pb2.GetQuoteResponse:
        origin, destination = request.origin, request.destination
        trace_id = _trace_id_from(context)

        logger.info(
            "RoutingService.GetQuote trace_id=%s served_by=%s %s -> %s, calling QuoteService",
            trace_id, _POD_NAME, origin.un_locode, destination.un_locode,
        )

        downstream_request = quote_pb2.GetQuoteRequest(
            origin=origin, destination=destination, cargo=request.cargo
        )
        quote_response = await self._quote_stub.GetQuote(
            downstream_request, metadata=((_TRACE_ID_KEY, trace_id),)
        )
        quote = quote_response.quote

        leg = types_pb2.Leg(carrier=_CARRIER, origin=origin, destination=destination)
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}", legs=[leg], price=quote
        )

        # The pod-identity trailer loadclient.py tallies, exactly like
        # Chapter 22's demo — outside the proto entirely.
        context.set_trailing_metadata((("x-served-by", _POD_NAME), (_TRACE_ID_KEY, trace_id)))
        return routing_pb2.GetQuoteResponse(quote=quote, route=route)

    async def NegotiateRoute(self, request_iterator, context: grpc.aio.ServicerContext):
        async for req in request_iterator:
            proposal = req.proposal
            proposed_price = float(proposal.price.amount or "0")
            accepted = proposed_price <= _PRICE_CEILING
            counter = proposal
            if not accepted:
                counter = types_pb2.Route()
                counter.CopyFrom(proposal)
                counter.price.amount = f"{_PRICE_CEILING:.2f}"
            logger.info(
                "RoutingService.NegotiateRoute served_by=%s route=%s proposed=%s accepted=%s",
                _POD_NAME, proposal.id, proposal.price.amount, accepted,
            )
            yield routing_pb2.NegotiateRouteResponse(counter=counter, accepted=accepted)

    async def FindOptimalRoute(self, request, context):
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "out of this subtree's scope")

    async def ListRoutes(self, request, context):
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "out of this subtree's scope")

    async def RecomputeRoutes(self, request, context):
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "out of this subtree's scope")


class TrackingServiceServicer(tracking_pb2_grpc.TrackingServiceServicer):
    async def WatchShipment(self, request: tracking_pb2.WatchShipmentRequest, context):
        logger.info("TrackingService.WatchShipment served_by=%s bookingId=%s", _POD_NAME, request.booking_id)
        for location, state, note in _WATCH_SEQUENCE:
            event = tracking_pb2.TrackingEvent(
                booking_id=request.booking_id, location=location, state=state,
                at=Timestamp(seconds=1_700_000_000), note=note,
            )
            yield tracking_pb2.WatchShipmentResponse(event=event)


async def build_server() -> grpc.aio.Server:
    server = grpc.aio.server()

    loopback = grpc.aio.insecure_channel(f"localhost:{os.environ.get('GRPC_PORT', '9000')}")
    quote_stub = quote_pb2_grpc.QuoteServiceStub(loopback)

    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(quote_stub), server)
    quote_pb2_grpc.add_QuoteServiceServicer_to_server(QuoteServiceServicer(), server)
    tracking_pb2_grpc.add_TrackingServiceServicer_to_server(TrackingServiceServicer(), server)

    routing_name = routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name
    quote_name = quote_pb2.DESCRIPTOR.services_by_name["QuoteService"].full_name
    tracking_name = tracking_pb2.DESCRIPTOR.services_by_name["TrackingService"].full_name

    health_servicer = health_aio.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    for name in ("", routing_name, quote_name, tracking_name):
        await health_servicer.set(name, health_pb2.HealthCheckResponse.SERVING)

    reflection.enable_server_reflection(
        (routing_name, quote_name, tracking_name,
         health_pb2.DESCRIPTOR.services_by_name["Health"].full_name, reflection.SERVICE_NAME),
        server,
    )
    return server


async def serve() -> None:
    import asyncio

    host = os.environ.get("GRPC_HOST", "0.0.0.0")
    port = os.environ.get("GRPC_PORT", "9000")
    server = await build_server()
    server.add_insecure_port(f"{host}:{port}")
    await server.start()
    logger.info("ch27-finalproject-mesh: listening on %s:%s (pod=%s)", host, port, _POD_NAME)
    await server.wait_for_termination()


if __name__ == "__main__":
    import asyncio

    asyncio.run(serve())
