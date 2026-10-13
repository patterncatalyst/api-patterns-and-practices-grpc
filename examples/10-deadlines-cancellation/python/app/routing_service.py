"""Ch10 deadline-propagation ANCHOR — GetQuote no longer prices the shipment
itself (that was Ch5/Ch11); it calls DOWNSTREAM
shipping.quote.v1.QuoteService.GetQuote over a loopback grpc.aio channel
(see app/main.py — QuoteServiceServicer runs in this same process) and wraps
its answer in a Route.

The deadline this call runs under did not start here: grpc.aio parsed it off
the inbound call's grpc-timeout metadata and makes it available as
`context.time_remaining()` — seconds left, or None if the caller set no
deadline at all. Every call here subtracts a small margin for this method's
own overhead and passes what's left as the DOWNSTREAM call's own `timeout=`,
so the budget the booking service's REST handler started with, minus
everything already spent reaching this method, is exactly the number
QuoteService gets to work with — one shared clock, not three independent
ones.

When that downstream call runs out of time, grpc.aio raises an
`AioRpcError(DEADLINE_EXCEEDED)` from the awaited call — not after
QuoteService's full 2s delay, but the moment the slice handed to it elapses.
`context.abort(...)` re-raises that same code to whoever called THIS method,
the same `context.abort_with_status` pattern Ch11 uses for rich errors — no
translation step needed.

The other four RoutingService methods are declared in the proto for later
chapters. They are intentionally left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import logging

import grpc

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

logger = logging.getLogger("ch10-deadlines-python")

_CARRIER = "MAERSK"

# Reserved off the inbound deadline for this method's own work (building the
# downstream request, constructing the Route) before the downstream slice is
# carved — never hand QuoteService 100% of a budget that this method itself
# has to spend part of first.
_DOWNSTREAM_MARGIN_S = 0.1

# Used only when a caller sets NO deadline at all on the inbound call — gRPC
# permits that, but "no deadline" must never mean "wait forever" for the
# downstream hop either. See Chapter 10's "deadline, not timeout" section.
_DEFAULT_DOWNSTREAM_TIMEOUT_S = 5.0


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

        remaining = context.time_remaining()
        if remaining is None:
            downstream_timeout = _DEFAULT_DOWNSTREAM_TIMEOUT_S
        else:
            downstream_timeout = remaining - _DOWNSTREAM_MARGIN_S
            if downstream_timeout <= 0:
                # The budget was already gone before this method could even start
                # the downstream call — failing fast here, with no network round
                # trip at all, is cheaper than letting grpc.aio discover the same
                # thing a few milliseconds later over the wire.
                logger.info(
                    "GetQuote: %s -> %s, no budget left to call QuoteService "
                    "(inbound deadline already expired)",
                    origin.un_locode,
                    destination.un_locode,
                )
                await context.abort(
                    grpc.StatusCode.DEADLINE_EXCEEDED,
                    "no budget remaining to call QuoteService.GetQuote",
                )

        downstream_request = quote_pb2.GetQuoteRequest(
            origin=origin, destination=destination, cargo=request.cargo
        )

        logger.info(
            "GetQuote: %s -> %s, calling QuoteService with a %.3fs downstream deadline",
            origin.un_locode,
            destination.un_locode,
            downstream_timeout,
        )

        try:
            quote_response = await self._quote_stub.GetQuote(downstream_request, timeout=downstream_timeout)
        except grpc.aio.AioRpcError as exc:
            logger.info(
                "GetQuote: QuoteService call failed (own context cancelled=%s): %s",
                context.cancelled(),
                exc.details(),
            )
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                await context.abort(
                    grpc.StatusCode.DEADLINE_EXCEEDED,
                    "QuoteService.GetQuote exceeded its downstream budget",
                )
            raise

        quote = quote_response.quote
        leg = types_pb2.Leg(carrier=_CARRIER, origin=origin, destination=destination)
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}",
            legs=[leg],
            price=quote,
        )

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)
