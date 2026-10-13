package com.patterncatalyst.shipping.routing;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

import shipping.type.v1.Types;

/**
 * Ch11 error-handling example — the same deterministic quote formula as the
 * Ch5 contract-first anchor (see examples/05-contract-first/quarkus/.../QuoteCalculator.java),
 * reproduced here because this example is an independent module: only the
 * valid-input path reaches this calculator; the invalid and sentinel inputs
 * this chapter teaches short-circuit into a rich gRPC error before it runs.
 *
 *     quote.currency = "USD"
 *     quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
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
