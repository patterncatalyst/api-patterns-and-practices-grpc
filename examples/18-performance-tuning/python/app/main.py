"""Ch18 performance-tuning — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.routing.v1.RoutingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9181 by ../compose.yaml), with server reflection enabled so grpcurl can
`list`/`describe`/call it without a local copy of the .proto.

This chapter's tuning levers, all set via the `options` tuple grpc.aio.server
accepts — the Python stack's equivalent of Quarkus's
quarkus.grpc.server.max-inbound-message-size / .netty.keep-alive-time /
.netty.permit-keep-alive-time / .netty.permit-keep-alive-without-calls /
.compression (see README.md for the full cross-stack key-name table):

  grpc.max_receive_message_length / grpc.max_send_message_length
      Raised to MAX_MESSAGE_BYTES (16MB) — grpc core's default receive cap
      is 4MB; Quarkus's separate-server default is also 4MB. Both stacks
      get the same raised number.
  grpc.keepalive_time_ms / grpc.keepalive_timeout_ms /
  grpc.keepalive_permit_without_calls
      Matches Quarkus's netty.keep-alive-time / (no direct Python
      equivalent of keep-alive-timeout beyond this) / netty.permit-keep-
      alive-without-calls.
  grpc.http2.min_ping_interval_without_data_ms
      The floor on how often THIS server will tolerate a client-initiated
      ping with no RPCs in flight — grpc core's name for the same knob
      Quarkus calls netty.permit-keep-alive-time.
  compression=grpc.Compression.Gzip
      Forces gzip on every response this server sends, the same as setting
      quarkus.grpc.server.compression=gzip.

Run with the `opentelemetry-instrument` wrapper (see ../Containerfile) for
zero-code OTLP tracing when the opt-in `observability` compose profile is
up; without a reachable collector the OTLP exporter just logs failed
exports in the background — it never blocks startup or a call.
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
logger = logging.getLogger("ch18-performance-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")

# This chapter's tuning constants — kept here, at the top, as the single
# source of truth the README/chapter numbers are quoted from.
MAX_MESSAGE_BYTES = 16 * 1024 * 1024  # 16MB, raised past gRPC's 4MB default.
KEEPALIVE_TIME_MS = 5_000  # Production: tens of seconds to minutes. Shortened
KEEPALIVE_TIMEOUT_MS = 5_000  # here only so keepalive_client.py's idle gap
PERMIT_KEEPALIVE_TIME_MS = 5_000  # fits inside a verify.sh run.


async def serve() -> None:
    server = grpc.aio.server(
        options=[
            ("grpc.max_receive_message_length", MAX_MESSAGE_BYTES),
            ("grpc.max_send_message_length", MAX_MESSAGE_BYTES),
            ("grpc.keepalive_time_ms", KEEPALIVE_TIME_MS),
            ("grpc.keepalive_timeout_ms", KEEPALIVE_TIMEOUT_MS),
            ("grpc.keepalive_permit_without_calls", 1),
            ("grpc.http2.min_ping_interval_without_data_ms", PERMIT_KEEPALIVE_TIME_MS),
        ],
        compression=grpc.Compression.Gzip,
    )
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
        "ch18-performance-python: shipping.routing.v1.RoutingService listening on %s "
        "(GetQuote + ListRoutes implemented; max-message-size=%d keepalive_time_ms=%d "
        "gzip compression on; see README.md)",
        bind_addr,
        MAX_MESSAGE_BYTES,
        KEEPALIVE_TIME_MS,
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
