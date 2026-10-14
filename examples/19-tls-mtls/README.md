# Ch19 — TLS & mTLS: channel/transport credentials on `RoutingService.GetQuote`

The reference both-stack implementation of `shipping.routing.v1.RoutingService.GetQuote` served over
TLS, then mutual TLS — no contract change, since TLS/mTLS lives entirely in how a channel is built and
how a server is configured. The contract is unchanged from every prior chapter:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService` and its five RPCs
  (`GetQuote` is implemented here; the rest return `UNIMPLEMENTED`, same discipline as every prior
  example).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`, `Location`, `Cargo`, `Route`,
  `Leg` messages.

Quarkus (`quarkus/`, host port **9190**) and Python (`python/`, host port **9191**) independently
implement the identical RPC, generated from the **same** `.proto` files, served over the **same**
certificate material a one-shot `certgen` service mints fresh on every run.

## Run it

```bash
cd examples/19-tls-mtls
./verify.sh
```

This brings the stack up with `GRPC_CLIENT_AUTH=NONE` (TLS only), verifies a CA-only `grpcurl` call
succeeds and a plaintext call is refused on both stacks, then recreates both servers with
`GRPC_CLIENT_AUTH=REQUIRED` (mTLS) and verifies a client-cert call succeeds while the identical
CA-only call now fails. Prints `PASS` only if all eight assertions (four per stack) hold. A real run on
this book's dev box:

```
lib.sh: ok — quarkus phase A TLS quote.amount: '3001.25'
lib.sh: ok — quarkus phase A plaintext-refused: rejected at the transport/handshake layer
lib.sh: ok — python phase A TLS quote.amount: '3001.25'
lib.sh: ok — python phase A plaintext-refused: rejected at the transport/handshake layer
lib.sh: ok — quarkus phase B mTLS quote.amount: '3001.25'
lib.sh: ok — quarkus phase B no-client-cert-rejected: rejected at the transport/handshake layer
lib.sh: ok — python phase B mTLS quote.amount: '3001.25'
lib.sh: ok — python phase B no-client-cert-rejected: rejected at the transport/handshake layer
```

To poke at it by hand instead:

```bash
GRPC_CLIENT_AUTH=NONE docker compose up -d --build   # TLS only
# or just: docker compose up -d --build              # mTLS (the default — GRPC_CLIENT_AUTH=REQUIRED)

CA=.host-out/ca.crt
CLIENT_CRT=.host-out/client.crt
CLIENT_KEY=.host-out/client.key

# TLS: a CA-only call succeeds whenever GRPC_CLIENT_AUTH=NONE
grpcurl -cacert "$CA" -servername quarkus -d '{
  "origin": {"unLocode": "USNYC", "name": "New York"},
  "destination": {"unLocode": "NLRTM", "name": "Rotterdam"},
  "cargo": [{"weightKg": 1200.5, "description": "Palletized electronics", "cargoType": "GENERAL"}]
}' localhost:9190 shipping.routing.v1.RoutingService/GetQuote

# Plaintext is always refused, regardless of GRPC_CLIENT_AUTH
grpcurl -plaintext -d '{...}' localhost:9190 shipping.routing.v1.RoutingService/GetQuote

# mTLS: with GRPC_CLIENT_AUTH=REQUIRED, the CA-only call above now fails...
grpcurl -cacert "$CA" -servername quarkus -d '{...}' localhost:9190 shipping.routing.v1.RoutingService/GetQuote
# ...and only succeeds with a client cert added
grpcurl -cacert "$CA" -cert "$CLIENT_CRT" -key "$CLIENT_KEY" -servername quarkus \
  -d '{...}' localhost:9190 shipping.routing.v1.RoutingService/GetQuote

docker compose down -v
```

Swap `9190`/`quarkus` for `9191`/`python` to hit the Python stack instead — identical certificates,
identical outcomes.

## The quote formula (unchanged from Ch7/Ch18)

```
quote.currency = "USD"
quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
route.id       = "rte_" + origin.un_locode + "-" + destination.un_locode
route.legs     = [ { carrier: "MAERSK", origin, destination } ]  # departs_at/arrives_at unset
route.price    = quote
```

## Cert bootstrap: `certgen`

`certgen/` builds a pinned `registry.access.redhat.com/ubi10/ubi-minimal:10.2-1791891203` image with
`openssl` and `java-21-openjdk-headless` (for `keytool` only) installed at build time. The actual
certificate material is generated at **container-run time** by `certgen/gen-certs.sh`, fresh on every
`docker compose up` — nothing cryptographic is committed to the repository or baked into an image
layer. `compose.yaml` wires `certgen` as a `depends_on: condition: service_completed_successfully`
dependency of both `quarkus` and `python`, so a plain `docker compose up` runs it to completion
automatically before either server starts.

`gen-certs.sh` mints one local CA and three identities from it, each with a 10-year validity window
and a notBefore backdated about a day to absorb clock skew:

| File | Purpose |
|---|---|
| `ca.crt` / `ca.key` | the local CA every other cert in this example chains to |
| `server.crt` / `server.key` | ONE server identity, shared by both Quarkus and Python |
| `client.crt` / `client.key` | the mTLS client identity `grpcurl` presents |
| `ca-truststore.jks` | `ca.crt` repackaged as a Java keystore — see below |

`server.crt`'s Subject Alternative Name list is `DNS:quarkus, DNS:python, DNS:localhost,
IP:127.0.0.1` — covering both in-container service names (so either server is a valid target when a
client inside the compose network dials `quarkus:9000` or `python:9000`) plus `localhost`/`127.0.0.1`
(so a host-side `grpcurl -servername quarkus` call against the published port `localhost:9190` also
validates).

Everything lands in a named Docker volume, `certs`, mounted read-only into both servers. `certgen`
additionally copies `ca.crt`, `client.crt`, and `client.key` — never `server.key` or `ca.key` — into
`.host-out/`, a bind-mounted host directory `verify.sh`'s plain host-process `grpcurl` reads directly
with `-cacert`/`-cert`/`-key`, since it is not itself a container on the compose network.

### The PKCS12 trust-store gotcha (why `keytool`, not `openssl pkcs12`)

Quarkus's gRPC Java server (`quarkus.grpc.server.use-separate-server=true`, the default used by every
chapter in this book) accepts a plain PEM file directly for `certificate`/`key`, but its `trust-store`
property always loads through Vert.x's `KeyStoreHelper`, which requires an actual Java keystore:

- Handing it `ca.crt` directly throws `java.io.IOException: Invalid keystore format` at startup.
- A PKCS12 trust-store built the obvious way, `openssl pkcs12 -export -nokeys -in ca.crt -out
  ca.p12`, loads without error but fails silently the moment it matters: Java's PKIX validator reports
  `InvalidAlgorithmParameterException: the trustAnchors parameter must be non-empty` the first time a
  client presents a certificate to verify. A one-way TLS handshake never exercises that code path, so
  this only surfaces once `client-auth=REQUIRED` is turned on — confirmed empirically while building
  this example, not assumed from documentation.
- `keytool -importcert -noprompt -alias ca -file ca.crt -keystore ca-truststore.jks -storepass
  changeit` builds a trust-store Java recognizes correctly. `java-21-openjdk-headless` is in the
  `certgen` image for `keytool` alone — nothing else in this example touches Java on the certgen side.

grpc.aio's `ssl_server_credentials(..., root_certificates=...)` on the Python side has no such
restriction; it reads `ca.crt` directly.

## Server configuration

| Key | Quarkus (`application.properties`) | Python (`grpc.aio` / `main.py`) |
|---|---|---|
| Disable plaintext | `quarkus.grpc.server.plain-text=false` | `server.add_secure_port(...)` in place of `add_insecure_port(...)` |
| Server certificate | `quarkus.grpc.server.ssl.certificate=/certs/server.crt` | `[(server_key_bytes, server_cert_bytes)]` passed to `ssl_server_credentials` |
| Server key | `quarkus.grpc.server.ssl.key=/certs/server.key` | (same pair, above) |
| Trust store (CA) | `quarkus.grpc.server.ssl.trust-store=/certs/ca-truststore.jks` + `.trust-store-password=changeit` | `root_certificates=ca_cert_bytes` |
| Client-auth toggle | `quarkus.grpc.server.ssl.client-auth=${GRPC_CLIENT_AUTH:REQUIRED}` | `require_client_auth=(os.environ.get("GRPC_CLIENT_AUTH", "REQUIRED") == "REQUIRED")` |

`GRPC_CLIENT_AUTH` is the one environment variable both stacks read to switch between the two phases
`verify.sh` demonstrates, without a rebuild:

- `NONE` — one-way TLS. The server presents its certificate; it never asks the client for one.
- `REQUIRED` (this example's default/steady state) — mutual TLS. A client without a certificate the
  server's trust store recognizes is rejected at the handshake, before `GetQuote`'s handler ever runs.

Quarkus's `client-auth` property also accepts `REQUEST` (ask for a certificate, accept the call either
way) — the three-value Vert.x `ClientAuth` enum; grpc-core's `require_client_auth` is a boolean, so the
Python side only ever has the two ends of that range.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files — same discipline as every prior
anchor. Each `Containerfile` builds with the **repo root** as its Docker build context (see
`compose.yaml`) so it can `COPY` the two proto files this service needs straight from
`contracts/proto/` at build time. See Ch7's README for the full local, non-container `mvn`/`uv` copy
instructions; the destinations are identical here, just under `examples/19-tls-mtls/`.

## On the wire

See the chapter's own "On the wire" section for the full set of `grpcurl` invocations and their exact
output across both phases and both stacks, including the three different error shapes a rejected call
can produce (`context deadline exceeded`, `EOF`, `remote error: tls: certificate required`) depending
on exactly where the handshake fails.

## Diagrams

Three paired figures in `assets/diagrams/` (generated with `scripts/generate_diagram.py`) back this
chapter: `19-tls-handshake-cert-chain` (one-way TLS — the client verifies the server, never the
reverse), `19-mtls-mutual-verification` (mTLS adds the second direction, side by side with plain TLS),
and `19-where-credentials-attach` (the compose topology: `certgen`'s one-shot run, the shared `certs`
volume, the host-bind export, and the server certificate's SAN list).

## Progression toward a real cluster

This example's cert bootstrap is Compose-local by design — a throwaway CA, a ten-year validity
window, a shell script. A Kubernetes deployment of the same two services would swap `certgen` for
[cert-manager](https://cert-manager.io/) issuing into mounted `Secret` volumes at the same file paths
this chapter's configuration already points at, and would swap the ten-year window for cert-manager's
own renewal schedule — neither change touches `RoutingServiceImpl`/`RoutingServiceServicer`, since the
application code only ever reads certificate files from disk. This book does not stand up that
migration; see the chapter's "Progression toward a real cluster" section for the full mapping.

---

*Verification status: <span class="status status--unverified">unverified</span>. `verify.sh` ran green
against both stacks on the authoring machine across repeated runs. See the chapter's own verification
footer for what a reader's own run should double-check.*
