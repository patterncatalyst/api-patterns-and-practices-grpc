"""Ch23 grpc-web & JSON/HTTP transcoding — the hand-written REST shim's wire
shapes. `alias_generator=to_camel` + `populate_by_name=True` makes every
field accept AND emit camelCase JSON keys (`cargoKg`), matching the Quarkus
stack's Java records byte for byte — see ../../quarkus/.../BookingQuote*.java.
FastAPI serializes response models with `by_alias=True` by default, so no
extra configuration is needed on the route handlers in app/api.py.
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
    """Unlike Ch21's version, there is no `trace_id` field — this chapter is
    not about tracing, and LGTM stays opt-in (see ../../compose.yaml's
    `observability` profile).
    """

    quote: Money
    route: Route
