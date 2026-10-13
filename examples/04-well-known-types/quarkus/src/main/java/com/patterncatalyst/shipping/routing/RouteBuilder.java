package com.patterncatalyst.shipping.routing;

import java.time.Instant;

import com.google.protobuf.Timestamp;

import shipping.type.v1.Types;

/**
 * Ch4 well-known-types ANCHOR — builds the one deterministic {@code Route}
 * this chapter's {@code FindOptimalRoute} always returns, identical on both
 * stacks (see python/app/route.py). Fixed {@code departs_at}/{@code
 * arrives_at} {@link Timestamp}s and a fixed decimal-string {@code Money}
 * are the whole point: this class exists so {@code verify.sh} can assert the
 * exact JSON a {@link com.google.protobuf.Timestamp} and a {@code Money}
 * render as, not just that a call succeeds.
 */
public final class RouteBuilder {

    private static final String CARRIER = "MAERSK";

    // Fixed, deterministic instants — not "now" — so both stacks' responses
    // are byte-identical and the chapter's "On the wire" box can print an
    // exact expected RFC 3339 string instead of "some recent timestamp".
    private static final Instant DEPARTS_AT = Instant.parse("2026-02-01T10:00:00Z");
    private static final Instant ARRIVES_AT = Instant.parse("2026-02-18T06:00:00Z");

    private RouteBuilder() {
    }

    public static Types.Route build(Types.Location origin, Types.Location destination) {
        Types.Leg leg = Types.Leg.newBuilder()
                .setCarrier(CARRIER)
                .setOrigin(origin)
                .setDestination(destination)
                .setDepartsAt(toTimestamp(DEPARTS_AT))
                .setArrivesAt(toTimestamp(ARRIVES_AT))
                .build();

        // Money.amount is a decimal STRING, never a binary float — the same
        // convention Chapter 5's QuoteCalculator uses and the sibling REST
        // site's JSON Schema enforces for the identical { currency, amount }
        // shape. Fixed here (no arithmetic) because this chapter's point is
        // the JSON *mapping*, not the pricing formula.
        Types.Money price = Types.Money.newBuilder()
                .setCurrency("USD")
                .setAmount("4200.00")
                .build();

        return Types.Route.newBuilder()
                .setId("rte_" + origin.getUnLocode() + "-" + destination.getUnLocode())
                .addLegs(leg)
                .setPrice(price)
                .build();
    }

    // com.google.protobuf.Timestamp ships inside protobuf-java itself (the
    // compiled well-known-type classes, not a separate dependency) — the
    // same jar quarkus-grpc already pulls in to generate Leg/Money/Route.
    private static Timestamp toTimestamp(Instant instant) {
        return Timestamp.newBuilder()
                .setSeconds(instant.getEpochSecond())
                .setNanos(instant.getNano())
                .build();
    }
}
