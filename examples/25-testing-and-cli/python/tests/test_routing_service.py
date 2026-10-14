"""Ch25 testing-and-cli — the in-process test suite this chapter is about.

A REAL `grpc.aio` server, not `grpc_testing`: grpc_testing's fake channel has
no asyncio support, so the only way to exercise an async servicer in-process
is to actually start one, on an ephemeral port (`add_insecure_port(...:0)`,
the OS picks a free one), and drive it with a real `grpc.aio` channel. The
fixture tears the server and channel down after each test.

This test is the hard gate: the Containerfile's build stage runs
`.venv/bin/python -m pytest tests -q` unconditionally, so if this assertion
goes red, `pytest` exits non-zero, the Docker build fails, `docker compose up
--build` fails, and `verify.sh` fails before a single grpcurl call runs
against a broken image — the Python-side mirror of the Quarkus side's
`mvn verify` gate. See the chapter's "Build, run, observe" section for the
seeded-failure smoke test that proves this gate actually bites.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import grpc
import pytest
import pytest_asyncio

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.routing_service import RoutingServiceServicer

_REQUEST = routing_pb2.GetQuoteRequest(
    origin=types_pb2.Location(un_locode="USNYC", name="New York"),
    destination=types_pb2.Location(un_locode="NLRTM", name="Rotterdam"),
    cargo=[
        types_pb2.Cargo(
            weight_kg=1200.5,
            description="Palletized electronics",
            cargo_type="GENERAL",
        )
    ],
)


@pytest_asyncio.fixture
async def routing_channel() -> AsyncIterator[grpc.aio.Channel]:
    """Starts a REAL grpc.aio server bound to an OS-assigned ephemeral port,
    wired with the same RoutingServiceServicer the container runs, yields a
    channel connected to it, and tears both down afterward."""
    server = grpc.aio.server()
    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()

    channel = grpc.aio.insecure_channel(f"127.0.0.1:{port}")
    try:
        yield channel
    finally:
        await channel.close()
        await server.stop(grace=None)


@pytest.mark.asyncio
async def test_get_quote_computes_the_expected_amount_and_route(
    routing_channel: grpc.aio.Channel,
) -> None:
    stub = routing_pb2_grpc.RoutingServiceStub(routing_channel)

    response = await stub.GetQuote(_REQUEST)

    assert response.quote.currency == "USD"
    assert response.quote.amount == "3001.25"
    assert response.route.id == "rte_USNYC-NLRTM"
    assert response.route.legs[0].carrier == "MAERSK"
