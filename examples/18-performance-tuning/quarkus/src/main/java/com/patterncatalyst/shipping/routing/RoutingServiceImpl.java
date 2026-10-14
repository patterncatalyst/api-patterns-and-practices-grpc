package com.patterncatalyst.shipping.routing;

import java.util.List;

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
 * Ch18 performance-tuning — two real RPCs on purpose: {@link #getQuote} is
 * the Ch7 fast-unary anchor, unchanged; {@link #listRoutes} pages through
 * {@link RouteCatalog#ALL}, the one deliberately oversized payload this
 * chapter's wire-size levers (max-inbound-message-size, gzip) act on.
 *
 * <p>Unlike Ch13, {@code field_mask} is NOT applied here — that projection
 * lever is Chapter 13's, already covered in depth there, and re-implementing
 * it on this catalog would just duplicate it without adding a new teaching
 * point. This chapter's subject is wire SIZE and channel lifecycle, so
 * {@code ListRoutes} always returns full, unprojected {@code Route}s; a
 * request's {@code field_mask} field is accepted (the proto requires it to
 * be) but ignored.
 *
 * <p>The other three {@code RoutingService} methods return
 * {@code UNIMPLEMENTED}, same discipline as every prior chapter's example.
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
    public Uni<Routing.ListRoutesResponse> listRoutes(Routing.ListRoutesRequest request) {
        List<Types.Route> catalog = RouteCatalog.ALL;

        int pageSize = request.getPageSize();
        if (pageSize <= 0) {
            pageSize = RouteCatalog.DEFAULT_PAGE_SIZE;
        } else if (pageSize > RouteCatalog.MAX_PAGE_SIZE) {
            pageSize = RouteCatalog.MAX_PAGE_SIZE;
        }

        int start;
        String token = request.getPageToken();
        if (token.isEmpty()) {
            start = 0;
        } else {
            try {
                start = Integer.parseInt(token);
            } catch (NumberFormatException e) {
                return Uni.createFrom().failure(Status.INVALID_ARGUMENT
                        .withDescription("page_token '" + token + "' is not a valid continuation token")
                        .asRuntimeException());
            }
            if (start < 0 || start > catalog.size()) {
                return Uni.createFrom().failure(Status.INVALID_ARGUMENT
                        .withDescription("page_token '" + token + "' is out of range")
                        .asRuntimeException());
            }
        }

        int end = Math.min(start + pageSize, catalog.size());
        List<Types.Route> page = catalog.subList(start, end);
        String nextPageToken = end < catalog.size() ? String.valueOf(end) : "";

        LOG.infof("ListRoutes: page_size=%d page_token='%s' -> %d route(s) (catalog=%d), next_page_token='%s'",
                pageSize, token, page.size(), catalog.size(), nextPageToken);

        Routing.ListRoutesResponse response = Routing.ListRoutesResponse.newBuilder()
                .addAllRoutes(page)
                .setNextPageToken(nextPageToken)
                .build();
        return Uni.createFrom().item(response);
    }

    @Override
    public Uni<Routing.FindOptimalRouteResponse> findOptimalRoute(Routing.FindOptimalRouteRequest request) {
        return Uni.createFrom().failure(unimplemented("FindOptimalRoute"));
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
