package com.patterncatalyst.shipping.booking;

import java.util.List;
import java.util.stream.Collectors;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

import org.jboss.logging.Logger;

import io.quarkus.grpc.GrpcClient;
import io.smallrye.mutiny.Uni;
import shipping.routing.v1.MutinyRoutingServiceGrpc;
import shipping.routing.v1.Routing;
import shipping.type.v1.Types;

/**
 * Ch23 grpc-web & JSON/HTTP transcoding — the hand-written REST shim this
 * chapter contrasts against Envoy's generic {@code grpc_json_transcoder}
 * (../../../../../../envoy/). This class is purpose-built for ONE RPC: it
 * knows the {@code BookingQuoteRequest}/{@code BookingQuoteResponse} JSON
 * shape, builds the {@code GetQuoteRequest} by hand, and shapes the response
 * by hand. Every new RPC this book ever exposes over REST needs a class like
 * this one, written and maintained by a human. Envoy's transcoder, by
 * contrast, derives its JSON mapping from the proto descriptor alone — see
 * the chapter prose for the trade-off between the two.
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
        LOG.infof("BookingResource.quote %s -> %s cargoKg=%.1f",
                request.origin(), request.destination(), request.cargoKg());

        Routing.GetQuoteRequest grpcRequest = Routing.GetQuoteRequest.newBuilder()
                .setOrigin(Types.Location.newBuilder().setUnLocode(request.origin()).build())
                .setDestination(Types.Location.newBuilder().setUnLocode(request.destination()).build())
                .addCargo(Types.Cargo.newBuilder().setWeightKg(request.cargoKg()).build())
                .build();

        return routingClient.getQuote(grpcRequest)
                .onItem().transform(BookingResource::toBookingResponse);
    }

    private static BookingQuoteResponse toBookingResponse(Routing.GetQuoteResponse resp) {
        BookingMoney money = new BookingMoney(resp.getQuote().getCurrency(), resp.getQuote().getAmount());
        List<BookingLeg> legs = resp.getRoute().getLegsList().stream()
                .map(leg -> new BookingLeg(leg.getCarrier()))
                .collect(Collectors.toList());
        BookingRoute route = new BookingRoute(resp.getRoute().getId(), legs);
        return new BookingQuoteResponse(money, route);
    }
}
