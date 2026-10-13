package com.patterncatalyst.shipping.routing;

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
 * Ch12 interceptors ANCHOR — same {@code GetQuote} formula as Chapter 5
 * (examples/05-contract-first), running behind AuthLoggingInterceptor
 * instead of unprotected. The handler itself knows nothing about auth or
 * timing: both are the interceptor's job, not this class's. The other four
 * RoutingService methods still return UNIMPLEMENTED — the interceptor runs
 * in front of those too, so a call missing `authorization` never reaches
 * even the UNIMPLEMENTED path.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);
    private static final String CARRIER = "MAERSK";

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        Types.Location origin = request.getOrigin();
        Types.Location destination = request.getDestination();

        Types.Money quote = QuoteCalculator.compute(request.getCargoList());

        Types.Leg leg = Types.Leg.newBuilder()
                .setCarrier(CARRIER)
                .setOrigin(origin)
                .setDestination(destination)
                // departsAt / arrivesAt intentionally left unset.
                .build();

        Types.Route route = Types.Route.newBuilder()
                .setId("rte_" + origin.getUnLocode() + "-" + destination.getUnLocode())
                .addLegs(leg)
                .setPrice(quote)
                .build();

        LOG.infof("GetQuote: %s -> %s, %d cargo item(s), quote=%s %s",
                origin.getUnLocode(), destination.getUnLocode(),
                request.getCargoCount(), quote.getCurrency(), quote.getAmount());

        Routing.GetQuoteResponse response = Routing.GetQuoteResponse.newBuilder()
                .setQuote(quote)
                .setRoute(route)
                .build();
        return Uni.createFrom().item(response);
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
