"""Ch26 debugging — GRPC_TRACE / GRPC_VERBOSITY demonstration.

grpc-python wraps the same C-core gRPC implementation grpc-java and grpc-c++
embed, so these two environment variables make it log low-level
transport/call activity to stderr: GRPC_VERBOSITY sets the minimum severity
(DEBUG/INFO/ERROR) the C-core will log at all, and GRPC_TRACE picks which
tracer subsystems log (a comma-separated list of names, or "all" for every
tracer — verbose enough to be useful only when narrowed to one or two names
in practice). grpcurl is built on grpc-go, a from-scratch Go implementation
that does not read either variable at all — its equivalents are
GRPC_GO_LOG_VERBOSITY_LEVEL and GRPC_GO_LOG_SEVERITY_LEVEL. See README.md.

This script makes one GetQuote call so verify.sh can run it with GRPC_TRACE
and GRPC_VERBOSITY set in the container environment and capture whatever the
C-core logs to stderr as a result. The exact lines are illustrative — they
vary between grpcio releases and between the two tracer names chosen —
verify.sh only asserts that output appeared at all.

Usage: python -m app.trace_probe <host:port>
"""
from __future__ import annotations

import asyncio
import sys

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

_REQUEST = routing_pb2.GetQuoteRequest(
    origin=types_pb2.Location(un_locode="USNYC", name="New York"),
    destination=types_pb2.Location(un_locode="NLRTM", name="Rotterdam"),
    cargo=[types_pb2.Cargo(weight_kg=1200.5, description="Palletized electronics", cargo_type="GENERAL")],
)


async def run(target: str) -> int:
    channel = grpc.aio.insecure_channel(target)
    try:
        stub = routing_pb2_grpc.RoutingServiceStub(channel)
        response = await stub.GetQuote(_REQUEST, timeout=10)
        print(f"trace_probe: GetQuote ok, quote.amount={response.quote.amount}", file=sys.stderr)
        return 0
    finally:
        await channel.close()


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python -m app.trace_probe <host:port>", file=sys.stderr)
        return 2
    return asyncio.run(run(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())
