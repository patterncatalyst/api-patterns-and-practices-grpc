"""Ch26 debugging — UNAVAILABLE-on-a-cold-channel repro.

grpcurl dials blocking, before issuing any RPC. Against a port nothing is
listening on, it reports a raw dial failure — "Failed to dial target host
... connection refused" — with no gRPC status "Code:" line at all, the same
shape this chapter's TLS-handshake-failure repro produces and for the same
underlying reason: the call never reached gRPC's status machinery, because
no connection was ever established for a status to travel over.

A real application client, built the way Chapter 7 teaches (one channel,
built once, reused across calls), behaves differently: `grpc.aio.insecure_
channel(...)` returns immediately without dialing anything, and only
attempts to connect when a call is actually made on it. The first RPC
against a dead target therefore surfaces the condition AS a gRPC status —
`grpc.StatusCode.UNAVAILABLE` — on the call itself, rather than as a
pre-flight dial error grpcurl's own CLI can show. This script makes exactly
that call and asserts the one code grpcurl can never produce for this
condition.

Usage: python -m app.unavailable_probe <host:port>
"""
from __future__ import annotations

import asyncio
import sys

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

_REQUEST = routing_pb2.GetQuoteRequest(
    origin=types_pb2.Location(un_locode="USNYC"),
    destination=types_pb2.Location(un_locode="NLRTM"),
)


async def run(target: str) -> int:
    channel = grpc.aio.insecure_channel(target)
    try:
        stub = routing_pb2_grpc.RoutingServiceStub(channel)
        try:
            await stub.GetQuote(_REQUEST, timeout=5)
        except grpc.aio.AioRpcError as exc:
            print(f"unavailable_probe: target={target} code={exc.code()} details={exc.details()!r}")
            if exc.code() == grpc.StatusCode.UNAVAILABLE:
                print("unavailable_probe: ok — UNAVAILABLE on a cold/closed channel")
                return 0
            print(f"unavailable_probe: FAIL — expected UNAVAILABLE, got {exc.code()}", file=sys.stderr)
            return 1
        print("unavailable_probe: FAIL — call against a dead target unexpectedly succeeded", file=sys.stderr)
        return 1
    finally:
        await channel.close()


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python -m app.unavailable_probe <host:port>", file=sys.stderr)
        return 2
    return asyncio.run(run(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())
