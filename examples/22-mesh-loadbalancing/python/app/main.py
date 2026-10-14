"""Ch22 mesh-loadbalancing — the GetQuote server pods this chapter's demo
load-balances across.

Three replicas of this exact image run in the cluster (see ../../k8s/deployment.yaml).
They are otherwise unremarkable: the only addition over Ch7's server is the
`x-served-by` trailer set in routing_service.py. Server reflection stays on
so a human can `grpcurl` a single pod directly for a sanity check; the demo
itself never uses grpcurl in the load-generation path (see loadclient.py's
module docstring for why).
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
logger = logging.getLogger("ch22-routing-python")

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
        "ch22-routing-python: shipping.routing.v1.RoutingService listening on %s "
        "(pod=%s)",
        bind_addr,
        os.environ.get("HOSTNAME", "unknown"),
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
