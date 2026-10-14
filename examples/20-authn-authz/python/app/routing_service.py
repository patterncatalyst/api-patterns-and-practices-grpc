"""Ch20 authn-authz — same GetQuote formula as Chapter 5/Chapter 12, running
behind AuthzInterceptor instead of the presence-only auth hook from Chapter 12.
The servicer itself knows nothing about tokens or scopes: both are the
interceptor's job, not this class's.

ListRoutes, FindOptimalRoute, NegotiateRoute, and RecomputeRoutes are left
unoverridden — the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override. That
matters for this chapter specifically: ListRoutes is the method
AuthzInterceptor gates on the `routes:admin` scope, and a token that lacks
that scope gets PERMISSION_DENIED from the interceptor without ever reaching
this class's (absent) ListRoutes override. A token that legitimately carried
`routes:admin` would still land on UNIMPLEMENTED here — that UNIMPLEMENTED
is a separate, later fact about this example's scope, not the authorization
decision this chapter demonstrates.
"""
from __future__ import annotations

import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.quote import compute_quote

logger = logging.getLogger("ch20-routing-python")

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
            # departs_at / arrives_at left unset.
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
