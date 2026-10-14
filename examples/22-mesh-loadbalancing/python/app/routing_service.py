"""The GetQuote servicer for the Ch22 load-balancing demo.

Identical RPC semantics to every prior chapter's RoutingService.GetQuote —
same request/response messages, same quote formula. The one addition is a
response TRAILER, `x-served-by: <HOSTNAME>`, set on every call. This is
gRPC metadata, not a proto field: it adds zero bytes to the contract and
exists purely so `loadclient.py` (and a human with grpcurl -v) can tell
which pod actually answered a given call, which is the entire point of this
chapter's demo. Kubernetes sets HOSTNAME to the pod's own name for every
container by default, so no Downward API plumbing is needed to read it.
"""
from __future__ import annotations

import logging
import os
import socket

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.quote import compute_quote

logger = logging.getLogger("ch22-routing-python")

_CARRIER = "MAERSK"
_POD_NAME = os.environ.get("HOSTNAME", socket.gethostname())


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
        )
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}",
            legs=[leg],
            price=quote,
        )

        # The pod-identity trailer this chapter's whole demo rests on: outside
        # the proto entirely, read by loadclient.py after each call completes.
        context.set_trailing_metadata((("x-served-by", _POD_NAME),))

        logger.info(
            "GetQuote served-by=%s: %s -> %s, %d cargo item(s), quote=%s %s",
            _POD_NAME,
            origin.un_locode,
            destination.un_locode,
            len(request.cargo),
            quote.currency,
            quote.amount,
        )

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)
