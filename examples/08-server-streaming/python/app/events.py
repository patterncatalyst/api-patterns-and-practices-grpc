"""Ch8 server-streaming example — the DETERMINISTIC event sequence
WatchShipment streams back, shared with the Quarkus stack (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/tracking/TrackingEvents.java).
Four TrackingEvents, one per BookingState transition, with fixed, strictly
increasing timestamps and a fixed location per event — so the Python and
Quarkus responses are byte-for-byte comparable, not just independently
plausible.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone

from google.protobuf.timestamp_pb2 import Timestamp

from shipping.tracking.v1 import tracking_pb2
from shipping.type.v1 import types_pb2

_USNYC = types_pb2.Location(un_locode="USNYC", name="New York")
_NLRTM = types_pb2.Location(un_locode="NLRTM", name="Rotterdam")

# (location, state, ISO instant, note) — identical to the Quarkus sequence.
_STEPS = (
    (_USNYC, types_pb2.BOOKING_STATE_PENDING, "2026-01-02T08:00:00+00:00",
     "Booking accepted; container released to terminal"),
    (_USNYC, types_pb2.BOOKING_STATE_CONFIRMED, "2026-01-02T14:00:00+00:00",
     "Export customs cleared; loaded onboard MAERSK vessel"),
    (_NLRTM, types_pb2.BOOKING_STATE_IN_TRANSIT, "2026-01-15T09:30:00+00:00",
     "Vessel arrived at Rotterdam; awaiting discharge"),
    (_NLRTM, types_pb2.BOOKING_STATE_DELIVERED, "2026-01-16T11:00:00+00:00",
     "Container discharged and delivered to consignee"),
)


def sequence(booking_id: str) -> Iterator[tracking_pb2.TrackingEvent]:
    for location, state, iso_instant, note in _STEPS:
        at = Timestamp()
        at.FromDatetime(datetime.fromisoformat(iso_instant).astimezone(timezone.utc))
        yield tracking_pb2.TrackingEvent(
            booking_id=booking_id,
            location=location,
            state=state,
            at=at,
            note=note,
        )
