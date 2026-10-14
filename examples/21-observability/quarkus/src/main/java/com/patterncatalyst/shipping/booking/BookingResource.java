package com.patterncatalyst.shipping.booking;

import java.util.List;
import java.util.stream.Collectors;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

import org.jboss.logging.Logger;

import io.opentelemetry.api.trace.Span;
import io.quarkus.grpc.GrpcClient;
import io.smallrye.mutiny.Uni;
import shipping.routing.v1.MutinyRoutingServiceGrpc;
import shipping.routing.v1.Routing;
import shipping.type.v1.Types;

/**
 * Ch21 observability ANCHOR — the REST front door this chapter adds: the ONE
 * place in this example a client crosses the REST-to-gRPC seam this book keeps
 * coming back to. {@code quarkus-opentelemetry}'s REST instrumentation (on by
 * default) starts a span here BEFORE this method runs — {@link Span#current()}
 * below reads that span's trace id. The {@code @GrpcClient("routing")} stub is
 * ALSO auto-instrumented, so calling it injects a W3C {@code traceparent}
 * carrying that same trace id into the outgoing gRPC call's metadata. Neither
 * injection nor extraction is code in this file: both sides of the propagation
 * are the OpenTelemetry auto-instrumentation doing exactly what it is for.
 *
 * <p>No proto field changes: this resource builds the identical
 * {@code shipping.routing.v1.RoutingService.GetQuoteRequest} any other gRPC
 * client would, over gRPC, to the same {@code RoutingServiceImpl} every other
 * chapter's example calls directly.
 */
@Path("/booking")
public class BookingResource {

    private static final Logger LOG = Logger.getLogger(BookingResource.class);

    @GrpcClient("routing")
    MutinyRoutingServiceGrpc.MutinyRoutingServiceStub routingClient;

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
