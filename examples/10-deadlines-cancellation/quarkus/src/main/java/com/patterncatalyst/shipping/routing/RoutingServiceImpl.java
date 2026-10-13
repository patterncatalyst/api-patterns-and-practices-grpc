package com.patterncatalyst.shipping.routing;

import java.util.concurrent.TimeUnit;

import org.jboss.logging.Logger;

import io.grpc.Context;
import io.grpc.Deadline;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.quarkus.grpc.GrpcClient;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import shipping.quote.v1.MutinyQuoteServiceGrpc;
import shipping.quote.v1.Quote;
import shipping.routing.v1.Routing;
import shipping.routing.v1.RoutingService;
import shipping.type.v1.Types;

/**
 * Ch10 deadline-propagation ANCHOR — {@code GetQuote} no longer prices the shipment
 * itself (that was Ch5/Ch11); it calls DOWNSTREAM {@code shipping.quote.v1.QuoteService.GetQuote}
 * over a loopback {@code @GrpcClient} channel (see application.properties — QuoteServiceImpl
 * runs in this same process) and wraps its answer in a {@code Route}.
 *
 * <p>The deadline this call runs under did not start here: it arrived on the inbound
 * call's {@code grpc-timeout} metadata and grpc-java attached it to {@link Context#current()}
 * before invoking this method. {@code quarkus.grpc.clients.quote.deadline} (a fixed,
 * per-client duration applied to every call regardless of how much time a caller actually
 * has left) is not used here — see application.properties. Instead, every
 * call reads {@code Context.current().getDeadline()}, subtracts a small margin for this
 * method's own overhead, and hands what's left to {@link MutinyQuoteServiceGrpc.MutinyQuoteServiceStub#withDeadlineAfter}
 * before invoking the downstream stub. The budget the booking service's REST handler
 * started with, minus everything already spent reaching this method, is exactly the
 * number QuoteService gets to work with — one shared clock, not three independent ones.
 *
 * <p>When that downstream call runs out of time, grpc-java raises a
 * {@code StatusRuntimeException(DEADLINE_EXCEEDED)} from the stub — not after QuoteService's
 * full 2s delay, but the moment the slice handed to it elapses. Quarkus's default gRPC
 * exception mapping recognizes a {@code StatusRuntimeException} surfacing from a failed
 * {@code Uni} and reuses its status verbatim, so that same {@code DEADLINE_EXCEEDED} is
 * exactly what the client that called THIS method sees — no translation step needed.
 *
 * <p>The other four RoutingService methods return UNIMPLEMENTED, as in Ch5/Ch11.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);
    private static final String CARRIER = "MAERSK";

    // Reserved off the inbound deadline for this method's own work (building the
    // downstream request, constructing the Route) before the downstream slice is
    // carved — never hand QuoteService 100% of a budget that this method itself
    // has to spend part of first.
    private static final long DOWNSTREAM_MARGIN_MS = 100;

    // Used only when a caller sets NO deadline at all on the inbound call — gRPC
    // permits that, but "no deadline" must never mean "wait forever" for the
    // downstream hop either. See Chapter 10's "deadline, not timeout" section.
    private static final long DEFAULT_DOWNSTREAM_BUDGET_MS = 5_000;

    @GrpcClient("quote")
    MutinyQuoteServiceGrpc.MutinyQuoteServiceStub quoteClient;

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        Types.Location origin = request.getOrigin();
        Types.Location destination = request.getDestination();

        Deadline inbound = Context.current().getDeadline();
        long downstreamBudgetMs = inbound != null
                ? inbound.timeRemaining(TimeUnit.MILLISECONDS) - DOWNSTREAM_MARGIN_MS
                : DEFAULT_DOWNSTREAM_BUDGET_MS;

        if (downstreamBudgetMs <= 0) {
            // The budget was already gone before this method could even start the
            // downstream call — failing fast here, with no network round trip at
            // all, is cheaper than letting grpc-java discover the same thing a few
            // milliseconds later over the wire.
            LOG.infof("GetQuote: %s -> %s, no budget left to call QuoteService (inbound deadline already expired)",
                    origin.getUnLocode(), destination.getUnLocode());
            return Uni.createFrom().failure(Status.DEADLINE_EXCEEDED
                    .withDescription("no budget remaining to call QuoteService.GetQuote")
                    .asRuntimeException());
        }

        Quote.GetQuoteRequest downstreamRequest = Quote.GetQuoteRequest.newBuilder()
                .setOrigin(origin)
                .setDestination(destination)
                .addAllCargo(request.getCargoList())
                .build();

        LOG.infof("GetQuote: %s -> %s, calling QuoteService with a %dms downstream deadline",
                origin.getUnLocode(), destination.getUnLocode(), downstreamBudgetMs);

        return quoteClient.withDeadlineAfter(downstreamBudgetMs, TimeUnit.MILLISECONDS)
                .getQuote(downstreamRequest)
                .onFailure().invoke(failure -> LOG.infof(
                        "GetQuote: QuoteService call failed (own context cancelled=%s): %s",
                        Context.current().isCancelled(), failure.getMessage()))
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
