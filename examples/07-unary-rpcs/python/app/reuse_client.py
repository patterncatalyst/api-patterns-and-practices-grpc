"""Ch7 unary-rpcs — the channel/stub reuse demo client.

This is the chapter's teaching point made runnable: build ONE grpc.aio
Channel and ONE RoutingServiceStub from it, then call GetQuote on that same
stub repeatedly. The channel (one HTTP/2 connection, handshaken once) and
the stub (a thin typed wrapper over it) are each created exactly once,
outside the loop — the opposite of the #1 gRPC performance footgun, a new
channel per call.

Run against EITHER stack's server, from this image's own venv (verify.sh
invokes it via `docker compose run --rm --entrypoint python python -m
app.reuse_client <host:port> <calls> [expected-amount]`, pointed at the
`quarkus` or `python` compose service's in-network address, container port
9000 — not the host-mapped 9070/9071 ports, since this runs *inside* the
compose network, not from the host). Both stacks answer identically because
both implement the same proto-generated GetQuote.

Usage:
    python -m app.reuse_client quarkus:9000 3 3001.25
    python -m app.reuse_client python:9000 3 3001.25
"""
from __future__ import annotations

import asyncio
import sys

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

# The same single-cargo-item request used throughout this chapter:
# 1200.5kg * 2.50 = 3001.25.
_REQUEST = routing_pb2.GetQuoteRequest(
    origin=types_pb2.Location(un_locode="USNYC", name="New York"),
    destination=types_pb2.Location(un_locode="NLRTM", name="Rotterdam"),
    cargo=[types_pb2.Cargo(weight_kg=1200.5, description="Palletized electronics", cargo_type="GENERAL")],
)


async def run(target: str, calls: int, expected_amount: str | None) -> int:
    # ONE channel, built once. Everything below reuses it.
    channel = grpc.aio.insecure_channel(target)
    # ONE stub, built once from that one channel. Cheap: no network I/O
    # happens here, just a typed wrapper around `channel`.
    stub = routing_pb2_grpc.RoutingServiceStub(channel)

    print(f"reuse_client: one channel id={id(channel)}, one stub id={id(stub)}, target={target}")

    amounts: list[str] = []
    try:
        for i in range(calls):
            # Same stub object, same underlying channel, every iteration —
            # no `grpc.aio.insecure_channel(...)` call inside this loop.
            response = await stub.GetQuote(_REQUEST)
            amounts.append(response.quote.amount)
            print(f"reuse_client: call {i + 1}/{calls} -> quote.amount={response.quote.amount}")
    finally:
        await channel.close()

    if len(set(amounts)) != 1:
        print(f"reuse_client: FAIL — responses disagree across calls on the same stub: {amounts}", file=sys.stderr)
        return 1

    if expected_amount is not None and amounts[0] != expected_amount:
        print(
            f"reuse_client: FAIL — expected quote.amount={expected_amount}, got {amounts[0]}",
            file=sys.stderr,
        )
        return 1

    print(f"reuse_client: ok — {calls} calls on one reused channel/stub, all quote.amount={amounts[0]}")
    return 0


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: python -m app.reuse_client <host:port> <calls> [expected-amount]", file=sys.stderr)
        return 2
    target = sys.argv[1]
    calls = int(sys.argv[2])
    expected_amount = sys.argv[3] if len(sys.argv) > 3 else None
    return asyncio.run(run(target, calls, expected_amount))


if __name__ == "__main__":
    raise SystemExit(main())
