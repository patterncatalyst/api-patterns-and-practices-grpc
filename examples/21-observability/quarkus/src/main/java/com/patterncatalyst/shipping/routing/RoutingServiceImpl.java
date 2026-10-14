package com.patterncatalyst.shipping.routing;

import org.jboss.logging.Logger;

import io.opentelemetry.api.trace.Span;
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
 * Ch21 observability ANCHOR — the Ch10 two-service loopback shape, minus the
 * deadline-propagation plumbing (no artificial downstream delay, no deadline
 * carving): {@code GetQuote} calls DOWNSTREAM {@code shipping.quote.v1.QuoteService.GetQuote}
 * over a loopback {@code @GrpcClient("quote")} channel and wraps its answer in a
 * {@code Route}, exactly as every prior anchor's handler does.
 *
 * <p>This method is reached two ways: directly over gRPC (grpcurl, the health
 * check target), and indirectly through {@code BookingResource.quote} over ITS
 * OWN loopback {@code @GrpcClient("routing")} channel. Either caller's W3C
 * {@code traceparent} — injected automatically by {@code quarkus-opentelemetry}'s
 * gRPC client instrumentation when the caller is itself inside a span — arrives
 * on this call's metadata and is extracted automatically by the server-side gRPC
 * instrumentation before this method runs, so {@link Span#current()} is already a
 * child of whatever span started the request. Logging that trace id here is half
 * of what verify.sh's trace-continuity assertion checks; QuoteServiceImpl logs the
 * other half.
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
        String traceId = Span.current().getSpanContext().getTraceId();

        Quote.GetQuoteRequest downstreamRequest = Quote.GetQuoteRequest.newBuilder()
                .setOrigin(origin)
                .setDestination(destination)
                .addAllCargo(request.getCargoList())
                .build();

        LOG.infof("RoutingServiceImpl.GetQuote traceId=%s %s -> %s, calling QuoteService",
                traceId, origin.getUnLocode(), destination.getUnLocode());

        return quoteClient.getQuote(downstreamRequest)
                .onItem().transform(quoteResponse -> buildResponse(origin, destination, quoteResponse.getQuote()));
    }

    private static Routing.GetQuoteResponse buildResponse(Types.Location origin, Types.Location destination,
            Types.Money quote) {
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
