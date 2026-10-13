"""Ch15 backend-io-concurrency ANCHOR — FindOptimalRoute performs the same
~400ms of simulated blocking DB+file I/O (app.blocking_lookup.blocking_lookup)
in every mode; what changes is which thread runs it, selected by a demo-only
flag carried in request.origin.name (see MODE_STARVING below, and README.md
for the full table):

    "" (unset, the default) -> CORRECT model: the blocking lookup is handed
        to asyncio.to_thread, which runs it on the loop's default
        ThreadPoolExecutor and awaits the result. grpc.aio's single event
        loop thread is free to run other coroutines — including other
        concurrent FindOptimalRoute calls — while this call's ~400ms of I/O
        is in flight elsewhere.
    "starving" -> the STARVING contrast: the identical blocking_lookup call
        is made directly, with no await and no executor hop. It runs right
        here, on grpc.aio's one and only event-loop thread, blocking every
        other coroutine on that loop — including other RoutingService calls
        in ANY mode — for the ~400ms it takes.

The other seven RoutingService methods are declared in the proto for later
chapters. They are left unoverridden here: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import asyncio
import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.blocking_lookup import blocking_lookup

logger = logging.getLogger("ch15-concurrency-python")

MODE_STARVING = "starving"


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    async def FindOptimalRoute(
        self,
        request: routing_pb2.FindOptimalRouteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.FindOptimalRouteResponse:
        mode = request.origin.name
        origin_code = request.origin.un_locode
        dest_code = request.destination.un_locode

        logger.info(
            "FindOptimalRoute: origin=%s destination=%s mode='%s'",
            origin_code,
            dest_code,
            mode or "(default)",
        )

        if mode == MODE_STARVING:
            # STARVING: call the blocking function in-line, on THIS
            # coroutine, on grpc.aio's one event-loop thread. No await
            # point is reached until the ~400ms of work is already done, so
            # nothing else scheduled on this loop runs in the meantime.
            route = blocking_lookup(origin_code, dest_code)
        else:
            # CORRECT: hand the same blocking call to the default
            # thread-pool executor and await its future. The event loop is
            # free the instant this line suspends.
            route = await asyncio.to_thread(blocking_lookup, origin_code, dest_code)

        return routing_pb2.FindOptimalRouteResponse(route=route)
