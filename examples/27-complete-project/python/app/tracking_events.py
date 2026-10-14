"""The fixed, deterministic 4-event WatchShipment sequence this book has used
since Chapter 8: PENDING@USNYC -> CONFIRMED@USNYC -> IN_TRANSIT@NLRTM ->
DELIVERED@NLRTM, for any requested booking id. Identical to the Quarkus
side's tracking/TrackingEvents.java.
"""
from __future__ import annotations

from google.protobuf.timestamp_pb2 import Timestamp

from shipping.tracking.v1 import tracking_pb2
from shipping.type.v1 import types_pb2

_USNYC = types_pb2.Location(un_locode="USNYC", name="New York")
_NLRTM = types_pb2.Location(un_locode="NLRTM", name="Rotterdam")


def _event(booking_id: str, location: types_pb2.Location, state, note: str, hour_offset: int) -> tracking_pb2.TrackingEvent:
    at = Timestamp(seconds=1_700_000_000 + hour_offset * 3600)
    return tracking_pb2.TrackingEvent(
        booking_id=booking_id, location=location, state=state, at=at, note=note
    )


def sequence(booking_id: str) -> list[tracking_pb2.TrackingEvent]:
    return [
        _event(booking_id, _USNYC, types_pb2.BOOKING_STATE_PENDING, "booking received", 1),
        _event(booking_id, _USNYC, types_pb2.BOOKING_STATE_CONFIRMED, "carrier confirmed", 2),
        _event(booking_id, _NLRTM, types_pb2.BOOKING_STATE_IN_TRANSIT, "arrived at destination port", 3),
        _event(booking_id, _NLRTM, types_pb2.BOOKING_STATE_DELIVERED, "delivered", 4),
    ]
