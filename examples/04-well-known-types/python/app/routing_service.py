"""Ch4 well-known-types ANCHOR — the unary FindOptimalRoute RPC, implemented
identically here and in the Quarkus stack (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/routing/RoutingServiceImpl.java).

The other four RoutingService methods (GetQuote, ListRoutes, NegotiateRoute,
RecomputeRoutes) are declared in the proto for other chapters. They are
intentionally left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override, so
grpcurl / any client sees UNIMPLEMENTED without extra code here. This example
stands on its own, independent of Chapter 5's GetQuote anchor.
"""
from __future__ import annotations

import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.route import build_route

logger = logging.getLogger("ch04-wkt-python")


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    async def FindOptimalRoute(
        self,
        request: routing_pb2.FindOptimalRouteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.FindOptimalRouteResponse:
        origin = request.origin
        destination = request.destination

        route = build_route(origin, destination)

        logger.info(
            "FindOptimalRoute: %s -> %s, departs=%s, arrives=%s, price=%s %s",
            origin.un_locode,
            destination.un_locode,
            route.legs[0].departs_at.ToJsonString(),
            route.legs[0].arrives_at.ToJsonString(),
            route.price.currency,
            route.price.amount,
        )

        return routing_pb2.FindOptimalRouteResponse(route=route)
