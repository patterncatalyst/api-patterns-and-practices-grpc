"""Ch18 performance-tuning — the POOLED (reused channel) demo client.

The fix for footgun_client.py's #1 mistake: build ONE grpc.aio Channel and
ONE stub from it, then call GetQuote on that same stub repeatedly. The
channel's HTTP/2 connection setup cost is paid exactly once, before the
first call; every call after that reuses the already-established
connection. A single reused channel already multiplexes concurrent calls
over one connection — "pooling" here means holding onto that one channel
(or a small fixed set of them under real concurrent load), never opening
one per call.

Run against EITHER stack's server, from this image's own venv (verify.sh
invokes it via `docker compose run --rm python python -m app.pooled_client
<host:port> <calls>`, pointed at the `quarkus` or `python` compose service's
in-network address, container port 9000).

Prints exactly one line to stdout: the total wall-clock elapsed seconds for
all <calls> calls, directly comparable to footgun_client.py's number for the
same target and the same call count.

Usage:
    python -m app.pooled_client quarkus:9000 50
    python -m app.pooled_client python:9000 50
"""
from __future__ import annotations

import asyncio
import sys
import time

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

_REQUEST = routing_pb2.GetQuoteRequest(
    origin=types_pb2.Location(un_locode="USNYC", name="New York"),
    destination=types_pb2.Location(un_locode="NLRTM", name="Rotterdam"),
    cargo=[types_pb2.Cargo(weight_kg=1200.5, description="Palletized electronics", cargo_type="GENERAL")],
)


async def run(target: str, calls: int) -> int:
    # ONE channel, ONE stub, built once, outside the loop.
    channel = grpc.aio.insecure_channel(target)
    stub = routing_pb2_grpc.RoutingServiceStub(channel)
    print(f"pooled_client: one channel id={id(channel)}, one stub id={id(stub)}, target={target}",
          file=sys.stderr)

    amounts: list[str] = []
    start = time.monotonic()
    try:
        for i in range(calls):
            # Same stub, same underlying channel, every iteration.
            response = await stub.GetQuote(_REQUEST)
            amounts.append(response.quote.amount)
    finally:
        await channel.close()
    elapsed = time.monotonic() - start

    if len(set(amounts)) != 1:
        print(f"pooled_client: FAIL — responses disagree across calls: {amounts}", file=sys.stderr)
        return 1

    print(f"pooled_client: {calls} calls, one reused channel, target={target}, "
          f"total={elapsed:.6f}s", file=sys.stderr)
    print(f"{elapsed:.6f}")
    return 0


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: python -m app.pooled_client <host:port> <calls>", file=sys.stderr)
        return 2
    target = sys.argv[1]
    calls = int(sys.argv[2])
    return asyncio.run(run(target, calls))


if __name__ == "__main__":
    raise SystemExit(main())
