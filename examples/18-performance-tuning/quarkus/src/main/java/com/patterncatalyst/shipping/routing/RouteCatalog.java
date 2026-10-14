package com.patterncatalyst.shipping.routing;

import java.util.ArrayList;
import java.util.List;

import shipping.type.v1.Types;

/**
 * Ch18 performance-tuning — a fixed, in-memory catalog of {@value #ROUTE_COUNT}
 * {@code Route}s, built so that requesting the WHOLE catalog in one
 * {@code ListRoutes} response is deterministically larger than gRPC's 4MB
 * default max-message-size, and requesting the chapter's small default page
 * is deterministically well under it. Every route's {@code Leg.carrier}
 * field is padded to {@value #PAD_LEN} characters past its short, readable
 * prefix — the only free-text field {@code Route}/{@code Leg} expose (there
 * is no spare "description" field on either message in the frozen
 * contract), so padding it is how this demo manufactures size without
 * touching {@code contracts/proto/}.
 *
 * <p>The padding is a deliberate simplification, not a realistic payload: a
 * production catalog gets this size from genuine data — many legs, carrier
 * metadata, timestamps — not a block of repeated characters. What has to be
 * real here is the BYTE COUNT, so the same {@code ListRoutes} call produces
 * the same number of bytes on every run, on both stacks — see
 * {@code python/app/catalog.py} for the byte-for-byte equivalent.
 *
 * <pre>
 *   {@value #ROUTE_COUNT} routes x {@value #LEGS_PER_ROUTE} legs x (~15-byte
 *   prefix + {@value #PAD_LEN}-byte pad) carrier payload alone totals
 *   ~5.0MB — comfortably past the 4MB default max-message-size and
 *   comfortably under an 8MB raised one.
 * </pre>
 */
final class RouteCatalog {

    static final int ROUTE_COUNT = 25;
    static final int LEGS_PER_ROUTE = 2;
    static final int PAD_LEN = 100_000;
    static final int DEFAULT_PAGE_SIZE = 3;
    static final int MAX_PAGE_SIZE = ROUTE_COUNT;

    // Five origin/destination pairs, cycled — the same port data Ch13's
    // catalog uses, not padded (Location.name/un_locode stay realistic;
    // only Leg.carrier is inflated).
    private static final String[][] PORT_PAIRS = {
            { "USNYC", "New York", "NLRTM", "Rotterdam" },
            { "USLAX", "Los Angeles", "CNSHA", "Shanghai" },
            { "DEHAM", "Hamburg", "SGSIN", "Singapore" },
            { "NLRTM", "Rotterdam", "USNYC", "New York" },
            { "CNSHA", "Shanghai", "USLAX", "Los Angeles" },
    };

    private static final String[] CARRIERS = { "MAERSK", "MSC", "HMM", "COSCO", "CMA CGM" };

    static final List<Types.Route> ALL = buildCatalog();

    private RouteCatalog() {
    }

    private static List<Types.Route> buildCatalog() {
        List<Types.Route> routes = new ArrayList<>(ROUTE_COUNT);
        for (int i = 1; i <= ROUTE_COUNT; i++) {
            String[] pair = PORT_PAIRS[(i - 1) % PORT_PAIRS.length];
            String carrierName = CARRIERS[(i - 1) % CARRIERS.length];

            Types.Location origin = Types.Location.newBuilder()
                    .setUnLocode(pair[0]).setName(pair[1]).build();
            Types.Location destination = Types.Location.newBuilder()
                    .setUnLocode(pair[2]).setName(pair[3]).build();
            Types.Money price = Types.Money.newBuilder()
                    .setCurrency("USD").setAmount((1000 + i) + ".00").build();

            Types.Route.Builder route = Types.Route.newBuilder()
                    .setId(String.format("rte_%03d", i))
                    .setPrice(price);
            for (int legIdx = 1; legIdx <= LEGS_PER_ROUTE; legIdx++) {
                route.addLegs(Types.Leg.newBuilder()
                        .setCarrier(paddedCarrier(carrierName, i, legIdx))
                        .setOrigin(origin)
                        .setDestination(destination)
                        .build());
            }
            routes.add(route.build());
        }
        return List.copyOf(routes);
    }

    /**
     * {@code "<CARRIER>-<route>-<leg>-"} followed by {@value #PAD_LEN} filler
     * characters. The prefix keeps the field inspectable (a reader or a
     * {@code grpcurl} call can confirm which route/leg a given carrier string
     * belongs to); the filler is what manufactures byte count deterministically.
     */
    private static String paddedCarrier(String carrierName, int routeIdx, int legIdx) {
        String prefix = carrierName + "-" + String.format("%03d", routeIdx) + "-" + legIdx + "-";
        return prefix + "X".repeat(PAD_LEN);
    }
}
