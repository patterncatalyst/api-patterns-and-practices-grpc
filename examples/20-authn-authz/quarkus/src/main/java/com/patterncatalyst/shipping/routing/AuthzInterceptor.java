package com.patterncatalyst.shipping.routing;

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
 * Ch20 authn-authz — JWT-validating + per-method-authorizing
 * {@code ServerInterceptor}, the direct descendant of Chapter 12's
 * {@code AuthLoggingInterceptor} (which checked only that {@code
 * authorization} was PRESENT, never what it contained).
 *
 * <p>Three outcomes per call, decided in this order, before
 * {@link RoutingServiceImpl} ever runs:
 * <ol>
 *   <li><b>Reflection is exempt.</b> {@code grpc.reflection.*} skips every
 *       check below — {@code grpcurl list}/{@code describe} (and this
 *       chapter's own {@code verify.sh}) have to work with no token at all,
 *       the same exemption Chapter 12 made.</li>
 *   <li><b>Authentication.</b> No {@code authorization} header, a header
 *       that isn't {@code Bearer <jwt>}, or a token {@link JwtVerifier}
 *       rejects (bad signature, malformed, expired) all close the call with
 *       {@code UNAUTHENTICATED}. The token's claims are never inspected
 *       until the signature and expiry both check out.</li>
 *   <li><b>Authorization.</b> A successfully authenticated token whose
 *       {@code scope} claim doesn't contain the scope {@code METHOD_SCOPES}
 *       names for this method gets {@code PERMISSION_DENIED}. For {@code
 *       ListRoutes} (gated on {@code routes:admin}, which the demo tokens
 *       never carry) this fires and closes the call with {@code
 *       PERMISSION_DENIED} BEFORE {@code next.startCall(...)} is ever
 *       invoked — {@link RoutingServiceImpl#listRoutes} never runs. That
 *       method would also answer {@code UNIMPLEMENTED} if ever reached; that
 *       is a separate, later fact about this example's scope, not the
 *       authorization decision made here.</li>
 * </ol>
 */
@ApplicationScoped
@GlobalInterceptor
public class AuthzInterceptor implements ServerInterceptor {

    private static final Logger LOG = Logger.getLogger(AuthzInterceptor.class);
    private static final Metadata.Key<String> AUTHORIZATION =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);
    private static final String BEARER_PREFIX = "Bearer ";

    // method (MethodDescriptor.getFullMethodName() format: "pkg.Service/Method")
    // -> the scope required to call it. No entry means "authenticated only".
    private static final Map<String, String> METHOD_SCOPES = Map.of(
            "shipping.routing.v1.RoutingService/GetQuote", "quote:read",
            "shipping.routing.v1.RoutingService/ListRoutes", "routes:admin");

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
            Set<String> granted = Set.of(String.valueOf(claims.getOrDefault("scope", "")).trim().split("\\s+"));
            if (!granted.contains(requiredScope)) {
                return reject(call, method, startNanos, Status.PERMISSION_DENIED
                        .withDescription("token lacks required scope '" + requiredScope + "'"));
            }
        }

        // Wrap the CALL, not the handler: close(status, trailers) is the one
        // place every RPC shape reports its final status (same as Chapter 12).
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
        // No listener does anything meaningful once the call is closed; gRPC
        // still requires one back from interceptCall.
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
