"""Ch16 async/long-running-jobs example — Python side, OperationsService.

GetOperation (poll), WatchOperation (server-stream), and CancelOperation
(server-owned cancel) against the SAME OperationRegistry instance
RoutingServiceServicer's RecomputeRoutes populates (see
app/routing_service.py) — app/main.py constructs one OperationRegistry and
injects it into both servicers, then registers both on the same grpc.aio
server, so a RecomputeRoutes call and a GetOperation/WatchOperation/
CancelOperation call read and write the identical OperationState record.

This is a SEPARATE servicer class from RoutingServiceServicer — not three
more methods on it — mirroring the Quarkus side's two-@GrpcService-bean
split (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/routing/OperationsServiceImpl.java).
quarkus-grpc's fully abstract per-service interface is what FORCES that
split on the Quarkus stack; Python's generated stub base classes would
tolerate three more methods directly on RoutingServiceServicer without
complaint. Keeping the split here anyway is deliberate: the contract itself
now declares GetOperation/WatchOperation/CancelOperation on a dedicated
shipping.routing.v1.OperationsService, the AIP-151 shape, and both language
stacks in this example implement the identical service boundary rather than
one stack's servicer layout quietly drifting from what the .proto says.
"""
from __future__ import annotations

import asyncio
import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.operations import OperationRegistry

logger = logging.getLogger("ch16-operation-python")

# WatchOperation's poll interval — how often a snapshot is yielded onto the
# stream while the operation is still running.
_WATCH_POLL_S = 0.15


class OperationsServiceServicer(routing_pb2_grpc.OperationsServiceServicer):
    def __init__(self, registry: OperationRegistry) -> None:
        self._registry = registry

    async def GetOperation(
        self,
        request: routing_pb2.GetOperationRequest,
        context: grpc.aio.ServicerContext,
    ):
        state = self._registry.get(request.operation_id)
        if state is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no such operation: {request.operation_id}")
        return state.snapshot()

    async def WatchOperation(
        self,
        request: routing_pb2.WatchOperationRequest,
        context: grpc.aio.ServicerContext,
    ):
        state = self._registry.get(request.operation_id)
        if state is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no such operation: {request.operation_id}")
            return

        # Each yield sends one Operation snapshot as a DATA frame on the one
        # HTTP/2 stream this call opened; returning from the loop (once a
        # snapshot comes back done=True) sends grpc.aio's half-close — the
        # same mechanic Ch8's WatchShipment uses for a fixed event sequence,
        # here driven by the operation's own terminal state instead.
        while True:
            snapshot = state.snapshot()
            yield snapshot
            if snapshot.done:
                return
            await asyncio.sleep(_WATCH_POLL_S)

    async def CancelOperation(
        self,
        request: routing_pb2.CancelOperationRequest,
        context: grpc.aio.ServicerContext,
    ):
        state = self._registry.get(request.operation_id)
        if state is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no such operation: {request.operation_id}")
        cancelled_now = state.cancel()
        logger.info("CancelOperation: id=%s cancelled_now=%s", state.id, cancelled_now)
        return state.snapshot()
