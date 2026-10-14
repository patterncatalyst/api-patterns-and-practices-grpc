"""Ch27 final project — RoutingService: GetQuote (unary, calling DOWNSTREAM
QuoteService over a real mTLS+JWT gRPC hop) and NegotiateRoute (bidirectional,
real negotiation logic — see app/negotiation.py) implemented for real.
FindOptimalRoute, ListRoutes, and RecomputeRoutes are left unoverridden: the
generated `routing_pb2_grpc.RoutingServiceServicer` base class already sets
gRPC status UNIMPLEMENTED for any method a subclass doesn't override.
ListRoutes is this example's wrong-scope PERMISSION_DENIED target (see
app/interceptors.py) — the interceptor's authorization decision is
independent of whether the method behind it is implemented.
"""
from __future__ import annotations

import logging

import grpc
from opentelemetry import trace

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.negotiation import negotiate

logger = logging.getLogger("ch27-final-project-python")

_CARRIER = "MAERSK"


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    def __init__(self, quote_stub: quote_pb2_grpc.QuoteServiceStub, internal_metadata: tuple) -> None:
        self._quote_stub = quote_stub
        self._internal_metadata = internal_metadata

    async def GetQuote(
        self,
        request: routing_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.GetQuoteResponse:
        origin = request.origin
        destination = request.destination
        trace_id = format(trace.get_current_span().get_span_context().trace_id, "032x")

        downstream_request = quote_pb2.GetQuoteRequest(
            origin=origin, destination=destination, cargo=request.cargo
        )

        logger.info(
            "RoutingServiceServicer.GetQuote trace_id=%s %s -> %s, calling QuoteService",
            trace_id,
            origin.un_locode,
            destination.un_locode,
        )

        quote_response = await self._quote_stub.GetQuote(downstream_request, metadata=self._internal_metadata)

        quote = quote_response.quote
        leg = types_pb2.Leg(carrier=_CARRIER, origin=origin, destination=destination)
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}",
            legs=[leg],
            price=quote,
        )

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)

    async def NegotiateRoute(self, request_iterator, context: grpc.aio.ServicerContext):
        """Bidirectional: for every NegotiateRouteRequest proposal received,
        emit one NegotiateRouteResponse decided by app.negotiation.negotiate —
        a 1:1 mapping preserving arrival order, same shape Chapter 9's Sync
        uses on this stack.
        """
        async for req in request_iterator:
            resp = negotiate(req)
            logger.info(
                "NegotiateRoute: proposal price=%s -> accepted=%s counter.price=%s",
                req.proposal.price.amount,
                resp.accepted,
                resp.counter.price.amount,
            )
            yield resp
