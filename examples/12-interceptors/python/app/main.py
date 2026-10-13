"""Ch12 interceptors ANCHOR — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.routing.v1.RoutingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9121 by ../compose.yaml), with server reflection enabled so grpcurl can
`list`/`describe`/call it without a local copy of the .proto.

`interceptors=[AuthLoggingInterceptor()]` is the whole wiring: grpc.aio runs
every registered interceptor's `intercept_service` for every incoming call,
in list order, before the call reaches RoutingServiceServicer. There's no
per-service opt-in/opt-out here — unlike Quarkus's @GlobalInterceptor vs.
@RegisterInterceptor split, a grpc.aio interceptor list is already global to
the one grpc.aio.server() it's passed to.

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

from app.interceptors import AuthLoggingInterceptor
from app.routing_service import RoutingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch12-routing-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")


async def serve() -> None:
    server = grpc.aio.server(interceptors=[AuthLoggingInterceptor()])
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
        "ch12-routing-python: shipping.routing.v1.RoutingService listening on %s "
        "behind AuthLoggingInterceptor (logs+times every call; rejects calls "
        "missing 'authorization' metadata with UNAUTHENTICATED)",
        bind_addr,
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
