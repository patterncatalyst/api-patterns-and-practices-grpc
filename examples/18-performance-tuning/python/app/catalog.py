"""Ch18 performance-tuning — the deterministic quote formula (unchanged from
Ch7) plus the fixed, oversized ListRoutes catalog.

ROUTE_COUNT routes, each with LEGS_PER_ROUTE legs whose `carrier` field is
padded to PAD_LEN filler characters past a short, readable prefix — the only
free-text field Route/Leg expose in the frozen contract (there is no spare
"description" field on either message). The padding is a deliberate
simplification, not realistic data: what has to be real is the BYTE COUNT, so
the same ListRoutes call produces the same number of bytes on every run, on
both stacks — see ../quarkus/.../RouteCatalog.java for the byte-for-byte
equivalent. The arithmetic this chapter leans on:

    ROUTE_COUNT(25) * LEGS_PER_ROUTE(2) * (~15-byte prefix + PAD_LEN(100_000))
    ~= 5.0MB of carrier payload alone — comfortably past gRPC's 4MB default
    max-message-size and comfortably under an 8MB raised one.
"""
from __future__ import annotations

from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal

from shipping.routing.v1 import routing_pb2
from shipping.type.v1 import types_pb2

_RATE_PER_KG = 2.50


def compute_quote(cargo_items: Iterable[types_pb2.Cargo]) -> types_pb2.Money:
    total_weight_kg = sum(item.weight_kg for item in cargo_items)
    amount = str(
        Decimal(str(total_weight_kg * _RATE_PER_KG)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    )
    return types_pb2.Money(currency="USD", amount=amount)


# --- The oversized ListRoutes catalog ---------------------------------------

ROUTE_COUNT = 25
LEGS_PER_ROUTE = 2
PAD_LEN = 100_000
DEFAULT_PAGE_SIZE = 3
MAX_PAGE_SIZE = ROUTE_COUNT

# Five origin/destination pairs, cycled — the same port data Ch13's catalog
# uses, not padded (Location.name/un_locode stay realistic; only
# Leg.carrier is inflated).
_PORT_PAIRS = [
    ("USNYC", "New York", "NLRTM", "Rotterdam"),
    ("USLAX", "Los Angeles", "CNSHA", "Shanghai"),
    ("DEHAM", "Hamburg", "SGSIN", "Singapore"),
    ("NLRTM", "Rotterdam", "USNYC", "New York"),
    ("CNSHA", "Shanghai", "USLAX", "Los Angeles"),
]

_CARRIERS = ["MAERSK", "MSC", "HMM", "COSCO", "CMA CGM"]


def _padded_carrier(carrier_name: str, route_idx: int, leg_idx: int) -> str:
    """'<CARRIER>-<route>-<leg>-' followed by PAD_LEN filler characters. The
    prefix keeps the field inspectable; the filler manufactures byte count
    deterministically."""
    prefix = f"{carrier_name}-{route_idx:03d}-{leg_idx}-"
    return prefix + ("X" * PAD_LEN)


def _build_catalog() -> list[types_pb2.Route]:
    routes: list[types_pb2.Route] = []
    for i in range(1, ROUTE_COUNT + 1):
        origin_code, origin_name, dest_code, dest_name = _PORT_PAIRS[(i - 1) % len(_PORT_PAIRS)]
        carrier_name = _CARRIERS[(i - 1) % len(_CARRIERS)]

        origin = types_pb2.Location(un_locode=origin_code, name=origin_name)
        destination = types_pb2.Location(un_locode=dest_code, name=dest_name)
        price = types_pb2.Money(currency="USD", amount=f"{1000 + i}.00")

        legs = [
            types_pb2.Leg(
                carrier=_padded_carrier(carrier_name, i, leg_idx),
                origin=origin,
                destination=destination,
            )
            for leg_idx in range(1, LEGS_PER_ROUTE + 1)
        ]
        routes.append(types_pb2.Route(id=f"rte_{i:03d}", legs=legs, price=price))
    return routes


ALL: list[types_pb2.Route] = _build_catalog()


def paginate(page_size: int, page_token: str) -> routing_pb2.ListRoutesResponse:
    """Clamp page_size, resolve page_token to a start offset, slice ALL, and
    build the response envelope. field_mask is NOT applied here — that
    projection lever is Chapter 13's; this chapter's subject is wire size
    and channel lifecycle, so ListRoutes always returns full Routes."""
    if page_size <= 0:
        page_size = DEFAULT_PAGE_SIZE
    elif page_size > MAX_PAGE_SIZE:
        page_size = MAX_PAGE_SIZE

    if not page_token:
        start = 0
    else:
        try:
            start = int(page_token)
        except ValueError as exc:
            raise ValueError(f"page_token '{page_token}' is not a valid continuation token") from exc
        if start < 0 or start > len(ALL):
            raise ValueError(f"page_token '{page_token}' is out of range")

    end = min(start + page_size, len(ALL))
    page = ALL[start:end]
    next_page_token = str(end) if end < len(ALL) else ""
    return routing_pb2.ListRoutesResponse(routes=page, next_page_token=next_page_token)
