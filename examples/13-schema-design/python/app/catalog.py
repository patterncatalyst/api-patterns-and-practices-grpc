"""Ch13 schema-design ANCHOR — a small, fixed, in-memory catalog of five
Routes that app.routing_service.RoutingServiceServicer.ListRoutes paginates
and projects. A real routing engine would page over a database query; this
catalog exists only so pagination and field-mask projection have
deterministic data to walk, in the same identical order on every call — see
the Quarkus stack's RouteCatalog.java for the byte-for-byte equivalent list.
"""
from __future__ import annotations

from shipping.type.v1 import types_pb2


def _route(
    route_id: str,
    carrier: str,
    origin_code: str,
    origin_name: str,
    dest_code: str,
    dest_name: str,
    price_amount: str,
) -> types_pb2.Route:
    origin = types_pb2.Location(un_locode=origin_code, name=origin_name)
    destination = types_pb2.Location(un_locode=dest_code, name=dest_name)
    price = types_pb2.Money(currency="USD", amount=price_amount)
    leg = types_pb2.Leg(carrier=carrier, origin=origin, destination=destination)
    return types_pb2.Route(id=route_id, legs=[leg], price=price)


ALL: list[types_pb2.Route] = [
    _route("rte_001", "MAERSK", "USNYC", "New York", "NLRTM", "Rotterdam", "1200.00"),
    _route("rte_002", "MSC", "USLAX", "Los Angeles", "CNSHA", "Shanghai", "2400.00"),
    _route("rte_003", "HMM", "DEHAM", "Hamburg", "SGSIN", "Singapore", "1800.50"),
    _route("rte_004", "MAERSK", "NLRTM", "Rotterdam", "USNYC", "New York", "1150.75"),
    _route("rte_005", "COSCO", "CNSHA", "Shanghai", "USLAX", "Los Angeles", "2600.25"),
]
