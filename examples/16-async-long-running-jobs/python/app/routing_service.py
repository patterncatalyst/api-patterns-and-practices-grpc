"""Ch16 async/long-running-jobs example — Python side, RoutingService.

RecomputeRoutes returns almost instantly: it creates an OperationState (see
app/operations.py) and schedules the actual work with `asyncio.create_task`,
a SEPARATE task on the SAME event loop that keeps running after this
coroutine's `return` — the asyncio analog of handing the job to Mutiny's
worker pool on the Quarkus side (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/routing/RoutingServiceImpl.java).

GetOperation, WatchOperation, and CancelOperation are NOT on this servicer —
they live on OperationsServiceServicer (see app/operations_service.py),
registered as a separate grpc.aio service sharing the SAME OperationRegistry
instance this servicer is constructed with. Splitting them out mirrors the
Quarkus side's two-bean structure: quarkus-grpc's fully abstract per-service
interface is what forces that split there, and keeping both language stacks
on the identical RoutingService/OperationsService boundary is the point —
the lesson doesn't change shape just because Python's stub base classes
default every unoverridden method to UNIMPLEMENTED rather than refusing to
compile.

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


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    def __init__(self, registry: OperationRegistry) -> None:
        # Injected rather than created here, so OperationsServiceServicer
        # (registered separately on the same grpc.aio server in app/main.py)
        # reads and writes the identical records this servicer creates.
        self._registry = registry
        # Strong references to in-flight background jobs. asyncio.create_task
        # does not keep its Task alive on its own — the event loop only holds
        # a WEAK reference, so a Task with nothing else referencing it can be
        # garbage-collected mid-flight, silently killing the job. Keeping
        # each Task in this set (and discarding it via the done-callback once
        # it finishes) is the fix asyncio's own docs recommend for exactly
        # this fire-and-forget pattern.
        self._background_tasks: set[asyncio.Task] = set()

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
        # job's first step. Add it to _background_tasks before this method
        # returns, so nothing can collect it between scheduling and its first
        # await point.
        task = asyncio.create_task(self._run_job(state, steps, step_s))
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

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
