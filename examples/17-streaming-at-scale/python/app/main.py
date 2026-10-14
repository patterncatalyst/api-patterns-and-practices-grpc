"""Ch17 streaming-at-scale example — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.tracking.v1.TrackingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9171 by ../compose.yaml), with server reflection enabled so grpcurl can
`list`/`describe`/call it without a local copy of the .proto, and server
keepalive configured via the server's `options` tuple (grpc.aio.server takes
the same channel-argument options the sync grpc.server API does — see
https://github.com/grpc/grpc/blob/master/doc/keepalive.md for what each key
does):

    grpc.keepalive_time_ms                      -> how often THIS server
        pings an otherwise-silent client to prove the connection is still
        alive (mirrors Quarkus's quarkus.grpc.server.netty.keep-alive-time).
    grpc.keepalive_timeout_ms                    -> how long the server waits
        for a ping ACK before considering the connection dead.
    grpc.keepalive_permit_without_calls          -> whether the server itself
        keeps pinging on a connection with no RPC in flight.
    grpc.http2.min_ping_interval_without_data_ms -> the shortest ping
        interval this server accepts from a CLIENT's own keepalive pings on
        an otherwise-idle connection before treating them as abusive
        (mirrors Quarkus's netty.permit-keep-alive-time).

Run with the `opentelemetry-instrument` wrapper (see ../Containerfile) for
zero-code OTLP tracing when the opt-in `observability` compose profile is
up; without a reachable collector the OTLP exporter just logs failed
exports in the background — it never blocks startup or a WatchShipment call.
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
logger = logging.getLogger("ch17-streaming-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")

KEEPALIVE_OPTIONS = [
    ("grpc.keepalive_time_ms", 30_000),
    ("grpc.keepalive_timeout_ms", 10_000),
    ("grpc.keepalive_permit_without_calls", 1),
    ("grpc.http2.min_ping_interval_without_data_ms", 10_000),
]


async def serve() -> None:
    server = grpc.aio.server(options=KEEPALIVE_OPTIONS)
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
        "ch17-streaming-python: shipping.tracking.v1.TrackingService listening on %s "
        "(WatchShipment is a demand-driven async generator; see README.md for the "
        "bkg_demo / bkg_eager / bkg_quiet modes)",
        bind_addr,
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
