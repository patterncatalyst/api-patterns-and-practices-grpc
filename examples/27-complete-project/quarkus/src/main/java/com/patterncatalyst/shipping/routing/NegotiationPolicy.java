package com.patterncatalyst.shipping.routing;

import java.math.BigDecimal;
import java.math.RoundingMode;

import shipping.routing.v1.Routing;
import shipping.type.v1.Types;

/**
 * Ch27 final project — the real negotiation policy behind
 * {@code RoutingService.NegotiateRoute}, identical on both stacks: a proposal
 * priced at or under {@link #ACCEPT_THRESHOLD} is accepted as-is; anything
 * over it is countered at 90% of the proposed price. Deterministic by design
 * (no randomness, no clock dependence) so {@code verify.sh} can assert an
 * exact counter amount for a fixed input, the same discipline every other
 * anchor's quote formula follows.
 */
public final class NegotiationPolicy {

    public static final String ACCEPT_THRESHOLD = "5000.00";
    private static final BigDecimal COUNTER_FACTOR = new BigDecimal("0.90");

    private NegotiationPolicy() {
    }

    public static Routing.NegotiateRouteResponse negotiate(Routing.NegotiateRouteRequest request) {
        Types.Route proposal = request.getProposal();
        BigDecimal price = new BigDecimal(proposal.getPrice().getAmount());
        BigDecimal threshold = new BigDecimal(ACCEPT_THRESHOLD);

        if (price.compareTo(threshold) <= 0) {
            return Routing.NegotiateRouteResponse.newBuilder()
                    .setAccepted(true)
                    .setCounter(proposal)
                    .build();
        }

        String counterAmount = price.multiply(COUNTER_FACTOR).setScale(2, RoundingMode.HALF_UP).toPlainString();
        Types.Route counterRoute = proposal.toBuilder()
                .setPrice(proposal.getPrice().toBuilder().setAmount(counterAmount).build())
                .build();
        return Routing.NegotiateRouteResponse.newBuilder()
                .setAccepted(false)
                .setCounter(counterRoute)
                .build();
    }
}
