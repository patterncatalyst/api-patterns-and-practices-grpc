package com.patterncatalyst.shipping.security;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import org.jboss.logging.Logger;

import io.grpc.ForwardingServerCall;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import io.quarkus.grpc.GlobalInterceptor;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

/**
 * Ch27 final project — the Chapter 20 JWT-validating + per-method-authorizing
 * {@code ServerInterceptor}, extended to the four RPCs this chapter actually
 * exercises for real (GetQuote, NegotiateRoute, WatchShipment,
 * ReportPositions) plus the admin-gated negative-test target (ListRoutes,
 * still UNIMPLEMENTED behind it). Runs on top of the mTLS handshake Chapter
 * 19's {@code quarkus.grpc.server.ssl.*} keys already enforce — mTLS proves
 * WHO is dialing in at the transport layer; this interceptor decides WHAT
 * that caller is allowed to invoke, a separate question answered a layer up.
 *
 * <p>Three outcomes per call, decided in this order, before any service
 * implementation ever runs:
 * <ol>
 *   <li><b>Reflection is exempt</b> — {@code grpcurl list}/{@code describe}
 *       work with no token.</li>
 *   <li><b>Authentication.</b> No {@code authorization} header, a header that
 *       isn't {@code Bearer <jwt>}, or a token {@link JwtVerifier} rejects
 *       (bad signature, malformed, expired) all close the call with
 *       {@code UNAUTHENTICATED}.</li>
 *   <li><b>Authorization.</b> A successfully authenticated token whose
 *       {@code scope} claim doesn't contain the scope {@code METHOD_SCOPES}
 *       names for this method gets {@code PERMISSION_DENIED}, before the
 *       handler ever runs.</li>
 * </ol>
 */
@ApplicationScoped
@GlobalInterceptor
public class AuthzInterceptor implements ServerInterceptor {

    private static final Logger LOG = Logger.getLogger(AuthzInterceptor.class);
    private static final Metadata.Key<String> AUTHORIZATION =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);
    private static final String BEARER_PREFIX = "Bearer ";

    // method ("pkg.Service/Method") -> the scope required to call it. No
    // entry means "authenticated only". ListRoutes is gated on routes:admin,
    // a scope none of this example's demo tokens ever carry — the wrong-scope
    // PERMISSION_DENIED target.
    private static final Map<String, String> METHOD_SCOPES = Map.ofEntries(
            Map.entry("shipping.routing.v1.RoutingService/GetQuote", "quote:read"),
            Map.entry("shipping.routing.v1.RoutingService/NegotiateRoute", "routes:negotiate"),
            Map.entry("shipping.routing.v1.RoutingService/ListRoutes", "routes:admin"),
            Map.entry("shipping.quote.v1.QuoteService/GetQuote", "quote:read"),
            Map.entry("shipping.tracking.v1.TrackingService/WatchShipment", "tracking:read"),
            Map.entry("shipping.tracking.v1.TrackingService/ReportPositions", "tracking:write"));

    @Inject
    JwtVerifier jwtVerifier;

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
        String method = call.getMethodDescriptor().getFullMethodName();
        long startNanos = System.nanoTime();

        if (isReflection(method)) {
            return next.startCall(call, headers);
        }

        String authorization = headers.get(AUTHORIZATION);
        if (authorization == null || !authorization.startsWith(BEARER_PREFIX)) {
            return reject(call, method, startNanos, Status.UNAUTHENTICATED
                    .withDescription("missing 'authorization: Bearer <jwt>' metadata"));
        }

        Map<String, Object> claims;
        try {
            claims = jwtVerifier.verify(authorization.substring(BEARER_PREFIX.length()));
        } catch (JwtVerifier.TokenError e) {
            return reject(call, method, startNanos,
                    Status.UNAUTHENTICATED.withDescription("invalid token: " + e.getMessage()));
        }

        String requiredScope = METHOD_SCOPES.get(method);
        if (requiredScope != null) {
            Set<String> granted = new HashSet<>(Arrays.asList(String.valueOf(claims.getOrDefault("scope", "")).trim().split("\\s+")));
            if (!granted.contains(requiredScope)) {
                return reject(call, method, startNanos, Status.PERMISSION_DENIED
                        .withDescription("token lacks required scope '" + requiredScope + "'"));
            }
        }

        ServerCall<ReqT, RespT> timedCall =
                new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                    @Override
                    public void close(Status status, Metadata trailers) {
                        logOutcome(method, status, startNanos);
                        super.close(status, trailers);
                    }
                };
        return next.startCall(timedCall, headers);
    }

    private <ReqT, RespT> ServerCall.Listener<ReqT> reject(
            ServerCall<ReqT, RespT> call, String method, long startNanos, Status status) {
        logOutcome(method, status, startNanos);
        call.close(status, new Metadata());
        return new ServerCall.Listener<>() {
        };
    }

    private static boolean isReflection(String method) {
        return method.startsWith("grpc.reflection.");
    }

    private static void logOutcome(String method, Status status, long startNanos) {
        long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000;
        LOG.infof("grpc_call method=%s status=%s duration_ms=%d", method, status.getCode(), elapsedMs);
    }
}
