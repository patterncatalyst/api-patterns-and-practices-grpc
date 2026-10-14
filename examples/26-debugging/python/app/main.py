"""Ch26 debugging — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.routing.v1.RoutingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9261 by ../compose.yaml), with server reflection enabled so grpcurl can
`list`/`describe`/call it without a local copy of the .proto — unchanged from
every prior chapter.

This chapter ALSO registers grpc_channelz.v1.Channelz on the same server and
port: quarkus-grpc 3.40.x ships no channelz support at all (no mention of it
anywhere in the quarkus-grpc reference guide or the service-implementation
guide — confirmed by searching both before writing this chapter), so the
channelz diagnosis path this chapter teaches is Python-only. See README.md
for the accounting of that gap and what Quarkus offers instead
(reflection, structured logs, and GRPC_TRACE/GRPC_VERBOSITY on a grpc-python
caller talking to it).
"""
from __future__ import annotations

import asyncio
import logging
import os

import grpc
from grpc_channelz.v1 import channelz, channelz_pb2, channelz_pb2_grpc
from grpc_reflection.v1alpha import reflection

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.routing_service import RoutingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch26-routing-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")


async def serve() -> None:
    server = grpc.aio.server()
    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)

    # channelz: exposes grpc.channelz.v1.Channelz/{GetServers,GetServerSockets,
    # GetChannel,...} on this SAME port — no separate admin port, no extra
    # listener. channelz.aio.ChannelzServicer() is the asyncio-server variant;
    # the sync grpc.server() case (not used here) would use
    # channelz.add_channelz_servicer(server) instead.
    channelz_pb2_grpc.add_ChannelzServicer_to_server(channelz.aio.ChannelzServicer(), server)

    service_names = (
        routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name,
        channelz_pb2.DESCRIPTOR.services_by_name["Channelz"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    bind_addr = f"{HOST}:{PORT}"
    server.add_insecure_port(bind_addr)
    await server.start()
    logger.info(
        "ch26-routing-python: shipping.routing.v1.RoutingService + "
        "grpc.channelz.v1.Channelz listening on %s (GetQuote implemented "
        "with an artificial delay; see README.md)",
        bind_addr,
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
