# Ch20 — AuthN/AuthZ: JWT-validating + per-method authorization

The reference both-stack implementation of a JWT-validating, per-method
authorizing server interceptor in front of
`shipping.routing.v1.RoutingService` — the direct descendant of Chapter 12's
`AuthLoggingInterceptor`, which only checked that an `authorization` header
was *present*. This chapter checks what it *contains*: a signature, an
expiry, and a scope.

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs. No contract change: authentication and authorization
  ride entirely in call metadata and the interceptor, never in a proto field.
  `GetQuote` is implemented (the Ch5/Ch7/Ch12 formula, unchanged); the other
  four return `UNIMPLEMENTED`, same discipline as every prior example.
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages.

Quarkus (`quarkus/`, host port **9200**) and Python (`python/`, host port
**9201**) each register one interceptor — `AuthzInterceptor` — that decides,
for every non-reflection call, in order:

1. **Authentication.** Is there a bearer token, and does it carry a valid
   HS256 signature and an unexpired `exp`? Any failure (missing header, bad
   signature, expired) closes the call with `UNAUTHENTICATED` before
   `RoutingServiceImpl`/`RoutingServiceServicer` ever runs.
2. **Authorization.** Does the token's `scope` claim include the scope this
   *specific method* requires? `GetQuote` requires `quote:read`; `ListRoutes`
   requires `routes:admin`. A token that authenticates fine but lacks the
   required scope gets `PERMISSION_DENIED` — a decision made entirely inside
   the interceptor, before the handler runs.

Reflection (`grpc.reflection.*`) is exempt from both checks, same as
Chapter 12 — `grpcurl list`/`describe` works with no token at all.

## The token: deterministic, no IdP, no network

Every token in this chapter is minted locally by a bundled Python script,
`python/app/mint_token.py`, using a **fixed, hardcoded HS256 secret**
(`app/auth.py`'s `SECRET`, byte-for-byte identical to Quarkus's
`JwtVerifier.SECRET`). This is a documented shortcut: a
production service never bakes a symmetric secret into source and never
verifies a JWT by hand. It fetches its identity provider's public key set
(a JWKS endpoint) and verifies an asymmetric signature (RS256/ES256) against
keys it never has to keep secret itself — Keycloak is the production option
this book names. HS256-with-a-baked-in-secret is used here only because it
is the smallest mechanism that demonstrates the shape every interceptor in
this chapter implements, without a running IdP container or a network round
trip inside `verify.sh`. See the chapter's "Decision" callout.

`exp` is computed at **mint time** — run the minter and it stamps `exp` five
minutes from the moment it runs, not a value baked into the image at build
time, so a verify.sh run next week is exactly as valid as one run today.

Four cases, invoked via `docker compose run` against the already-built
`python` image (the Chapter 18 bundled-client pattern — no second image):

```bash
docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token valid
docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token expired
docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token wrong-scope
docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token bad-sig
```

| Case | Signature | `exp` | `scope` |
|---|---|---|---|
| `valid` | `SECRET` (correct) | 5 min in the future | `quote:read` |
| `expired` | `SECRET` (correct) | 5 min in the **past** | `quote:read` |
| `wrong-scope` | `SECRET` (correct) | 5 min in the future | `shipments:write` — lacks `routes:admin` |
| `bad-sig` | `WRONG_SECRET` | 5 min in the future | `quote:read` |

Each prints exactly the encoded JWT to stdout.

## The per-method-authz gate: `ListRoutes` requires `routes:admin`

`AuthzInterceptor` maps method → required scope:

```
shipping.routing.v1.RoutingService/GetQuote    -> quote:read
shipping.routing.v1.RoutingService/ListRoutes  -> routes:admin
```

The `valid` and `wrong-scope` tokens both carry a scope other than
`routes:admin`, so calling `ListRoutes` with either one gets
`PERMISSION_DENIED` — straight from the interceptor, before
`RoutingServiceImpl.listRoutes`/`RoutingServiceServicer.ListRoutes` is ever
reached. `ListRoutes` is left unoverridden in this example (same as
`FindOptimalRoute`, `NegotiateRoute`, and `RecomputeRoutes`), so it would
also answer `UNIMPLEMENTED` if the interceptor ever let a call through to
it. A token that legitimately carried `routes:admin` would still get
`UNIMPLEMENTED` here. The `PERMISSION_DENIED` `verify.sh` asserts is the
interceptor's authorization decision, made and proven before the handler is
ever invoked, independent of what — if anything — that handler does; it is
not evidence that the method is merely unimplemented.

## Run it

```bash
cd examples/20-authn-authz
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, mints all four token cases at runtime,
and drives six assertions against `localhost:9200` (Quarkus) and
`localhost:9201` (Python): reflection works with no token; a `valid` token
reaches `GetQuote` and returns the correct quote; a missing token, a
`bad-sig` token, and an `expired` token are each rejected with
`UNAUTHENTICATED`; and a `wrong-scope` token calling `ListRoutes` is
rejected with `PERMISSION_DENIED`. Prints `PASS` only if every assertion
holds for **both** stacks.

A real run on this book's dev box:

```
=== verifying stack 'quarkus' at localhost:9200 ===
lib.sh: ok — quarkus reflection 'list' succeeds with no token
lib.sh: ok — quarkus GetQuote valid token: quote.currency: 'USD'
lib.sh: ok — quarkus GetQuote valid token: quote.amount: '2500.00'
lib.sh: ok — quarkus GetQuote missing token: got expected code UNAUTHENTICATED (grpcurl: Unauthenticated)
lib.sh: ok — quarkus GetQuote bad-signature token: got expected code UNAUTHENTICATED (grpcurl: Unauthenticated)
lib.sh: ok — quarkus GetQuote expired token: got expected code UNAUTHENTICATED (grpcurl: Unauthenticated)
lib.sh: ok — quarkus ListRoutes wrong-scope token (valid authn, failed authz): got expected code PERMISSION_DENIED (grpcurl: PermissionDenied)
=== quarkus: all assertions passed ===

=== verifying stack 'python' at localhost:9201 ===
lib.sh: ok — python reflection 'list' succeeds with no token
lib.sh: ok — python GetQuote valid token: quote.currency: 'USD'
lib.sh: ok — python GetQuote valid token: quote.amount: '2500.00'
lib.sh: ok — python GetQuote missing token: got expected code UNAUTHENTICATED (grpcurl: Unauthenticated)
lib.sh: ok — python GetQuote bad-signature token: got expected code UNAUTHENTICATED (grpcurl: Unauthenticated)
lib.sh: ok — python GetQuote expired token: got expected code UNAUTHENTICATED (grpcurl: Unauthenticated)
lib.sh: ok — python ListRoutes wrong-scope token (valid authn, failed authz): got expected code PERMISSION_DENIED (grpcurl: PermissionDenied)
=== python: all assertions passed ===

PASS — Ch20 authn-authz: ...
```

To poke at it by hand instead:

```bash
docker compose up --build

TOKEN="$(docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token valid)"

grpcurl -plaintext -H "authorization: Bearer $TOKEN" -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"},
  "cargo": [{"weightKg": 1000}]
}' localhost:9200 shipping.routing.v1.RoutingService/GetQuote
# { "quote": { "currency": "USD", "amount": "2500.00" }, ... }

grpcurl -plaintext -d '{}' localhost:9200 shipping.routing.v1.RoutingService/GetQuote
# ERROR: Code: Unauthenticated ... missing 'authorization: Bearer <jwt>' metadata

grpcurl -plaintext -H "authorization: Bearer $TOKEN" -d '{}' \
  localhost:9200 shipping.routing.v1.RoutingService/ListRoutes
# ERROR: Code: PermissionDenied ... token lacks required scope 'routes:admin'

docker compose down -v
```

Swap `9200` for `9201` to hit the Python stack instead — same four outcomes,
same numbers.

The Grafana LGTM observability stack is opt-in and off by default:

```bash
docker compose --profile observability up --build
```

## The interceptor, on each stack

**Quarkus** (`quarkus/src/main/java/.../AuthzInterceptor.java` +
`JwtVerifier.java`): an `@ApplicationScoped` bean implementing
`io.grpc.ServerInterceptor`, annotated `@GlobalInterceptor`. `JwtVerifier`
does the HS256 check itself with the JDK's `javax.crypto.Mac`
(`HmacSHA256`) plus a CDI-managed Jackson `ObjectMapper` (the
`quarkus-jackson` extension) to decode the claims segment — no OIDC client,
no JWKS fetch, nothing beyond what's needed to check one fixed secret. See
`JwtVerifier`'s class Javadoc for why this is the chapter's
"dependency-light" choice over `quarkus-oidc`/SmallRye JWT.

**Python** (`python/app/interceptors.py` + `app/auth.py`): a
`grpc.aio.ServerInterceptor` subclass passed to
`grpc.aio.server(interceptors=[...])`, structured identically to Chapter
12's `AuthLoggingInterceptor` (same handler-substitution mechanics, same
cardinality-matching helpers so the interceptor works in front of
`NegotiateRoute`'s bidirectional stream too). `app/auth.py` verifies with
PyJWT's `jwt.decode(token, SECRET, algorithms=["HS256"])`, which checks
signature and `exp` in one call.

Both sides share the same secret, the same claim shape (`sub`, `scope`,
`iat`, `exp`), and the same method→scope map — one contract, two independent
implementations, exactly like the shared `.proto`.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) so it can `COPY` the two proto files this service needs
straight from `contracts/proto/` at build time — identical mechanics to
every prior anchor.

## On the wire

Server reflection is enabled on both stacks and exempt from the auth check,
so `grpcurl` needs no local `.proto` copy and no token to `list`/`describe`.
`verify.sh` asserts:

| Call | Token | Expected |
|---|---|---|
| `GetQuote` | `valid` | `quote.currency = "USD"`, `quote.amount = "2500.00"` |
| `GetQuote` | none | `UNAUTHENTICATED` |
| `GetQuote` | `bad-sig` | `UNAUTHENTICATED` |
| `GetQuote` | `expired` | `UNAUTHENTICATED` |
| `ListRoutes` | `wrong-scope` | `PERMISSION_DENIED` |
| `list` (reflection) | none | succeeds |

## Diagrams

`assets/diagrams/20-jwt-in-metadata-flow.svg`,
`20-auth-interceptor-pipeline.svg`, and `20-per-method-authz-matrix.svg`
(each paired with a matching `.excalidraw` source, generated with
`scripts/generate_diagram.py`) show the token riding in HTTP/2 headers ahead
of the message, the interceptor's authenticate-then-authorize decision tree,
and the method×scope grid that makes `ListRoutes` behave differently from
`GetQuote` under the identical token.

## Verification status

*Verification status: <span class="status status--verified">verified</span>.*
`./verify.sh` was run against both stacks on this book's dev box: all six
assertions passed on Quarkus (port 9200) and on Python (port 9201) — valid
token answers the correct quote, missing/bad-signature/expired tokens are
all rejected with `UNAUTHENTICATED`, a wrong-scope token against
`ListRoutes` is rejected with `PERMISSION_DENIED`, and reflection answers
with no token on either stack.
