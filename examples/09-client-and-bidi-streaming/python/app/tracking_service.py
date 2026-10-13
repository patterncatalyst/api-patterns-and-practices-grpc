"""Ch9 client-and-bidi-streaming — ReportPositions (client streaming) and
Sync (bidirectional streaming), implemented identically here and in the
Quarkus stack (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/tracking/TrackingServiceImpl.java).

WatchShipment (server streaming, Ch8's RPC) is declared on the same service
and intentionally left unoverridden: the generated
`tracking_pb2_grpc.TrackingServiceServicer` base class already sets gRPC
status UNIMPLEMENTED and raises for any method a subclass doesn't override
(the same pattern Ch5/Ch7's RoutingServiceServicer uses), so grpcurl sees
UNIMPLEMENTED without extra code here.
"""
from __future__ import annotations

import logging

import grpc

from shipping.tracking.v1 import tracking_pb2, tracking_pb2_grpc

logger = logging.getLogger("ch09-tracking-python")


class TrackingServiceServicer(tracking_pb2_grpc.TrackingServiceServicer):
    async def ReportPositions(
        self,
        request_iterator,
        context: grpc.aio.ServicerContext,
    ) -> tracking_pb2.ReportPositionsResponse:
        # Client streaming: the server reads the inbound stream to
        # exhaustion — `async for` only ends when the client half-closes
        # (signals "done sending") — folding every ReportPositionsRequest
        # into a single count, then returns ONE response. Nothing is sent
        # back to the client until the stream is fully consumed.
        accepted_count = 0
        async for _ in request_iterator:
            accepted_count += 1

        logger.info("ReportPositions: folded %d position report(s) into one ack", accepted_count)
        return tracking_pb2.ReportPositionsResponse(accepted_count=accepted_count)

    async def Sync(
        self,
        request_iterator,
        context: grpc.aio.ServicerContext,
    ):
        # Bidirectional: read and write are independent directions on the
        # same stream. This handler happens to respond to each request as
        # it arrives (`yield` inside the loop), so one SyncResponse goes out
        # per SyncRequest that comes in, in arrival order — but the two
        # directions aren't lockstepped by the protocol itself, only by
        # this handler's choice to answer immediately.
        async for request in request_iterator:
            yield tracking_pb2.SyncResponse(event=request.event)
