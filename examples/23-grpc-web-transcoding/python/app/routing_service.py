"""Ch23 grpc-web & JSON/HTTP transcoding ANCHOR — the Ch21/Ch10 two-service
loopback shape, reused unchanged: GetQuote calls DOWNSTREAM
shipping.quote.v1.QuoteService.GetQuote over a loopback grpc.aio channel (see
app/main.py — QuoteServiceServicer runs in this same process) and wraps its
answer in a Route, exactly as every prior anchor's handler does.

This method is reached FOUR ways in this chapter, all converging on this same
coroutine: directly over native gRPC (grpcurl, port 9231); through
app/api.py's hand-written REST shim over ITS OWN stub built from the same
loopback channel (port 8231); through Envoy's grpc_json_transcoder filter,
which decodes a plain JSON/HTTP POST into this same proto request and
forwards it as native gRPC (port 10231); and through Envoy's grpc_web filter
(also port 10231), driven in this example by grpcweb_client.py as the
deterministic browser stand-in. Nothing in this class — or in the proto
contract — knows the difference; see ../../envoy/.

The other four RoutingService methods are declared in the proto for later
chapters. They are left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import logging

import grpc

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

logger = logging.getLogger("ch23-grpc-web-python")

_CARRIER = "MAERSK"


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    def __init__(self, quote_stub: quote_pb2_grpc.QuoteServiceStub) -> None:
        self._quote_stub = quote_stub

    async def GetQuote(
        self,
        request: routing_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.GetQuoteResponse:
        origin = request.origin
        destination = request.destination

        downstream_request = quote_pb2.GetQuoteRequest(
            origin=origin, destination=destination, cargo=request.cargo
        )

        logger.info(
            "RoutingServiceServicer.GetQuote %s -> %s, calling QuoteService",
            origin.un_locode,
            destination.un_locode,
        )

        quote_response = await self._quote_stub.GetQuote(downstream_request)

        quote = quote_response.quote
        leg = types_pb2.Leg(carrier=_CARRIER, origin=origin, destination=destination)
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}",
            legs=[leg],
            price=quote,
        )

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)
