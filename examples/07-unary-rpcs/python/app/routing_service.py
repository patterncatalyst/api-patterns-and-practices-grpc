"""Ch7 unary-rpcs — the generated RoutingServiceServicer base class,
subclassed here exactly the way Ch5 subclassed it. This module's point is
the generated stub-to-stub path and channel/stub reuse on the client side
(see reuse_client.py and ../README.md) — GetQuote's own formula is
unchanged from Ch5.

FindOptimalRoute, ListRoutes, NegotiateRoute, and RecomputeRoutes are
intentionally left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC
status UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.quote import compute_quote

logger = logging.getLogger("ch07-routing-python")

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
