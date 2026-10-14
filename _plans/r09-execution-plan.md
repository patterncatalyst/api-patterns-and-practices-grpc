---
title: "r09 Execution Plan (Phase 6a)"
layout: plan
render_with_liquid: false
---

# r09 Execution Plan — Part 9: Observability, Mesh & Load Balancing (Ch21 + Ch22)

Relay on branch `docs/r09-content`, mirroring `_plans/r08-execution-plan.md`. New content.
**ZERO contract change, no Wave 0.** First iteration with a **two-tier split**: Ch21 is a Compose
example CI-gated by `verify.sh`; Ch22 is a **cluster-tier** example run on **minikube by hand, NOT in
the Compose CI matrix** (`validate.py`'s `CLUSTER_TIER_DIRS` forbids a `verify.sh` in its dir).
Environment confirmed: `minikube`, `kubectl`, `istioctl`, `docker` on PATH — Ch22's demo is actually run.

## Scope
- **Ch21 — Observability** [H]: OTel tracing + metrics across the REST→gRPC seam (trace context in
  metadata), Prometheus/Grafana/Tempo, gRPC health. CI-gated Compose example.
- **Ch22 — Load balancing & service mesh** [H]: the L4 single-connection problem (a plain K8s Service
  pins every call to one pod over gRPC's one long-lived HTTP/2 connection), client-side LB (headless +
  round_robin) vs Istio/Envoy L7; mesh mTLS + retries/timeouts. Retires **risk #6**. Cluster-tier, minikube-run.

## Zero contract change (justified)
Observability rides beside the RPC (tracing/metrics in metadata; health = the library's
`grpc.health.v1.Health/Check`, not our proto). LB is deployment-level. Ch22 surfaces pod identity via a
response trailer `x-served-by: <HOSTNAME>` (metadata, outside the proto) + a server log. Honors the r06
lesson (never add an RPC to an implemented service). `git diff main -- contracts/` stays empty.

## Figures (≥2/chapter; concept-first)
- **Ch21:** `21-otel-trace-seam` (REST→gRPC→QuoteService one trace-id) · `21-trace-context-in-metadata`
  (W3C traceparent in HPACK headers; child span continues parent) · `21-observability-surfaces`
  (traces→Tempo, metrics→Prom, health→grpc.health.v1).
- **Ch22:** `22-grpc-lb-problem` (3 pods, one connection pins to pod A) · `22-lb-fixes-headless-and-mesh`
  (headless+round_robin vs Istio L7) · (opt) `22-l4-vs-l7-balancing`.

## Examples
### `examples/21-observability` (Compose, CI-GATED)
- gRPC 9210/9211; REST 8210/8211; project `ch21-observability`. Reuse the Ch10 RoutingService→QuoteService
  loopback + a minimal REST `POST /booking/quote` front, OTel-instrumented so one trace spans
  REST→gRPC→QuoteService. LGTM (`grafana/otel-lgtm:0.36.0`) REQUIRED here (drop the `observability`
  profile guard); publish Tempo 3200. Quarkus: quarkus-rest + quarkus-opentelemetry + micrometer-prometheus
  (`/q/metrics`) + built-in grpc health (confirm enable key via quarkus-agent). Python: FastAPI+uvicorn REST
  under `opentelemetry-instrument` + grpc otel + grpcio-health-checking + prometheus `/metrics`.
- **verify.sh (both stacks; example-local helpers, lib.sh untouched):** (1) functional — `POST /booking/quote`
  → correct quote (Ch10 semantics); (2) **HARD: trace-id continuity** — REST returns the trace-id; Routing
  and Quote handlers each log it; assert the SAME trace-id appears in BOTH handler logs (synchronous, no Tempo
  wait) → proves traceparent propagated through gRPC metadata; (3) SOFT: bounded-retry Tempo `/api/traces/<id>`
  shows spans from ≥2 services (loose, shielded by the 3-attempt wrapper); (4) metrics — scrape the app's own
  endpoint, assert a `grpc_server_*` metric count>0; (5) health — `grpc.health.v1.Health/Check` → SERVING.

### `examples/22-mesh-loadbalancing` (CLUSTER tier, NO verify.sh)
- `k8s/` — kustomize base of CORE resources only (kubeconform-strict-safe): Deployment (3 replicas of a
  minimal GetQuote server), a plain ClusterIP Service (pin demo), a headless Service (clusterIP: None, for
  round_robin), kustomization.yaml. This is what the CI `k8s-manifests` job validates.
- `istio/` — Istio CRs kept OUT of `k8s/` (unknown CRDs fail `kubeconform -strict`): PeerAuthentication
  (STRICT mTLS), DestinationRule (LB policy + outlier detection), VirtualService (retries/timeouts). minikube only.
- `scripts/` — `bootstrap.sh` (minikube start; `istioctl install` pinned profile; label ns for injection),
  `run-demo.sh` (deploy; pin demo on plain Service; switch to headless+round_robin; switch to Istio; capture),
  `teardown.sh`. All `bash -n` clean.
- `loadclient.py` — holds ONE channel, N calls, reads `x-served-by` trailer, tallies distinct pods (NOT
  grpcurl-per-call, which opens a channel per call and would HIDE the pin). Minimal GetQuote server image
  (one stack, Python for fast cold start; Quarkus noted) sets the `x-served-by: <HOSTNAME>` trailer + log.
- `expected-output.md` / README: recorded real runs — plain Service → all N from one pod (pin);
  headless+round_robin → spread across 3; Istio DestinationRule → spread across 3. Scaffold Istio via
  `lgtm-minikube-stack` (Istio only). NO verify.sh. Chapter footer: honest "run on minikube, not CI."

## Waves (parallel-safe, no Wave 0)
- **Wave A (parallel):** Ch21 executor (doc + compose example both stacks + verify.sh + 3 figures;
  re-verify quarkus health/metrics/otel keys via quarkus-agent); Ch22 executor (doc + cluster example +
  istio/ CRs + scripts + loadclient + server image + 2–3 figures; scaffold Istio via lgtm-minikube-stack;
  RUN the demo on minikube and paste real output). Forbidden to both: `contracts/`, `examples/_lib/lib.sh`,
  `_plans/*`, `coverage-matrix.md`, `_example_pages/index.md`, `_config.yml`.
- **Validation (Opus):** OTel accuracy (trace-id continuity really proves metadata propagation; real gRPC
  server metric; standard health service); LB accuracy (pin is real = one channel/one connection;
  headless+round_robin and Istio genuinely fan out; STRICT mTLS + retries/timeouts correct; single-channel-
  vs-grpcurl trap called out); the CI-gated-vs-minikube-run split stated honestly; voice 0 ban-tier;
  lgtm-idiomatic-review both stacks + K8s/kustomize/Istio.
- **Wrap (serialized):** per-chapter checkpoints; coverage Ch21→draft→verified after CI green, Ch22→a state
  reflecting minikube-run (not CI-verified); flip the `R2 minikube tier` coverage row; `_example_pages/index.md`;
  local gates; push; watch CI; r09 PR + merge.

## Acceptance
Contracts frozen (buf green; health via grpc.health.v1; pod identity via trailer); validate.py green incl.
**cluster-dir-no-verify** (Ch22 has NO verify.sh) + bash-syntax on all new *.sh; Ch21 verify.sh green in CI
(functional + trace-id continuity + metric count>0 + health SERVING + soft Tempo); `k8s-manifests` job green
(`kubectl kustomize examples/22-mesh-loadbalancing/k8s | kubeconform -strict`); Ch22 pin→fan-out demo run on
minikube and recorded (retires risk #6, satisfies acceptance #9); floor cleared; ≥2 figures/chapter;
"On the wire" last + "Decision"; 0 voice ban-tier; jekyll green.

## Risks
Tempo ingest lag → hard gate on trace-id continuity via synchronous logs, Tempo query soft/bounded ·
LGTM startup → pinned image + healthcheck + wait loop · metrics ingest → scrape app directly, not Mimir ·
minikube availability → confirmed present; Ch22 not CI-gated so a hiccup never reds the build; scripts
idempotent; recorded output honest · pod identity → `x-served-by` trailer (no proto) · single-channel demo →
real reused-channel client, not grpcurl · kubeconform chokes on Istio CRDs → Istio CRs in `istio/`, out of
`k8s/` · Istio install flakiness → pinned profile, idempotent bootstrap · stale quarkus keys → quarkus-agent ·
parallel shared-file hazard → contracts/_lib/plans/index/config off-limits, serialized wrap.
