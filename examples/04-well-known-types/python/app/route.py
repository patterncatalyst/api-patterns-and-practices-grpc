"""Ch4 well-known-types ANCHOR — builds the one deterministic Route this
chapter's FindOptimalRoute always returns, identical on both stacks (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/routing/RouteBuilder.java).

Fixed departs_at/arrives_at Timestamps and a fixed decimal-string Money are
the whole point: this module exists so verify.sh can assert the exact JSON a
google.protobuf.Timestamp and a Money render as, not just that a call
succeeds.
"""
from __future__ import annotations

from datetime import datetime, timezone

from google.protobuf import timestamp_pb2

from shipping.type.v1 import types_pb2

_CARRIER = "MAERSK"

# Fixed, deterministic instants — not "now" — so both stacks' responses are
# byte-identical and the chapter's "On the wire" box can print an exact
# expected RFC 3339 string instead of "some recent timestamp".
_DEPARTS_AT = datetime(2026, 2, 1, 10, 0, 0, tzinfo=timezone.utc)
_ARRIVES_AT = datetime(2026, 2, 18, 6, 0, 0, tzinfo=timezone.utc)


def _to_timestamp(when: datetime) -> timestamp_pb2.Timestamp:
    # google.protobuf.timestamp_pb2 ships inside the `protobuf` package
    # itself (the compiled well-known-type module) — no extra dependency
    # beyond the grpcio/protobuf pair this project already needs.
    ts = timestamp_pb2.Timestamp()
    ts.FromDatetime(when)
    return ts


def build_route(origin: types_pb2.Location, destination: types_pb2.Location) -> types_pb2.Route:
    leg = types_pb2.Leg(
        carrier=_CARRIER,
        origin=origin,
        destination=destination,
        departs_at=_to_timestamp(_DEPARTS_AT),
        arrives_at=_to_timestamp(_ARRIVES_AT),
    )
    # Money.amount is a decimal STRING, never a binary float — the same
    # convention Chapter 5's app/quote.py uses and the sibling REST site's
    # JSON Schema enforces for the identical { currency, amount } shape.
    # Fixed here (no arithmetic) because this chapter's point is the JSON
    # *mapping*, not the pricing formula.
    price = types_pb2.Money(currency="USD", amount="4200.00")
    return types_pb2.Route(
        id=f"rte_{origin.un_locode}-{destination.un_locode}",
        legs=[leg],
        price=price,
    )
