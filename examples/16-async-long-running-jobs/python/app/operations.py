"""Ch16 async/long-running-jobs example — the server-owned Operation record
and its registry, shared by RecomputeRoutes/GetOperation/WatchOperation/
CancelOperation in app/routing_service.py.

asyncio runs one coroutine at a time on a single event loop — there is never
a context switch mid-statement — so, unlike the Quarkus side's OperationState
(whose background job and RPC handlers really can run on different OS
threads), these methods need no lock: every `await` is the only point where
another coroutine can run, and none of the state transitions below span an
`await`.
"""
from __future__ import annotations

import uuid

from shipping.type.v1 import types_pb2


class OperationState:
    """One server-owned Operation record, mutated in place by the background
    job coroutine and read by GetOperation/WatchOperation, and terminated
    early by CancelOperation."""

    def __init__(self, operation_id: str, kind: str) -> None:
        self.id = operation_id
        self.kind = kind
        self.done = False
        self.progress_pct = 0
        self.message = "started"

    def snapshot(self) -> types_pb2.Operation:
        """Immutable point-in-time view handed back on every RPC."""
        return types_pb2.Operation(
            id=self.id,
            kind=self.kind,
            done=self.done,
            progress_pct=self.progress_pct,
            message=self.message,
        )

    def advance(self, pct: int, message: str) -> None:
        """Called by the background job between steps; a no-op once terminal."""
        if self.done:
            return
        self.progress_pct = pct
        self.message = message

    def complete(self, message: str) -> None:
        """Called by the background job on its last step; a no-op once terminal."""
        if self.done:
            return
        self.done = True
        self.progress_pct = 100
        self.message = message

    def cancel(self) -> bool:
        """Called by CancelOperation. Returns True if this call is the one
        that moved the operation to terminal; False if it was already done
        (the cancel arrived too late, or twice)."""
        if self.done:
            return False
        self.done = True
        self.message = f"operation cancelled by client request at {self.progress_pct}% progress"
        return True


class OperationRegistry:
    """The server-owned table of in-flight and completed OperationState
    records, keyed by an op_-prefixed id. An in-memory dict is enough for
    this example — a production RoutingService would back this with a
    durable store so an operation survives a server restart, but the
    client-visible contract (create, poll, watch, cancel by id) is identical
    either way."""

    def __init__(self) -> None:
        self._operations: dict[str, OperationState] = {}

    def create(self, kind: str) -> OperationState:
        operation_id = f"op_{uuid.uuid4().hex}"
        state = OperationState(operation_id, kind)
        self._operations[operation_id] = state
        return state

    def get(self, operation_id: str) -> OperationState | None:
        return self._operations.get(operation_id)
