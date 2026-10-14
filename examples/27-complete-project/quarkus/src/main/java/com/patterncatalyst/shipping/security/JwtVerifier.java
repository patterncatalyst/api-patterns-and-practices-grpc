package com.patterncatalyst.shipping.security;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Map;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

/**
 * Ch27 final project — dependency-light HS256 JWT verification, Quarkus side.
 * Byte-for-byte Chapter 20's {@code JwtVerifier} (same reasoning: this
 * example's token is a fixed, baked-in HS256 secret with no IdP, so the
 * "dependency-light" HMAC approach — base64url-decode, recompute with the
 * JDK's own {@code javax.crypto.Mac}, constant-time compare — is deliberate,
 * not a shortcut; a production service uses {@code quarkus-oidc} against a
 * real IdP's JWKS instead. See the "Decision" callout.
 *
 * <p>SECRET is shared, byte-for-byte, with the Python stack's
 * {@code app/auth.py} and this module's own {@code InternalTokenIssuer} — one
 * contract, two independent implementations, exactly like the shared .proto.
 */
@ApplicationScoped
public class JwtVerifier {

    // Demo-only, hardcoded, shared with the Python stack (app/auth.py) and
    // this process's own InternalTokenIssuer.
    public static final String SECRET = "ch27-final-project-demo-shared-hmac-secret-DO-NOT-USE-IN-PRODUCTION";
    // A different secret; a server that only knows SECRET must reject
    // anything signed with this one. Used only by mint_token.py's "bad-sig" case.
    public static final String WRONG_SECRET = "ch27-wrong-secret-used-only-for-the-bad-sig-demo-case";

    private static final String HMAC_ALGORITHM = "HmacSHA256";

    @Inject
    ObjectMapper objectMapper;

    /** Any verification failure: malformed token, bad signature, or expired. */
    public static final class TokenError extends RuntimeException {
        public TokenError(String message) {
            super(message);
        }
    }

    /** Verifies signature + {@code exp}; returns the decoded claims map on success. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> verify(String token) {
        String[] parts = token.split("\\.", -1);
        if (parts.length != 3) {
            throw new TokenError("malformed token: expected 3 dot-separated segments, got " + parts.length);
        }
        String signingInput = parts[0] + "." + parts[1];
        byte[] expectedSignature = hmacSha256(signingInput, SECRET);

        byte[] actualSignature;
        try {
            actualSignature = Base64.getUrlDecoder().decode(pad(parts[2]));
        } catch (IllegalArgumentException e) {
            throw new TokenError("malformed signature segment");
        }
        // Constant-time comparison: a short-circuiting compare leaks how many
        // leading bytes matched via timing, the textbook MAC-verification pitfall.
        if (!MessageDigest.isEqual(expectedSignature, actualSignature)) {
            throw new TokenError("signature verification failed");
        }

        byte[] payloadBytes;
        try {
            payloadBytes = Base64.getUrlDecoder().decode(pad(parts[1]));
        } catch (IllegalArgumentException e) {
            throw new TokenError("malformed payload segment");
        }

        Map<String, Object> claims;
        try {
            claims = objectMapper.readValue(payloadBytes, Map.class);
        } catch (Exception e) {
            throw new TokenError("malformed claims JSON: " + e.getMessage());
        }

        Object expClaim = claims.get("exp");
        if (!(expClaim instanceof Number expNumber)) {
            throw new TokenError("missing or non-numeric 'exp' claim");
        }
        long nowEpochSeconds = System.currentTimeMillis() / 1000;
        if (expNumber.longValue() < nowEpochSeconds) {
            throw new TokenError("token expired");
        }
        return claims;
    }

    static byte[] hmacSha256(String data, String secret) {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC_ALGORITHM));
            return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            // HmacSHA256 is a JDK-mandatory algorithm; a SecretKeySpec built from
            // a non-empty byte array is always valid. Neither branch is reachable
            // in practice — a defensive translation to an unchecked exception.
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }

    // JWT's base64url encoding omits padding ('='); Java's decoder requires it.
    static String pad(String base64Url) {
        int remainder = base64Url.length() % 4;
        return remainder == 0 ? base64Url : base64Url + "=".repeat(4 - remainder);
    }
}
