package com.patterncatalyst.shipping.routing;

import java.util.ArrayList;
import java.util.List;

import org.jboss.logging.Logger;

import com.google.protobuf.Any;
import com.google.protobuf.FieldMask;
import com.google.protobuf.util.FieldMaskUtil;
import com.google.rpc.BadRequest;
import com.google.rpc.Code;

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
 * Ch13 schema-design ANCHOR — {@code ListRoutes} pages through
 * {@link RouteCatalog#ALL} and projects each returned {@code Route} through
 * the request's {@code FieldMask}, implemented identically here and in the
 * Python stack (see python/app/routing_service.py).
 *
 * <pre>
 *   page_size &lt;= 0                 -&gt; DEFAULT_PAGE_SIZE (3)
 *   page_size &gt; MAX_PAGE_SIZE (5)  -&gt; clamped to MAX_PAGE_SIZE
 *   page_token == ""               -&gt; start at index 0
 *   page_token == "&lt;n&gt;"            -&gt; start at index n (opaque to the client,
 *                                      but just the next offset in this demo)
 *   field_mask.paths empty         -&gt; full Route, unmasked
 *   field_mask.paths non-empty     -&gt; only the named top-level fields set
 * </pre>
 *
 * The other four {@code RoutingService} methods return {@code UNIMPLEMENTED},
 * same discipline as every prior chapter's example — only one RPC is this
 * chapter's real anchor.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);
    static final int DEFAULT_PAGE_SIZE = 3;
    static final int MAX_PAGE_SIZE = 5;

    @Override
    public Uni<Routing.ListRoutesResponse> listRoutes(Routing.ListRoutesRequest request) {
        List<Types.Route> catalog = RouteCatalog.ALL;

        int pageSize = request.getPageSize();
        if (pageSize <= 0) {
            pageSize = DEFAULT_PAGE_SIZE;
        } else if (pageSize > MAX_PAGE_SIZE) {
            pageSize = MAX_PAGE_SIZE;
        }

        int start;
        String token = request.getPageToken();
        if (token.isEmpty()) {
            start = 0;
        } else {
            try {
                start = Integer.parseInt(token);
            } catch (NumberFormatException e) {
                return Uni.createFrom().failure(invalidPageToken(token));
            }
            if (start < 0 || start > catalog.size()) {
                return Uni.createFrom().failure(invalidPageToken(token));
            }
        }

        int end = Math.min(start + pageSize, catalog.size());
        List<Types.Route> page = catalog.subList(start, end);

        FieldMask mask = request.getFieldMask();
        List<Types.Route> projected = new ArrayList<>(page.size());
        for (Types.Route route : page) {
            try {
                projected.add(applyFieldMask(route, mask));
            } catch (IllegalArgumentException e) {
                return Uni.createFrom().failure(invalidFieldMask(e.getMessage()));
            }
        }

        String nextPageToken = end < catalog.size() ? String.valueOf(end) : "";

        LOG.infof("ListRoutes: page_size=%d page_token='%s' -> %d route(s), next_page_token='%s', mask=%s",
                pageSize, token, projected.size(), nextPageToken, mask.getPathsList());

        Routing.ListRoutesResponse response = Routing.ListRoutesResponse.newBuilder()
                .addAllRoutes(projected)
                .setNextPageToken(nextPageToken)
                .build();
        return Uni.createFrom().item(response);
    }

    /**
     * Returns {@code route} unchanged when the caller sent no mask (an unset
     * {@code FieldMask} means "I want everything" — the only reading that
     * keeps {@code ListRoutes} backward compatible with a client built before
     * this field existed). Otherwise builds a FRESH, empty {@code Route}
     * builder and merges only the named top-level paths into it, so any field
     * not named in the mask stays at its zero value and is therefore absent
     * from the wire (proto3 omits unset/default scalar and message fields).
     * {@link FieldMaskUtil#normalize} sorts and de-duplicates the paths first,
     * which also happens to be where an unrecognized path is rejected via
     * {@link FieldMaskUtil#isValid} — never silently ignored.
     */
    private static Types.Route applyFieldMask(Types.Route route, FieldMask mask) {
        if (mask.getPathsCount() == 0) {
            return route;
        }
        if (!FieldMaskUtil.isValid(Types.Route.getDescriptor(), mask)) {
            throw new IllegalArgumentException("field_mask names a path Route does not have: "
                    + mask.getPathsList());
        }
        FieldMask normalized = FieldMaskUtil.normalize(mask);
        Types.Route.Builder projected = Types.Route.newBuilder();
        FieldMaskUtil.merge(normalized, route, projected);
        return projected.build();
    }

    private static StatusRuntimeException invalidPageToken(String token) {
        return richError(Code.INVALID_ARGUMENT,
                "invalid ListRoutesRequest: page_token '" + token + "' is not a valid continuation token",
                Any.pack(BadRequest.newBuilder()
                        .addFieldViolations(BadRequest.FieldViolation.newBuilder()
                                .setField("page_token")
                                .setDescription("must be \"\" or a token returned by a previous ListRoutes call")
                                .build())
                        .build()));
    }

    private static StatusRuntimeException invalidFieldMask(String description) {
        return richError(Code.INVALID_ARGUMENT,
                "invalid ListRoutesRequest: " + description,
                Any.pack(BadRequest.newBuilder()
                        .addFieldViolations(BadRequest.FieldViolation.newBuilder()
                                .setField("field_mask")
                                .setDescription(description)
                                .build())
                        .build()));
    }

    private static StatusRuntimeException richError(Code code, String message, Any detail) {
        com.google.rpc.Status richStatus = com.google.rpc.Status.newBuilder()
                .setCode(code.getNumber())
                .setMessage(message)
                .addDetails(detail)
                .build();
        return StatusProto.toStatusRuntimeException(richStatus);
    }

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        return Uni.createFrom().failure(unimplemented("GetQuote"));
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
