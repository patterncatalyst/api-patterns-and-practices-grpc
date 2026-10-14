---
title: "r10 Execution Plan (Phase 6b)"
layout: plan
render_with_liquid: false
---

# r10 Execution Plan — Part 10: Browsers, Transcoding & Cross-Protocol (Ch23 + Ch24)

Relay on branch `docs/r10-content`, mirroring `_plans/r09-execution-plan.md`. New content; both-stack
Compose examples, CI-gated. **ZERO contract change, no Wave 0.**

## Headline decisions
- **Zero contract change.** Both chapters reuse `shipping.routing.v1.RoutingService.GetQuote` (+ the Ch21
  QuoteService loopback + REST booking front) unchanged. `git diff main -- contracts/` must be empty.
- **Ch23 transcoder = Envoy `grpc_json_transcoder` (`auto_mapping: true`) + `grpc_web` filters**, fed a
  descriptor built from the FROZEN proto at image-build time. **No `google.api.http` annotation** — it would
  force `import google/api/annotations.proto` into the shared routing.proto + a googleapis buf dep, breaking
  every existing example's protoc build (rejected for that reason; the clean REST URL it buys is shown in
  prose as the not-wired alternative — a teaching point). JSON edge lives at
  `POST /shipping.routing.v1.RoutingService/GetQuote`; `convert_grpc_status: true` maps gRPC status → HTTP.
- **Ch24: h2 is the HARD CI gate** (correctness + a loose measured ghz baseline, both stacks); **HTTP/3 is a
  capability-gated, non-fatal TRANSPORT demo** (Caddy + aioquic over QUIC), explicitly "HTTP/3 the transport,
  NOT gRPC-over-HTTP/3" (grpc-java/grpcio have no native gRPC-over-h3 today); cross-protocol = prose + figures.

## Figures (≥2/chapter; concept-first)
- **Ch23:** `23-grpc-web-transcoding-seam` (browser+JSON client → Envoy grpc_web/transcoder → native gRPC;
  REST shim calls GetQuote natively; all converge on one RPC) · `23-three-ways-to-reach-grpc` (REST shim vs
  JSON transcoder vs grpc-web) · (opt) `23-grpc-web-framing`.
- **Ch24:** `24-http3-crossprotocol` (h2-over-TCP HOL blocking vs h3-over-QUIC independent streams/0-RTT/
  migration) · `24-protocol-decision-matrix` (gRPC vs REST-h2 vs WebSockets for streaming) · (opt)
  `24-h2-everywhere-h3-where-it-stands`.

## Examples
### `examples/23-grpc-web-transcoding` (Compose, CI-GATED, both stacks)
- Ports: app gRPC 9230/9231; REST 8230/8231; Envoy listeners 10230 (quarkus) / 10231 (python). Project `ch23-grpc-web`.
- App = the Ch21 app reused (RoutingService+QuoteService loopback + REST `booking/quote` front), frozen proto,
  repo-root COPY. LGTM opt-in (profile) here. One Envoy per stack: multi-stage image — stage 1 builds a
  descriptor `buf build proto -o /descriptor.binpb` (MUST include imports), stage 2 pinned
  `envoyproxy/envoy:<tag>` (skopeo re-check note) + static envoy.yaml with filter chain
  grpc_web → grpc_json_transcoder(proto_descriptor, services:[RoutingService], auto_mapping, convert_grpc_status)
  → router → cluster app:9000 (http2).
- grpc-web client = `grpcweb_client.py` (reuses python app stubs): serialize GetQuoteRequest, prepend the
  5-byte grpc-web frame, POST `application/grpc-web+proto` to Envoy, strip frame, deserialize, print JSON.
  (Real browser JS client = illustrative snippet only.)
- **verify.sh (both stacks; example-local helpers):** (1) native gRPC GetQuote correct; (2) REST shim
  `/booking/quote` correct; (3) **JSON edge** `curl POST :10230/shipping.routing.v1.RoutingService/GetQuote`
  (application/json) → same quote; (4) **grpc-web** via grpcweb_client → same quote; (5) opt non-fatal
  malformed-JSON → HTTP 4xx via convert_grpc_status. Retires risk #7.

### `examples/24-cross-protocol-http3` (Compose, CI-GATED for h2; h3 non-fatal; both stacks)
- Ports: app gRPC 9240/9241; Caddy h3 8443 (UDP+TCP); ghz one-shot. Project `ch24-cross-protocol`.
- App = lean GetQuote server both stacks (Ch18 build). Pinned ghz `ghcr.io/bojand/ghz:0.121.0` one-shot for
  the measured h2 baseline. Pinned `caddy:<ver>` serving HTTPS (h3/QUIC on by default) + `h3_probe.py`
  (aioquic, pinned) over QUIC on the compose network.
- **verify.sh (both stacks):** (1) HARD h2 GetQuote correct everywhere; (2) HARD measured h2 ghz baseline —
  loose bounds only (errors==0, generous p99, rps floor; 3-attempt wrapper); (3) SOFT/capability-gated h3
  transport probe → QUIC handshake + 200 ("HTTP/3 transport, NOT gRPC-over-h3"); non-fatal with documented
  fallback (SKIP, don't red the build). Never asserts a gRPC-over-h3 measurement. Retires risk #8.

## Waves (no Wave 0)
- **Wave A (parallel):** Ch23 executor (doc + example: both app stacks reusing Ch21, per-stack Envoy image +
  envoy.yaml + descriptor stage, grpcweb_client, verify.sh, ≥2 figures incl. `23-grpc-web-transcoding-seam`;
  re-verify any `quarkus.grpc.server.grpc-web` prose via quarkus-agent); Ch24 executor (doc + example: lean
  GetQuote both stacks, pinned ghz, Caddy+Caddyfile, aioquic h3_probe, verify.sh, ≥2 figures incl.
  `24-http3-crossprotocol`). Forbidden to both: `contracts/`, `examples/_lib/lib.sh`, `_plans/*`,
  `coverage-matrix.md`, `_example_pages/index.md`, `_config.yml`.
- **Validation (Opus):** transcoding accuracy (auto_mapping real, descriptor includes imports, convert_grpc_status,
  zero contract change); grpc-web framing correctness + "browser illustrative / framed client is the CI stand-in"
  honest; Ch24 honesty audit (h2 hard gate; h3 transport-only, non-fatal; no gRPC-over-h3 claim; grpc-java/grpcio
  h3 status accurate as of Jan 2026); voice 0 ban-tier; lgtm-idiomatic-review both stacks + Envoy/Caddy config;
  "On the wire" LAST + "Decision" present; callouts safe/warn/danger only.
- **Wrap (serialized):** per-chapter checkpoints; coverage T23/T24 (+ inventory 23/24) planned→draft→verified
  after CI green; `_example_pages/index.md` rows; local gates; push; watch CI; r10 PR + merge.

## Acceptance
Contract frozen (buf green; no annotation/dep); validate.py green (diagram-pairs, bash-syntax, coverage; both
Ch23/Ch24 are Compose CI-gated, NOT cluster-tier); Ch23 verify.sh green both stacks (native + REST shim + JSON
edge + grpc-web); Ch24 verify.sh green both stacks (h2 correct + ghz loose baseline; h3 transport probe
non-fatal, labeled transport-only); floor cleared; ≥2 figures/chapter incl. reserved names; "On the wire" last +
"Decision"; 0 voice ban-tier; prior examples (Ch00–22) stay green; `_lib/`+`contracts/` byte-unchanged;
unique ports (9230/31, 9240/41, Envoy 10230/31, Caddy 8443) + projects (`ch23-grpc-web`, `ch24-cross-protocol`);
jekyll green.

## Risks
Transcoder fiddliness (#7) → descriptor built --include_imports, baked in Envoy image; JSON-edge assertion is
the canary · grpc-web framing → grpcweb_client.py (correct 5-byte prefix+trailer), not bash · h3/QUIC in CI (#8)
→ aioquic↔Caddy intra-host UDP, non-fatal fallback; h2 gate independent · over-claiming h3 → honesty audit;
banner/prose/figure all say transport-only; no h3 gRPC assertion · proto-annotation breakage → sidestepped
(auto_mapping, no dep); git diff gate · image pins (Envoy/Caddy/ghz/buf) → skopeo re-check notes · parallel
shared-file hazard → unique ports/projects, example-local helpers, serialized wrap.
