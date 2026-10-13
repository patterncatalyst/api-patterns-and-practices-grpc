"""Ch8 server-streaming example — the WatchShipment RPC, implemented
identically here and in the Quarkus stack (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/tracking/TrackingServiceImpl.java).

ReportPositions (client streaming) and Sync (bidirectional) are declared in
the proto for Chapter 9. They are intentionally left unoverridden: the
generated `tracking_pb2_grpc.TrackingServiceServicer` base class already
sets gRPC status UNIMPLEMENTED and raises for any method a subclass doesn't
override, so grpcurl / any client sees UNIMPLEMENTED without extra code here.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
import logging

import grpc

from shipping.tracking.v1 import tracking_pb2, tracking_pb2_grpc

from app.events import sequence

logger = logging.getLogger("ch08-tracking-python")


class TrackingServiceServicer(tracking_pb2_grpc.TrackingServiceServicer):
    async def WatchShipment(
        self,
        request: tracking_pb2.WatchShipmentRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[tracking_pb2.WatchShipmentResponse]:
        logger.info("WatchShipment: opening stream for bookingId=%s", request.booking_id)

        # Each `yield` sends one WatchShipmentResponse as a DATA frame on the
        # one HTTP/2 stream this call opened, in the order yielded; the
        # async generator returning is what sends grpc.aio's half-close —
        # no explicit "end of stream" call needed.
        for event in sequence(request.booking_id):
            yield tracking_pb2.WatchShipmentResponse(event=event)
