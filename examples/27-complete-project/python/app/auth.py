"""Ch27 final project — shared JWT constants + verification, Python side.

SECRET is a FIXED, hardcoded HS256 shared secret — demo only, no IdP, no
network round trip, the same Chapter 20 approach extended to this example's
full method set. Quarkus verifies the same secret and claim shape with its
own dependency-light HMAC check (quarkus/.../security/JwtVerifier.java) — one
shared contract, two independent implementations, exactly like the shared
.proto.
"""
from __future__ import annotations

import jwt

ALGORITHM = "HS256"

# Demo-only, hardcoded, shared with the Quarkus stack (security/JwtVerifier.java).
SECRET = "ch27-final-project-demo-shared-hmac-secret-DO-NOT-USE-IN-PRODUCTION"  # noqa: S105

# A different secret, used only to mint the wrong-secret "bad-sig" case in
# mint_token.py. A server that only knows SECRET must reject anything signed
# with this one.
WRONG_SECRET = "ch27-wrong-secret-used-only-for-the-bad-sig-demo-case"  # noqa: S105

# method (as grpc.HandlerCallDetails.method reports it, minus any leading
# '/') -> the OAuth2 scope required to call it. ListRoutes is gated on
# routes:admin, a scope none of this example's demo tokens ever carry — the
# wrong-scope PERMISSION_DENIED target.
METHOD_SCOPES: dict[str, str] = {
    "shipping.routing.v1.RoutingService/GetQuote": "quote:read",
    "shipping.routing.v1.RoutingService/NegotiateRoute": "routes:negotiate",
    "shipping.routing.v1.RoutingService/ListRoutes": "routes:admin",
    "shipping.quote.v1.QuoteService/GetQuote": "quote:read",
    "shipping.tracking.v1.TrackingService/WatchShipment": "tracking:read",
    "shipping.tracking.v1.TrackingService/ReportPositions": "tracking:write",
}

# The internal service token this process's own loopback callers (the REST
# booking handler calling RoutingService, RoutingService calling downstream
# QuoteService) present — broad enough to cover every internal hop, minted
# once at import time, never sent to an external caller. A real system would
# issue this as a short-lived service-account token from the same IdP a
# user-facing token comes from.
INTERNAL_SCOPE = "quote:read tracking:read tracking:write routes:negotiate"


class TokenError(Exception):
    """Any authentication failure: missing, malformed, bad signature, or expired."""


def method_name(raw: str) -> str:
    """Normalize grpc's wire-format method string (strip a leading '/', if present)."""
    return raw.lstrip("/")


def required_scope(method: str) -> str | None:
    """The scope METHOD_SCOPES names for this method, or None if unscoped."""
    return METHOD_SCOPES.get(method_name(method))


def verify_token(token: str) -> dict:
    """Verify signature + expiry with PyJWT; return the decoded claims.

    Collapses PyJWT's exception hierarchy (ExpiredSignatureError,
    InvalidSignatureError, DecodeError, ...) into one TokenError: every
    authentication failure maps to the same UNAUTHENTICATED outcome in the
    interceptor.
    """
    try:
        return jwt.decode(token, SECRET, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc


def mint_internal_token(ttl_seconds: int = 24 * 60 * 60) -> str:
    """Mints the one long-lived token this process's own internal callers present."""
    import time

    now = int(time.time())
    claims = {"sub": "internal-service", "scope": INTERNAL_SCOPE, "iat": now, "exp": now + ttl_seconds}
    return jwt.encode(claims, SECRET, algorithm=ALGORITHM)
