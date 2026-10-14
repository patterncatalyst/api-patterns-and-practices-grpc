package com.patterncatalyst.shipping.security;

import java.io.File;

import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptor;
import io.grpc.ForwardingClientCall;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.grpc.netty.shaded.io.netty.handler.ssl.SslContext;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.context.Context;

/**
 * Ch27 final project — builds the ONE kind of internal gRPC client this
 * module needs: a loopback channel to {@code localhost:9000} (this process's
 * own mTLS-required, JWT-gated port), presenting the SAME client certificate
 * certgen mints for external callers (see ../../README.md and
 * {@code certgen/gen-certs.sh}), plus the internal service token from
 * {@link InternalTokenIssuer} attached to every call as an
 * {@code authorization: Bearer} header.
 *
 * <p>Built with plain grpc-java ({@code NettyChannelBuilder}/{@code
 * GrpcSslContexts}) rather than a Quarkus-managed {@code @GrpcClient}: this
 * sidesteps needing to prove, for an INTERNAL loopback hop that already has
 * zero ambiguity about identity, exactly which Quarkus
 * {@code quarkus.grpc.clients.<name>.ssl.*} key shape the gRPC Java client
 * transport reads for a CLIENT certificate (the reference guide documents the
 * trust-store key but not a client-identity key) — grpc-java's own,
 * upstream-documented {@code SslContextBuilder.keyManager(cert, key)} has no
 * such ambiguity.
 */
public final class SecureGrpcClients {

    private static final String CA_CRT = "/certs/ca.crt";
    private static final String CLIENT_CRT = "/certs/client.crt";
    private static final String CLIENT_KEY = "/certs/client.key";

    private SecureGrpcClients() {
    }

    /** One loopback mTLS channel to this process's own gRPC port, reusable by any stub. */
    public static ManagedChannel loopbackChannel() {
        try {
            SslContext sslContext = GrpcSslContexts.forClient()
                    .trustManager(new File(CA_CRT))
                    .keyManager(new File(CLIENT_CRT), new File(CLIENT_KEY))
                    .build();
            return NettyChannelBuilder.forAddress("localhost", 9000)
                    .sslContext(sslContext)
                    // The SAN list certgen writes into server.crt covers "localhost"
                    // (see certgen/gen-certs.sh), matching this authority override.
                    .overrideAuthority("localhost")
                    .build();
        } catch (Exception e) {
            throw new IllegalStateException("failed to build the internal mTLS loopback channel", e);
        }
    }

    /** Wraps a channel so every call it makes carries the internal service bearer token. */
    public static Channel withInternalToken(Channel channel) {
        return io.grpc.ClientInterceptors.intercept(channel, new BearerTokenInterceptor());
    }

    private static final class BearerTokenInterceptor implements ClientInterceptor {
        private static final Metadata.Key<String> AUTHORIZATION =
                Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);

        @Override
        public <ReqT, RespT> ClientCall<ReqT, RespT> interceptCall(
                MethodDescriptor<ReqT, RespT> method, CallOptions callOptions, Channel next) {
            return new ForwardingClientCall.SimpleForwardingClientCall<>(next.newCall(method, callOptions)) {
                @Override
                public void start(Listener<RespT> responseListener, Metadata headers) {
                    headers.put(AUTHORIZATION, "Bearer " + InternalTokenIssuer.token());
                    // This hand-built channel is NOT a Quarkus-managed @GrpcClient, so OTel
                    // auto-instrumentation never sees it. Inject the active W3C trace context
                    // into the metadata by hand so the downstream handler continues this trace
                    // (the gRPC server side IS auto-instrumented and extracts it).
                    GlobalOpenTelemetry.getPropagators().getTextMapPropagator().inject(
                            Context.current(), headers,
                            (carrier, key, value) -> carrier.put(
                                    Metadata.Key.of(key, Metadata.ASCII_STRING_MARSHALLER), value));
                    super.start(responseListener, headers);
                }
            };
        }
    }
}
