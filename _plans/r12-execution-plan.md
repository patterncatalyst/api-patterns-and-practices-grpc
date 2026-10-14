---
title: "r12 Execution Plan (Phase 7)"
layout: plan
render_with_liquid: false
---

# r12 Execution Plan — Part 12: Running It & the Final Project (Ch27 + Appendix A)

Relay on `docs/r12-content`, mirroring `_plans/r09-execution-plan.md` (two-tier) + `_plans/r11-execution-plan.md`.
The final, heaviest content iteration — integrates the whole book across **three tiers**. **ZERO contract
change, no Wave 0.** Naming: the **Final Project**, never "capstone", in all reader-facing text; reserved
figure `27-final-project-architecture`. Env confirmed: `minikube`/`kubectl`/`istioctl`/`docker` + **`crc` 2.64.0**.

## Three-tier split
1. **Ch27 Compose — CI-gated.** `examples/27-complete-project/` with a top-level `verify.sh` (auto-discovered).
   Asserts the full booking→route→track flow, all four RPC modes, mTLS + JWT enforcement, trace-id continuity,
   ghz smoke — both stacks.
2. **Ch27 minikube — run by hand, NOT CI.** `k8s/` (kustomize) + `istio/` + `scripts/{bootstrap,run-demo,teardown}.sh`
   + loadclient, nested INSIDE `examples/27-complete-project/`. Scripts MUST NOT be named `verify.sh` (the
   top-level verify.sh is the sole CI entrypoint; the `examples/*/verify.sh` glob is one level deep). Reuses the
   Ch22 LB fix (headless+round_robin / Istio). Recorded output + honest footer.
3. **Appendix A CRC — cluster-tier, run by hand.** `examples/99-appendix-a-openshift-crc/` is in
   `CLUSTER_TIER_DIRS` → NO `verify.sh` at any depth. Scaffold via `lgtm-crc`: helm chart (restricted-v2, edge-TLS
   Routes), scripts (crc start/install_operator pinned-CSV OSSM+OTel/in-cluster S2I build/deploy/teardown), OSSM
   CRs (STRICT mTLS + canary), Route manifests (h2c/edge/passthrough), evidence capture w/ secret-scrub. Recorded
   output + honest footer. CI covers it via the existing `k8s-manifests` helm lint+template+kubeconform step.

## Zero contract change
All RPCs already declared (GetQuote unary, NegotiateRoute bidi, WatchShipment server-stream, ReportPositions
client-stream, Sync bidi, QuoteService downstream). The final project IMPLEMENTS them together for the first time
(some were UNIMPLEMENTED in lean builds). r06 lesson honored. `git diff main -- contracts/` empty; buf green.

## Four CI-gated RPC modes
Unary GetQuote (via REST front → QuoteService) · server-stream WatchShipment (count+ordered states, Ch8) ·
client-stream ReportPositions (accepted_count, Ch9) · bidi NegotiateRoute. (TrackingService.Sync illustrative/optional.)

## Figures (≥2/chapter; concept-first)
- **Ch27:** `27-final-project-architecture` (whole system: REST front → Routing[GetQuote/NegotiateRoute] → Quote;
  Tracking[WatchShipment/ReportPositions]; mTLS+JWT; OTel→LGTM; buf+ghz frame) · `27-booking-route-track-flow`
  (the asserted sequence through the 4 modes, traceparent threaded) · `27-three-tier-deploy` (Compose→minikube→CRC,
  each with its traced call + CI-gated-vs-run-by-hand band) · (opt) `27-decision-axes-mapped`.
- **Appendix A:** `A-crc-grpc-routes` (h2c vs edge vs passthrough for gRPC/HTTP-2) · `A-ossm-strict-mtls-canary`
  (PeerAuthentication STRICT + weighted canary) · (opt) `A-crc-incluster-build`.

## Examples
### `examples/27-complete-project` (Compose, CI-GATED, both stacks)
- Ports 9270/9271 gRPC, 8270/8271 REST, Tempo 3200; project `ch27-final-project`. Repo-root build; each stack
  serves Routing+Quote+Tracking+health behind a REST booking front, over mTLS (reuse 19 certgen), JWT interceptor
  +per-method authz (reuse 20 + mint_token), OTel one-trace REST→gRPC→Quote (reuse 21 trace-id continuity), LGTM
  always-on (grafana/otel-lgtm:0.36.0, curl healthcheck).
- **verify.sh (both stacks; example-local helpers, _lib frozen):** (1) full flow `POST /booking/quote` → correct
  Money/route + traceId; (2) four RPC modes each asserted (unary fields; WatchShipment count/order; ReportPositions
  accepted_count; NegotiateRoute bidi pair); (3) **mTLS enforced** (no-cert/plaintext → refused, assert_tls_rejected);
  (4) **JWT enforced** (missing→UNAUTHENTICATED; wrong-scope→PERMISSION_DENIED); (5) **trace-id continuity** (hard,
  via handler logs); (6) SOFT Tempo multi-span; (7) ghz smoke (pinned ghcr.io/bojand/ghz:0.121.0, loose, 3-retry).
- **minikube subtree (run by hand):** k8s/ kustomize (3 replicas, plain+headless Service), istio/ CRs (OUT of k8s/),
  scripts/{bootstrap,run-demo,teardown}.sh (Ch22 shape, `minikube image load`), loadclient (one channel, x-served-by
  tally). Full flow over the mesh + LB fix + a traced call. expected-output.md + honest footer.
- Ch27 executor adds a `k8s-manifests` step for `examples/27-complete-project/k8s` (kustomize | kubeconform -strict)
  to `.github/workflows/contracts.yml` — Ch27 executor is the ONLY one touching contracts.yml.

### `examples/99-appendix-a-openshift-crc` (CLUSTER tier, NO verify.sh anywhere)
- Scaffold via `lgtm-crc`: helm/ (restricted-v2, edge-TLS Routes — CI helm lint+template+kubeconform covers it),
  scripts/ (bootstrap crc start + pinned-CSV OSSM/OTel operators + in-cluster S2I build + deploy; teardown removes
  operators/CRDs/namespaces then crc stop), OSSM CRs (STRICT PeerAuthentication + canary DestinationRule/VirtualService),
  Route manifests (h2c/edge/passthrough), evidence capture + secret-scrub. Run on CRC by hand: a traced GetQuote
  through an HTTP/2 Route + the STRICT-mTLS canary. expected-output.md + honest "run on CRC, not CI" footer.

## Waves (author parallel-safe; SERIALIZE live runs — Compose/minikube/CRC can't coexist)
- **Executed SEQUENTIALLY by the orchestrator** (resource contention): Ch27 executor first (doc + Compose example +
  verify.sh + minikube subtree + figures + the contracts.yml kustomize step; re-confirm quarkus TLS/JWT/OTel/health
  keys via quarkus-agent; run Compose verify.sh green both stacks, then run the minikube tier, record); THEN Appendix A
  executor (doc + helm/scripts/OSSM/Routes + figures via lgtm-crc; run on CRC, record). Forbidden to both: `contracts/`,
  `examples/_lib/lib.sh`, `_plans/*`, `coverage-matrix.md`, `_example_pages/index.md`, `_config.yml` (contracts.yml Ch27-only).
- **Validation (Opus):** integration honesty (seeded wrong field reds the gate; mTLS refusal real; JWT codes real;
  trace-id continuity real; four modes genuinely exercised); three-tier CI-vs-run-by-hand split honest; Decision defends
  all five axes; "On the wire" LAST; callouts safe/warn/danger; 0 voice ban-tier; idiomatic review both stacks + K8s/Helm/OSSM.
- **Wrap (serialized):** per-chapter checkpoints; coverage T27 + Appendix A + R3 CRC tier rows → verified/run-on-CRC after
  CI green; `_example_pages/index.md` rows; local gates; push; watch CI; r12 PR + merge.

## Acceptance
CI-gated: Ch27 Compose verify.sh green both stacks (full flow + 4 modes + mTLS + JWT + trace-id + ghz); validate.py
green incl. cluster-dir-no-verify (Appendix A no verify.sh; Ch27 minikube scripts not named verify.sh) + bash-syntax;
buf green (contract frozen); k8s-manifests green (Ch27 kustomize + Appendix A helm); jekyll green; ≥2 figures/chapter
incl. reserved names; "On the wire" last + "Decision" (defends 5 axes); floor cleared; 0 voice ban-tier; prior Ch00–26
green; _lib/+contracts/ byte-unchanged; ports 9270/9271.
Run-by-hand (recorded, honest footers): Ch27 minikube (LB fix + full flow + traced call); Appendix A CRC (in-cluster
build, gRPC over HTTP/2 Route, OSSM STRICT mTLS + canary, traced call). Together satisfy acceptance #9 (all three tiers,
each a traced call) + re-show risk #6 solved.

## Risks
Integration CI weight/flake (top) → reuse only proven deterministic patterns (21 trace-id-logs, 19 cert+assert_tls_rejected,
20 mint_token+header codes, 8/9 stream asserts, 18 pinned ghz), Tempo soft, ghz loose+pinned+3-retry, seeded-wrong-field smoke ·
mTLS+JWT layered → front door holds cert+token, negatives are targeted probes · startup budget → wait_for_lgtm + healthchecks ·
minikube contention w/ Ch22 → serialized, idempotent, distinct/reused profile, not CI-gated · CRC very heavy → serialized runs,
tear down between, lgtm-crc sizing + crc-admin context · cluster-dir-no-verify trap → minikube scripts not verify.sh; Appendix A
none at any depth · k8s-manifests needs Ch27 kustomize step → Ch27 executor adds it (contracts.yml Ch27-only) · gRPC-over-Route →
h2c/passthrough not plain edge; figure + recorded call + lint · shared-file hazard → frozen set, serialized wrap.
