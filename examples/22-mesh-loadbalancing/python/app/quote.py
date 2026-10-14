"""The same deterministic quote formula Ch5 and Ch7 use, so this cluster-tier
server's GetQuote answers are byte-for-byte comparable to every Compose-tier
example in the book — load balancing changes nothing about response content.

    quote.currency = "USD"
    quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)

`amount` is always rendered as a decimal STRING, per `shipping.type.v1.Money`.
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
