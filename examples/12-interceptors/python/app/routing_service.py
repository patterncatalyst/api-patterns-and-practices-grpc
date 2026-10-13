"""Ch12 interceptors ANCHOR — same GetQuote formula as Chapter 5
(examples/05-contract-first), running behind AuthLoggingInterceptor instead
of unprotected. The servicer itself knows nothing about auth or timing: both
are the interceptor's job, not this class's.

The other four RoutingService methods (FindOptimalRoute, ListRoutes,
NegotiateRoute, RecomputeRoutes) are intentionally left unoverridden — the
generated `routing_pb2_grpc.RoutingServiceServicer` base class already sets
gRPC status UNIMPLEMENTED and raises for any method a subclass doesn't
override. The interceptor runs in front of those too, so a call missing
`authorization` never reaches even the UNIMPLEMENTED path.
"""
from __future__ import annotations

import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.quote import compute_quote

logger = logging.getLogger("ch12-routing-python")

_CARRIER = "MAERSK"


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    async def GetQuote(
        self,
        request: routing_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.GetQuoteResponse:
        origin = request.origin
        destination = request.destination

        quote = compute_quote(request.cargo)

        leg = types_pb2.Leg(
            carrier=_CARRIER,
            origin=origin,
            destination=destination,
            # departs_at / arrives_at intentionally left unset.
        )
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}",
            legs=[leg],
            price=quote,
        )

        logger.info(
            "GetQuote: %s -> %s, %d cargo item(s), quote=%s %s",
            origin.un_locode,
            destination.un_locode,
            len(request.cargo),
            quote.currency,
            quote.amount,
        )

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)
