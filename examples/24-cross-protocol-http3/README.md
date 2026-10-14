# Ch24 — Cross-protocol choices and HTTP/3

The reference both-stack implementation of a lean `shipping.routing.v1.RoutingService.GetQuote`
(the Ch7 formula, unchanged), a pinned `ghz` measured baseline against it over
native gRPC/HTTP2, and a completely separate, clearly-labeled HTTP/3-over-QUIC
transport probe against a pinned Caddy instance. The contract is unchanged
from every prior chapter:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`;
  only `GetQuote` is implemented here, the other four RPCs return
  `UNIMPLEMENTED`, same discipline as every prior example.
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Route`, `Leg`,
  `Location`, `Money` messages `GetQuote` uses.

## What this example does and does not claim about HTTP/3

grpc-java and grpcio — the two gRPC implementations behind every Quarkus and
Python example in this book — have **no native gRPC-over-HTTP/3 transport**
as of this writing. So:

- `quarkus` (host port **9240**) and `python` (host port **9241**) both speak
  gRPC the only way either stack can: **native gRPC over HTTP/2**. `verify.sh`
  treats correctness + a measured `ghz` baseline against these two servers as
  a **HARD, CI-gating** check.
- `caddy` (host port **8443**, published on both TCP and UDP) is a **separate,
  unrelated** service: a pinned Caddy instance serving one static JSON file
  over HTTPS. Caddy turns HTTP/3 on by default for any TLS site, so this is a
  real HTTP/3-over-QUIC endpoint for `python/app/h3_probe.py` (built on
  `aioquic`) to probe. `verify.sh` treats this probe's result as
  **capability-gated and non-fatal** — on success it logs a confirmed QUIC
  handshake + HTTP 200; on any failure (most commonly a sandboxed network
  blocking inter-container UDP) it logs a clear `SKIP` with a documented
  fallback and the script continues. **Neither this README nor `verify.sh`
  ever claims a gRPC-over-HTTP/3 measurement** — there is no gRPC call
  anywhere near the `caddy` service.

## Run it

```bash
cd examples/24-cross-protocol-http3
./verify.sh
```

This brings all three services up with `docker compose`, verifies `GetQuote`
on both stacks via `grpcurl`, runs `ghz` against `GetQuote` on each stack and
asserts loose bounds (zero errors, generous p99 ceiling, low rps floor), then
runs the HTTP/3 transport probe and logs its result either way — it never
fails the build over that last step. A real run on this book's dev box:

```
lib.sh: ok — quarkus quote.amount: '3001.25'
lib.sh: ok — quarkus route.id: 'rte_USNYC-NLRTM'
lib.sh: info — quarkus ghz (h2): errors=0 rps=1888.0997659832508 p99=0.012580479s
lib.sh: ok — quarkus ghz (h2) p99 latency vs generous ceiling: 0.012580479 < 1.5
lib.sh: ok — quarkus ghz (h2) throughput vs low floor: 1888.0997659832508 > 20
lib.sh: ok — python quote.amount: '3001.25'
lib.sh: ok — python route.id: 'rte_USNYC-NLRTM'
lib.sh: info — python ghz (h2): errors=0 rps=5117.610187947304 p99=0.004636686s
lib.sh: ok — python ghz (h2) p99 latency vs generous ceiling: 0.004636686 < 1.5
lib.sh: ok — python ghz (h2) throughput vs low floor: 5117.610187947304 > 20
lib.sh: ok — h3 transport confirmed: a real QUIC handshake completed and Caddy
          answered HTTP/3 with 200. This is the transport, not gRPC-over-HTTP/3.
PASS — Ch24 cross-protocol-http3: ...
```

To poke at it by hand instead:

```bash
docker compose up --build

# GetQuote (native gRPC, HTTP/2 — the only transport either stack has)
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC", "name": "New York"},
  "destination": {"unLocode": "NLRTM", "name": "Rotterdam"},
  "cargo": [{"weightKg": 1200.5, "description": "Palletized electronics", "cargoType": "GENERAL"}]
}' localhost:9240 shipping.routing.v1.RoutingService/GetQuote
# ... same call against localhost:9241 for the Python stack

# ghz: a real load-test run against GetQuote, fed the proto directly
# (no reflection support in ghz)
docker compose run --rm ghz --insecure \
  --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \
  --call shipping.routing.v1.RoutingService.GetQuote \
  -d '{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}' \
  -c 10 -n 300 -O json quarkus:9000

# an HTTP/3 transport probe against Caddy — not a gRPC call
docker compose run --rm --entrypoint python python -m app.h3_probe caddy 8443 --path /transport.json
# or, with an HTTP/3-capable curl build (check `curl --version` for HTTP3 first):
curl -k --http3-only https://localhost:8443/transport.json

docker compose down -v
```

## Caddy + aioquic: how the transport probe works

`caddy/Caddyfile` declares one site, `caddy:8443, localhost:8443`, with
`tls internal` — Caddy's own non-ACME issuer, which mints a fresh,
container-local self-signed CA and a leaf certificate for exactly those two
hostnames on every start. Naming both matters: `h3_probe.py` connects by the
compose network name (`caddy`), and the certificate has to carry that name as
a SAN for the TLS handshake to validate against; `localhost` is there so a
reader can also point a browser or `curl` at the published port from the
host. Caddy enables HTTP/3 automatically for any TLS site — no extra
directive, true since Caddy 2.6 — so a plain `file_server` block serving
`caddy/www/transport.json` is enough to give a QUIC client something real to
negotiate with.

`python/app/h3_probe.py` is that QUIC client, built on `aioquic` — used here
entirely independently of `grpcio`. It completes a QUIC handshake negotiating
the `h3` ALPN, sends one HTTP/3 GET, and checks for a completed handshake
plus a `200` status. Certificate verification is disabled
(`verify_mode=ssl.CERT_NONE`): Caddy's internal CA regenerates on every
start, and distributing it to the probe would add machinery that teaches
nothing new — Ch19/Ch20 already cover TLS trust chains and mutual
authentication in depth. This script is a transport probe, not a security
demo.

`verify.sh`'s `run_h3_probe` retries a few times (Caddy needs a moment to
mint its certificate and bind the UDP socket) but treats any failure after
that as a `SKIP`, never a build failure — some sandboxed CI networks and
corporate firewalls block inter-container UDP, which QUIC rides on, and that
is a property of the environment, not of this code.

## Pins

| Component | Pin | Re-check with |
|---|---|---|
| Quarkus | 3.40.1 | upstream release notes |
| `ubi10/openjdk-25` (build) | `1.24-16` | `skopeo list-tags docker://registry.access.redhat.com/ubi10/openjdk-25` |
| `ubi10/openjdk-25-runtime` | `1.24-16` | same |
| `ubi10/python-314-minimal` | `10.2-1791928506` | `skopeo list-tags docker://registry.access.redhat.com/ubi10/python-314-minimal` |
| `grpcio` / `grpcio-reflection` | `>=1.83,<2` | PyPI |
| `aioquic` | `>=1.6.1,<2` | PyPI (`https://pypi.org/pypi/aioquic/json`) |
| `ghz` | `ghcr.io/bojand/ghz:0.121.0` | `skopeo list-tags docker://ghcr.io/bojand/ghz` (ghcr-only; not on docker.io) |
| `caddy` | `docker.io/library/caddy:2.11.7` | `skopeo list-tags docker://docker.io/library/caddy` |

## Verification status

`verify.sh` ran green against both stacks on the authoring machine across
repeated runs — see the chapter's verification-status footer for the full
discussion of what was and wasn't confirmed, including the HTTP/3 probe's
non-fatal `SKIP` path.
