package com.patterncatalyst.shipping.routing;

import java.util.List;

import shipping.type.v1.Types;

/**
 * Ch13 schema-design ANCHOR — a small, fixed, in-memory catalog of five
 * {@code Route}s that {@code RoutingServiceImpl.listRoutes} paginates and
 * projects. A real routing engine would page over a database query; this
 * catalog exists only so pagination and field-mask projection have
 * deterministic data to walk, in the same identical order on every call —
 * see the Python stack's {@code app/catalog.py} for the byte-for-byte
 * equivalent list.
 */
final class RouteCatalog {

    private RouteCatalog() {
    }

    static final List<Types.Route> ALL = List.of(
            route("rte_001", "MAERSK", "USNYC", "New York", "NLRTM", "Rotterdam", "1200.00"),
            route("rte_002", "MSC", "USLAX", "Los Angeles", "CNSHA", "Shanghai", "2400.00"),
            route("rte_003", "HMM", "DEHAM", "Hamburg", "SGSIN", "Singapore", "1800.50"),
            route("rte_004", "MAERSK", "NLRTM", "Rotterdam", "USNYC", "New York", "1150.75"),
            route("rte_005", "COSCO", "CNSHA", "Shanghai", "USLAX", "Los Angeles", "2600.25"));

    private static Types.Route route(String id, String carrier,
            String originCode, String originName, String destCode, String destName, String priceAmount) {
        Types.Location origin = Types.Location.newBuilder().setUnLocode(originCode).setName(originName).build();
        Types.Location destination = Types.Location.newBuilder().setUnLocode(destCode).setName(destName).build();
        Types.Money price = Types.Money.newBuilder().setCurrency("USD").setAmount(priceAmount).build();
        Types.Leg leg = Types.Leg.newBuilder()
                .setCarrier(carrier)
                .setOrigin(origin)
                .setDestination(destination)
                .build();
        return Types.Route.newBuilder()
                .setId(id)
                .addLegs(leg)
                .setPrice(price)
                .build();
    }
}
