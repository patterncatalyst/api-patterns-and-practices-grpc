"""Ch15 backend-io-concurrency ANCHOR — the ~400ms simulated blocking DB+file
I/O step every RoutingService.FindOptimalRoute call performs identically, in
both execution models. Only WHERE this runs (a thread-pool worker, via
asyncio.to_thread, vs grpc.aio's single event-loop thread) changes between
the correct and starving modes — see app/routing_service.py.
"""
from __future__ import annotations

import time
from pathlib import Path

from shipping.type.v1 import types_pb2

_DB_DELAY_S = 0.2
_STORAGE_DELAY_S = 0.2
_CACHE_PATH = Path(__file__).parent / "pricing_cache.txt"


def _read_cache_rows() -> list[tuple[str, str, str, str, str]]:
    rows: list[tuple[str, str, str, str, str]] = []
    with open(_CACHE_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            route_id, carrier, origin_code, dest_code, price_amount = line.split(",")
            rows.append((route_id, carrier, origin_code, dest_code, price_amount))
    return rows


def blocking_lookup(origin_code: str, dest_code: str) -> types_pb2.Route:
    """Performs the chapter's ~400ms of blocking, thread-occupying
    work: time.sleep standing in for a database round trip, then a REAL
    blocking read of the bundled cache file, padded with a second
    time.sleep standing in for a slow, network-attached store. The two
    sleeps are what make the total land near 400ms; the local file read
    itself typically finishes in microseconds — naming both delays
    explicitly keeps the "DB hop" and "storage hop" shapes this chapter's
    prose refers to visible in the code. time.sleep and a blocking file read
    both release the GIL for their duration (CPython has always done this
    for I/O-bound calls), which is why the correct, offloaded mode in
    app/routing_service.py overlaps eight concurrent calls rather
    than only *looking* concurrent — see the chapter's GIL section. Falls
    back to the cache's first row when no exact origin/destination match
    exists — a simplification: this demo's subject is WHERE the blocking
    work runs, not route-matching logic.
    """
    time.sleep(_DB_DELAY_S)
    rows = _read_cache_rows()
    time.sleep(_STORAGE_DELAY_S)

    row = next((r for r in rows if r[2] == origin_code and r[3] == dest_code), rows[0])
    route_id, carrier, origin_code, dest_code, price_amount = row

    leg = types_pb2.Leg(
        carrier=carrier,
        origin=types_pb2.Location(un_locode=origin_code),
        destination=types_pb2.Location(un_locode=dest_code),
    )
    return types_pb2.Route(
        id=route_id,
        legs=[leg],
        price=types_pb2.Money(currency="USD", amount=price_amount),
    )
