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
 * Ch24 cross-protocol-http3 — a lean server: only {@link #getQuote} is
 * implemented, reusing the Ch7/Ch18 formula unchanged. This chapter's subject
 * is the wire each RPC travels over, not a new business capability, so there
 * is no {@code ListRoutes} catalog here the way Ch18 built one — every other
 * {@code RoutingService} method returns {@code UNIMPLEMENTED}, same
 * discipline as every prior chapter's example.
 *
 * <p>{@code GetQuote} is called two ways in this chapter's {@code verify.sh}:
 * once directly over native gRPC (HTTP/2) via {@code grpcurl}, and once under
 * load via the pinned {@code ghz} benchmarking tool — both against THIS same
 * implementation. Neither call has anything to do with the separate HTTP/3
 * transport probe against Caddy (see {@code python/app/h3_probe.py} and the
 * chapter prose): grpc-java has no gRPC-over-HTTP/3 transport to opt into as
 * of this writing, so this service speaks gRPC the only way grpc-java knows
 * how — over HTTP/2.
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
                .withDescription(method + " is out of scope for this chapter's lean GetQuote-only server")
                .asRuntimeException();
    }
}
