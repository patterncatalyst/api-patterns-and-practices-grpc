"""Ch21 observability ANCHOR — Python side entrypoint.

Starts, in ONE process and ONE asyncio event loop:

  1. A grpc.aio server exposing BOTH shipping.routing.v1.RoutingService and
     shipping.quote.v1.QuoteService on GRPC_HOST:GRPC_PORT (default
     0.0.0.0:9000 — container port 9000, mapped to host 9211 by
     ../compose.yaml), with server reflection AND a grpc.health.v1.Health
     service enabled, and app.metrics.MetricsInterceptor recording
     grpc_server_* Prometheus metrics for every unary call.
  2. A uvicorn ASGI server running the FastAPI app from app/api.py on
     HTTP_HOST:HTTP_PORT (default 0.0.0.0:8000 — container port 8000, mapped
     to host 8211 by ../compose.yaml), exposing POST /booking/quote and
     GET /metrics.

RoutingServiceServicer needs a client of its own (a LOOPBACK grpc.aio channel
back to this same process's own port, so RoutingService.GetQuote's call to
QuoteService.GetQuote is a real gRPC hop), and so does the FastAPI booking
handler (to call RoutingService.GetQuote). Both reuse the SAME loopback
channel — a grpc.aio.Channel supports any number of stubs for any number of
services at the address it connects to, so there is no reason to open a
second TCP connection to the same port.

Run with the `opentelemetry-instrument` wrapper (see ../Containerfile) for
zero-code OTLP tracing of the grpc.aio server, the grpc.aio client channel,
AND the FastAPI app, all in one trace per request. Without a reachable
collector the OTLP exporter just logs failed exports in the background — it
never blocks startup or a request.
"""
from __future__ import annotations

import asyncio
import logging
import os

import grpc
import uvicorn
from grpc_health.v1 import health_pb2, health_pb2_grpc
from grpc_health.v1.health import aio as health_aio
from grpc_reflection.v1alpha import reflection

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.api import create_app
from app.metrics import MetricsInterceptor
from app.quote_service import QuoteServiceServicer
from app.routing_service import RoutingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch21-observability-python")

GRPC_HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
GRPC_PORT = os.environ.get("GRPC_PORT", "9000")
HTTP_HOST = os.environ.get("HTTP_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8000"))


async def serve() -> None:
    server = grpc.aio.server(interceptors=[MetricsInterceptor()])

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

    # grpc.health.v1.Health: grpcio ships no automatic registration the way
    # quarkus-grpc does, so this chapter wires it by hand — the Python-stack
    # counterpart of the Quarkus side's zero-config Health service.
    # `grpc_health.v1.health.aio.HealthServicer` (NOT the plain,
    # classic-grpc `health.HealthServicer`) is the asyncio-native
    # implementation whose `Check`/`set` are coroutines, matching this
    # grpc.aio server and MetricsInterceptor's `await inner(...)` call —
    # the classic servicer's synchronous `Check` raises
    # "object can't be awaited" if registered here instead. SERVING is set
    # for the overall server ("") and for each implemented service by name,
    # which is what `grpcurl -d '{"service":"..."}' ... Health/Check` looks up.
    health_servicer = health_aio.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    for service_name in ("", routing_full_name, quote_full_name):
        await health_servicer.set(service_name, health_pb2.HealthCheckResponse.SERVING)

    service_names = (
        routing_full_name,
        quote_full_name,
        health_pb2.DESCRIPTOR.services_by_name["Health"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    grpc_bind_addr = f"{GRPC_HOST}:{GRPC_PORT}"
    server.add_insecure_port(grpc_bind_addr)
    await server.start()
    logger.info(
        "ch21-observability-python: shipping.routing.v1.RoutingService, "
        "shipping.quote.v1.QuoteService, and grpc.health.v1.Health all listening on %s",
        grpc_bind_addr,
    )

    http_app = create_app(routing_stub)
    http_config = uvicorn.Config(http_app, host=HTTP_HOST, port=HTTP_PORT, log_level="info")
    http_server = uvicorn.Server(http_config)

    logger.info(
        "ch21-observability-python: POST /booking/quote and GET /metrics listening on %s:%d (see README.md)",
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
