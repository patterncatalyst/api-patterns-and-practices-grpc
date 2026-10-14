"""Ch25 testing-and-cli — a lean RoutingServiceServicer, same shape as every
earlier chapter's: only GetQuote does real work. FindOptimalRoute,
ListRoutes, NegotiateRoute, and RecomputeRoutes are intentionally left
unoverridden — the generated `routing_pb2_grpc.RoutingServiceServicer` base
class (unlike the Quarkus side's generated INTERFACE) already sets gRPC
status UNIMPLEMENTED and raises for any method a subclass doesn't override,
so there is nothing to write for them here.

This exact class is what both the container's main.py wires into a real
`grpc.aio.server()` AND what tests/test_routing_service.py wires into a
SECOND, test-only `grpc.aio.server()` on an ephemeral port — the same
servicer code, two different server instances, which is the point: the
pytest suite exercises the real implementation, not a mock of it.
"""
from __future__ import annotations

import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.quote import compute_quote

logger = logging.getLogger("ch25-routing-python")

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
