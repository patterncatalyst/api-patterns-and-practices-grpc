"""Ch27 final project — Python side entrypoint.

Starts, in ONE process and ONE asyncio event loop:

  1. A grpc.aio server, over mTLS (require_client_auth=True — Ch19's shape),
     behind AuthzInterceptor (Ch20's shape, extended), exposing
     RoutingService (GetQuote, NegotiateRoute), QuoteService (the downstream
     hop), TrackingService (WatchShipment, ReportPositions), and
     grpc.health.v1.Health, on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 —
     mapped to host 9271 by ../compose.yaml).
  2. A uvicorn ASGI server running the FastAPI app from app/api.py on
     HTTP_HOST:HTTP_PORT (default 0.0.0.0:8000 — mapped to host 8271),
     exposing POST /booking/quote.

RoutingServiceServicer needs an mTLS+JWT client of its own to reach
QuoteService (a LOOPBACK secure channel back to this same process's own
port), and so does the FastAPI booking handler (to call RoutingService).
Both reuse the SAME loopback channel.

Run with the `opentelemetry-instrument` wrapper (see ../Containerfile) for
zero-code OTLP tracing of the grpc.aio server, the grpc.aio client channel,
and the FastAPI app, all in one trace per request.
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

import grpc
import uvicorn
from grpc_health.v1 import health_pb2, health_pb2_grpc
from grpc_health.v1.health import aio as health_aio
from grpc_reflection.v1alpha import reflection

from shipping.quote.v1 import quote_pb2, quote_pb2_grpc
from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.tracking.v1 import tracking_pb2, tracking_pb2_grpc

from app.api import create_app
from app.interceptors import AuthzInterceptor
from app.quote_service import QuoteServiceServicer
from app.routing_service import RoutingServiceServicer
from app.security import INTERNAL_METADATA, loopback_channel
from app.tracking_service import TrackingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch27-final-project-python")

GRPC_HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
GRPC_PORT = os.environ.get("GRPC_PORT", "9000")
HTTP_HOST = os.environ.get("HTTP_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8000"))
CERTS_DIR = Path(os.environ.get("CERTS_DIR", "/certs"))
CLIENT_AUTH = os.environ.get("GRPC_CLIENT_AUTH", "REQUIRED")


def _build_server_credentials() -> grpc.ServerCredentials:
    server_key = (CERTS_DIR / "server.key").read_bytes()
    server_cert = (CERTS_DIR / "server.crt").read_bytes()
    ca_cert = (CERTS_DIR / "ca.crt").read_bytes()
    return grpc.ssl_server_credentials(
        [(server_key, server_cert)],
        root_certificates=ca_cert,
        require_client_auth=(CLIENT_AUTH == "REQUIRED"),
    )


async def serve() -> None:
    server = grpc.aio.server(interceptors=[AuthzInterceptor()])

    # The loopback mTLS channel both RoutingServiceServicer (downstream to
    # QuoteService) and the FastAPI booking handler (into RoutingService)
    # dial, each call carrying the internal service bearer token.
    loopback = loopback_channel(GRPC_PORT)
    quote_stub = quote_pb2_grpc.QuoteServiceStub(loopback)
    routing_stub = routing_pb2_grpc.RoutingServiceStub(loopback)

    routing_pb2_grpc.add_RoutingServiceServicer_to_server(
        RoutingServiceServicer(quote_stub, INTERNAL_METADATA), server
    )
    quote_pb2_grpc.add_QuoteServiceServicer_to_server(QuoteServiceServicer(), server)
    tracking_pb2_grpc.add_TrackingServiceServicer_to_server(TrackingServiceServicer(), server)

    routing_full_name = routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name
    quote_full_name = quote_pb2.DESCRIPTOR.services_by_name["QuoteService"].full_name
    tracking_full_name = tracking_pb2.DESCRIPTOR.services_by_name["TrackingService"].full_name

    # grpc.health.v1.Health, wired by hand (grpcio ships no automatic
    # registration the way quarkus-grpc does). The asyncio-native
    # HealthServicer (health.aio), NOT the classic synchronous one — see
    # Ch21's "On the wire" note on this exact pitfall.
    health_servicer = health_aio.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    for service_name in ("", routing_full_name, quote_full_name, tracking_full_name):
        await health_servicer.set(service_name, health_pb2.HealthCheckResponse.SERVING)

    service_names = (
        routing_full_name,
        quote_full_name,
        tracking_full_name,
        health_pb2.DESCRIPTOR.services_by_name["Health"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    grpc_bind_addr = f"{GRPC_HOST}:{GRPC_PORT}"
    server.add_secure_port(grpc_bind_addr, _build_server_credentials())
    await server.start()
    logger.info(
        "ch27-final-project-python: RoutingService, QuoteService, TrackingService, and "
        "grpc.health.v1.Health all listening on %s over mTLS (require_client_auth=%s)",
        grpc_bind_addr,
        CLIENT_AUTH == "REQUIRED",
    )

    http_app = create_app(routing_stub)
    http_config = uvicorn.Config(http_app, host=HTTP_HOST, port=HTTP_PORT, log_level="info")
    http_server = uvicorn.Server(http_config)

    logger.info(
        "ch27-final-project-python: POST /booking/quote listening on %s:%d (see README.md)",
        HTTP_HOST,
        HTTP_PORT,
    )

    try:
        await asyncio.gather(server.wait_for_termination(), http_server.serve())
    finally:
        await loopback.close()


if __name__ == "__main__":
    asyncio.run(serve())
