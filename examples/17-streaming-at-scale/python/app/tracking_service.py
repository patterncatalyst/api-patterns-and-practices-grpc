"""Ch17 streaming-at-scale ANCHOR — WatchShipment as a DEMAND-DRIVEN live
feed, implemented identically in spirit on the Quarkus stack (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/tracking/TrackingServiceImpl.java).

The booking id carried on the request is a demo-only mode selector (no
domain meaning, same trick Ch15 used with origin.name — see README.md):

    "bkg_eager" -> the contrast case: app.events.eager_sequence builds and
        stamps ALL 6 events in one tight loop BEFORE the first `yield`, then
        this generator just replays the already-built list. The event loop
        never gets a chance to interleave anything between "build" and
        "stream" for this mode.
    "bkg_quiet" -> the same demand-driven generator, reused for a 2-event
        feed with one QUIET_GAP_S pause between them.
    "bkg_demo" (or anything else unrecognized) -> the headline case:
        _demand_driven_sequence is an async generator that builds and stamps
        each event just before yielding it, awaiting an asyncio.sleep
        between events rather than blocking the event loop. An async
        generator is ALREADY pull-based by construction — nothing past the
        current `yield` runs until the consumer (grpc.aio's internal
        machinery, driven by the gRPC stream's write-readiness) asks for the
        next item by resuming the generator. No separate demand-signalling
        API is needed the way Mutiny's MultiEmitter.onRequest is on the
        Quarkus side; the `async def ... yield` protocol IS the pull
        contract.

ReportPositions (client streaming) and Sync (bidirectional) are declared in
the proto but left unoverridden here: the generated
`tracking_pb2_grpc.TrackingServiceServicer` base class already sets gRPC
status UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import logging

import grpc

from shipping.tracking.v1 import tracking_pb2, tracking_pb2_grpc

from app.events import DEMO_WAYPOINTS, QUIET_WAYPOINTS, build_event, eager_sequence

logger = logging.getLogger("ch17-streaming-python")

BKG_EAGER = "bkg_eager"
BKG_QUIET = "bkg_quiet"

# ~Quarter-second production cadence: comfortably inside what the bundled
# slow_consumer.py (one read every ~300ms) can keep up with, and well past
# verify.sh's >=200ms-per-step / >=0.6s-whole-stream floors. See README.md
# "Why ~260ms, not ~150ms" for the reasoning.
STEP_DELAY_S = 0.26
QUIET_GAP_S = 2.0


async def _demand_driven_sequence(booking_id: str, waypoints: tuple, delays_s: list[float]) -> AsyncIterator[tracking_pb2.WatchShipmentResponse]:
    """Builds and stamps one event per iteration, awaiting `delays_s[i]`
    (never a blocking time.sleep) before each one. Nothing beyond the
    current `await asyncio.sleep(...)` / `yield` pair runs ahead of what the
    consumer has actually asked for — the async generator protocol itself is
    the demand signal.
    """
    for i in range(len(waypoints)):
        if delays_s[i] > 0:
            await asyncio.sleep(delays_s[i])
        event = build_event(booking_id, i, waypoints)
        yield tracking_pb2.WatchShipmentResponse(event=event)


class TrackingServiceServicer(tracking_pb2_grpc.TrackingServiceServicer):
    async def WatchShipment(
        self,
        request: tracking_pb2.WatchShipmentRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[tracking_pb2.WatchShipmentResponse]:
        booking_id = request.booking_id
        logger.info("WatchShipment: opening stream for bookingId=%s", booking_id)

        if booking_id == BKG_EAGER:
            # Built and stamped BEFORE the first yield — demand plays no
            # part in when these timestamps were set.
            for event in eager_sequence(booking_id):
                yield tracking_pb2.WatchShipmentResponse(event=event)
            return

        if booking_id == BKG_QUIET:
            async for response in _demand_driven_sequence(booking_id, QUIET_WAYPOINTS, [0.0, QUIET_GAP_S]):
                yield response
            return

        delays = [0.0] + [STEP_DELAY_S] * (len(DEMO_WAYPOINTS) - 1)
        async for response in _demand_driven_sequence(booking_id, DEMO_WAYPOINTS, delays):
            yield response
