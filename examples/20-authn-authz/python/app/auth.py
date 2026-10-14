"""Ch20 authn-authz — shared JWT constants + verification, Python side.

SECRET is a FIXED, hardcoded HS256 shared secret — demo only, no IdP, no
network round trip. A production service never bakes a symmetric secret into
source: it verifies against an IdP's published JWKS (Keycloak, the production
option this book names) over asymmetric keys, fetched and cached at startup,
never checked in. HS256 with a baked-in secret is used here only because it
is the smallest mechanism that demonstrates the shape every interceptor in
this chapter has to implement — read a bearer token, verify a signature,
check an expiry, authorize a scope — without standing up an IdP container or
a network call inside verify.sh.

Quarkus verifies the same secret and the same claim shape with its own
dependency-light HMAC check (quarkus/.../JwtVerifier.java) — one shared
contract, two independent implementations, exactly like the shared .proto.
"""
from __future__ import annotations

import jwt

ALGORITHM = "HS256"

# Demo-only, hardcoded, shared with the Quarkus stack (JwtVerifier.java).
SECRET = "ch20-demo-shared-hmac-secret-DO-NOT-USE-IN-PRODUCTION"  # noqa: S105

# A different secret, used only to mint the wrong-secret "bad-sig" case in
# mint_token.py. A server that only knows SECRET must reject anything signed
# with this one — that rejection is what verify.sh's bad-sig assertion proves.
WRONG_SECRET = "ch20-wrong-secret-used-only-for-the-bad-sig-demo-case"  # noqa: S105

# method (as grpc.HandlerCallDetails.method reports it, minus any leading
# '/') -> the OAuth2 scope required to call it. A method with no entry here
# needs only a VALID token (authentication); it is not scope-gated
# (authorization) by this interceptor.
METHOD_SCOPES: dict[str, str] = {
    "shipping.routing.v1.RoutingService/GetQuote": "quote:read",
    "shipping.routing.v1.RoutingService/ListRoutes": "routes:admin",
}


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

    `jwt.decode` rejects an expired `exp` and a signature that does not
    match SECRET on its own — PyJWT raises ExpiredSignatureError and
    InvalidSignatureError (both InvalidTokenError subclasses) for those two
    cases, plus DecodeError for a malformed token. This collapses all of
    them into one TokenError: every authentication failure maps to the same
    UNAUTHENTICATED outcome in the interceptor, so there is no reason to
    keep PyJWT's exception hierarchy past this point.
    """
    try:
        return jwt.decode(token, SECRET, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
