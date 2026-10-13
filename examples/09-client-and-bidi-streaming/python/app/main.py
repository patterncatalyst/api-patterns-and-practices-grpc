"""Ch9 client-and-bidi-streaming — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.tracking.v1.TrackingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9091 by ../compose.yaml), with server reflection enabled so grpcurl can
`list`/`describe`/call it without a local copy of the .proto.

Run with the `opentelemetry-instrument` wrapper (see ../Containerfile) for
zero-code OTLP tracing when the opt-in `observability` compose profile is
up; without a reachable collector the OTLP exporter just logs failed
exports in the background — it never blocks startup or a ReportPositions/Sync
call.
"""
from __future__ import annotations

import asyncio
import logging
import os

import grpc
from grpc_reflection.v1alpha import reflection

from shipping.tracking.v1 import tracking_pb2, tracking_pb2_grpc

from app.tracking_service import TrackingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch09-tracking-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")


async def serve() -> None:
    server = grpc.aio.server()
    tracking_pb2_grpc.add_TrackingServiceServicer_to_server(TrackingServiceServicer(), server)

    service_names = (
        tracking_pb2.DESCRIPTOR.services_by_name["TrackingService"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    bind_addr = f"{HOST}:{PORT}"
    server.add_insecure_port(bind_addr)
    await server.start()
    logger.info(
        "ch09-tracking-python: shipping.tracking.v1.TrackingService listening on %s "
        "(ReportPositions + Sync implemented; see README.md)",
        bind_addr,
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
