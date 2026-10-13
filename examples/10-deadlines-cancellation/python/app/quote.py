"""Deterministic quote formula, identical on both stacks (and identical to
the Ch5/Ch11 anchors' app/quote.py / QuoteCalculator.java) — see ../README.md:

    quote.currency = "USD"
    quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)

This chapter moves the formula from RoutingServiceServicer (Ch5/Ch11) into
QuoteServiceServicer — the DOWNSTREAM service RoutingService.GetQuote now
calls over gRPC, rather than computing locally. `amount` is still rendered
as a decimal STRING (e.g. "3001.25"), never a binary float, per
`shipping.type.v1.Money`.
"""
from __future__ import annotations

from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal

from shipping.type.v1 import types_pb2

_RATE_PER_KG = 2.50


def compute_quote(cargo_items: Iterable[types_pb2.Cargo]) -> types_pb2.Money:
    total_weight_kg = sum(item.weight_kg for item in cargo_items)
    amount = str(
        Decimal(str(total_weight_kg * _RATE_PER_KG)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    )
    return types_pb2.Money(currency="USD", amount=amount)
