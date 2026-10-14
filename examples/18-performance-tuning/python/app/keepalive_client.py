"""Ch18 performance-tuning — the keepalive-across-an-idle-gap demo client.

Builds ONE channel (configured with the SAME keepalive options as the
servers — see ../main.py's KEEPALIVE_TIME_MS/KEEPALIVE_TIMEOUT_MS), calls
GetQuote once, sleeps past the configured keepalive window while making no
calls at all, then calls GetQuote again on the SAME channel/stub. Both calls
must succeed with identical field values — proving the configured keepalive
pings didn't need a second, fresh channel to survive the idle gap.

This container network has no NAT, load balancer, or other intermediary
whose own idle-connection timeout keepalive exists to defeat, so this script
does not reproduce a connection actually being dropped and recovered — it
proves the opposite risk: that turning keepalive ON, with a short interval,
does not itself break a channel across an idle period. In production,
keepalive's payoff is detecting (or preventing) exactly the silent drop this
local network can't exhibit.

Run against EITHER stack's server (verify.sh invokes it via `docker compose
run --rm python python -m app.keepalive_client <host:port> [idle_seconds]`,
pointed at the `quarkus`/`python` compose service's in-network address,
container port 9000). Prints "SURVIVED" on success.

Usage:
    python -m app.keepalive_client quarkus:9000 8
    python -m app.keepalive_client python:9000 8
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

# Matches the server's grpc.keepalive_time_ms / quarkus.grpc.server.netty.
# keep-alive-time (5s) so both ends ping on the same cadence while idle.
_KEEPALIVE_OPTIONS = [
    ("grpc.keepalive_time_ms", 5_000),
    ("grpc.keepalive_timeout_ms", 5_000),
    ("grpc.keepalive_permit_without_calls", 1),
]


async def run(target: str, idle_seconds: float) -> int:
    channel = grpc.aio.insecure_channel(target, options=_KEEPALIVE_OPTIONS)
    stub = routing_pb2_grpc.RoutingServiceStub(channel)

    try:
        first = await stub.GetQuote(_REQUEST)
        print(f"keepalive_client: call 1 -> quote.amount={first.quote.amount}, "
              f"now idling {idle_seconds}s on channel id={id(channel)} ...", file=sys.stderr)

        await asyncio.sleep(idle_seconds)

        second = await stub.GetQuote(_REQUEST)
        print(f"keepalive_client: call 2 (same channel, after idle gap) -> "
              f"quote.amount={second.quote.amount}", file=sys.stderr)
    finally:
        await channel.close()

    if first.quote.amount != second.quote.amount or first.route.id != second.route.id:
        print(f"keepalive_client: FAIL — calls disagree across the idle gap: "
              f"{first} vs {second}", file=sys.stderr)
        return 1

    print(f"keepalive_client: ok — target={target} survived a {idle_seconds}s idle gap "
          "on one channel", file=sys.stderr)
    print("SURVIVED")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python -m app.keepalive_client <host:port> [idle_seconds]", file=sys.stderr)
        return 2
    target = sys.argv[1]
    idle_seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
    return asyncio.run(run(target, idle_seconds))


if __name__ == "__main__":
    raise SystemExit(main())
