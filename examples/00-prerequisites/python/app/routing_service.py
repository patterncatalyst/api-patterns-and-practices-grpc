"""Ch0 prerequisites SKELETON — the unary GetQuote RPC, returning a canned
response. Proves the toolchain (codegen, reflection, Compose) works; the
real quote formula (computed from cargo weight, identical on both stacks)
is Chapter 5's job — see ../../05-contract-first/python/app/quote.py.

The other four RoutingService methods (FindOptimalRoute, ListRoutes,
NegotiateRoute, RecomputeRoutes) are declared in the proto for later
chapters. They are intentionally left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC
status UNIMPLEMENTED and raises for any method a subclass doesn't
override, so grpcurl / any client sees UNIMPLEMENTED without extra code
here — same pattern as Chapter 5.
"""
from __future__ import annotations

import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

logger = logging.getLogger("ch00-prereq-python")

# Canned response — not computed from the request. Chapter 5 replaces this
# with a real formula; this chapter only needs a stable, assertable wire
# value to prove the stack is up.
_CANNED_QUOTE = types_pb2.Money(currency="USD", amount="0.00")


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    async def GetQuote(
        self,
        request: routing_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.GetQuoteResponse:
        placeholder_route = types_pb2.Route(
            id="rte_placeholder",
            price=_CANNED_QUOTE,
            # no legs yet — Chapter 5 fills these in from origin/destination.
        )

        logger.info(
            "GetQuote: canned response (%s %s) — skeleton only, see Chapter 5 for the real formula",
            _CANNED_QUOTE.currency,
            _CANNED_QUOTE.amount,
        )

        return routing_pb2.GetQuoteResponse(quote=_CANNED_QUOTE, route=placeholder_route)
