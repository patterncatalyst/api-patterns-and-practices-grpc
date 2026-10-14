package com.patterncatalyst.shipping.routing;

import org.jboss.logging.Logger;

import io.quarkus.grpc.GrpcClient;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import shipping.quote.v1.MutinyQuoteServiceGrpc;
import shipping.quote.v1.Quote;
import shipping.routing.v1.Routing;
import shipping.routing.v1.RoutingService;
import shipping.type.v1.Types;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;

/**
 * Ch23 grpc-web & JSON/HTTP transcoding ANCHOR — the Ch21/Ch10 two-service
 * loopback shape, reused unchanged: {@code GetQuote} calls DOWNSTREAM
 * {@code shipping.quote.v1.QuoteService.GetQuote} over a loopback
 * {@code @GrpcClient("quote")} channel and wraps its answer in a
 * {@code Route}, exactly as every prior anchor's handler does.
 *
 * <p>This method is reached FOUR ways in this chapter, all converging on the
 * identical generated service interface method below: directly over native
 * gRPC (grpcurl, port 9230); through {@code BookingResource.quote}'s
 * hand-written REST shim over ITS OWN loopback {@code @GrpcClient("routing")}
 * channel (port 8230); through Envoy's {@code grpc_json_transcoder} filter,
 * which decodes a plain JSON/HTTP POST into this same proto request and
 * forwards it as native gRPC (port 10230); and through Envoy's
 * {@code grpc_web} filter, which unwraps a grpc-web-framed POST into the same
 * native gRPC call (also port 10230). Nothing in this class — or in the proto
 * contract — knows the difference; see ../../../../../../envoy/.
 *
 * <p>The other four RoutingService methods return UNIMPLEMENTED, as in every
 * prior chapter.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);
    private static final String CARRIER = "MAERSK";

    @GrpcClient("quote")
    MutinyQuoteServiceGrpc.MutinyQuoteServiceStub quoteClient;

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        Types.Location origin = request.getOrigin();
        Types.Location destination = request.getDestination();

        Quote.GetQuoteRequest downstreamRequest = Quote.GetQuoteRequest.newBuilder()
                .setOrigin(origin)
                .setDestination(destination)
                .addAllCargo(request.getCargoList())
                .build();

        LOG.infof("RoutingServiceImpl.GetQuote %s -> %s, calling QuoteService",
                origin.getUnLocode(), destination.getUnLocode());

        return quoteClient.getQuote(downstreamRequest)
                .onItem().transform(quoteResponse -> buildResponse(origin, destination, quoteResponse.getQuote()));
    }

    private static Routing.GetQuoteResponse buildResponse(Types.Location origin, Types.Location destination,
            Types.Money quote) {
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

        return Routing.GetQuoteResponse.newBuilder()
                .setQuote(quote)
                .setRoute(route)
                .build();
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
