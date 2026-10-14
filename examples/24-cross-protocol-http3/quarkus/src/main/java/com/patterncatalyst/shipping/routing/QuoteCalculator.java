package com.patterncatalyst.shipping.routing;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

import shipping.type.v1.Types;

/**
 * Deterministic quote formula, identical on both stacks and unchanged from
 * every prior chapter's anchor — see ../../../../../../../README.md:
 *
 * <pre>
 *     quote.currency = "USD"
 *     quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
 * </pre>
 *
 * Ch24 reuses this formula verbatim: the point of this chapter's example is
 * the transport each request travels over (native gRPC/HTTP2 via ghz, and a
 * separate, unrelated HTTP/3-over-QUIC transport probe against Caddy), not a
 * new business rule.
 */
public final class QuoteCalculator {

    private static final double RATE_PER_KG = 2.50;

    private QuoteCalculator() {
    }

    public static Types.Money compute(List<Types.Cargo> cargo) {
        double totalWeightKg = 0;
        for (Types.Cargo item : cargo) {
            totalWeightKg += item.getWeightKg();
        }
        String amount = BigDecimal.valueOf(totalWeightKg * RATE_PER_KG)
                .setScale(2, RoundingMode.HALF_UP)
                .toPlainString();
        return Types.Money.newBuilder().setCurrency("USD").setAmount(amount).build();
    }
}
