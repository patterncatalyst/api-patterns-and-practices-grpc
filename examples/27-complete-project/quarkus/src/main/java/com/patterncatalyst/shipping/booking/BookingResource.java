package com.patterncatalyst.shipping.booking;

import java.util.List;
import java.util.stream.Collectors;

import jakarta.annotation.PostConstruct;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

import org.jboss.logging.Logger;

import io.grpc.Channel;
import io.opentelemetry.api.trace.Span;
import io.smallrye.mutiny.Uni;
import com.patterncatalyst.shipping.security.SecureGrpcClients;
import shipping.routing.v1.MutinyRoutingServiceGrpc;
import shipping.routing.v1.Routing;
import shipping.type.v1.Types;

/**
 * Ch27 final project — the REST front door: the ONE place in this example a
 * client crosses the REST-to-gRPC seam this book keeps coming back to.
 * {@code quarkus-opentelemetry}'s REST instrumentation starts a span here
 * BEFORE this method runs; {@link Span#current()} reads that span's trace id.
 * This resource's own {@code RoutingService} client is the SAME mTLS +
 * Bearer-token loopback shape {@code RoutingServiceImpl} uses to reach
 * {@code QuoteService} — the front door "holds the client cert and a valid
 * JWT" the same way any other caller of this port must.
 */
@Path("/booking")
public class BookingResource {

    private static final Logger LOG = Logger.getLogger(BookingResource.class);

    private MutinyRoutingServiceGrpc.MutinyRoutingServiceStub routingClient;

    @PostConstruct
    void init() {
        Channel channel = SecureGrpcClients.withInternalToken(SecureGrpcClients.loopbackChannel());
        this.routingClient = MutinyRoutingServiceGrpc.newMutinyStub(channel);
    }

    @POST
    @Path("/quote")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Uni<BookingQuoteResponse> quote(BookingQuoteRequest request) {
        String traceId = Span.current().getSpanContext().getTraceId();

        LOG.infof("BookingResource.quote traceId=%s %s -> %s cargoKg=%.1f",
                traceId, request.origin(), request.destination(), request.cargoKg());

        Routing.GetQuoteRequest grpcRequest = Routing.GetQuoteRequest.newBuilder()
                .setOrigin(Types.Location.newBuilder().setUnLocode(request.origin()).build())
                .setDestination(Types.Location.newBuilder().setUnLocode(request.destination()).build())
                .addCargo(Types.Cargo.newBuilder().setWeightKg(request.cargoKg()).build())
                .build();

        return routingClient.getQuote(grpcRequest)
                .onItem().transform(resp -> toBookingResponse(traceId, resp));
    }

    private static BookingQuoteResponse toBookingResponse(String traceId, Routing.GetQuoteResponse resp) {
        BookingMoney money = new BookingMoney(resp.getQuote().getCurrency(), resp.getQuote().getAmount());
        List<BookingLeg> legs = resp.getRoute().getLegsList().stream()
                .map(leg -> new BookingLeg(leg.getCarrier()))
                .collect(Collectors.toList());
        BookingRoute route = new BookingRoute(resp.getRoute().getId(), legs);
        return new BookingQuoteResponse(traceId, money, route);
    }
}
