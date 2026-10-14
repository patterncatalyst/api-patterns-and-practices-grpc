---
title: "r08 Execution Plan (Phase 5b)"
layout: plan
render_with_liquid: false
---

# r08 Execution Plan — Part 8: Security (Ch19 TLS/mTLS + Ch20 AuthN/AuthZ)

Relay on branch `docs/r08-content`, mirroring `_plans/r07-execution-plan.md`. New content; both-stack
examples verified in CI. **ZERO contract change, no Wave 0** — TLS is transport-level, auth rides in
metadata + interceptors; neither needs a proto edit (and adding RPCs to an implemented service is
source-breaking under quarkus-grpc, per the r06 lesson). Reuses `RoutingService.GetQuote`.

## Scope
- **Ch19 — TLS & mTLS** [H]: channel/transport credentials, cert management, Compose cert bootstrap,
  progression toward minikube (described). "TLS then mTLS on RoutingService; verify.sh self-generates
  certs, connects with a client cert, asserts plaintext is refused."
- **Ch20 — AuthN/AuthZ** [H]: JWT in call metadata, per-call credentials, auth interceptor, per-method
  authz. "Auth interceptor rejects missing/invalid token with UNAUTHENTICATED; per-method authz." Built
  on the Ch12 interceptor anchor.

## Figures (≥2/chapter; concept-first)
- **Ch19:** `19-tls-handshake-cert-chain` · `19-mtls-mutual-verification` · `19-where-credentials-attach` (certgen→shared volume topology).
- **Ch20:** `20-jwt-in-metadata-flow` · `20-auth-interceptor-pipeline` (authn→authz decision tree) · `20-per-method-authz-matrix`.

## Examples
- `examples/19-tls-mtls` — ports 9190/9191, project `ch19-tls`. GetQuote over TLS then mTLS, both stacks.
  **Cert bootstrap (risk #9):** a one-shot `certgen` compose service (profiled off, pinned openssl-bearing
  base) writes `ca/server/client` certs into a shared `certs` volume at verify.sh runtime (NOT baked into a
  cached layer). Server SAN = `DNS:quarkus,DNS:python,DNS:localhost,IP:127.0.0.1`; long validity + backdated
  notBefore (no clock-skew/expiry flake). certgen helper is example-local (never `_lib/`). Quarkus TLS via
  current quarkus-grpc keys (legacy `ssl.*`+client-auth vs TLS registry — executor confirms on Java 25 via
  quarkus-agent); Python `ssl_server_credentials(..., require_client_auth=True)` + `add_secure_port`.
  verify.sh overrides `GRPCURL_OPTS` locally so `wait_for_grpc` speaks TLS.
  **verify.sh (both stacks):** (1) TLS success — `-cacert -servername` → correct quote (semantic);
  (2) **plaintext REFUSED** — `-plaintext` call fails at transport; (3) **mTLS with client cert succeeds**
  (`-cert -key`); (4) **mTLS without client cert rejected** (CA only → handshake fail).
- `examples/20-authn-authz` — ports 9200/9201, project `ch20-auth`. GetQuote behind a JWT-validating +
  authorizing server interceptor (Ch12 shape; reflection/health exempt). **Token (deterministic, no IdP):**
  HS256 fixed secret; tokens minted at verify.sh runtime by a bundled Python signer (`mint_token`, run via
  `docker compose run`), cases: valid (scope `quote:read`, future exp), expired, wrong-scope, bad-sig.
  Quarkus verifies with a dependency-light HMAC/SmallRye JWT (confirm via quarkus-agent); Python PyJWT.
  **Per-method authz:** interceptor maps method→scope; gate an already-declared method (e.g. `ListRoutes`/
  `FindOptimalRoute`) on a scope the demo token lacks → PERMISSION_DENIED thrown BEFORE the handler
  (documented so it's not read as "unimplemented"). Keycloak/JWKS named as the production option in prose only.
  **verify.sh (both stacks):** (1) valid → OK (semantic); (2) missing → UNAUTHENTICATED; (3) bad-sig →
  UNAUTHENTICATED; (4) expired → UNAUTHENTICATED; (5) wrong-scope per-method → PERMISSION_DENIED;
  (6) reflection works without a token. Direct `grpcurl -H` for header cases (lib.sh unchanged).

## Waves (no Wave 0)
- **Wave A (parallel):** Ch19 executor (doc + example + example-local certgen + ≥2 figures); Ch20 executor
  (doc + example + example-local mint_token + ≥2 figures). Forbidden to both: `contracts/` (byte-identical
  to main), `examples/_lib/lib.sh` (example-local/verify.sh-local helpers only), `_plans/*`,
  `coverage-matrix.md`, `_example_pages/index.md`, `_config.yml`. Re-verify Quarkus TLS/JWT keys on Java 25
  via quarkus-agent before authoring.
- **Validation (Opus):** TLS/mTLS accuracy (handshake direction, SANs, client-auth REQUIRED, plaintext-refused
  is a real transport failure); auth accuracy (UNAUTHENTICATED vs PERMISSION_DENIED honest, HS256/exp/scope,
  reflection exempt, the gated-method framing is clear); voice 0 ban-tier; lgtm-idiomatic-review both stacks;
  "On the wire" is the LAST section + "Decision" callout present.
- **Wrap:** per-chapter checkpoints; coverage Ch19/Ch20 → draft → verified after CI green;
  `_example_pages/index.md`; local gates; push; watch CI; r08 PR + merge.

## Acceptance
Zero contract change (`git diff main -- contracts/` empty; buf green); floor cleared; ≥2 figures/chapter;
validate.py + jekyll green; Ch19 verify.sh green (TLS success + plaintext refused + mTLS with/without client
cert) with deterministic SAN-correct certs from a pinned image; Ch20 verify.sh green (valid→OK, missing/
bad-sig/expired→UNAUTHENTICATED, wrong-scope→PERMISSION_DENIED) with in-harness-minted tokens; satisfies
iteration-plan acceptance #11; ports 9190/91 + 9200/01; prior examples (Ch00–18) stay green; "On the wire"
last + "Decision" each; 0 voice ban-tier; `_lib/`+`contracts/` byte-unchanged.

## Risks
Cert bootstrap flakes (#9) → runtime certgen from pinned image to shared volume, fresh each run ·
SAN/hostname mismatch → SANs pinned to service-names+localhost+127.0.0.1, grpcurl always `-servername` ·
cert validity/clock skew → long validity + backdated notBefore · JWT exp skew → exp minted at runtime +
verifier leeway, HS256 no network · grpcurl TLS flags → documented `-cacert/-cert/-key/-servername`,
GRPCURL_OPTS overridden example-locally · UNAUTHENTICATED-vs-PERMISSION_DENIED conflation → asserted
separately · stale Quarkus keys → re-verify via quarkus-agent (analyze module first) · source-breaking proto
edit (r06) → contracts/ frozen + buf-breaking gate · parallel shared-file hazard → unique ports/projects,
example-local helpers.
