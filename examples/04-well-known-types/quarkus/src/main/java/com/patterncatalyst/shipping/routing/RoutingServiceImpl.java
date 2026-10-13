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
 * Ch4 well-known-types ANCHOR — the unary {@code FindOptimalRoute} RPC,
 * implemented identically here and in the Python stack (see
 * python/app/routing_service.py). The other four RoutingService methods are
 * declared in the proto for other chapters and intentionally return
 * UNIMPLEMENTED — this example stands on its own, independent of Chapter 5's
 * GetQuote anchor.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);

    @Override
    public Uni<Routing.FindOptimalRouteResponse> findOptimalRoute(Routing.FindOptimalRouteRequest request) {
        Types.Location origin = request.getOrigin();
        Types.Location destination = request.getDestination();

        Types.Route route = RouteBuilder.build(origin, destination);

        LOG.infof("FindOptimalRoute: %s -> %s, departs=%s, arrives=%s, price=%s %s",
                origin.getUnLocode(), destination.getUnLocode(),
                route.getLegs(0).getDepartsAt(), route.getLegs(0).getArrivesAt(),
                route.getPrice().getCurrency(), route.getPrice().getAmount());

        return Uni.createFrom().item(
                Routing.FindOptimalRouteResponse.newBuilder().setRoute(route).build());
    }

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        return Uni.createFrom().failure(unimplemented("GetQuote"));
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
                .withDescription(method + " is out of scope for this chapter")
                .asRuntimeException();
    }
}
