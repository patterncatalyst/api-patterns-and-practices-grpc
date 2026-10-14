"""Ch19 tls-mtls — Python side entrypoint.

Starts an asyncio grpc.aio server exposing shipping.routing.v1.RoutingService
on GRPC_HOST:GRPC_PORT (default 0.0.0.0:9000 — container port 9000, mapped to
host 9191 by ../compose.yaml), over TLS/mTLS instead of the plaintext port
every prior chapter used, with server reflection enabled so grpcurl can
`list`/`describe`/call it the same way it does any other chapter's server —
reflection is an ordinary unary RPC and works identically over a TLS/mTLS
channel. The one-line swap is `add_secure_port` in place of `add_insecure_port`,
backed by server transport credentials built once at startup from the PEM
files certgen (see ../../certgen/) writes into the shared /certs volume:

    server_credentials = grpc.ssl_server_credentials(
        [(server_key_bytes, server_cert_bytes)],
        root_certificates=ca_cert_bytes,
        require_client_auth=GRPC_CLIENT_AUTH == "REQUIRED",
    )
    server.add_secure_port(bind_addr, server_credentials)

root_certificates (the CA other client certs must chain to) is loaded unconditionally, same as Quarkus's
quarkus.grpc.server.ssl.trust-store — unused when require_client_auth is
False, so flipping GRPC_CLIENT_AUTH never needs a second code path.
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

import grpc
from grpc_reflection.v1alpha import reflection

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.routing_service import RoutingServiceServicer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ch19-routing-python")

HOST = os.environ.get("GRPC_HOST", "0.0.0.0")
PORT = os.environ.get("GRPC_PORT", "9000")
CERTS_DIR = Path(os.environ.get("CERTS_DIR", "/certs"))

# REQUIRED (handshake fails without a client cert) or anything else (no
# client cert requested) — the Python API only has an on/off switch, unlike
# Vert.x's three-value NONE/REQUEST/REQUIRED enum Quarkus's
# quarkus.grpc.server.ssl.client-auth exposes; REQUIRED is this example's
# steady state, same default as the Quarkus side.
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
    server = grpc.aio.server()
    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)

    service_names = (
        routing_pb2.DESCRIPTOR.services_by_name["RoutingService"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    bind_addr = f"{HOST}:{PORT}"
    server.add_secure_port(bind_addr, _build_server_credentials())
    await server.start()
    logger.info(
        "ch19-routing-python: shipping.routing.v1.RoutingService listening on %s "
        "over TLS (require_client_auth=%s); see README.md",
        bind_addr,
        CLIENT_AUTH == "REQUIRED",
    )
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
