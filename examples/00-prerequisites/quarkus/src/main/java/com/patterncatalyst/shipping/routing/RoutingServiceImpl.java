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
 * Ch0 prerequisites SKELETON — proves the toolchain (codegen, reflection,
 * Compose) wires up end to end, nothing more. {@code GetQuote} returns a
 * fixed, hardcoded {@code GetQuoteResponse} regardless of the request —
 * no weight math, no persistence. The real quote formula (computed from
 * cargo weight, identical on both stacks) is Chapter 5's job; see
 * examples/05-contract-first/quarkus/.../QuoteCalculator.java.
 *
 * The other four RoutingService methods are declared in the proto for later
 * chapters and intentionally return UNIMPLEMENTED here, same as Ch5.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);

    // Canned response — not computed from the request. Chapter 5 replaces
    // this with a real formula; this chapter only needs a stable, assertable
    // wire value to prove the stack is up.
    private static final Types.Money CANNED_QUOTE = Types.Money.newBuilder()
            .setCurrency("USD")
            .setAmount("0.00")
            .build();

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        Types.Route placeholderRoute = Types.Route.newBuilder()
                .setId("rte_placeholder")
                .setPrice(CANNED_QUOTE)
                // no legs yet — Chapter 5 fills these in from origin/destination.
                .build();

        LOG.infof("GetQuote: canned response (%s %s) — skeleton only, see Chapter 5 for the real formula",
                CANNED_QUOTE.getCurrency(), CANNED_QUOTE.getAmount());

        Routing.GetQuoteResponse response = Routing.GetQuoteResponse.newBuilder()
                .setQuote(CANNED_QUOTE)
                .setRoute(placeholderRoute)
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
