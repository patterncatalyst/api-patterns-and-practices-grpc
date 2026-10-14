"""Ch21 observability ANCHOR — the DOWNSTREAM service
RoutingServiceServicer.GetQuote calls over its own loopback grpc.aio channel
(see app/routing_service.py and app/main.py). Unlike Ch10, there is no
artificial delay here — this chapter's point is tracing and metrics, not
deadline propagation, so the hop stays fast.

`opentelemetry-instrumentation-grpc`'s server interceptor (installed by the
`opentelemetry-instrument` wrapper — see ../Containerfile) extracts the W3C
`traceparent` the caller's instrumented client channel injected into this
call's metadata and starts THIS method's span as a CHILD of that caller
BEFORE this coroutine runs, so `trace.get_current_span()` below is already
inside a span whose trace id matches whatever trace the original REST
request started. Logging that trace id here, and logging the SAME trace id
in RoutingServiceServicer.GetQuote, is exactly what verify.sh greps for:
proof that the traceparent survived the loopback gRPC hop end to end.
"""
from __future__ import annotations

import logging

import grpc
from opentelemetry import trace

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc

from app.quote import compute_quote

logger = logging.getLogger("ch21-observability-python")


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
