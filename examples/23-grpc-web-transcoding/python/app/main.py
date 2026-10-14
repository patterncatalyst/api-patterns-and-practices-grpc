"""Ch23 grpc-web & JSON/HTTP transcoding — Python side entrypoint.

Starts, in ONE process and ONE asyncio event loop:

  1. A grpc.aio server exposing BOTH shipping.routing.v1.RoutingService and
     shipping.quote.v1.QuoteService on GRPC_HOST:GRPC_PORT (default
     0.0.0.0:9000 — container port 9000, mapped to host 9231 by
     ../compose.yaml; Envoy's "app" cluster, ../envoy/envoy-python.yaml, also
     dials this same port, by its in-network name "python:9000"), with
     server reflection enabled (what grpcurl — NOT Envoy's transcoder, which
     reads a baked-in descriptor instead — needs for the native-gRPC path).
  2. A uvicorn ASGI server running the FastAPI app from app/api.py on
     HTTP_HOST:HTTP_PORT (default 0.0.0.0:8000 — container port 8000, mapped
     to host 8231 by ../compose.yaml), exposing POST /booking/quote, the
     hand-written REST shim this chapter contrasts against Envoy's transcoder.

RoutingServiceServicer needs a client of its own (a LOOPBACK grpc.aio channel
back to this same process's own port, so RoutingService.GetQuote's call to
QuoteService.GetQuote is a real gRPC hop), and so does the FastAPI booking
handler (to call RoutingService.GetQuote). Both reuse the SAME loopback
channel — a grpc.aio.Channel supports any number of stubs for any number of
services at the address it connects to, so there is no reason to open a
second TCP connection to the same port.

Run with the `opentelemetry-instrument` wrapper (see ../Containerfile) for
zero-code OTLP tracing when the opt-in `observability` compose profile is
active. Without a reachable collector the OTLP exporter just logs failed
exports in the background — it never blocks startup or a request.
"""
from __future__ import annotations

import asyncio
import logging
import os

import grpc
import uvicorn
from grpc_reflection.v1alpha import reflection

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.api import create_app
from app.quote_service import QuoteServiceServicer
from app.routing_service import RoutingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch23-grpc-web-python")

GRPC_HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
GRPC_PORT = os.environ.get("GRPC_PORT", "9000")
HTTP_HOST = os.environ.get("HTTP_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8000"))


async def serve() -> None:
    server = grpc.aio.server()

    # The loopback channel both RoutingServiceServicer (downstream to
    # QuoteService) and the FastAPI booking handler (into RoutingService)
    # dial. grpc.aio channels connect lazily on first use, so creating it
    # before the server itself is listening is safe.
    loopback_channel = grpc.aio.insecure_channel(f"localhost:{GRPC_PORT}")
    quote_stub = quote_pb2_grpc.QuoteServiceStub(loopback_channel)
    routing_stub = routing_pb2_grpc.RoutingServiceStub(loopback_channel)

    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(quote_stub), server)
    quote_pb2_grpc.add_QuoteServiceServicer_to_server(QuoteServiceServicer(), server)

    routing_full_name = routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name
    quote_full_name = quote_pb2.DESCRIPTOR.services_by_name["QuoteService"].full_name

    service_names = (
        routing_full_name,
        quote_full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    grpc_bind_addr = f"{GRPC_HOST}:{GRPC_PORT}"
    server.add_insecure_port(grpc_bind_addr)
    await server.start()
    logger.info(
        "ch23-grpc-web-python: shipping.routing.v1.RoutingService and "
        "shipping.quote.v1.QuoteService listening on %s (native gRPC, reflection on)",
        grpc_bind_addr,
    )

    http_app = create_app(routing_stub)
    http_config = uvicorn.Config(http_app, host=HTTP_HOST, port=HTTP_PORT, log_level="info")
    http_server = uvicorn.Server(http_config)

    logger.info(
        "ch23-grpc-web-python: POST /booking/quote (REST shim) listening on %s:%d; "
        "see ../envoy/ for the grpc_json_transcoder + grpc_web front door (see README.md)",
        HTTP_HOST,
        HTTP_PORT,
    )

    try:
        # Run the gRPC server's termination wait and the HTTP server side by
        # side in this one event loop; either one raising tears both down.
        await asyncio.gather(server.wait_for_termination(), http_server.serve())
    finally:
        await loopback_channel.close()


if __name__ == "__main__":
    asyncio.run(serve())
