package com.patterncatalyst.shipping.security;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Ch27 final project — mints the ONE token this process's own internal
 * callers present: {@code BookingResource} calling {@code RoutingService},
 * and {@code RoutingServiceImpl} calling DOWNSTREAM {@code QuoteService} —
 * both loopback gRPC hops that land on the SAME {@code AuthzInterceptor}-
 * gated, mTLS-required port every external grpcurl/ghz caller hits (see
 * ../../README.md). A real system would issue this as a short-lived
 * service-account token from the same IdP a user-facing token comes from;
 * this demo signs one itself, with {@link JwtVerifier#SECRET}, at class-init
 * time, scoped broadly enough to cover every internal hop this example makes.
 *
 * <p>Minted once and cached: {@code exp} is far enough in the future
 * (24 hours) that it never expires mid-run, so there is no token-refresh
 * logic to build for a call path nothing external ever presents this token
 * on.
 */
public final class InternalTokenIssuer {

    // Broad on purpose: this is the token two different internal hops share,
    // never checked by a human, never sent to an external caller.
    private static final String INTERNAL_SCOPE = "quote:read tracking:read tracking:write routes:negotiate";
    private static final long VALIDITY_SECONDS = 24L * 60 * 60;

    private static final String TOKEN = mint();

    private InternalTokenIssuer() {
    }

    public static String token() {
        return TOKEN;
    }

    private static String mint() {
        long now = System.currentTimeMillis() / 1000;
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = base64Url(("{\"sub\":\"internal-service\",\"scope\":\"" + INTERNAL_SCOPE
                + "\",\"iat\":" + now + ",\"exp\":" + (now + VALIDITY_SECONDS) + "}")
                        .getBytes(StandardCharsets.UTF_8));
        String signingInput = header + "." + payload;
        String signature = base64Url(JwtVerifier.hmacSha256(signingInput, JwtVerifier.SECRET));
        return signingInput + "." + signature;
    }

    private static String base64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
