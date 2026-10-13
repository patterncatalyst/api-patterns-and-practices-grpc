"""Ch10 deadline-propagation ANCHOR — Python side entrypoint.

Starts ONE asyncio grpc.aio server exposing BOTH
shipping.routing.v1.RoutingService and shipping.quote.v1.QuoteService on
GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9101 by ../compose.yaml), with server reflection enabled for both
services so grpcurl can call either without a local copy of the .proto.

RoutingServiceServicer needs a client of its own: a LOOPBACK grpc.aio channel
back to this same process's own port, so that RoutingService.GetQuote's call
to QuoteService.GetQuote is a real gRPC hop a deadline has to cross — not a
same-object method call that happens to look like one. See
app/routing_service.py for how the remaining budget crosses that hop.

Run with the `opentelemetry-instrument` wrapper (see ../Containerfile) for
zero-code OTLP tracing of both the server and the loopback client channel
when the opt-in `observability` compose profile is up; without a reachable
collector the OTLP exporter just logs failed exports in the background — it
never blocks startup or a GetQuote call.
"""
from __future__ import annotations

import asyncio
import logging
import os

import grpc
from grpc_reflection.v1alpha import reflection

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.quote_service import QuoteServiceServicer
from app.routing_service import RoutingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch10-deadlines-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")


async def serve() -> None:
    server = grpc.aio.server()

    # The loopback channel RoutingServiceServicer calls downstream. grpc.aio
    # channels connect lazily on first use, so creating it before the server
    # itself is listening is safe — by the time any GetQuote request arrives
    # to use it, the server below is already up.
    quote_channel = grpc.aio.insecure_channel(f"localhost:{PORT}")
    quote_stub = quote_pb2_grpc.QuoteServiceStub(quote_channel)

    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(quote_stub), server)
    quote_pb2_grpc.add_QuoteServiceServicer_to_server(QuoteServiceServicer(), server)

    service_names = (
        routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name,
        quote_pb2.DESCRIPTOR.services_by_name["QuoteService"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    bind_addr = f"{HOST}:{PORT}"
    server.add_insecure_port(bind_addr)
    await server.start()
    logger.info(
        "ch10-deadlines-python: shipping.routing.v1.RoutingService and "
        "shipping.quote.v1.QuoteService both listening on %s "
        "(RoutingService.GetQuote calls QuoteService.GetQuote over a loopback "
        "channel; see README.md)",
        bind_addr,
    )
    try:
        await server.wait_for_termination()
    finally:
        await quote_channel.close()


if __name__ == "__main__":
    asyncio.run(serve())
