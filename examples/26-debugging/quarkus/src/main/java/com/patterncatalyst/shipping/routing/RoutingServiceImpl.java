package com.patterncatalyst.shipping.routing;

import java.time.Duration;

import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import shipping.routing.v1.Routing;
import shipping.routing.v1.RoutingService;
import shipping.type.v1.Types;

/**
 * Ch26 debugging — the same GetQuote formula every prior unary chapter
 * implemented, plus one addition this chapter's DEADLINE_EXCEEDED repro
 * depends on: a configurable artificial delay before the response is built,
 * read from {@code QUOTE_DELAY_MS} (default 2000ms — see
 * application.properties and ../../../../../../../README.md). A client
 * deadline shorter than the delay cannot be met; one longer than it
 * succeeds normally, same request and same server either way.
 *
 * FindOptimalRoute, ListRoutes, NegotiateRoute, and RecomputeRoutes stay
 * exactly as declared in contracts/proto/shipping/routing/v1/routing.proto
 * and never implemented here — the UNIMPLEMENTED repro this chapter teaches
 * calls FindOptimalRoute for exactly that reason.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);
    private static final String CARRIER = "MAERSK";

    @ConfigProperty(name = "ch26.quote-delay-ms", defaultValue = "2000")
    long quoteDelayMs;

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        Types.Location origin = request.getOrigin();
        Types.Location destination = request.getDestination();

        Types.Money quote = QuoteCalculator.compute(request.getCargoList());

        Types.Leg leg = Types.Leg.newBuilder()
                .setCarrier(CARRIER)
                .setOrigin(origin)
                .setDestination(destination)
                // departsAt / arrivesAt left unset.
                .build();

        Types.Route route = Types.Route.newBuilder()
                .setId("rte_" + origin.getUnLocode() + "-" + destination.getUnLocode())
                .addLegs(leg)
                .setPrice(quote)
                .build();

        LOG.infof("GetQuote: %s -> %s, %d cargo item(s), quote=%s %s, delaying %dms before responding",
                origin.getUnLocode(), destination.getUnLocode(),
                request.getCargoCount(), quote.getCurrency(), quote.getAmount(), quoteDelayMs);

        Routing.GetQuoteResponse response = Routing.GetQuoteResponse.newBuilder()
                .setQuote(quote)
                .setRoute(route)
                .build();

        // The artificial delay stands in for a slow downstream dependency
        // without actually adding one — Chapter 10 wired a real downstream
        // hop for the same lesson; this chapter only needs a deadline to
        // have something to race against. .delayIt() schedules the emission
        // on Mutiny's default worker pool rather than blocking the event
        // loop thread a Thread.sleep() here would tie up, so other requests
        // on the same server keep flowing while this one waits.
        return Uni.createFrom().item(response)
                .onItem().delayIt().by(Duration.ofMillis(quoteDelayMs));
    }

    @Override
    public Uni<Routing.FindOptimalRouteResponse> findOptimalRoute(Routing.FindOptimalRouteRequest request) {
        return Uni.createFrom().failure(unimplemented("FindOptimalRoute"));
    }

    @Override
    public Uni<Routing.ListRoutesResponse> listRoutes(Routing.ListRoutesRequest request) {
        return Uni.createFrom().failure(unimplemented("ListRoutes"));
    }

    @Override
    public Uni<Routing.RecomputeRoutesResponse> recomputeRoutes(Routing.RecomputeRoutesRequest request) {
        return Uni.createFrom().failure(unimplemented("RecomputeRoutes"));
    }

    @Override
    public Multi<Routing.NegotiateRouteResponse> negotiateRoute(Multi<Routing.NegotiateRouteRequest> request) {
        return Multi.createFrom().failure(unimplemented("NegotiateRoute"));
    }

    private static StatusRuntimeException unimplemented(String method) {
        return Status.UNIMPLEMENTED
                .withDescription(method + " lands in a later chapter")
                .asRuntimeException();
    }
}
