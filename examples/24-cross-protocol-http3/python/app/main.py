"""Ch24 cross-protocol-http3 — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.routing.v1.RoutingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9241 by ../compose.yaml), with server reflection enabled so grpcurl can
`list`/`describe`/call it without a local copy of the .proto.

This server speaks gRPC the only way grpcio knows how as of this writing —
native gRPC over HTTP/2. It shares a compose network with a separate Caddy
service used for an unrelated HTTP/3-over-QUIC transport probe
(app/h3_probe.py) — see the chapter prose for why those two things are kept
apart.
"""
from __future__ import annotations

import asyncio
import logging
import os

import grpc
from grpc_reflection.v1alpha import reflection

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.routing_service import RoutingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch24-routing-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")


async def serve() -> None:
    server = grpc.aio.server()
    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)

    service_names = (
        routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    bind_addr = f"{HOST}:{PORT}"
    server.add_insecure_port(bind_addr)
    await server.start()
    logger.info(
        "ch24-routing-python: shipping.routing.v1.RoutingService listening on %s "
        "(GetQuote only, native gRPC/HTTP2; see README.md)",
        bind_addr,
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
