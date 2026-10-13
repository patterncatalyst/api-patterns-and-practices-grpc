"""Ch10 deadline-propagation ANCHOR — the DOWNSTREAM service
RoutingServiceServicer.GetQuote calls over its own loopback grpc.aio channel
(see app/routing_service.py and app/main.py). Artificially slow by design:
every call takes ~2s before it answers, which is the whole point of this
chapter's example — a caller whose budget can't cover that wait has to find
out in well under 2s, not after paying for it.

The delay is `asyncio.sleep`, an awaitable that asyncio can and does cancel
mid-wait, not a blocking call. That matters for cancellation: when
RoutingServiceServicer's downstream deadline expires, grpc.aio cancels the
asyncio Task running this coroutine, `asyncio.sleep` raises
`asyncio.CancelledError` immediately rather than running out its full 2s, and
the method aborts there. A well-behaved server doesn't just stop CARING about
doomed work once it's told to stop; it stops DOING it.
"""
from __future__ import annotations

import asyncio
import logging

import grpc

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc

from app.quote import compute_quote

logger = logging.getLogger("ch10-deadlines-python")

_ARTIFICIAL_DELAY_S = 2.0


class QuoteServiceServicer(quote_pb2_grpc.QuoteServiceServicer):
    async def GetQuote(
        self,
        request: quote_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> quote_pb2.GetQuoteResponse:
        quote = compute_quote(request.cargo)
        logger.info(
            "QuoteService.GetQuote: %s -> %s, quote=%s %s (after a %.0fs artificial delay)",
            request.origin.un_locode,
            request.destination.un_locode,
            quote.currency,
            quote.amount,
            _ARTIFICIAL_DELAY_S,
        )

        try:
            await asyncio.sleep(_ARTIFICIAL_DELAY_S)
        except asyncio.CancelledError:
            logger.info(
                "QuoteService.GetQuote: downstream deadline expired upstream — "
                "abandoning the %.0fs delay early",
                _ARTIFICIAL_DELAY_S,
            )
            raise

        return quote_pb2.GetQuoteResponse(quote=quote)
