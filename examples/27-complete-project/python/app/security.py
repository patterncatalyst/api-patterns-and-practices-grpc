"""Ch27 final project — builds the ONE kind of internal gRPC client this
module needs: a loopback mTLS channel to this process's own
`localhost:GRPC_PORT` (the same mTLS-required, JWT-gated port every external
grpcurl/ghz caller hits), plus the internal service bearer token every
loopback call attaches as per-call metadata. Mirrors the Quarkus side's
security/SecureGrpcClients.java + InternalTokenIssuer.java.
"""
from __future__ import annotations

import os
from pathlib import Path

import grpc

from app.auth import mint_internal_token

CERTS_DIR = Path(os.environ.get("CERTS_DIR", "/certs"))

# Minted once at import time; 24h validity means no refresh logic is needed
# for a call path nothing external ever presents this token on.
INTERNAL_TOKEN = mint_internal_token()
INTERNAL_METADATA = (("authorization", f"Bearer {INTERNAL_TOKEN}"),)


def loopback_channel(port: str) -> grpc.aio.Channel:
    ca_cert = (CERTS_DIR / "ca.crt").read_bytes()
    client_key = (CERTS_DIR / "client.key").read_bytes()
    client_cert = (CERTS_DIR / "client.crt").read_bytes()
    credentials = grpc.ssl_channel_credentials(
        root_certificates=ca_cert,
        private_key=client_key,
        certificate_chain=client_cert,
    )
    # The SAN list certgen writes into server.crt covers "localhost" (see
    # certgen/gen-certs.sh), so no ssl_target_name_override is needed.
    return grpc.aio.secure_channel(f"localhost:{port}", credentials)
