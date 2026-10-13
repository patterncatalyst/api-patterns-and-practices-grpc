"""Ch0 prerequisites SKELETON — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.routing.v1.RoutingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9001 by ../compose.yaml), with server reflection enabled so grpcurl can
`list`/`describe`/call it without a local copy of the .proto.

Run with the `opentelemetry-instrument` wrapper (see ../Containerfile) for
zero-code OTLP tracing when the opt-in `observability` compose profile is
up; without a reachable collector the OTLP exporter just logs failed
exports in the background — it never blocks startup or a GetQuote call.
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
logger = logging.getLogger("ch00-prereq-python")

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
        "ch00-prereq-python: shipping.routing.v1.RoutingService listening on %s "
        "(GetQuote returns a canned response; see Chapter 5 for the real formula)",
        bind_addr,
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
