"""Ch17 streaming-at-scale example — the waypoint tables WatchShipment
streams for each demo-only mode (see app/tracking_service.py for the
dispatch), mirrored in spirit by the Quarkus stack (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/tracking/TrackingEvents.java).
Unlike Chapter 8's fixed historical timestamps, every event here is stamped
with the current wall-clock time at the moment it is PRODUCED — the whole
point of this chapter's backpressure demonstration is comparing WHEN the
server computed that timestamp, not a canned value.
"""
from __future__ import annotations

from datetime import datetime, timezone

from google.protobuf.timestamp_pb2 import Timestamp

from shipping.tracking.v1 import tracking_pb2
from shipping.type.v1 import types_pb2

_USNYC = types_pb2.Location(un_locode="USNYC", name="New York")
_NLRTM = types_pb2.Location(un_locode="NLRTM", name="Rotterdam")
_DEHAM = types_pb2.Location(un_locode="DEHAM", name="Hamburg")
_SGSIN = types_pb2.Location(un_locode="SGSIN", name="Singapore")

# bkg_demo: the 6-event ordered demand feed. Extends Chapter 8's
# PENDING -> CONFIRMED -> IN_TRANSIT -> DELIVERED progression with two extra
# IN_TRANSIT waypoints (a second port call, then a transshipment leg) so a
# demand-driven feed has enough events to show a measurable production
# cadence.
DEMO_WAYPOINTS: tuple[tuple, ...] = (
    (_USNYC, types_pb2.BOOKING_STATE_PENDING),
    (_USNYC, types_pb2.BOOKING_STATE_CONFIRMED),
    (_NLRTM, types_pb2.BOOKING_STATE_IN_TRANSIT),
    (_DEHAM, types_pb2.BOOKING_STATE_IN_TRANSIT),
    (_SGSIN, types_pb2.BOOKING_STATE_IN_TRANSIT),
    (_SGSIN, types_pb2.BOOKING_STATE_DELIVERED),
)

# bkg_quiet: a 2-event feed with a multi-second quiet gap between them,
# demonstrating that a long idle stretch on an otherwise-open stream still
# delivers its final event rather than being silently dropped. Collapsing
# straight from PENDING to DELIVERED with no intermediate states is a
# simplification specific to this demo-only mode (see README.md) — this
# mode's subject is the quiet gap, not a realistic voyage.
QUIET_WAYPOINTS: tuple[tuple, ...] = (
    (_USNYC, types_pb2.BOOKING_STATE_PENDING),
    (_USNYC, types_pb2.BOOKING_STATE_DELIVERED),
)


def build_event(booking_id: str, index: int, waypoints: tuple) -> tracking_pb2.TrackingEvent:
    """Builds and stamps the event at `index` of `waypoints` RIGHT NOW — `at`
    is this call's wall-clock instant, and `note` is a bare "seq=<index>"
    marker (not Chapter 8's narrative text) so verify.sh can read production
    order and production time straight off the wire without guessing at
    prose.
    """
    location, state = waypoints[index]
    at = Timestamp()
    at.FromDatetime(datetime.now(timezone.utc))
    return tracking_pb2.TrackingEvent(
        booking_id=booking_id,
        location=location,
        state=state,
        at=at,
        note=f"seq={index}",
    )


def eager_sequence(booking_id: str) -> list[tracking_pb2.TrackingEvent]:
    """bkg_eager: every DEMO_WAYPOINTS event built and stamped in one tight
    loop, all effectively at the same instant — before the first one has
    left the server. This is the pre-materialized contrast
    app/tracking_service.py streams by yielding from an already-built list,
    the same shape Chapter 8 used for its (much smaller, non-paced) 4-event
    sequence.
    """
    return [build_event(booking_id, i, DEMO_WAYPOINTS) for i in range(len(DEMO_WAYPOINTS))]
