"""Ch27 final project — the real negotiation policy behind
RoutingService.NegotiateRoute, identical to the Quarkus side's
routing/NegotiationPolicy.java: a proposal priced at or under ACCEPT_THRESHOLD
is accepted as-is; anything over it is countered at 90% of the proposed
price. Deterministic (no randomness, no clock dependence).
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from shipping.routing.v1 import routing_pb2

ACCEPT_THRESHOLD = Decimal("5000.00")
_COUNTER_FACTOR = Decimal("0.90")


def negotiate(request: routing_pb2.NegotiateRouteRequest) -> routing_pb2.NegotiateRouteResponse:
    proposal = request.proposal
    price = Decimal(proposal.price.amount)

    if price <= ACCEPT_THRESHOLD:
        return routing_pb2.NegotiateRouteResponse(accepted=True, counter=proposal)

    counter_amount = str((price * _COUNTER_FACTOR).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    counter = proposal.__class__()
    counter.CopyFrom(proposal)
    counter.price.amount = counter_amount
    return routing_pb2.NegotiateRouteResponse(accepted=False, counter=counter)
