package com.patterncatalyst.shipping.routing;

import org.jboss.logging.Logger;

import io.grpc.ForwardingServerCall;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import io.quarkus.grpc.GlobalInterceptor;
import jakarta.enterprise.context.ApplicationScoped;

/**
 * Ch12 interceptors ANCHOR — one bean, two cross-cutting concerns.
 *
 * <p>{@code @GlobalInterceptor} registers this against every gRPC service in
 * the application (RoutingService is the only one here, but the annotation
 * doesn't know that — a second {@code @GrpcService} added later would run
 * through this same interceptor with no extra wiring). Quarkus's own
 * reference guide confirms the shape: an {@code @ApplicationScoped} bean
 * implementing {@code io.grpc.ServerInterceptor}, with {@code @GlobalInterceptor}
 * applying it to every service and {@code @RegisterInterceptor} applying it
 * to one. All global interceptors run before any service-specific one.
 *
 * <p>Two things happen on every call, in this order:
 * <ol>
 *   <li><b>Auth hook.</b> {@code headers} is the request's {@code Metadata} —
 *       gRPC's header map, read before a single byte of the request message
 *       is deserialized. No {@code authorization} entry means the call is
 *       rejected with {@code UNAUTHENTICATED} right here, via
 *       {@code call.close(...)}, and {@code next.startCall(...)} is never
 *       invoked — the handler this call would have reached (GetQuote, or one
 *       of the four UNIMPLEMENTED stubs) never runs. This chapter checks
 *       only for presence; validating a real token's contents is Chapter 20's
 *       job. <b>Exempted:</b> the server reflection service
 *       ({@code grpc.reflection.*}) — {@code @GlobalInterceptor} applies to
 *       every exposed service, reflection included, and a client (grpcurl,
 *       this example's own verify.sh) needs to list/describe the service
 *       before it has any token to send. Production auth interceptors make
 *       the identical exception for reflection and health checks.</li>
 *   <li><b>Logging + timing.</b> The call is wrapped (not the handler — the
 *       {@code ServerCall} itself, via {@code ForwardingServerCall}) so that
 *       whatever status it closes with — {@code OK} for GetQuote,
 *       {@code UNIMPLEMENTED} for the other four, {@code UNAUTHENTICATED}
 *       for a rejected one — gets one structured log line with the method
 *       name and the elapsed time. This runs for every call, auth hook
 *       outcome included.</li>
 * </ol>
 */
@ApplicationScoped
@GlobalInterceptor
public class AuthLoggingInterceptor implements ServerInterceptor {

    private static final Logger LOG = Logger.getLogger(AuthLoggingInterceptor.class);
    private static final Metadata.Key<String> AUTHORIZATION =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
        String method = call.getMethodDescriptor().getFullMethodName();
        long startNanos = System.nanoTime();

        if (!isReflection(method)) {
            String authorization = headers.get(AUTHORIZATION);
            if (authorization == null || authorization.isBlank()) {
                Status status = Status.UNAUTHENTICATED
                        .withDescription("missing 'authorization' metadata");
                logOutcome(method, status, startNanos);
                call.close(status, new Metadata());
                // No listener does anything meaningful once the call is closed;
                // gRPC still requires one back from interceptCall.
                return new ServerCall.Listener<>() {
                };
            }
        }

        // Wrap the CALL, not the handler: close(status, trailers) is the one
        // place every RPC shape — unary, streaming, successful, or not —
        // reports its final status, so this is the one place to log it from.
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

    private static boolean isReflection(String method) {
        return method.startsWith("grpc.reflection.");
    }

    private static void logOutcome(String method, Status status, long startNanos) {
        long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000;
        LOG.infof("grpc_call method=%s status=%s duration_ms=%d", method, status.getCode(), elapsedMs);
    }
}
