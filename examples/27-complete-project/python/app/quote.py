"""Deterministic quote formula, identical on both stacks and every prior anchor:

    quote.currency = "USD"
    quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)

`amount` is rendered as a decimal STRING, never a binary float, per
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
