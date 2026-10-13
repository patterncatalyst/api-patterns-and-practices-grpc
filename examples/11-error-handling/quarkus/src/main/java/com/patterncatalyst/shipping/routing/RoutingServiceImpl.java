package com.patterncatalyst.shipping.routing;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

import org.jboss.logging.Logger;

import com.google.protobuf.Any;
import com.google.protobuf.Duration;
import com.google.rpc.BadRequest;
import com.google.rpc.Code;
import com.google.rpc.ErrorInfo;
import com.google.rpc.RetryInfo;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.protobuf.StatusProto;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import shipping.routing.v1.Routing;
import shipping.routing.v1.RoutingService;
import shipping.type.v1.Types;

/**
 * Ch11 error-handling ANCHOR — {@code GetQuote} returns deterministic rich
 * errors by input, implemented identically here and in the Python stack (see
 * python/app/routing_service.py). The canonical status code carries the
 * category (retry or don't); {@code google.rpc.Status} details carry the
 * machine-readable specifics — {@link BadRequest}, {@link ErrorInfo}, and
 * {@link RetryInfo} all come from {@code com.google.api.grpc:proto-google-common-protos},
 * a runtime library, not from this chapter's {@code .proto}.
 *
 * <pre>
 *   empty/missing origin or destination unLocode -&gt; INVALID_ARGUMENT + BadRequest
 *   origin.unLocode == "ZZZZZ" (unroutable)      -&gt; NOT_FOUND + ErrorInfo
 *   origin.unLocode == "RETRY"                    -&gt; UNAVAILABLE + RetryInfo
 *   otherwise                                      -&gt; OK, same formula as Ch5
 * </pre>
 *
 * The other four RoutingService methods return UNIMPLEMENTED, as in Ch5.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);
    private static final String CARRIER = "MAERSK";
    private static final String ERROR_DOMAIN = "shipping.routing.v1";
    private static final String UNROUTABLE_ORIGIN = "ZZZZZ";
    private static final String RETRY_ORIGIN = "RETRY";

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        Types.Location origin = request.getOrigin();
        Types.Location destination = request.getDestination();

        List<BadRequest.FieldViolation> violations = new ArrayList<>();
        if (origin.getUnLocode().isBlank()) {
            violations.add(BadRequest.FieldViolation.newBuilder()
                    .setField("origin.un_locode")
                    .setDescription("origin.un_locode is required")
                    .build());
        }
        if (destination.getUnLocode().isBlank()) {
            violations.add(BadRequest.FieldViolation.newBuilder()
                    .setField("destination.un_locode")
                    .setDescription("destination.un_locode is required")
                    .build());
        }
        if (!violations.isEmpty()) {
            String fields = violations.stream()
                    .map(BadRequest.FieldViolation::getField)
                    .collect(Collectors.joining(", "));
            return Uni.createFrom().failure(richError(
                    Code.INVALID_ARGUMENT,
                    "invalid GetQuoteRequest: " + fields + " required (see BadRequest details)",
                    Any.pack(BadRequest.newBuilder().addAllFieldViolations(violations).build())));
        }

        if (UNROUTABLE_ORIGIN.equals(origin.getUnLocode())) {
            return Uni.createFrom().failure(richError(
                    Code.NOT_FOUND,
                    "origin " + UNROUTABLE_ORIGIN + " is unroutable (ErrorInfo reason=ORIGIN_UNROUTABLE)",
                    Any.pack(ErrorInfo.newBuilder()
                            .setReason("ORIGIN_UNROUTABLE")
                            .setDomain(ERROR_DOMAIN)
                            .build())));
        }

        if (RETRY_ORIGIN.equals(origin.getUnLocode())) {
            return Uni.createFrom().failure(richError(
                    Code.UNAVAILABLE,
                    "routing service temporarily unavailable, retry per RetryInfo",
                    Any.pack(RetryInfo.newBuilder()
                            .setRetryDelay(Duration.newBuilder().setSeconds(2).build())
                            .build())));
        }

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

        LOG.infof("GetQuote: %s -> %s, quote=%s %s",
                origin.getUnLocode(), destination.getUnLocode(), quote.getCurrency(), quote.getAmount());

        Routing.GetQuoteResponse response = Routing.GetQuoteResponse.newBuilder()
                .setQuote(quote)
                .setRoute(route)
                .build();
        return Uni.createFrom().item(response);
    }

    /** Builds a {@code google.rpc.Status} (canonical code + one rich detail) and hands it to
     * {@link StatusProto#toStatusRuntimeException} so it lands in the gRPC trailers, exactly
     * as any client library — grpcurl included — expects to find it. */
    private static StatusRuntimeException richError(Code code, String message, Any detail) {
        com.google.rpc.Status richStatus = com.google.rpc.Status.newBuilder()
                .setCode(code.getNumber())
                .setMessage(message)
                .addDetails(detail)
                .build();
        return StatusProto.toStatusRuntimeException(richStatus);
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
