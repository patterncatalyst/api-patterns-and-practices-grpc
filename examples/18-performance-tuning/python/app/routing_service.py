"""Ch18 performance-tuning — the generated RoutingServiceServicer base class,
implementing GetQuote (the Ch7 fast-unary anchor, unchanged) and ListRoutes
(the oversized catalog this chapter's wire-size levers act on).

The other three RPCs are left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.catalog import compute_quote, paginate

logger = logging.getLogger("ch18-performance-python")

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

        leg = types_pb2.Leg(carrier=_CARRIER, origin=origin, destination=destination)
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

    async def ListRoutes(
        self,
        request: routing_pb2.ListRoutesRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.ListRoutesResponse:
        try:
            response = paginate(request.page_size, request.page_token)
        except ValueError as exc:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
            raise  # context.abort raises; this line is unreachable but satisfies type checkers

        logger.info(
            "ListRoutes: page_size=%d page_token='%s' -> %d route(s), next_page_token='%s'",
            request.page_size,
            request.page_token,
            len(response.routes),
            response.next_page_token,
        )
        return response
