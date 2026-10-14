"""Ch27 final project — TrackingService: WatchShipment (server streaming, the
Ch8 deterministic 4-event sequence) and ReportPositions (client streaming,
the Ch9 fold-to-accepted_count) implemented for real. Sync (bidirectional) is
left unoverridden — illustrative/optional per this chapter's scope; the
generated base class answers UNIMPLEMENTED for it.
"""
from __future__ import annotations

import logging

import grpc

from shipping.tracking.v1 import tracking_pb2, tracking_pb2_grpc

from app.tracking_events import sequence

logger = logging.getLogger("ch27-final-project-python")


class TrackingServiceServicer(tracking_pb2_grpc.TrackingServiceServicer):
    async def WatchShipment(self, request: tracking_pb2.WatchShipmentRequest, context: grpc.aio.ServicerContext):
        booking_id = request.booking_id
        logger.info("WatchShipment: opening stream for booking_id=%s", booking_id)
        for event in sequence(booking_id):
            yield tracking_pb2.WatchShipmentResponse(event=event)

    async def ReportPositions(self, request_iterator, context: grpc.aio.ServicerContext):
        count = 0
        async for _ in request_iterator:
            count += 1
        logger.info("ReportPositions: folded %d position report(s) into one ack", count)
        return tracking_pb2.ReportPositionsResponse(accepted_count=count)
