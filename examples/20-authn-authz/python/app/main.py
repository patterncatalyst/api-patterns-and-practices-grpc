"""Ch20 authn-authz — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.routing.v1.RoutingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9201 by ../compose.yaml), with server reflection enabled so grpcurl can
`list`/`describe`/call it with no local copy of the .proto.

`interceptors=[AuthzInterceptor()]` is the whole wiring, same as Chapter 12:
grpc.aio runs every registered interceptor's `intercept_service` for every
incoming call, in list order, before the call reaches
RoutingServiceServicer. AuthzInterceptor now does three things instead of
Chapter 12's two: verify a JWT's signature and expiry, then check the scope
it grants against the method being called — see app/interceptors.py and
app/auth.py.
"""
from __future__ import annotations

import asyncio
import logging
import os

import grpc
from grpc_reflection.v1alpha import reflection

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.interceptors import AuthzInterceptor
from app.routing_service import RoutingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch20-routing-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")


async def serve() -> None:
    server = grpc.aio.server(interceptors=[AuthzInterceptor()])
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
        "ch20-routing-python: shipping.routing.v1.RoutingService listening on %s "
        "behind AuthzInterceptor (JWT signature+expiry, then per-method scope; "
        "reflection exempt)",
        bind_addr,
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
