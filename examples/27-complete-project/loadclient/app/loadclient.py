"""The Final Project's minikube load client — the Chapter 22 shape, reused
verbatim: build exactly ONE grpc.aio channel and ONE stub, call GetQuote
CALLS times over that same stub, read the `x-served-by` trailer after every
call, tally which pod answered.

A gRPC channel is one long-lived HTTP/2 connection; the whole point of this
subtree is what happens to the OTHER two pods when every call in a client's
lifetime goes out over that one connection. Running grpcurl in a bash loop
would hide the failure mode entirely — every grpcurl invocation dials a
FRESH channel, so a loop "load test" against a plain ClusterIP Service fans
out across all three pods for the wrong reason (a new TCP connection per
call, not real load balancing). See examples/22-mesh-loadbalancing/python/app/loadclient.py's
module docstring for the full argument.

Usage (env vars; see ../../scripts/run-demo.sh for how each phase sets them):
  TARGET      dial target, e.g. "finalproject-plain.final-project-demo.svc.cluster.local:9000"
              or "dns:///finalproject-headless.final-project-demo.svc.cluster.local:9000"
  LB_POLICY   grpc-core LB policy name ("round_robin" or unset for pick_first)
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
