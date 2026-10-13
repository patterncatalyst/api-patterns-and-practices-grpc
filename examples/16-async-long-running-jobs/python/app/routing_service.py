"""Ch16 async/long-running-jobs example — Python side.

RecomputeRoutes returns almost instantly: it creates an OperationState (see
app/operations.py) and schedules the actual work with `asyncio.create_task`,
a SEPARATE task on the SAME event loop that keeps running after this
coroutine's `return` — the asyncio analog of handing the job to Mutiny's
worker pool on the Quarkus side (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/routing/RoutingServiceImpl.java).
GetOperation polls the record, WatchOperation streams it as an async
generator (each `yield` is one DATA frame, the same mechanic Ch8's
WatchShipment uses), and CancelOperation moves it to a terminal state before
the job notices on its own.

The other four RoutingService methods are declared in the proto for other
chapters' examples. They are left unoverridden here: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import asyncio
import logging

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

from app.operations import OperationRegistry, OperationState

logger = logging.getLogger("ch16-operation-python")

# The normal RecomputeRoutes job: 5 steps x 0.2s = 1s to done=True/100%,
# comfortably inside verify.sh's bounded poll loop and with enough margin
# that WatchOperation's stream always has progress to report before the job
# finishes, even on a loaded CI runner.
_NORMAL_STEPS = 5
_NORMAL_STEP_S = 0.2

# The "slow" variant (reason contains "slow"): 20 steps x 0.2s = 4s total, a
# deterministic window in which verify.sh calls CancelOperation well before
# the job would finish on its own.
_SLOW_STEPS = 20
_SLOW_STEP_S = 0.2

# WatchOperation's poll interval — how often a snapshot is yielded onto the
# stream while the operation is still running.
_WATCH_POLL_S = 0.15


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    def __init__(self) -> None:
        self._registry = OperationRegistry()

    async def RecomputeRoutes(
        self,
        request: routing_pb2.RecomputeRoutesRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.RecomputeRoutesResponse:
        reason = request.reason
        slow = "slow" in reason
        steps = _SLOW_STEPS if slow else _NORMAL_STEPS
        step_s = _SLOW_STEP_S if slow else _NORMAL_STEP_S

        state = self._registry.create("recompute_routes")
        logger.info(
            "RecomputeRoutes: id=%s reason=%s starting (%d steps x %.2fs, %s variant)",
            state.id,
            reason,
            steps,
            step_s,
            "slow" if slow else "normal",
        )

        # asyncio.create_task schedules the job as an independent task on the
        # SAME event loop; it is not awaited here, so this coroutine returns
        # — and the caller gets its response — without waiting for even the
        # job's first step.
        asyncio.create_task(self._run_job(state, steps, step_s))

        return routing_pb2.RecomputeRoutesResponse(operation=state.snapshot())

    async def _run_job(self, state: OperationState, steps: int, step_s: float) -> None:
        for i in range(1, steps + 1):
            if state.done:
                logger.info("RecomputeRoutes: id=%s job stopping early (cancelled)", state.id)
                return
            await asyncio.sleep(step_s)
            if state.done:
                logger.info("RecomputeRoutes: id=%s job stopping early (cancelled)", state.id)
                return
            pct = round(100 * i / steps)
            if i == steps:
                state.complete("recompute complete: routes reconciled")
            else:
                state.advance(pct, f"recomputing routes ({pct}%)")
        logger.info("RecomputeRoutes: id=%s job finished", state.id)

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
