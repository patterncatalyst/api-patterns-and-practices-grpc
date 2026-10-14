"""Ch21 observability ANCHOR — the Ch10 two-service loopback shape, minus the
deadline-propagation plumbing (no artificial downstream delay, no deadline
carving): GetQuote calls DOWNSTREAM shipping.quote.v1.QuoteService.GetQuote
over a loopback grpc.aio channel (see app/main.py — QuoteServiceServicer runs
in this same process) and wraps its answer in a Route, exactly as every prior
anchor's handler does.

This method is reached two ways: directly over gRPC (grpcurl, the health
check target), and indirectly through app/api.py's FastAPI handler over ITS
OWN stub built from the same loopback channel. Either caller's W3C
`traceparent` — injected automatically by `opentelemetry-instrumentation-grpc`'s
client interceptor when the caller is itself inside a span — arrives on this
call's metadata and is extracted automatically by the server-side interceptor
before this coroutine runs, so `trace.get_current_span()` is already a child
of whatever span started the request. Logging that trace id here is half of
what verify.sh's trace-continuity assertion checks; QuoteServiceServicer logs
the other half.

The other four RoutingService methods are declared in the proto for later
chapters. They are intentionally left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import logging

import grpc
from opentelemetry import trace

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

logger = logging.getLogger("ch21-observability-python")

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
        trace_id = format(trace.get_current_span().get_span_context().trace_id, "032x")

        downstream_request = quote_pb2.GetQuoteRequest(
            origin=origin, destination=destination, cargo=request.cargo
        )

        logger.info(
            "RoutingServiceServicer.GetQuote trace_id=%s %s -> %s, calling QuoteService",
            trace_id,
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
