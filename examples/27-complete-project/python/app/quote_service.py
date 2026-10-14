"""Ch27 final project — the DOWNSTREAM service RoutingServiceServicer.GetQuote
calls over its own mTLS+JWT loopback channel (see app/security.py and
app/routing_service.py). Logging the trace id here, and the SAME trace id in
RoutingServiceServicer.GetQuote, is what this example's trace-id-continuity
assertion greps `docker compose logs` for — proof the W3C traceparent
survived the loopback gRPC hop.
"""
from __future__ import annotations

import logging

import grpc
from opentelemetry import trace

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc

from app.quote import compute_quote

logger = logging.getLogger("ch27-final-project-python")


class QuoteServiceServicer(quote_pb2_grpc.QuoteServiceServicer):
    async def GetQuote(
        self,
        request: quote_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> quote_pb2.GetQuoteResponse:
        quote = compute_quote(request.cargo)
        trace_id = format(trace.get_current_span().get_span_context().trace_id, "032x")

        logger.info(
            "QuoteServiceServicer.GetQuote trace_id=%s %s -> %s quote=%s %s",
            trace_id,
            request.origin.un_locode,
            request.destination.un_locode,
            quote.currency,
            quote.amount,
        )

        return quote_pb2.GetQuoteResponse(quote=quote)
