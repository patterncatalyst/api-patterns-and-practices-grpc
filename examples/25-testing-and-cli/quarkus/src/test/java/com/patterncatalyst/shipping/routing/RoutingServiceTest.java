package com.patterncatalyst.shipping.routing;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Duration;

import org.junit.jupiter.api.Test;

import io.quarkus.grpc.GrpcClient;
import io.quarkus.test.junit.QuarkusTest;
import shipping.routing.v1.Routing;
import shipping.routing.v1.RoutingService;
import shipping.type.v1.Types;

/**
 * Ch25 testing-and-cli — the in-process test suite this chapter is about.
 *
 * {@code @QuarkusTest} boots the full application for the test JVM,
 * including the real gRPC server this module wires up in
 * {@code application.properties} (its own port, not the HTTP port).
 * {@code @GrpcClient} then injects a client typed to the SAME generated
 * Mutiny {@code RoutingService} interface {@code RoutingServiceImpl}
 * implements — no manual channel, no manual stub, no host/port
 * configuration, because a client with no client-specific config in a
 * {@code @QuarkusTest} self-wires to the test server's own address. This is
 * the exact pattern documented in the Quarkus gRPC guide's "Testing your
 * services" section (quarkus.io/guides/grpc-service-implementation,
 * confirmed against the installed quarkus-grpc 3.40.1): "in the case of
 * using a client to test an exposed service that does not use TLS, there is
 * no need to provide any configuration."
 *
 * This test is the hard gate: the Containerfile's build stage runs
 * {@code mvn verify} (not {@code -DskipTests}), so if this assertion goes
 * red, {@code mvn verify} fails, the Docker build fails, {@code docker
 * compose up --build} fails, and {@code verify.sh} fails before a single
 * grpcurl call runs against a broken image. See "Build, run, observe" in the
 * chapter for the seeded-failure smoke test that proves this gate actually
 * bites.
 */
@QuarkusTest
class RoutingServiceTest {

    @GrpcClient
    RoutingService client;

    @Test
    void getQuoteComputesTheExpectedAmountAndRoute() {
        Routing.GetQuoteRequest request = Routing.GetQuoteRequest.newBuilder()
                .setOrigin(Types.Location.newBuilder()
                        .setUnLocode("USNYC")
                        .setName("New York")
                        .build())
                .setDestination(Types.Location.newBuilder()
                        .setUnLocode("NLRTM")
                        .setName("Rotterdam")
                        .build())
                .addCargo(Types.Cargo.newBuilder()
                        .setWeightKg(1200.5)
                        .setDescription("Palletized electronics")
                        .setCargoType("GENERAL")
                        .build())
                .build();

        // GetQuote is unary-in/unary-out: the Uni resolves once the server
        // replies. .await().atMost(...) blocks this test thread for that one
        // reply — a tight, explicit timeout so a hung server fails the test
        // instead of hanging the build forever.
        Routing.GetQuoteResponse response = client.getQuote(request)
                .await().atMost(Duration.ofSeconds(5));

        assertEquals("USD", response.getQuote().getCurrency(), "quote.currency");
        assertEquals("3001.25", response.getQuote().getAmount(), "quote.amount");
        assertEquals("rte_USNYC-NLRTM", response.getRoute().getId(), "route.id");
        assertEquals("MAERSK", response.getRoute().getLegs(0).getCarrier(), "route.legs[0].carrier");
    }
}
