---
title: "TLS & mTLS"
order: 19
part: "Security"
description: "Transport credentials on both stacks, a certificate bootstrap with the right SANs, and the switch from one-way TLS to mutual TLS on RoutingService.GetQuote."
duration: "24 min read"
---

## Learning objectives

By the end of this chapter you can:

- Configure TLS and mTLS transport credentials on Quarkus (`quarkus.grpc.server.ssl.*`) and Python (`grpc.ssl_server_credentials`).
- Tell a transport-layer handshake failure from a gRPC status code.
- Toggle `client-auth` / `require_client_auth` to move a service from one-way TLS to mutual TLS, and say what each direction of trust buys.
- Build a CA, a server certificate with SANs and a client certificate with `openssl`, and avoid the PEM-versus-Java-keystore trust-store trap.
- Map the Compose certificate bootstrap onto cert-manager on a cluster.

## Why this matters

Every earlier example dialed `RoutingService.GetQuote` over plaintext. That is fine for studying request shape and streaming, and wrong for anything that leaves a laptop. TLS lives in how a channel is built and a server is configured, never in a `.proto` file, so `GetQuote` is unchanged. What changes is underneath: the bytes are encrypted, the client verifies the server's identity before trusting a response, and with mutual TLS the server verifies the client back.

{% include excalidraw.html file="19-tls-handshake-cert-chain" alt="Two panels, client on the left and server on the right. The client panel shows a grpcurl client holding a trusted CA certificate. The server panel shows the RoutingService GetQuote handler presenting a server certificate and key. Four numbered arrows cross between them: 1, ClientHello, from client to server; 2, ServerHello plus the server certificate, from server to client; 3, a self-loop on the client labeled verify chain against the CA certificate; 4, an encrypted GetQuote call, from client to server, sent only once verification succeeds. A note states the client never presents a certificate of its own in this mode." caption="Figure 19.1: one-way TLS. The client verifies the server's certificate against a CA it trusts; the server never asks who is calling." %}

## Transport credentials

A plaintext channel tells the stack not to negotiate TLS at all. TLS channel credentials replace that with a trust store: the certificate authorities the client accepts a server certificate from, plus, for mutual TLS, a client identity. The server side is a certificate and private key, optionally paired with its own trust store for verifying client certificates. Both stacks expose the same four parts under different names. Quarkus runs the gRPC Java server (`quarkus.grpc.server.use-separate-server` stays at its default `true`) and configures them in `application.properties`. The certificate and key accept PEM:

```properties
quarkus.grpc.server.plain-text=false
quarkus.grpc.server.ssl.certificate=/certs/server.crt
quarkus.grpc.server.ssl.key=/certs/server.key
```

The trust store is the CA client certificates must chain to. It loads unconditionally, so changing `client-auth` never needs a second file; with `client-auth=NONE` it is simply unused. The password unlocks the keystore archive and is not a secret:

```properties
quarkus.grpc.server.ssl.trust-store=/certs/ca-truststore.jks
quarkus.grpc.server.ssl.trust-store-password=changeit
```

Python builds the same values with one call. The certificate and key go in as a list of `(key, cert)` pairs so a server can present more than one identity:

```python
def _build_server_credentials() -> grpc.ServerCredentials:
    server_key = (CERTS_DIR / "server.key").read_bytes()
    server_cert = (CERTS_DIR / "server.crt").read_bytes()
    ca_cert = (CERTS_DIR / "ca.crt").read_bytes()
    return grpc.ssl_server_credentials(
        [(server_key, server_cert)],
        root_certificates=ca_cert,
        require_client_auth=(CLIENT_AUTH == "REQUIRED"),
    )
```

`add_secure_port` replaces `add_insecure_port`; the servicer is untouched. The vocabularies differ, but the handshake is the same: the server always presents its certificate, the client always validates it against a CA it trusts, and whether the server also validates the client is one independent setting.

## TLS alone

One-way TLS authenticates one party. A `grpcurl` call with only a CA certificate completes the handshake and gets a normal response, because `client-auth` set to `NONE` (or `require_client_auth=False`) means the server never asks for a certificate:

```bash
grpcurl -cacert ca.crt -servername quarkus \
  -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}' \
  localhost:9190 shipping.routing.v1.RoutingService/GetQuote
```

`-servername` sets the Server Name Indication value, the name checked against the certificate's Subject Alternative Names regardless of the address dialed. The server certificate carries four SANs (`DNS:quarkus`, `DNS:python`, `DNS:localhost`, `IP:127.0.0.1`), so one certificate serves both stacks inside the Compose network and a host-side call to `localhost`. A name missing from the SAN list fails verification even when the CA is right.

A plaintext call to the same listener never produces an application error. Depending on where the mismatch is caught, grpcurl reports `Failed to dial target host ... context deadline exceeded`, `EOF` or a TLS alert. All three mean the call never reached gRPC's status machinery. A real status such as `NOT_FOUND` or `INVALID_ARGUMENT` exists only after a successful handshake, so a missing `Code:` line plus a "Failed to dial" prefix marks a transport failure.

<div class="callout callout--warn"><p class="callout__title">Watch out</p><p>Quarkus accepts PEM for <code>certificate</code> and <code>key</code>, but <code>trust-store</code> loads through Vert.x and needs a Java keystore. A PEM CA fails at startup with <code>Invalid keystore format</code>. A PKCS12 file built with <code>openssl pkcs12 -export -nokeys</code> is worse: it loads with zero trust anchors, and one-way TLS never exercises that path, so the mistake surfaces only when mTLS is on. Build the store with <code>keytool -importcert</code>.</p></div>

## mTLS

Mutual TLS adds the missing direction: the server requests a certificate during the handshake and verifies it against its own trust store. Quarkus takes three values, mirroring the Vert.x `ClientAuth` enum:

| `client-auth` | Server behavior |
| --- | --- |
| `NONE` | Never asks for a certificate |
| `REQUEST` | Asks, accepts the handshake either way |
| `REQUIRED` | Handshake fails without a valid certificate |

Python's `require_client_auth` is a boolean with no "ask but don't enforce" middle, so only the two ends are used. Both servers read one environment variable, `GRPC_CLIENT_AUTH`, which switches a stack between them without a rebuild. `REQUIRED` is the default, so a plain `docker compose up` serves mTLS from the first request:

```properties
quarkus.grpc.server.ssl.client-auth=${GRPC_CLIENT_AUTH:REQUIRED}
```

```python
CLIENT_AUTH = os.environ.get("GRPC_CLIENT_AUTH", "REQUIRED")
```

The certificate material stays the same in both modes; only the server's willingness to ask changes.

{% include excalidraw.html file="19-mtls-mutual-verification" alt="Two side-by-side panels. The left panel, labeled TLS one-way, shows a client with no certificate connecting successfully to a server, captioned client identity not checked, any client with the CA succeeds. The right panel, labeled mTLS two-way, shows a client presenting client.crt connecting successfully to a server configured with client-auth REQUIRED, while a second, dashed client with no certificate is rejected, captioned client identity verified against the CA, no cert leads to rejection at handshake." caption="Figure 19.2: mTLS adds the second direction of trust. A client without a certificate is turned away before any RPC runs." %}

With `REQUIRED`, the CA-only call that worked above now fails at the handshake:

```bash
grpcurl -cacert ca.crt -servername quarkus -d '{...}' \
  localhost:9190 shipping.routing.v1.RoutingService/GetQuote
# Failed to dial target host "localhost:9190": remote error: tls: certificate required
```

Python's grpc-core reports the same refusal as `EOF`; the difference is where each TLS stack chooses to report it. Adding `-cert client.crt -key client.key` restores the response. Identical flags, identical server, opposite outcomes from one configuration value. The rejection happens before `GetQuoteRequest` is deserialized, so it never reaches `RoutingServiceImpl.getQuote` or `RoutingServiceServicer.GetQuote`. It sits a layer below interceptors, in the handshake itself.

## Certificate bootstrap

A one-shot `certgen` Compose service mints every certificate on each run, so no key is committed or baked into an image. Both servers declare `depends_on: certgen: condition: service_completed_successfully`, so a plain `docker compose up` generates certificates before either server starts. The image is a pinned `ubi10/ubi-minimal` with `openssl` and a headless JDK installed for `keytool` alone.

{% include excalidraw.html file="19-where-credentials-attach" alt="A certgen one-shot container running openssl and keytool writes into a named volume called certs, containing ca.crt, ca.key, server.crt, server.key, client.crt, client.key, and ca-truststore.jks. An arrow shows the certs volume mounted read-only into the quarkus and python servers, which read server.crt, server.key, and the trust store. A second arrow shows certgen also copying ca.crt, client.crt, and client.key into a host bind mount, which a host-side grpcurl process reads directly with -cacert, -cert, and -key flags. A note lists the server certificate's Subject Alternative Names: DNS colon quarkus, DNS colon python, DNS colon localhost, IP colon 127.0.0.1." caption="Figure 19.3: certgen writes once into a shared volume for both servers and copies the public material to a host directory for grpcurl." %}

`gen-certs.sh` builds three identities from one local CA: the CA itself, the server certificate with the four SANs and `extendedKeyUsage = serverAuth`, and a client certificate with `extendedKeyUsage = clientAuth`. Each is valid ten years, with `notBefore` backdated a day to absorb clock skew between certgen, the servers and the host. Everything lands in a named volume `certs`, mounted read-only into both servers. The host-side `grpcurl` is a plain process, so certgen also copies the public material (`ca.crt`, `client.crt`, `client.key`) to a bind-mounted host directory. `server.key` and `ca.key` never leave the volume.

The odd file is `ca-truststore.jks`, built by `keytool -importcert` from `ca.crt`. The Java server's trust-store loader wants a real Java keystore. grpc-core has no such requirement: `root_certificates` reads `ca.crt` directly.

## From Compose to a cluster

The application reads file paths (`/certs/server.crt`, `/certs/server.key`, `/certs/ca-truststore.jks`) and does not care how they got there, so moving to a cluster changes only who writes them. [cert-manager](https://cert-manager.io/) replaces `certgen`: a `Certificate` resource requests the same SAN list, now with a cluster DNS name such as `routing-quarkus.default.svc.cluster.local`, and writes a `Secret` mounted at the same paths. Its renewal controller replaces the ten-year validity window. The trust-store gotcha survives the move: a cluster-issued PEM CA still needs `keytool -importcert` for the Java gRPC server, unless the deployment switches to the Vert.x-based server and the `quarkus.tls.*` registry, which accepts PEM trust material.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Terminate TLS at the service itself, not in front of it, whenever a call might cross a network boundary that another team or trust domain controls. A sidecar or ingress can add defense in depth, but the service's own certificate is what lets the application rely on an encrypted, verified connection instead of assuming one. Require mutual TLS for internal services that only known services should call: it is the cheapest service identity, and unlike a bearer token there is no credential to leak into a log line, only a private key that never leaves the caller's filesystem. Keep one-way TLS (<code>client-auth=NONE</code>) for public endpoints whose callers cannot hold a client certificate. Rotate on a schedule of weeks or months, never the ten-year demo window, and let cert-manager or a mesh own issuance and renewal.</p></div>

> **🤖 Explore with your agent**
>
> "In `examples/19-tls-mtls`, add a second client identity to `certgen/gen-certs.sh`, signed by the same CA with `extendedKeyUsage = clientAuth`, and copy it to `.host-out/` with the first. With the default `GRPC_CLIENT_AUTH=REQUIRED`, show `grpcurl` calls to `shipping.routing.v1.RoutingService/GetQuote` on ports 9190 and 9191 with no client certificate and with the new one, and say which `client-auth` value a public endpoint should use instead."
>
> Check: the CA-only calls fail with `tls: certificate required` (Quarkus) or `EOF` (Python), the calls with the new certificate return a quote, and `./verify.sh` still prints `PASS`.

## Build, run, observe

```bash
cd examples/19-tls-mtls && ./verify.sh
```

The script starts both stacks with `GRPC_CLIENT_AUTH=NONE` and checks a CA-only call and a plaintext call on Quarkus (`localhost:9190`) and Python (`localhost:9191`). It then recreates both with `REQUIRED` and checks the call with a client certificate and the CA-only call. It ends with `PASS` when all eight checks hold. The full error strings are in `examples/19-tls-mtls/README.md`. As an independent check, OpenSSL's own client should report `Verify return code: 0 (ok)`:

```bash
openssl s_client -connect localhost:9190 -servername quarkus \
  -CAfile examples/19-tls-mtls/.host-out/ca.crt </dev/null 2>&1 | grep -E "Verify return code|subjectAltName"
```

Experiments:

- **Drop the client certificate.** Start the stack with `GRPC_CLIENT_AUTH=NONE`: the CA-only call succeeds. With `REQUIRED` it fails at the handshake.
- **Use a PEM trust store.** Point `trust-store` at `ca.crt`: Quarkus fails at startup with `Invalid keystore format`.
- **Use a PKCS12 trust store.** Build one with `openssl pkcs12 -export -nokeys -in ca.crt -out ca.p12`: it loads, then rejects client certificates with `the trustAnchors parameter must be non-empty` once mTLS is on.

## What you learned

- TLS credentials give the client a trust store and the server a certificate and key. Mutual TLS adds a trust store on the server, so both sides are verified before any RPC runs.
- A handshake failure carries no gRPC status code. That absence separates it from an application error.
- One setting, `client-auth` or `require_client_auth`, moves a service from one-way TLS to mutual TLS.
- A Java keystore and a PEM certificate are not interchangeable for the Java server's trust store.

Authentication and authorization build on this channel: once the server knows which service is calling, what is that caller allowed to do?

## For deeper coverage

- [grpc.io: Authentication guide](https://grpc.io/docs/guides/auth/): gRPC's built-in TLS, ALTS and token-based mechanisms.
- [cert-manager](https://cert-manager.io/): the Kubernetes issuance and rotation controller named above.
- Liz Rice, *Container Security*, 2nd ed., O'Reilly, 2025: service identity and mutual authentication in containerized environments.
- Cloud Native Design Patterns, "Security" chapter: the wider authn/authz pattern catalog.
