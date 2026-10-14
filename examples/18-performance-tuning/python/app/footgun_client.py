"""Ch18 performance-tuning — the FOOTGUN demo client.

This is the #1 gRPC performance mistake made runnable: build a NEW
grpc.aio Channel (and a new stub from it) for EVERY call, instead of once
and reusing it. Each new channel pays the full HTTP/2 connection setup cost
(TCP connect + the HTTP/2 connection preface/SETTINGS exchange) before the
first RPC on it can even start — cost that pooled_client.py's single reused
channel pays exactly once, no matter how many calls follow.

Run against EITHER stack's server, from this image's own venv (verify.sh
invokes it via `docker compose run --rm python python -m app.footgun_client
<host:port> <calls>`, pointed at the `quarkus` or `python` compose service's
in-network address, container port 9000).

Prints exactly one line to stdout: the total wall-clock elapsed seconds for
all <calls> calls. Everything else goes to stderr, so a caller can capture
just the number (the same convention Ch15's verify.sh timing helpers use).

Usage:
    python -m app.footgun_client quarkus:9000 50
    python -m app.footgun_client python:9000 50
"""
from __future__ import annotations

import asyncio
import sys
import time

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

# The same single-cargo-item request used throughout this book's unary
# chapters: 1200.5kg * 2.50 = 3001.25.
_REQUEST = routing_pb2.GetQuoteRequest(
    origin=types_pb2.Location(un_locode="USNYC", name="New York"),
    destination=types_pb2.Location(un_locode="NLRTM", name="Rotterdam"),
    cargo=[types_pb2.Cargo(weight_kg=1200.5, description="Palletized electronics", cargo_type="GENERAL")],
)


async def run(target: str, calls: int) -> int:
    amounts: list[str] = []

    start = time.monotonic()
    for i in range(calls):
        # THE FOOTGUN: a fresh channel, and a fresh stub from it, every
        # iteration. Each one re-pays connection setup before GetQuote can
        # even be sent.
        channel = grpc.aio.insecure_channel(target)
        stub = routing_pb2_grpc.RoutingServiceStub(channel)
        try:
            response = await stub.GetQuote(_REQUEST)
            amounts.append(response.quote.amount)
        finally:
            await channel.close()
        print(f"footgun_client: call {i + 1}/{calls} -> quote.amount={response.quote.amount} "
              f"(new channel id={id(channel)})", file=sys.stderr)
    elapsed = time.monotonic() - start

    if len(set(amounts)) != 1:
        print(f"footgun_client: FAIL — responses disagree across calls: {amounts}", file=sys.stderr)
        return 1

    print(f"footgun_client: {calls} calls, one new channel per call, target={target}, "
          f"total={elapsed:.6f}s", file=sys.stderr)
    print(f"{elapsed:.6f}")
    return 0


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: python -m app.footgun_client <host:port> <calls>", file=sys.stderr)
        return 2
    target = sys.argv[1]
    calls = int(sys.argv[2])
    return asyncio.run(run(target, calls))


if __name__ == "__main__":
    raise SystemExit(main())
