package com.patterncatalyst.appendixa.getquote;

import io.grpc.ForwardingServerCall;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import io.quarkus.grpc.GlobalInterceptor;
import jakarta.inject.Singleton;

/**
 * The examples/22-mesh-loadbalancing convention, ported to Java: a response
 * TRAILER, {@code x-served-by: <pod-name>}, set on every call. This is gRPC
 * metadata, not a proto field — it adds zero bytes to the contract and
 * exists purely so a caller (grpcurl -v, or a load client) can tell which
 * pod actually answered, which is the whole point of the canary demo in
 * this appendix.
 */
@Singleton
@GlobalInterceptor
public class ServedByInterceptor implements ServerInterceptor {

    private static final Metadata.Key<String> SERVED_BY =
            Metadata.Key.of("x-served-by", Metadata.ASCII_STRING_MARSHALLER);

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
        ServerCall<ReqT, RespT> wrapped = new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
            @Override
            public void close(Status status, Metadata trailers) {
                trailers.put(SERVED_BY, PodIdentity.NAME);
                super.close(status, trailers);
            }
        };
        return next.startCall(wrapped, headers);
    }
}
