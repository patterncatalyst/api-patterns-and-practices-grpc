"""Ch11 error-handling example — the same deterministic quote formula as the
Ch5 contract-first anchor (see examples/05-contract-first/python/app/quote.py),
reproduced here because this example is an independent module: only the
valid-input path reaches this calculator; the invalid and sentinel inputs
this chapter teaches short-circuit into a rich gRPC error before it runs.

    quote.currency = "USD"
    quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
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
