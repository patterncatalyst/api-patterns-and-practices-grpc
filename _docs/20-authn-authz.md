---
title: "AuthN/AuthZ"
order: 20
part: "Security"
description: "JWT/OAuth2 bearer tokens in call metadata, a signature-and-expiry-checking server interceptor, and per-method authorization — the auth hook Chapter 12 built, grown into a real credential check."
duration: "26 min read"
---

Chapter 12's `AuthLoggingInterceptor` checked one thing about every call: whether an `authorization` entry existed in the request's metadata at all. It never looked at what that entry said — `Bearer demo-token` passed the check exactly as well as a forged string typed by hand, because presence was the whole test. That gap was a scope choice, not an oversight: Chapter 12 was about where a cross-cutting concern belongs, not about cryptography, and a real credential check would have buried the interceptor pattern under machinery the chapter didn't need yet. This chapter builds that machinery: a JSON Web Token with a signature the server verifies, an expiry it checks, and a scope it uses to decide not just *whether* a caller is who they claim, but *what that caller is allowed to call*. `RoutingService.GetQuote` is still the RPC under test — no proto field changes, because authentication and authorization live entirely in metadata and in the interceptor sitting in front of the handler, exactly where Chapter 12 left them.

The code is in `examples/20-authn-authz/`. The run script there (`verify.sh`) builds and starts both stacks, mints four distinct tokens at runtime, and asserts every claim this chapter makes against both of them; its `README.md` covers what it does and how to drive it by hand.

{% include excalidraw.html file="20-jwt-in-metadata-flow" alt="A client box on the left attaches an authorization header carrying a Bearer JWT to a gRPC call's metadata. An arrow labeled 1, sent first shows an HTTP/2 HEADERS frame carrying authorization: Bearer less-than jwt greater-than traveling to a server interceptor box, drawn ahead of a second, dashed arrow labeled 2, sent after carrying a DATA frame with the GetQuoteRequest message bytes. A third arrow labeled 3, interceptor reads shows the AuthzInterceptor box reading the header before a fourth arrow labeled 4, allowed through reaches a GetQuote handler box below it, which only runs once the interceptor allows the call. A note states that headers travel ahead of the message and the interceptor never waits for the body, and a second note explains that authorization is one HPACK header among several and HTTP/2's header compression tables apply to it like any other." caption="Figure 20.1 — authorization rides in the HEADERS frame, ahead of the message body; the interceptor reads it before the request is even deserialized." %}

## What a JWT is, and why metadata is where it rides

A JSON Web Token is three base64url-encoded segments joined by dots: a header naming the signing algorithm, a payload of claims (facts about the caller and the token itself), and a signature over the first two segments. `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vLWNsaWVudCIsInNjb3BlIjoicXVvdGU6cmVhZCIsImV4cCI6MTc5MDAwMDAwMH0.c2lnbmF0dXJl` decodes to a header of `{"alg":"HS256"}`, a payload naming a subject, a scope, and an expiry, and a signature nobody can forge without the signing key. That shape matters for where it travels on a gRPC call: a JWT is a string, so it fits naturally into `Metadata`/`invocation_metadata` — the same header map Chapter 12's presence check already read — as the value of a standard `authorization` key, conventionally prefixed `Bearer ` to name the authentication scheme. Nothing about gRPC treats a JWT specially; it is exactly as opaque to the transport as `demo-token` was in Chapter 12. What changes in this chapter is entirely on the receiving end: the interceptor now decodes that string, recomputes a signature over it, and makes two separate decisions instead of one.

Two properties of this placement are worth being explicit about, because both get this chapter's test cases right. First, metadata is sent in gRPC's HEADERS frame, which HTTP/2 transmits before the DATA frame carrying the request message — the token arrives, and can be rejected, before the server has spent any work deserializing the body. Figure 20.1 draws that ordering directly. Second, metadata is per-call, not per-connection: a client can reuse the same HTTP/2 connection (as Chapter 18 insists it should) for a call carrying a fresh token and a later call carrying an expired one, and the server has no way to know from the connection alone which is which — every call has to prove its own credential, every time.

## Authentication vs. authorization: two questions, two outcomes

It is tempting to treat "checking the token" as one step, but `AuthzInterceptor` makes it two, kept separate and evaluated in a fixed order:

- **Authentication** answers "is this caller who they claim to be?" A signature that doesn't match, a token that's expired, or no token at all are all authentication failures, and all three map to the same gRPC status: `UNAUTHENTICATED`. The interceptor never looks at *what* the token claims to permit until it has confirmed the token itself is valid and unexpired.
- **Authorization** answers "is this caller allowed to do *this*?" — asked only of a token that already passed authentication. A `demo-client` token carrying `scope: quote:read` authenticates perfectly well; it isn't entitled to a method that requires `routes:admin`. That failure is `PERMISSION_DENIED`, a different code, because it is a categorically different fact: the caller is who they say, and that identity still doesn't have the privilege the call requires.

Collapsing these into one check is a common and costly mistake — a service that returns `UNAUTHENTICATED` for both an unverifiable identity and an insufficient privilege forces every client-side retry policy and every log-triage workflow to guess which one happened, when the two call for entirely different responses: re-authenticate (get a new token) versus request a different grant (get a *better* token, or accept the call isn't yours to make). Figure 20.2 draws the full decision tree `AuthzInterceptor` implements, with the two outcome families kept visually distinct.

{% include excalidraw.html file="20-auth-interceptor-pipeline" alt="A flowchart titled AuthzInterceptor.interceptCall / intercept_service. An incoming call box feeds into a decision box asking whether the method is reflection or health; a yes answer, drawn in amber, goes straight to a Handler runs box, exempting reflection from every check below. A no answer proceeds down a vertical chain of three more decision boxes: extract bearer token, verify signature plus expiry using HMAC-SHA256, and authorize scope against a METHOD_SCOPES map. Each of the three failure paths exits to the right into its own outcome box: missing or absent token and bad signature or expired token both lead to boxes labeled UNAUTHENTICATED, drawn with a dashed border, while scope not granted leads to a box labeled PERMISSION_DENIED, also dashed. A final amber arrow labeled scope granted runs from the bottom of the chain back up to the same Handler runs box reached by the reflection exemption, showing that both paths converge on the same handler. A note states that authentication, signature and expiry, is checked before authorization, scope, so a forged token never gets far enough to be asked what it is allowed to do." caption="Figure 20.2 — authentication (signature, expiry) gates every call before authorization (scope) is ever evaluated; a forged or expired token never reaches the scope check at all." %}

Both stacks implement that tree with the same shape Chapter 12 established for `AuthLoggingInterceptor`: reflection is checked and exempted first, then the interceptor either substitutes a handler that immediately aborts with the right status, or lets the real handler run. What's new here is that the auth decision now needs the token's *contents*, not just its presence, which means a real signature check and a real clock comparison have to happen on the hot path of every call — the implementation this chapter adds.

## Per-method authorization: the same token, three outcomes

Chapter 12's auth hook was uniform: every method behind it got the identical check, because presence-of-a-header doesn't vary by method. Real authorization almost never works that way — a routing service's read path (`GetQuote`) and its administrative path (a hypothetical bulk route rewrite) have no business requiring the same privilege, and a token minted for a customer-facing integration should never be able to exercise an operator-only method just because it happens to carry *some* valid signature. `AuthzInterceptor` encodes that as a plain map from method name to the scope it requires:

```
shipping.routing.v1.RoutingService/GetQuote    -> quote:read
shipping.routing.v1.RoutingService/ListRoutes  -> routes:admin
```

`GetQuote` requires `quote:read`, which this chapter's `valid` demo token carries, so it succeeds. `ListRoutes` requires `routes:admin` — a privilege nothing in this chapter's token set grants — so calling it with any of the demo tokens returns `PERMISSION_DENIED`, regardless of how well-formed, correctly signed, or unexpired that token is. A method with no entry in the map (`FindOptimalRoute`, `NegotiateRoute`, `RecomputeRoutes`) needs only a valid, authenticated token; this interceptor doesn't gate those on any particular scope, which is itself a choice worth naming — an un-gated method is authenticated-only, not unauthenticated, and a service that means to restrict it eventually has to add it to the map explicitly, the same way `ListRoutes` was added here.

{% include excalidraw.html file="20-per-method-authz-matrix" alt="A grid showing one demo token, carrying scope quote:read, valid and unexpired, checked against three groups of methods. GetQuote requires quote:read, which the token has, so the outcome is scope present, handler runs, OK, drawn in a dark emphasis style. ListRoutes requires routes:admin, which the token lacks, so the outcome is scope missing, PERMISSION_DENIED, drawn with a dashed border. A third group, FindOptimalRoute, NegotiateRoute, and RecomputeRoutes, has no scope entry at all, so the outcome is authenticated only, then UNIMPLEMENTED. A note states that the same token on the same connection produces three different outcomes, because authorization is decided per method call, never once per connection." caption="Figure 20.3 — one authenticated token, three different authorization outcomes, because the scope requirement is attached to the method, not the connection." %}

Authorization is per-call, not per-connection, and not even per-token in any blanket sense: a single HTTP/2 connection, carrying a single bearer token on every call, produces `OK` for one method and `PERMISSION_DENIED` for another on the very next call — nothing about the connection or the prior successful call makes the second one more likely to succeed. That is also exactly why this chapter's `ListRoutes` test needs care in how it's read: the interceptor's `PERMISSION_DENIED` fires before `RoutingServiceImpl.listRoutes`/`RoutingServiceServicer.ListRoutes` is ever invoked, and this example's handler for that method is left unoverridden — it would answer `UNIMPLEMENTED` if the interceptor ever let a call reach it. A token that legitimately carried `routes:admin` would still hit `UNIMPLEMENTED` here, because implementing `ListRoutes`'s actual logic isn't this chapter's job. The `PERMISSION_DENIED` `verify.sh` asserts is the authorization decision, proven independently of what — if anything — sits behind it.

<div class="callout callout--warn"><p class="callout__title">The shared secret is a demo prop, not a design</p><p>Both stacks verify against the identical hardcoded string, <code>ch20-demo-shared-hmac-secret-DO-NOT-USE-IN-PRODUCTION</code>, baked directly into source on both sides. That is the right call for a self-contained example with no IdP and no network dependency, and the wrong call for anything that ships: a secret checked into a repository is a secret every contributor, every CI log, and every forked clone has already seen. See this chapter's "Decision" callout for what replaces it in production.</p></div>

## How the code works

Both stacks share one claim shape — `sub`, `scope`, `iat`, `exp` — and one method-to-scope map, but verify signatures with entirely different mechanisms, which is a useful demonstration that the *contract* (what a valid token looks like) and the *implementation* (how a given stack checks one) are independent concerns.

**The shared secret and scope map (Python, `app/auth.py`).** `SECRET` and `WRONG_SECRET` are plain module-level strings — `SECRET` is what both stacks verify against; `WRONG_SECRET` exists only so `mint_token.py`'s `bad-sig` case can produce a token signed with a key neither server recognizes. `METHOD_SCOPES` is a `dict[str, str]` from a normalized method name (leading `/` stripped, since gRPC's wire-format method string carries one but `MethodDescriptor.getFullMethodName()` on the Java side doesn't) to the scope that method requires. A `dict` is the right structure here specifically because the lookup is exact-match on a small, fixed set of method names known at authoring time — there's no prefix matching or wildcarding to justify anything more elaborate. `verify_token` wraps PyJWT's `jwt.decode(token, SECRET, algorithms=["HS256"])` in a `try`/`except` that collapses PyJWT's whole `InvalidTokenError` hierarchy — `ExpiredSignatureError`, `InvalidSignatureError`, `DecodeError`, and others — into one `TokenError`. Every one of those failures produces the identical `UNAUTHENTICATED` outcome one level up, so there is no reason for the interceptor to branch on *which* PyJWT exception fired.

**The token minter (`app/mint_token.py`).** Four cases share one claims dict — `sub`, `scope: "quote:read"`, `iat: now`, `exp: now + 300` — built fresh on every invocation so `exp` is always five minutes from the actual moment the script runs, never a timestamp baked into the container image at build time. `expired` is the baseline with `exp` set to `now - 300` instead; `wrong-scope` swaps `scope` to `"shipments:write"` (a value that satisfies neither `quote:read` nor `routes:admin`); `bad-sig` keeps the baseline claims but signs with `WRONG_SECRET`. The script's entire output contract is one line on stdout — the encoded token, nothing else — so `verify.sh` can capture it directly with command substitution: `TOKEN="$(docker compose run ...)"`. This is the Chapter 18 bundled-client pattern applied to a signer instead of a load-testing client: the minter ships inside the same image as the server it's testing, so there's no second image to build and no drift between the claim shape the minter produces and the one the interceptor expects.

**The interceptor (Python, `app/interceptors.py`).** `AuthzInterceptor.intercept_service` follows the exact resolve-then-decide structure Chapter 12 established: `continuation(handler_call_details)` resolves the real handler without invoking it, so every branch below still has the option of substituting a different handler before anything the client sent gets processed. Reflection is checked first and exempted unconditionally. `_bearer_token` extracts the token from the `authorization` entry, requiring the `Bearer ` prefix and returning `None` for anything else — a header present but malformed is treated identically to a header that's absent, because neither identifies a usable credential. `verify_token` either returns the decoded claims or raises `TokenError`, caught and converted to `UNAUTHENTICATED` with a message naming the specific problem. Only once that succeeds does `required_scope(method)` get consulted: `None` means no gate (pass straight to logging), and a scope name means the token's own `scope` claim — split on whitespace into a `set`, the standard OAuth2 convention for a space-delimited scope string — has to contain it, or the call is rejected with `PERMISSION_DENIED`. The handler-substitution machinery below that (`_abort_handler`, `_with_logging`) is unchanged from Chapter 12's cardinality-matching helpers: both match the real handler's unary/streaming shape on each side, so the same interceptor protects `NegotiateRoute`'s bidirectional stream exactly as it protects `GetQuote`'s unary call, without the interceptor itself branching on which.

**The verifier (Quarkus, `JwtVerifier.java`).** This is the chapter's one real cryptographic implementation, written by hand because the whole point is to show what a signature check does rather than hide it behind a framework. `verify(String token)` splits on `.`, requiring exactly three segments. It recomputes the HMAC over `header.payload` using `javax.crypto.Mac.getInstance("HmacSHA256")` seeded with `SECRET` as a `SecretKeySpec` — the JDK's own HMAC implementation, no third-party crypto library needed — and compares the result against the token's own signature segment with `MessageDigest.isEqual`, not `Arrays.equals` or `==`. That distinction matters: `MessageDigest.isEqual` runs in time independent of *where* the first mismatched byte occurs, where a short-circuiting comparison leaks exactly that information through timing, letting an attacker recover a valid signature one byte at a time by observing how long rejection takes for each guess — a `Mac` verification routine that gets this wrong defeats the entire point of using a MAC. Only after the signature checks out does the method base64url-decode the payload segment and hand the bytes to a CDI-injected Jackson `ObjectMapper` (`quarkus-jackson`) to produce a `Map<String, Object>` of claims, then checks `exp` against `System.currentTimeMillis() / 1000`. A malformed token, a bad signature, or an expired `exp` all throw the same `JwtVerifier.TokenError` — mirroring Python's single-exception collapse — so `AuthzInterceptor` has one `catch` clause to reason about, not three.

**The interceptor (Quarkus, `AuthzInterceptor.java`).** Structurally identical to Chapter 12's `AuthLoggingInterceptor`: an `@ApplicationScoped` bean implementing `io.grpc.ServerInterceptor`, registered everywhere via `@GlobalInterceptor`. Reflection is exempted by `isReflection(method)` before anything else runs. A missing or non-`Bearer`-prefixed `authorization` header, or a `JwtVerifier.TokenError` caught from `jwtVerifier.verify(...)`, both call `reject(...)`, which logs the outcome and calls `call.close(status, new Metadata())` directly — `next.startCall(...)` is never invoked, so `RoutingServiceImpl` never runs. Only a token that both authenticates checks `METHOD_SCOPES.get(method)`: a `null` means no gate; a non-null scope is checked against the claims map's `scope` value, split on whitespace into a `Set<String>` the same way the Python side does, and a miss produces `PERMISSION_DENIED` through the identical `reject(...)` path. A successful call wraps the `ServerCall` in a `ForwardingServerCall.SimpleForwardingServerCall` that logs whatever status the handler eventually closes with — the same timing mechanism Chapter 12 used, now running only after both authentication and authorization have already passed.

**The fragile part.** `JwtVerifier` and `app/auth.py` hardcode a literal secret string in source. That is correct for this example's goal — demonstrating the shape of signature verification and scope authorization without an IdP container — and it is precisely the thing a real deployment must never do. A production service fetches its identity provider's public signing keys from a JWKS endpoint (Keycloak publishes one; so does any OIDC-compliant IdP), caches them, and verifies an *asymmetric* signature (commonly RS256 or ES256) where the verifying party never possesses — and therefore can never leak — the key that produced the signature. Quarkus's path there is `quarkus-oidc`, not a hand-rolled `Mac`; this chapter's `JwtVerifier` is sized for a demo with a fixed secret, not a template to extend toward production.

## Build, run, observe

```bash
cd examples/20-authn-authz
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC server to answer reflection's `list`, mints all four token cases at runtime via `docker compose run --entrypoint python python -m app.mint_token <case>`, and drives six assertions against `localhost:9200` (Quarkus) and `localhost:9201` (Python): reflection answers with no token; a `valid` token reaches `GetQuote` and returns the correct quote; a missing token, a `bad-sig` token, and an `expired` token are each rejected with `UNAUTHENTICATED`; and a `wrong-scope` token calling `ListRoutes` is rejected with `PERMISSION_DENIED`. It prints `PASS` only once every assertion holds for both stacks, then tears the stack down.

## Cross-check

A hand-rolled HMAC verifier is exactly the kind of code worth checking against an independent implementation, not just against its own test suite — a bug that happens to make the Java verifier agree with itself proves nothing. Mint a token and recompute its signature with `openssl`, which has no awareness of this chapter's code at all:

```bash
TOKEN="$(docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token valid)"
HEADER_PAYLOAD="$(cut -d. -f1-2 <<<"$TOKEN")"
echo -n "$HEADER_PAYLOAD" | openssl dgst -sha256 -hmac "ch20-demo-shared-hmac-secret-DO-NOT-USE-IN-PRODUCTION" -binary \
  | base64 | tr '+/' '-_' | tr -d '='
```

The base64url string `openssl` prints matches the token's own third segment (`cut -d. -f3 <<<"$TOKEN"`) byte for byte. Agreement between `openssl`'s general-purpose HMAC implementation and `JwtVerifier`'s hand-rolled `Mac`/`MessageDigest.isEqual` pair is the strongest evidence that the Java side computes the correct signature rather than one that merely satisfies its own round trip.

## What you learned

- Authentication (is this caller who they claim?) and authorization (is this caller allowed to do *this*?) are separate decisions with separate gRPC status codes — `UNAUTHENTICATED` and `PERMISSION_DENIED` — and collapsing them into one check destroys information a client's retry logic and a log's triage workflow both depend on.
- A server interceptor is where both decisions belong, for the same reason Chapter 12 put the presence check there: the check is identical across every method it protects, so it never has to be remembered by whoever adds the next RPC.
- Authorization attaches to the method being called, not the connection or even the token as a whole — the same valid, authenticated token produces `OK` for one method and `PERMISSION_DENIED` for another, on the same connection, back to back.
- `MessageDigest.isEqual` (or an equivalent constant-time comparison) is not an optional nicety in a signature check; a short-circuiting comparison turns a MAC verification into a timing oracle.

Chapter 21 picks up where this chapter's logging left off: the same interceptor seam, now wired to OpenTelemetry's own span machinery, so a rejected call and an authorized one both show up on a trace, not just in a log line.

## On the wire

No token at all — the interceptor never reaches `RoutingServiceImpl`/`RoutingServiceServicer`:

```bash
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}' \
  localhost:9200 shipping.routing.v1.RoutingService/GetQuote
```

```
ERROR:
  Code: Unauthenticated
  Message: missing 'authorization: Bearer <jwt>' metadata
```

A valid token reaches the handler and gets the identical Chapter 5 quote:

```bash
TOKEN="$(docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token valid)"
grpcurl -plaintext -H "authorization: Bearer $TOKEN" \
  -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1000}]}' \
  localhost:9200 shipping.routing.v1.RoutingService/GetQuote
```

```
{
  "quote": { "currency": "USD", "amount": "2500.00" },
  "route": { "id": "rte_USNYC-NLRTM", "legs": [ { "carrier": "MAERSK" } ] }
}
```

The same token, valid and unexpired, called against a method it isn't entitled to:

```bash
grpcurl -plaintext -H "authorization: Bearer $TOKEN" -d '{}' \
  localhost:9200 shipping.routing.v1.RoutingService/ListRoutes
```

```
ERROR:
  Code: PermissionDenied
  Message: token lacks required scope 'routes:admin'
```

And reflection, which needs none of this:

```bash
grpcurl -plaintext localhost:9200 list
```

```
grpc.reflection.v1.ServerReflection
grpc.reflection.v1alpha.ServerReflection
shipping.routing.v1.RoutingService
```

Three different calls, three different outcomes, from a server that never ran `RoutingServiceImpl.getQuote`/`RoutingServiceServicer.GetQuote` for the first request and never ran `listRoutes`/`ListRoutes` for the third — both rejections happened entirely inside `AuthzInterceptor`, before either handler had a chance to run. Swap port `9200` for `9201` and the Python stack answers all four calls identically, because `examples/20-authn-authz/verify.sh` asserts precisely that for both stacks before it prints `PASS`.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Validate a token's signature and expiry in an interceptor, not inside each handler — the check is identical for every method a service exposes, which is the same symmetry test Chapter 12's "Decision" callout named: code that's correct unmodified in front of every method belongs in the chain, and a credential check is the textbook example. Keep per-method authorization in the interceptor too, as a lookup against a method name, rather than scattering an <code>if (!hasScope(...))</code> at the top of each handler — the lookup table is the whole policy, visible in one place, instead of implicit in however many handlers remembered to add the check. Reach for a JWT, verified against an IdP's published JWKS, when identity needs to travel with the call itself — through a gateway, across a service a client never has a direct TLS session with, in a token a client can inspect and reason about client-side. Reach for mTLS (Chapter 19) when identity is a property of the <em>connection</em> — the two endpoints establishing it — not of the request riding over it — a service mesh's sidecar-to-sidecar identity being the common case. The two are not alternatives to pick once; a system commonly uses both; mTLS secures the hop between two services, while a JWT travels end-to-end inside the payload that hop carries, surviving a hop a TLS session itself does not. And wherever this chapter's hardcoded HS256 secret appears in a reader's own service, replace it: verify against an identity provider's JWKS endpoint over an asymmetric algorithm, never a shared secret both sides have to know and keep equally secret.</p></div>

---

*Verification status: <span class="status status--verified">verified</span>. `examples/20-authn-authz/verify.sh` was run end to end against both stacks: reflection answered with no token, a `valid` token returned the correct `GetQuote` quote, a missing/bad-signature/expired token was rejected with `UNAUTHENTICATED` in every case, and a `wrong-scope` token calling `ListRoutes` was rejected with `PERMISSION_DENIED` — on both Quarkus (port 9200) and Python (port 9201). The cross-check's HMAC computation was independently confirmed against a freshly-minted `valid` token using Python's stdlib `hmac`/`hashlib` (matching signature byte for byte); the `openssl` CLI form shown above was not re-run in the authoring sandbox, which has no `openssl` binary installed — confirm it with a local `openssl` before relying on that exact command.*
