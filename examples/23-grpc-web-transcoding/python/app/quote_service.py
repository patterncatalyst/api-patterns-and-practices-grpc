"""Ch23 grpc-web & JSON/HTTP transcoding — the DOWNSTREAM service
RoutingServiceServicer.GetQuote calls over its own loopback grpc.aio channel
(see app/routing_service.py and app/main.py). Identical to Ch21/Ch18's
QuoteServiceServicer: this chapter adds nothing to the server itself, only a
proxy (Envoy) in front of it — see ../../envoy/.
"""
from __future__ import annotations

import logging

import grpc

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc

from app.quote import compute_quote

logger = logging.getLogger("ch23-grpc-web-python")


class QuoteServiceServicer(quote_pb2_grpc.QuoteServiceServicer):
    async def GetQuote(
        self,
        request: quote_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> quote_pb2.GetQuoteResponse:
        quote = compute_quote(request.cargo)

        logger.info(
            "QuoteServiceServicer.GetQuote %s -> %s quote=%s %s",
            request.origin.un_locode,
            request.destination.un_locode,
            quote.currency,
            quote.amount,
        )

        return quote_pb2.GetQuoteResponse(quote=quote)
