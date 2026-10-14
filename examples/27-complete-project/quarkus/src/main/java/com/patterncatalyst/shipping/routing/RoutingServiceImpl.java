package com.patterncatalyst.shipping.routing;

import org.jboss.logging.Logger;

import io.grpc.Channel;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.opentelemetry.api.trace.Span;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import com.patterncatalyst.shipping.security.SecureGrpcClients;
import jakarta.annotation.PostConstruct;
import shipping.quote.v1.MutinyQuoteServiceGrpc;
import shipping.quote.v1.Quote;
import shipping.routing.v1.Routing;
import shipping.routing.v1.RoutingService;
import shipping.type.v1.Types;

/**
 * Ch27 final project — RoutingService: GetQuote (unary, calling DOWNSTREAM
 * QuoteService over a real mTLS+JWT gRPC hop) and NegotiateRoute (bidi, real
 * negotiation logic — see {@link NegotiationPolicy}) implemented for real;
 * FindOptimalRoute/ListRoutes/RecomputeRoutes still answer UNIMPLEMENTED,
 * same discipline as every prior anchor. ListRoutes is this example's
 * wrong-scope PERMISSION_DENIED target (see
 * {@code security/AuthzInterceptor.java}) — the interceptor's authorization
 * decision is independent of whether the method behind it is implemented.
 *
 * <p>The downstream {@code QuoteService} client is a manually-built mTLS
 * channel (see {@link SecureGrpcClients}), not a Quarkus-managed
 * {@code @GrpcClient}, because this call lands on the SAME mTLS-required,
 * JWT-gated port every external caller hits.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);
    private static final String CARRIER = "MAERSK";

    private MutinyQuoteServiceGrpc.MutinyQuoteServiceStub quoteClient;

    @PostConstruct
    void init() {
        Channel channel = SecureGrpcClients.withInternalToken(SecureGrpcClients.loopbackChannel());
        this.quoteClient = MutinyQuoteServiceGrpc.newMutinyStub(channel);
    }

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

    /**
     * Bidirectional: for every {@code NegotiateRouteRequest} proposal
     * received, emit one {@code NegotiateRouteResponse} decided by
     * {@link NegotiationPolicy} — a 1:1 mapping that preserves arrival order,
     * same operator shape Chapter 9's {@code Sync} uses.
     */
    @Override
    public Multi<Routing.NegotiateRouteResponse> negotiateRoute(Multi<Routing.NegotiateRouteRequest> request) {
        return request.onItem().transform(req -> {
            Routing.NegotiateRouteResponse resp = NegotiationPolicy.negotiate(req);
            LOG.infof("NegotiateRoute: proposal price=%s -> accepted=%s counter.price=%s",
                    req.getProposal().getPrice().getAmount(), resp.getAccepted(), resp.getCounter().getPrice().getAmount());
            return resp;
        });
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

    private static StatusRuntimeException unimplemented(String method) {
        return Status.UNIMPLEMENTED
                .withDescription(method + " is declared in the contract but out of scope for this example")
                .asRuntimeException();
    }
}
