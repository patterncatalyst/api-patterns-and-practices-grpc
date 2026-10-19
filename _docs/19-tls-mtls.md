---
title: "TLS & mTLS"
order: 19
part: "Security"
description: "Channel and transport credentials, certificate management, a Compose-local cert bootstrap, and the progression from one-way TLS to mutual TLS on RoutingService.GetQuote."
duration: "24 min read"
---

## Learning objectives

By the end of this chapter you can:

- Configure TLS and mTLS channel/transport credentials on both Quarkus (`quarkus.grpc.server.ssl.*`) and Python (`grpc.ssl_server_credentials`).
- Distinguish a transport-layer handshake failure from a gRPC application status code, and recognize the different error shapes each stack produces.
- Toggle `client-auth`/`require_client_auth` to move a service from one-way TLS to mutual TLS, and explain what each direction of trust buys.
- Build a certificate bootstrap (CA, server certificate with SANs, client certificate) with `openssl`, and avoid the PEM-vs-Java-keystore trust-store pitfall.
- Plan the migration from a Compose-local certificate bootstrap to cert-manager-issued certificates on a real cluster.

## Why this matters

Chapter 18 closed by turning from making an existing plaintext connection fast to making it private and mutually authenticated. Every example before this one dialed `RoutingService.GetQuote` with `grpc.aio.insecure_channel` or `quarkus.grpc.server.plain-text=true` — correct for a book whose subject was request shape, streaming, and throughput, but not a configuration any of those services could run with outside a laptop. This chapter closes that gap without touching the contract at all: TLS and mTLS live entirely in how a channel is built and how a server is configured, never in a `.proto` file, so `GetQuote` — the same unary anchor Chapter 7 served and Chapter 18 tuned — is the RPC under test again, unchanged down to its formula. What changes is everything underneath it: the bytes on the wire are now encrypted, the client verifies the server's identity before trusting a single response, and — once this chapter turns on mutual TLS — the server verifies the client's identity right back.

The code is in `examples/19-tls-mtls/`. The run script there (`verify.sh`) builds and starts both stacks, brings up a one-shot certificate-bootstrap service ahead of either server, and asserts every claim this chapter makes against both of them, in two phases; its `README.md` covers what it does and how to drive it by hand.

{% include excalidraw.html file="19-tls-handshake-cert-chain" alt="Two panels, client on the left and server on the right. The client panel shows a grpcurl client holding a trusted CA certificate. The server panel shows the RoutingService GetQuote handler presenting a server certificate and key. Four numbered arrows cross between them: 1, ClientHello, from client to server; 2, ServerHello plus the server certificate, from server to client; 3, a self-loop on the client labeled verify chain against the CA certificate; 4, an encrypted GetQuote call, from client to server, sent only once verification succeeds. A note states the client never presents a certificate of its own in this mode." caption="Figure 19.1 — one-way TLS: the client verifies the server's certificate against a CA it already trusts; the server never asks who is calling." %}

## What a channel's transport credentials actually are

Every prior chapter's client built what grpc-core and grpc-java both call plaintext, or insecure, channel credentials: a value that tells the channel "do not negotiate TLS at all, send HTTP/2 frames in the clear." TLS channel credentials replace that value with one carrying a trust store — the set of certificate authorities the client is willing to accept a server certificate from — and, for mutual TLS, a client identity of its own. Server-side, the equivalent concept is transport credentials: a certificate and private key the server presents during the handshake, optionally paired with its own trust store for verifying whatever certificate a client presents back. Both stacks in this book expose the same four moving parts under different names. Quarkus, running the gRPC Java server (`quarkus.grpc.server.use-separate-server` stays at its default `true`, unchanged from every prior chapter), configures all four directly in `application.properties`:

```properties
quarkus.grpc.server.plain-text=false
quarkus.grpc.server.ssl.certificate=/certs/server.crt
quarkus.grpc.server.ssl.key=/certs/server.key
quarkus.grpc.server.ssl.trust-store=/certs/ca-truststore.jks
quarkus.grpc.server.ssl.trust-store-password=changeit
quarkus.grpc.server.ssl.client-auth=REQUIRED
```

Python's `grpc.aio` server builds the same four values as one call, with the certificate and key passed as a list of `(key, cert)` pairs — the shape grpc-core uses so a server can present more than one identity, even though this example presents exactly one:

```python
server_credentials = grpc.ssl_server_credentials(
    [(server_key_bytes, server_cert_bytes)],
    root_certificates=ca_cert_bytes,
    require_client_auth=True,
)
server.add_secure_port(bind_addr, server_credentials)
```

`add_secure_port` replaces `add_insecure_port` — the one-line swap every prior chapter's Python `main.py` would need to stop serving plaintext. Nothing about `RoutingServiceServicer.GetQuote` changes; the credentials object is built once at startup and handed to the server before it starts, the same way a channel is built once and reused across calls in Chapter 18. The two stacks disagree on vocabulary — Quarkus calls the client-verification knob `client-auth` with three string values; grpc-core calls it `require_client_auth` with one boolean — but they agree completely on what a handshake does: the server always presents `server.crt`/`server.key`; the client always validates that certificate against a CA it trusts; and whether the server also validates the client's own certificate is a single, independently togglable setting on each side.

## TLS alone: encrypting the channel, authenticating one direction

Plain TLS — what Figure 19.1 shows — authenticates exactly one party: the server proves its identity to the client, and the client proves nothing back. A `grpcurl` call presenting only a CA certificate, with no client certificate, completes a full handshake and gets a normal response, because `quarkus.grpc.server.ssl.client-auth` defaults to `NONE` and `require_client_auth=False` on the Python side means the server never asks for one:

```bash
grpcurl -cacert ca.crt -servername quarkus \
  -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9190 shipping.routing.v1.RoutingService/GetQuote
```

`-servername` sets TLS's Server Name Indication value — the name grpcurl checks the server's certificate's Subject Alternative Names against, independent of the socket address it actually dialed. This example's server certificate carries four SAN entries — `DNS:quarkus`, `DNS:python`, `DNS:localhost`, `IP:127.0.0.1` — covering both in-container service names plus the loopback address a host-side `grpcurl` call actually uses, which is why the same certificate works unmodified whether a caller is `quarkus` talking to `python` inside the compose network or a human on the host hitting `localhost:9190`.

What a plaintext call gets, against this same server, is not a clean application error — it never gets far enough to produce one:

```bash
grpcurl -plaintext -d '{...}' localhost:9190 shipping.routing.v1.RoutingService/GetQuote
# Failed to dial target host "localhost:9190": context deadline exceeded
```

A TLS-only listener does not recognize an incoming plaintext HTTP/2 preface as anything meaningful; depending on exactly where the mismatch is caught, grpcurl reports a stalled dial (`context deadline exceeded`), a dropped connection (`EOF`), or an explicit TLS alert (`remote error: tls: certificate required`, seen later in this chapter's mTLS phase) — three different error shapes for the same underlying fact: the call never reached gRPC's status-code machinery at all. That absence of a `Code:` line is itself the signal. A real application error — `NOT_FOUND`, `INVALID_ARGUMENT`, the rich-error payloads Chapter 11 built — only exists once a handshake has already succeeded; a transport failure happens earlier, and grpcurl's own "Failed to dial" prefix marks exactly that distinction.

<div class="callout callout--warn"><p class="callout__title">Watch out</p><p>Quarkus's gRPC Java server accepts a plain PEM file directly for <code>certificate</code>/<code>key</code>, but its <code>trust-store</code> property always loads through Vert.x's <code>KeyStoreHelper</code>, which expects an actual Java keystore. Handing it a PEM CA throws <code>Invalid keystore format</code> at startup, which fails fast and points straight at the cause. A PKCS12 trust-store built with <code>openssl pkcs12 -export -nokeys -in ca.crt -out ca.p12</code> is the harder failure mode: it loads without error, but Java's PKIX validator reports zero usable trust anchors (<code>InvalidAlgorithmParameterException: the trustAnchors parameter must be non-empty</code>) the moment a client actually presents a certificate to verify — a one-way TLS handshake never exercises that code path, so the mistake only surfaces once mTLS is turned on. <code>keytool -importcert</code> builds a trust-store Java recognizes correctly; see "Cert bootstrap" below.</p></div>

## mTLS: the server asks back

Mutual TLS adds the direction plain TLS leaves out: the server requests a certificate from the client during the handshake and verifies it against its own trust store before completing the connection. Quarkus's `client-auth` property takes three values — `NONE` (never asked), `REQUEST` (asked for, accepted either way), `REQUIRED` (handshake fails without one) — mirroring the Vert.x `ClientAuth` enum underneath it; grpc-core's `require_client_auth` collapses the same idea to a boolean, since Python's API has no middle "ask but don't enforce" option. This example only ever uses the two ends of that range. `GRPC_CLIENT_AUTH`, an environment variable both `application.properties` and `main.py` read, switches a running stack between them without a rebuild:

```properties
quarkus.grpc.server.ssl.client-auth=${GRPC_CLIENT_AUTH:REQUIRED}
```

```python
CLIENT_AUTH = os.environ.get("GRPC_CLIENT_AUTH", "REQUIRED")
require_client_auth=(CLIENT_AUTH == "REQUIRED")
```

`REQUIRED` is this example's steady state — a plain `docker compose up` serves mTLS from the first request. `verify.sh` demonstrates the progression by recreating both servers with `GRPC_CLIENT_AUTH=NONE` first, running the one-way-TLS assertions against that, then recreating them again with `GRPC_CLIENT_AUTH=REQUIRED` for the mTLS assertions — the same certificate material throughout, only the server's willingness to ask changes.

{% include excalidraw.html file="19-mtls-mutual-verification" alt="Two side-by-side panels. The left panel, labeled TLS one-way, shows a client with no certificate connecting successfully to a server, captioned client identity not checked, any client with the CA succeeds. The right panel, labeled mTLS two-way, shows a client presenting client.crt connecting successfully to a server configured with client-auth REQUIRED, while a second, dashed client with no certificate is rejected, captioned client identity verified against the CA, no cert leads to rejection at handshake." caption="Figure 19.2 — mTLS adds the second direction of trust: the server now verifies the client's certificate too, and a client without one is turned away before any RPC runs." %}

With `client-auth=REQUIRED`, the exact `grpcurl` invocation that succeeded in the TLS-only phase — CA certificate only, no client identity — now fails the same way a plaintext call always has:

```bash
grpcurl -cacert ca.crt -servername quarkus -d '{...}' \
  localhost:9190 shipping.routing.v1.RoutingService/GetQuote
# Failed to dial target host "localhost:9190": remote error: tls: certificate required
```

Presenting a client certificate the server's trust store recognizes restores the call to a normal response:

```bash
grpcurl -cacert ca.crt -cert client.crt -key client.key -servername quarkus \
  -d '{...}' localhost:9190 shipping.routing.v1.RoutingService/GetQuote
```

That contrast — identical flags, identical server, opposite outcomes, purely because one configuration value changed between the two calls — is this chapter's central point. TLS proves the server's identity to the client. Mutual TLS proves both directions, and it does so at the transport layer, before a single byte of the `GetQuoteRequest` message is deserialized — a rejection here never reaches `RoutingServiceImpl.getQuote` or `RoutingServiceServicer.GetQuote` at all, the same way Chapter 12's interceptors run ahead of a handler but one layer further down the stack, in the handshake itself rather than in gRPC's own request pipeline.

## Cert bootstrap: certgen, the shared volume, and the SAN list

Every certificate this example uses is minted fresh, every run, by a one-shot `certgen` compose service — never a server, never left running, and never baked into an image layer. `compose.yaml` wires it as an init dependency: both `quarkus` and `python` declare `depends_on: certgen: condition: service_completed_successfully`, so a plain `docker compose up` runs certificate generation to completion automatically before either server container starts, the same one-shot pattern Chapter 18's `ghz` load generator uses for a different purpose. `certgen`'s image is a pinned `registry.access.redhat.com/ubi10/ubi-minimal` base with `openssl` and a headless JDK (`java-21-openjdk-headless`, for `keytool` alone) installed at build time — a cached layer — while the actual key material is generated by `gen-certs.sh` at container-run time, so every `verify.sh` invocation produces a brand-new certificate authority rather than reusing one committed to the repository.

{% include excalidraw.html file="19-where-credentials-attach" alt="A certgen one-shot container running openssl and keytool writes into a named volume called certs, containing ca.crt, ca.key, server.crt, server.key, client.crt, client.key, and ca-truststore.jks. An arrow shows the certs volume mounted read-only into the quarkus and python servers, which read server.crt, server.key, and the trust store. A second arrow shows certgen also copying ca.crt, client.crt, and client.key into a host bind mount, which a host-side grpcurl process reads directly with -cacert, -cert, and -key flags. A note lists the server certificate's Subject Alternative Names: DNS colon quarkus, DNS colon python, DNS colon localhost, IP colon 127.0.0.1." caption="Figure 19.3 — certgen's one-shot run feeds both servers through a shared named volume and feeds the host-side grpcurl process through a bind-mounted copy of the public material." %}

`gen-certs.sh` builds three identities from one locally-generated CA, each with a ten-year validity window and a notBefore backdated about a day to absorb clock skew between the certgen container, the two servers, and whatever host eventually runs `verify.sh`:

```bash
openssl req -x509 -new -key ca.key -sha256 \
  -subj "/O=PatternCatalyst/CN=ch19-tls-mtls example CA" \
  -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" -out ca.crt

openssl req -new -key server.key -subj "/O=PatternCatalyst/CN=ch19-tls-mtls server" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -extfile server-ext.cnf -out server.crt   # server-ext.cnf sets subjectAltName
```

One server certificate, carrying all four SAN entries, is shared by both the Quarkus and Python services — simpler than minting a certificate per stack, and it exercises the exact property SAN checking exists for: a single certificate can legitimately answer to more than one name. The client identity follows the same CA-signing pattern with `extendedKeyUsage = clientAuth` in place of `serverAuth`, producing `client.crt`/`client.key` for `grpcurl` to present during the mTLS phase.

Everything certgen writes lands in a named Docker volume called `certs`, mounted read-only into both servers — the single source both stacks' TLS configuration points at. Because `verify.sh`'s `grpcurl` calls run as a plain host process (the same self-contained binary every prior chapter's `verify.sh` downloads, not a container on the compose network), certgen also copies the public material — `ca.crt`, `client.crt`, `client.key`, deliberately never `server.key` or `ca.key` — into a second, bind-mounted host directory a host-side `grpcurl` can read directly. The private server key and the CA's own signing key never leave the named volume; only identities a client is meant to present cross that boundary.

The one piece of material that is not a plain certificate is `ca-truststore.jks`: a Java keystore `keytool -importcert` builds from `ca.crt`, which exists purely because of the gotcha the callout above describes. The gRPC Java server's trust-store loader wants a real keystore, not PEM and not a certificate-only PKCS12 — `keytool`, not `openssl pkcs12`, is what produces one Java's own PKIX validator actually recognizes as carrying a trust anchor. grpc-core has no equivalent requirement; `root_certificates=ca_cert_bytes` on the Python side reads `ca.crt` directly, the same file the host-side `grpcurl` process uses with `-cacert`.

## Build, run, observe

```bash
cd examples/19-tls-mtls && ./verify.sh
```

`verify.sh` brings the stack up with `GRPC_CLIENT_AUTH=NONE`, waits for certgen's output to land, then runs the TLS-only assertions against both stacks' host ports (`localhost:9190` Quarkus, `localhost:9191` Python): a CA-only `grpcurl` call returns the correct `quote.currency`/`quote.amount`/`route.id`/`route.legs[0].carrier`, and the identical request over `-plaintext` fails at the transport layer. It then recreates both servers with `GRPC_CLIENT_AUTH=REQUIRED` and repeats the correctness check with a client certificate added, followed by the same CA-only call — now rejected — to prove the server's new requirement is actually enforced. Expect `PASS` once all eight assertions (four per stack) hold; the full set of real error strings from an authoring-machine run is in `examples/19-tls-mtls/README.md`.

## Progression toward a real cluster

Everything in this chapter's example is Compose-local by design: a one-shot container writes certificates into a volume two sibling containers mount. A production Kubernetes deployment replaces every piece of that mechanism without touching `RoutingServiceImpl`/`RoutingServiceServicer` at all, because the application code only ever reads file paths — `/certs/server.crt`, `/certs/server.key`, `/certs/ca-truststore.jks` — and never cares how those files got there. On minikube or any other cluster, the natural replacement for `certgen` is [cert-manager](https://cert-manager.io/), which issues and automatically rotates certificates into Kubernetes `Secret` objects mounted as volumes at the same paths this chapter's `application.properties` and `main.py` already reference; a `Certificate` resource requesting the same SAN list (now a cluster-internal DNS name like `routing-quarkus.default.svc.cluster.local` rather than a bare compose service name) replaces `gen-certs.sh`'s `openssl` invocation, and cert-manager's renewal controller replaces the ten-year validity window this example uses to avoid rotation entirely. The trust-store conversion gotcha this chapter spent real effort working around is unaffected by that move — a Kubernetes-issued PEM certificate still needs the same `keytool -importcert` step before Quarkus's gRPC Java server will accept it as a trust-store, unless that deployment switches to the Vert.x-based server and the centralized `quarkus.tls.*` registry instead, which accepts PEM trust material directly. This book does not stand up that migration — Appendix A's OpenShift Local path and the later load-balancing chapter cover running services on a real cluster — but every certificate and configuration key in this chapter is the same one a cluster deployment would use; only who writes the files and how often they rotate changes.

## Cross-check

Independent of `grpcurl`, OpenSSL's own client confirms the same chain and SAN list a different way:

```bash
openssl s_client -connect localhost:9190 -servername quarkus \
  -CAfile examples/19-tls-mtls/.host-out/ca.crt </dev/null 2>&1 | grep -E "Verify return code|subjectAltName"
# Verify return code: 0 (ok)
```

A `Verify return code: 0 (ok)` from a completely different TLS client, using the same CA file `grpcurl` was handed, is a reasonable sanity check that the certificate chain itself is sound — independent of any gRPC-specific behavior grpcurl might add on top.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Terminate TLS at the service itself, not in front of it, whenever a call might cross a network boundary a different team or a different trust domain controls — a sidecar or ingress can add defense in depth, but the service's own certificate is what makes "this call came over an encrypted, verified connection" a property the application code can rely on rather than assume. Require mutual TLS (<code>client-auth=REQUIRED</code> / <code>require_client_auth=True</code>) for any internal service that should only ever be called by other known services in the same system — it is the cheapest form of service identity available, cheaper than a bearer token because there is no credential to steal from a log line, only a private key that never leaves the calling service's own filesystem. Reserve one-way TLS (<code>client-auth=NONE</code>) for a public-facing endpoint whose callers cannot reasonably hold a client certificate at all. Rotate certificates on a schedule measured in weeks or months, never this chapter's ten-year demo window — in production, let a tool built for the job (cert-manager on Kubernetes, a service mesh's own identity system) own issuance and renewal rather than a hand-rolled script, so an expiring certificate is a non-event instead of an outage.</p></div>

## What you learned

- TLS channel and transport credentials replace plaintext/insecure credentials with a trust store (the client) and a certificate-and-key pair (the server); mutual TLS adds a trust store on the server side too, so both parties verify who they are talking to before a single RPC runs.
- A transport-layer rejection — a failed dial, a dropped connection, an explicit TLS alert — never produces a gRPC status code, because the handshake never got far enough for one to exist; that absence is what distinguishes it from a clean application-level error.
- The same `grpcurl` flags that succeed against a one-way-TLS server fail against the identical server once `client-auth=REQUIRED` is turned on — the contrast this chapter's `verify.sh` proves explicitly, on both stacks, is mutual TLS's entire value proposition in one pair of commands.
- A Java keystore and a PEM certificate are not interchangeable even when they encode the identical trust material: the gRPC Java server's trust-store loader silently produces zero usable trust anchors from an openssl-built PKCS12 file, a failure mode that only surfaces once mTLS, not plain TLS, is exercised.

Chapter 20 keeps this chapter's encrypted, mutually-trusted channel and adds a third question on top of it: now that the server knows *which* service is calling, what is that caller allowed to do?

## On the wire

TLS only, `client-auth=NONE` — a CA-only call succeeds:

```bash
grpcurl -cacert ca.crt -servername quarkus \
  -d '{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}' \
  localhost:9190 shipping.routing.v1.RoutingService/GetQuote
```

```json
{
  "quote": { "currency": "USD", "amount": "3001.25" },
  "route": { "id": "rte_USNYC-NLRTM", "legs": [{"carrier": "MAERSK", "...": "..."}], "price": {"currency": "USD", "amount": "3001.25"} }
}
```

The same request over `-plaintext`, against that same TLS-only server, refused at the transport layer:

```bash
grpcurl -plaintext -d '{...}' localhost:9190 shipping.routing.v1.RoutingService/GetQuote
# Failed to dial target host "localhost:9190": context deadline exceeded
```

mTLS, `client-auth=REQUIRED` — the identical CA-only call that succeeded above now fails:

```bash
grpcurl -cacert ca.crt -servername quarkus -d '{...}' \
  localhost:9190 shipping.routing.v1.RoutingService/GetQuote
# Failed to dial target host "localhost:9190": remote error: tls: certificate required
```

Presenting a client certificate restores the call:

```bash
grpcurl -cacert ca.crt -cert client.crt -key client.key -servername quarkus \
  -d '{...}' localhost:9190 shipping.routing.v1.RoutingService/GetQuote
# { "quote": { "currency": "USD", "amount": "3001.25" }, ... }
```

The Python stack (`localhost:9191`, `-servername python`) produces byte-for-byte the same four outcomes against the identical four invocations — grpc-core's dial failure for the no-client-cert mTLS case renders as `Failed to dial target host "localhost:9191": EOF` rather than Quarkus's explicit `tls: certificate required` alert, a difference in exactly where each server's TLS stack chooses to report the same refusal, not a difference in behavior.

---

*Verification status: <span class="status status--unverified">unverified</span>.
`verify.sh` ran green against both stacks on the authoring machine across
repeated runs, including both the TLS-only phase (CA-only success, plaintext
refused) and the mTLS phase (client-cert success, CA-only rejected) on each
of Quarkus and Python. The highest-risk things a reader's own run should
confirm: that `registry.access.redhat.com/ubi10/ubi-minimal` continues to
ship a `java-21-openjdk-headless` package reachable via `microdnf` (re-check
with `skopeo list-tags` before bumping the pin, same discipline as this
book's other base-image pins), that the exact `quarkus.grpc.server.ssl.*`
keys and the PKCS12-trust-store gotcha this chapter documents continue to
hold on a future `quarkus-grpc` point release, and that a Docker Engine
other than the Linux-native one this book was authored against still
produces host-readable files under the `certs` named volume's bind-mounted
export directory.*

## For deeper coverage

- [grpc.io — Authentication guide](https://grpc.io/docs/guides/auth/) — gRPC's built-in TLS, ALTS, and token-based authentication mechanisms, the catalog this chapter's TLS half and Chapter 20's JWT half both come from.
- [cert-manager](https://cert-manager.io/) — the Kubernetes certificate issuance and rotation controller this chapter's "Progression toward a real cluster" section names as the production replacement for `certgen`.
- Liz Rice, *Container Security*, 2nd ed. — O'Reilly, 2025 — service identity and mutual authentication in containerized environments.
- Cloud Native Design Patterns — "Security" chapter — the broader authn/authz pattern catalog this chapter's TLS/mTLS mechanics sit inside.
