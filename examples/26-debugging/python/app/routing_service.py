"""Ch26 debugging — the same GetQuote formula every prior chapter
implemented, plus one addition this chapter's DEADLINE_EXCEEDED repro
depends on: a configurable artificial delay before the response is
returned, read from QUOTE_DELAY_MS (default 2000ms — see ../README.md). A
client deadline shorter than the delay cannot be met; one longer than it
succeeds normally, same request and same server either way.

FindOptimalRoute, ListRoutes, NegotiateRoute, and RecomputeRoutes are
left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC
status UNIMPLEMENTED and raises for any method a subclass doesn't override
— this chapter's UNIMPLEMENTED repro calls FindOptimalRoute for exactly
that reason.
"""
from __future__ import annotations

import asyncio
import logging
import os

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.quote import compute_quote

logger = logging.getLogger("ch26-routing-python")

_CARRIER = "MAERSK"
_QUOTE_DELAY_MS = int(os.environ.get("QUOTE_DELAY_MS", "2000"))


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
            "GetQuote: %s -> %s, %d cargo item(s), quote=%s %s, delaying %dms before responding",
            origin.un_locode,
            destination.un_locode,
            len(request.cargo),
            quote.currency,
            quote.amount,
            _QUOTE_DELAY_MS,
        )

        # The artificial delay stands in for a slow downstream dependency
        # without actually adding one — Chapter 10 wired a real downstream
        # hop for the same lesson; this chapter only needs a deadline to
        # have something to race against.
        if _QUOTE_DELAY_MS > 0:
            await asyncio.sleep(_QUOTE_DELAY_MS / 1000)

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)
