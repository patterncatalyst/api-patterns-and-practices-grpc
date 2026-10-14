"""Ch22 mesh-loadbalancing — the load client this chapter's whole demo rests on.

This builds exactly one grpc.aio channel and one stub, then calls GetQuote
CALLS times over that same stub, reading the `x-served-by` response trailer
after every call and tallying which pod answered. That single-channel shape
is deliberate and non-negotiable for this demo: a gRPC channel is one
long-lived HTTP/2 connection, and the entire point of Chapter 22 is what
happens to the OTHER two pods when every call in a client's lifetime goes
out over that one connection.

The trap this file exists to avoid: running `grpcurl` in a bash loop looks
like an equivalent load generator, but it is not one. Every `grpcurl`
invocation is a fresh process that dials a brand-new channel, makes one
call, and exits — so a `for i in $(seq 1 30); do grpcurl ...; done` loop
opens 30 independent TCP connections. Against a plain ClusterIP Service,
kube-proxy's iptables rule picks a backend pod freshly for EACH of those
30 connections, so a grpcurl-loop "load test" fans out across all three
pods even though the Service is doing nothing but L4 connection pinning —
it HIDES the exact failure mode this chapter is about. A real client never
behaves like this: it builds a channel once at startup and reuses it for
the life of the process, which is exactly what this file does, and exactly
what every stub client should do (Ch7's whole subject).

Usage (env vars; see ../../scripts/run-demo.sh for how each phase sets them):
  TARGET      dial target, e.g. "quote-plain.mesh-lb-demo.svc.cluster.local:9000"
              or "dns:///quote-headless.mesh-lb-demo.svc.cluster.local:9000"
  LB_POLICY   grpc-core LB policy name ("round_robin" or unset for the
              default, pick_first)
  CALLS       number of GetQuote calls to make over the one channel (default 30)
  PHASE_LABEL a label printed in the summary, purely cosmetic
"""
from __future__ import annotations

import asyncio
import os
from collections import Counter

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

TARGET = os.environ["TARGET"]
LB_POLICY = os.environ.get("LB_POLICY", "")
CALLS = int(os.environ.get("CALLS", "30"))
PHASE_LABEL = os.environ.get("PHASE_LABEL", "demo")

_REQUEST = routing_pb2.GetQuoteRequest(
    origin=types_pb2.Location(un_locode="USNYC", name="New York"),
    destination=types_pb2.Location(un_locode="NLRTM", name="Rotterdam"),
    cargo=[types_pb2.Cargo(weight_kg=1200.5, description="Palletized electronics", cargo_type="GENERAL")],
)


async def main() -> None:
    options = [("grpc.lb_policy_name", LB_POLICY)] if LB_POLICY else []

    # One channel, built once, reused for every call below — see the module
    # docstring for why this is the entire point of the exercise.
    async with grpc.aio.insecure_channel(TARGET, options=options) as channel:
        stub = routing_pb2_grpc.RoutingServiceStub(channel)

        served_by: list[str] = []
        for i in range(CALLS):
            call = stub.GetQuote(_REQUEST)
            await call
            trailers = dict(await call.trailing_metadata())
            pod = trailers.get("x-served-by", "<no x-served-by trailer>")
            served_by.append(pod)
            print(f"  call {i + 1:>3}/{CALLS}: served-by={pod}")

    tally = Counter(served_by)
    print(f"\n=== {PHASE_LABEL} ===")
    print(f"target={TARGET} lb_policy={LB_POLICY or '(default: pick_first)'} calls={CALLS}")
    print(f"distinct pods answering: {len(tally)}")
    for pod, count in sorted(tally.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {pod}: {count}/{CALLS}")


if __name__ == "__main__":
    asyncio.run(main())
