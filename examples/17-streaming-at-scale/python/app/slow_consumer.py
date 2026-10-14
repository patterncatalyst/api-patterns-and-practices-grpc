"""Ch17 streaming-at-scale example — the bundled slow consumer.

A slow WatchShipment reader: read one event, sleep ~300ms,
read the next. verify.sh's headline backpressure assertion runs this
against BOTH stacks and compares the server-stamped `event.at` timestamps
it prints for `bkg_demo` (demand-driven: production paces itself so a
~300ms-per-read consumer never falls far behind) against `bkg_eager`
(pre-materialized: every event was already stamped microseconds apart,
long before this script's first read).

Ships inside the Python image (it imports the same generated stubs the
server uses) and targets either stack over the compose network — run it
with `docker compose -p ch17-streaming run --rm python`:

    docker compose -p ch17-streaming run --rm python \\
      python -m app.slow_consumer quarkus:9000 bkg_demo
    docker compose -p ch17-streaming run --rm python \\
      python -m app.slow_consumer python:9000 bkg_eager

Prints one JSON line per event to stdout (booking_id, state, location, at,
note) — `at` is the server's protobuf-JSON-mapped Timestamp string
(fractional seconds included), which is what verify.sh parses to compute
the inter-event deltas the backpressure assertion is built on.
"""
from __future__ import annotations

import asyncio
import json
import sys

import grpc

from shipping.tracking.v1 import tracking_pb2, tracking_pb2_grpc
from shipping.type.v1 import types_pb2

READ_DELAY_S = 0.3


async def _run(target: str, booking_id: str) -> None:
    async with grpc.aio.insecure_channel(target) as channel:
        stub = tracking_pb2_grpc.TrackingServiceStub(channel)
        call = stub.WatchShipment(tracking_pb2.WatchShipmentRequest(booking_id=booking_id))
        async for response in call:
            event = response.event
            line = {
                "booking_id": event.booking_id,
                "state": types_pb2.BookingState.Name(event.state),
                "location": event.location.un_locode,
                "at": event.at.ToJsonString(),
                "note": event.note,
            }
            print(json.dumps(line), flush=True)
            # The deliberate slow part: pretend this event takes ~300ms to
            # process before the next read.
            await asyncio.sleep(READ_DELAY_S)


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python -m app.slow_consumer <host:port> [booking_id]", file=sys.stderr)
        raise SystemExit(2)
    target = sys.argv[1]
    booking_id = sys.argv[2] if len(sys.argv) > 2 else "bkg_demo"
    asyncio.run(_run(target, booking_id))


if __name__ == "__main__":
    main()
