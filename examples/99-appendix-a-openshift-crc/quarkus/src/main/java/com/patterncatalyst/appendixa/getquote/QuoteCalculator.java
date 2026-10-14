package com.patterncatalyst.appendixa.getquote;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

import shipping.type.v1.Types;

/**
 * Same formula shape as every other chapter's QuoteCalculator: a fixed base
 * fee plus a per-kilogram rate, USD, rounded to two decimal places. The
 * absolute numbers do not matter here — what Appendix A is demonstrating is
 * the Route/mesh/canary path, not pricing logic.
 */
final class QuoteCalculator {

    private static final BigDecimal BASE_FEE = new BigDecimal("250.00");
    private static final BigDecimal RATE_PER_KG = new BigDecimal("1.35");

    private QuoteCalculator() {
    }

    static Types.Money compute(List<Types.Cargo> cargo) {
        BigDecimal totalWeight = cargo.stream()
                .map(c -> BigDecimal.valueOf(c.getWeightKg()))
                .reduce(BigDecimal.ZERO, BigDecimal::add);

        BigDecimal amount = BASE_FEE.add(totalWeight.multiply(RATE_PER_KG))
                .setScale(2, RoundingMode.HALF_UP);

        return Types.Money.newBuilder()
                .setCurrency("USD")
                .setAmount(amount.toPlainString())
                .build();
    }
}
