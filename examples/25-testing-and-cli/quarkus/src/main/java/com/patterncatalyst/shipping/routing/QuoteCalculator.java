package com.patterncatalyst.shipping.routing;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

import shipping.type.v1.Types;

/**
 * Deterministic quote formula, identical to every other chapter's Quarkus
 * side (and to the Python side here — see ../../../../../../../README.md),
 * so a {@code RoutingServiceTest} assertion and a {@code verify.sh} grpcurl
 * call agree on the same number:
 *
 * <pre>
 *     quote.currency = "USD"
 *     quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
 * </pre>
 *
 * {@code amount} is always rendered as a decimal STRING ("3001.25"), per
 * {@code shipping.type.v1.Money} — never a binary float.
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
