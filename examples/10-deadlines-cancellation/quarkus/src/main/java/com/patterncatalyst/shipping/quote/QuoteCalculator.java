package com.patterncatalyst.shipping.quote;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

import shipping.type.v1.Types;

/**
 * Deterministic quote formula, identical on both stacks (and identical to the
 * Ch5/Ch11 anchors' QuoteCalculator.java / app/quote.py) so the Quarkus and
 * Python gRPC responses are byte-for-byte comparable — see ../../../../../../README.md:
 *
 * <pre>
 *     quote.currency = "USD"
 *     quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
 * </pre>
 *
 * This chapter moves the formula from RoutingServiceImpl (Ch5/Ch11) into
 * QuoteServiceImpl — the DOWNSTREAM service RoutingService.GetQuote now calls
 * over gRPC, rather than computing locally. {@code amount} is still rendered
 * as a decimal STRING ("3001.25"), never a binary float, per
 * {@code shipping.type.v1.Money}.
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
