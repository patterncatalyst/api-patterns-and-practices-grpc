---
title: "AuthN/AuthZ"
order: 20
part: "Security"
description: "Bearer JWTs in call metadata, a server interceptor that checks signature and expiry, and per-method authorization by scope."
duration: "26 min read"
---

## Learning objectives

By the end of this chapter you can:

- Write a server interceptor that verifies a JWT's HMAC signature and expiry and returns `UNAUTHENTICATED` on any failure.
- Separate authentication (`UNAUTHENTICATED`) from per-method authorization (`PERMISSION_DENIED`) with a method-to-scope map.
- Compare signatures in constant time with `MessageDigest.isEqual`.
- Explain why mTLS (connection identity) and JWTs (request identity) complement each other.
- Mint valid, expired, bad-signature and wrong-scope tokens to exercise every interceptor branch.

## Why this matters

A presence check on the `authorization` header accepts `Bearer demo-token` exactly as it accepts a forged string, because presence is the whole test. A real check decodes the token, verifies a signature, compares an expiry to the clock and reads a scope to decide not only whether the caller is who they claim, but what they may call. `RoutingService.GetQuote` is unchanged: no proto field moves, because authentication and authorization live in metadata and in the interceptor in front of the handler.

{% include excalidraw.html file="20-jwt-in-metadata-flow" alt="A client box on the left attaches an authorization header carrying a Bearer JWT to a gRPC call's metadata. An arrow labeled 1, sent first shows an HTTP/2 HEADERS frame carrying authorization: Bearer less-than jwt greater-than traveling to a server interceptor box, drawn ahead of a second, dashed arrow labeled 2, sent after carrying a DATA frame with the GetQuoteRequest message bytes. A third arrow labeled 3, interceptor reads shows the AuthzInterceptor box reading the header before a fourth arrow labeled 4, allowed through reaches a GetQuote handler box below it, which only runs once the interceptor allows the call. A note states that headers travel ahead of the message and the interceptor never waits for the body, and a second note explains that authorization is one HPACK header among several and HTTP/2's header compression tables apply to it like any other." caption="Figure 20.1: authorization rides in the HEADERS frame, ahead of the message body. The interceptor reads it before the request is deserialized." %}

## A JWT in metadata

A JSON Web Token is three base64url segments joined by dots: a header naming the algorithm (`{"alg":"HS256"}`), a payload of claims (`sub`, `scope`, `iat`, `exp`) and a signature over the first two segments that nobody can forge without the key. A JWT is a string, so it rides in call metadata as the value of the `authorization` key, conventionally prefixed `Bearer `. gRPC treats it as opaque; all the work is on the receiving end.

Two properties of metadata matter here:

- **Headers arrive first.** Metadata travels in the HTTP/2 HEADERS frame, ahead of the DATA frame with the request message, so a token can be rejected before any work is spent deserializing the body.
- **Metadata is per call.** A reused connection can carry a fresh token on one call and an expired one on the next, and the server cannot tell from the connection alone. Every call proves its own credential.

## Authentication and authorization

The interceptor makes two decisions, in a fixed order:

| Question | Failure | Status |
| --- | --- | --- |
| Is this caller who they claim to be? | Missing token, bad signature, expired token | `UNAUTHENTICATED` |
| Is this caller allowed to do this? | Valid token without the method's scope | `PERMISSION_DENIED` |

Authorization is asked only of a token that already authenticated. Collapsing the two into one status hides which happened, and they need different responses: a client re-authenticates for the first and must obtain a different grant for the second. Reflection is exempt from both checks.

{% include excalidraw.html file="20-auth-interceptor-pipeline" alt="A flowchart titled AuthzInterceptor.interceptCall / intercept_service. An incoming call box feeds into a decision box asking whether the method is a reflection call; a yes answer, drawn in amber, goes straight to a Handler runs box, exempting reflection from every check below. A no answer proceeds down a vertical chain of three more decision boxes: extract bearer token, verify signature plus expiry using HMAC-SHA256, and authorize scope against a METHOD_SCOPES map. Each of the three failure paths exits to the right into its own outcome box: missing or absent token and bad signature or expired token both lead to boxes labeled UNAUTHENTICATED, drawn with a dashed border, while scope not granted leads to a box labeled PERMISSION_DENIED, also dashed. A final amber arrow labeled scope granted runs from the bottom of the chain back up to the same Handler runs box reached by the reflection exemption, showing that both paths converge on the same handler. A note states that authentication, signature and expiry, is checked before authorization, scope, so a forged token never gets far enough to be asked what it is allowed to do." caption="Figure 20.2: authentication (signature, expiry) gates every call before authorization (scope) is evaluated. A forged or expired token never reaches the scope check." %}

## Per-method scopes

Authorization is a plain map from method name to the scope it requires. The `dict` fits because lookup is an exact match on a small fixed set:

```python
METHOD_SCOPES: dict[str, str] = {
    "shipping.routing.v1.RoutingService/GetQuote": "quote:read",
    "shipping.routing.v1.RoutingService/ListRoutes": "routes:admin",
}
```

The leading `/` of the wire-format method string is stripped before lookup, because the Java side's `getFullMethodName()` has none. A demo token carrying `quote:read` gets `OK` from `GetQuote` and `PERMISSION_DENIED` from `ListRoutes`, however well signed and unexpired it is. A method with no entry (`FindOptimalRoute`, `NegotiateRoute`, `RecomputeRoutes`) is authenticated-only, not open. A service that means to restrict one adds it to the map.

{% include excalidraw.html file="20-per-method-authz-matrix" alt="A grid showing one demo token, carrying scope quote:read, valid and unexpired, checked against three groups of methods. GetQuote requires quote:read, which the token has, so the outcome is scope present, handler runs, OK, drawn in a dark emphasis style. ListRoutes requires routes:admin, which the token lacks, so the outcome is scope missing, PERMISSION_DENIED, drawn with a dashed border. A third group, FindOptimalRoute, NegotiateRoute, and RecomputeRoutes, has no scope entry at all, so the outcome is authenticated only, then UNIMPLEMENTED. A note states that the same token on the same connection produces three different outcomes, because authorization is decided per method call, never once per connection." caption="Figure 20.3: one authenticated token, three authorization outcomes, because the scope requirement belongs to the method, not the connection." %}

The `PERMISSION_DENIED` for `ListRoutes` fires before the handler runs. That handler is not implemented and would answer `UNIMPLEMENTED`, so the denial is the authorization decision itself, independent of what sits behind it.

<div class="callout callout--warn"><p class="callout__title">The shared secret is a demo prop</p><p>Both stacks verify against one hardcoded string, <code>ch20-demo-shared-hmac-secret-DO-NOT-USE-IN-PRODUCTION</code>. That suits a self-contained example with no identity provider and is wrong for anything that ships: a secret in a repository is a secret every contributor and clone has seen. Production verifies an asymmetric signature (RS256 or ES256) against the provider's public keys from a JWKS endpoint, so the verifier holds no key that could forge a token. In Quarkus that is <code>quarkus-oidc</code>, not a hand-rolled <code>Mac</code>.</p></div>

## Verifying the signature

Both stacks share one claim shape and one scope map, and verify with different mechanisms. The contract, what a valid token looks like, is independent of how a stack checks it.

**Python.** `verify_token` calls PyJWT's `jwt.decode(token, SECRET, algorithms=["HS256"])` and collapses PyJWT's `InvalidTokenError` hierarchy (`ExpiredSignatureError`, `InvalidSignatureError`, `DecodeError`) into one `TokenError`. Every one of those maps to `UNAUTHENTICATED`, so the interceptor has nothing to branch on. A header that is present but malformed is treated like an absent one, since neither is a usable credential. The scope claim is split on whitespace into a set, the OAuth2 convention for a space-delimited scope string.

**Quarkus.** `JwtVerifier` is written by hand to show what a signature check does. It splits the token into exactly three segments, recomputes `HmacSHA256` over `header.payload` with the JDK's `javax.crypto.Mac`, and compares:

```java
        if (!MessageDigest.isEqual(expectedSignature, actualSignature)) {
            throw new TokenError("signature verification failed");
        }
```

`MessageDigest.isEqual` runs in time independent of where the first mismatch occurs. A short-circuiting comparison leaks how many leading bytes were correct, and an attacker who can time rejections recovers a valid signature one byte at a time. That would turn the MAC into a timing oracle. Only after the signature passes does the verifier decode the payload with Jackson and check `exp` against the clock. A malformed token, a bad signature and an expired `exp` throw the same `TokenError`.

Both interceptors exempt reflection first. The Python interceptor resolves the real handler with `continuation(handler_call_details)` without invoking it, then either returns it or substitutes a handler that aborts with the right status. The substitute matches the real handler's unary or streaming shape, so the same interceptor protects `NegotiateRoute`'s bidirectional stream and `GetQuote`'s unary call. The Quarkus `AuthzInterceptor` is an `@ApplicationScoped` `ServerInterceptor` registered with `@GlobalInterceptor`. A rejection calls `call.close(status, new Metadata())` and never calls `next.startCall`, so `RoutingServiceImpl` never runs. An accepted call is wrapped in a `ForwardingServerCall.SimpleForwardingServerCall` that logs the status the handler closes with.

Tokens come from a minter bundled in the Python image, `app.mint_token <case>`, which prints one line: the encoded token. Claims are built fresh on each run, with `exp` five minutes out. `expired` sets `exp` to five minutes ago, `wrong-scope` carries `shipments:write`, which satisfies neither scope, and `bad-sig` signs with a different secret. Shipping the signer in the server's image keeps the claim shape it produces from drifting away from what the interceptor expects.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Check signature, expiry and scope in an interceptor, not in each handler: the check is identical for every method, so it belongs in the chain, and the method-to-scope map keeps the whole policy in one place. Use a JWT verified against the provider's JWKS when identity must travel with the call, through a gateway or across hops that share no TLS session. Use mTLS when identity is a property of the connection, as with sidecar-to-sidecar identity in a mesh. Systems commonly use both: mTLS secures each hop and the JWT survives across hops. Wherever a shared HS256 secret appears in a real service, replace it with an asymmetric algorithm verified against the provider's JWKS.</p></div>

> **🤖 Explore with your agent**
>
> "In `examples/20-authn-authz`, require a new `routes:read` scope on `FindOptimalRoute` in `METHOD_SCOPES` (`python/app/auth.py`) and in the Quarkus `AuthzInterceptor`, and add a `routes-reader` case to `app/mint_token.py` whose space-delimited `scope` claim is `quote:read routes:read`. Keep authentication failures as `UNAUTHENTICATED` and a missing scope as `PERMISSION_DENIED`, and do not weaken the `MessageDigest.isEqual` comparison."
>
> Check: call `FindOptimalRoute` with `grpcurl -H "authorization: Bearer $TOKEN"` on ports 9200 and 9201. The `valid` token (only `quote:read`) must return `PermissionDenied`; the `routes-reader` token must pass the interceptor and reach the unimplemented handler (`Unimplemented`).

## Build, run, observe

```bash
cd examples/20-authn-authz
./verify.sh
```

The script starts both services with `docker compose`, waits for reflection, mints the four token cases at runtime and drives `localhost:9200` (Quarkus) and `localhost:9201` (Python). Reflection answers with no token, a `valid` token returns the `GetQuote` quote, a missing, `bad-sig` or `expired` token gets `UNAUTHENTICATED`, and a `wrong-scope` token calling `ListRoutes` gets `PERMISSION_DENIED`. It prints `PASS` when both stacks agree.

By hand, a call with no token fails with `Code: Unauthenticated`, and a valid token calling `ListRoutes` fails with `Code: PermissionDenied` and the message `token lacks required scope 'routes:admin'`:

```bash
TOKEN="$(docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token valid)"
grpcurl -plaintext -H "authorization: Bearer $TOKEN" -d '{}' \
  localhost:9200 shipping.routing.v1.RoutingService/ListRoutes
```

A hand-rolled HMAC verifier deserves a check against an independent implementation. Recompute the signature with `openssl`, which knows nothing about this code:

```bash
HEADER_PAYLOAD="$(cut -d. -f1-2 <<<"$TOKEN")"
echo -n "$HEADER_PAYLOAD" | openssl dgst -sha256 -hmac "ch20-demo-shared-hmac-secret-DO-NOT-USE-IN-PRODUCTION" -binary \
  | base64 | tr '+/' '-_' | tr -d '='
```

The output equals the token's third segment (`cut -d. -f3 <<<"$TOKEN"`).

Experiments:

- **Drop the `Bearer ` prefix.** Send `-H "authorization: $TOKEN"`: a malformed header counts as absent, and the call fails with `Unauthenticated` and `missing 'authorization: Bearer <jwt>' metadata`.
- **Swap tokens.** Mint `bad-sig` or `expired` and call `GetQuote`: both fail with `Unauthenticated` and an `invalid token:` message, never `PermissionDenied`, because authentication runs first.

## What you learned

- Authentication and authorization are separate decisions with separate statuses, and merging them discards information that retry logic and log triage need.
- An interceptor is where both belong, because the check is the same for every method and nobody has to remember it for the next RPC.
- Authorization attaches to the method: one valid token gets `OK` on one call and `PERMISSION_DENIED` on the next, over the same connection.
- Constant-time comparison is required in a signature check.

Observability reuses the same interceptor seam to put rejected and authorized calls on a trace.

## For deeper coverage

- [grpc.io: Authentication guide](https://grpc.io/docs/guides/auth/): gRPC's token-based authentication APIs, the category the bearer-token check belongs to.
- Quarkus, OpenID Connect (`quarkus-oidc`) guide: the production replacement for the hand-rolled HMAC check, verifying against a provider's JWKS endpoint.
- Cloud Native Design Patterns, "Security" chapter: the wider authn/authz pattern catalog.
- Liz Rice, *Container Security*, 2nd ed., O'Reilly, 2025: secret management and service identity.
