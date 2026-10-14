"""Ch27 final project — the REST front door's wire shapes. `alias_generator
=to_camel` + `populate_by_name=True` makes every field accept AND emit
camelCase JSON keys (`cargoKg`, `traceId`), matching the Quarkus stack's Java
records byte for byte.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class BookingQuoteRequest(CamelModel):
    origin: str
    destination: str
    cargo_kg: float


class Money(CamelModel):
    currency: str
    amount: str


class Leg(CamelModel):
    carrier: str


class Route(CamelModel):
    id: str
    legs: list[Leg]


class BookingQuoteResponse(CamelModel):
    """`trace_id` (JSON: `traceId`) is the hex W3C trace id of the span this
    request ran under — the same id RoutingServiceServicer and
    QuoteServiceServicer both logged while handling the two mTLS+JWT gRPC
    hops underneath this call.
    """

    trace_id: str
    quote: Money
    route: Route
