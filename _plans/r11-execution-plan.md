---
title: "r11 Execution Plan (Phase 6c)"
layout: plan
render_with_liquid: false
---

# r11 Execution Plan — Part 11: Testing & Debugging (Ch25 + Ch26)

Relay on branch `docs/r11-content`, mirroring `_plans/r10-execution-plan.md`. New content; both-stack
**Compose** examples, CI-gated. **ZERO contract change, no Wave 0, no cluster tier, no new proxy** — a
lighter iteration (testing/debugging are tooling + deliberate mis-calls, not contract or infra).

## Headline decisions
- **Zero contract change.** Reuse `RoutingService.GetQuote` + the already-declared unimplemented RPCs
  (`FindOptimalRoute`/`NegotiateRoute`) that a lean build leaves at `UNIMPLEMENTED`. `git diff main -- contracts/` empty.
- **Ch25 in-process test suites = HARD gate at image-build time.** `@QuarkusTest` + `@GrpcClient` runs via
  `mvn verify` (drop `-DskipTests`) in the Quarkus Containerfile build stage; Python `pytest` + `pytest-asyncio`
  (real in-process `grpc.aio` server fixture) in the Python build stage — a red test fails the image build →
  fails compose_up → fails verify.sh. verify.sh ALSO re-runs each suite one-shot to surface green in the log.
- **grpcui / Insomnia / Yaak = illustrative, never CI.** Deterministic stand-in = reflection-driven
  `grpcurl list` + `grpcurl describe` (asserted). UIs are named + screenshot-in-prose; reflection is the shared mechanism.
- **Ch26 reproduces every failure code deterministically, NO new infra.** TLS-handshake failure = a TLS-expecting
  grpcurl (omit `-plaintext`) against the plaintext server (no certgen/TLS server needed); cert-mismatch variant
  described in prose only.
- **channelz is honest + partial.** Python registers `grpc_channelz` (asserted); **quarkus-grpc has no channelz**
  (confirmed absent in 3.40.1) — Quarkus diagnosed via reflection + `GRPC_TRACE`, stated in prose + figure.
  `GRPC_TRACE`/`GRPC_VERBOSITY` dumps are illustrative (assert non-empty only).

## Re-verified (quarkus-agent, Quarkus 3.40.1)
`@QuarkusTest` + `@GrpcClient RoutingService` injection is the current test path; reflection is dev-only by
default so the container sets `quarkus.grpc.server.enable-reflection-service=true`; no channelz extension exists.
Python: `pytest`+`pytest-asyncio` in-process `grpc.aio` fixture (not `grpc_testing`, no aio support); register
`grpc_channelz` + `grpc_reflection` servicers.

## Figures (≥2/chapter; concept-first)
- **Ch25:** `25-grpc-test-pyramid` (unit/in-process → integration/verify.sh → load/ghz → manual CLI/UIs, with the
  CI-gated vs illustrative band) · `25-reflection-probe-landscape` (one reflection service feeding grpcurl + the UIs).
- **Ch26:** `26-debug-failure-modes` (UNIMPLEMENTED / DEADLINE_EXCEEDED / UNAVAILABLE / TLS-handshake as
  symptom→cause→fix) · `26-diagnosis-toolbox` (reflection / channelz[Python-only] / GRPC_TRACE — what each reveals).

## Examples
### `examples/25-testing-and-cli` (Compose, CI-GATED, both stacks)
- Ports 9250/9251, project `ch25-testing`. Lean GetQuote both stacks, reflection on, pinned ghz one-shot + opt-in LGTM.
- Test suites (the gate): Quarkus `@QuarkusTest`+`@GrpcClient` asserts GetQuote (3001.25/USD/route) — `mvn verify`
  in the build stage; Python `pytest` in-process `grpc.aio` fixture, same asserts — `pytest` in the build stage.
- **verify.sh (both stacks):** (1) GetQuote correct (semantic); (2) reflection `list` contains RoutingService +
  `describe` shows GetQuote (grpcui stand-in); (3) one-shot re-run of `mvn verify`/`pytest` → zero exit + pass
  marker; (4) ghz smoke (`ghcr.io/bojand/ghz:0.121.0`, fed the proto, LOOSE bounds, 3-attempt retry) — meets acceptance #11.

### `examples/26-debugging` (Compose, CI-GATED, both stacks)
- Ports 9260/9261, project `ch26-debugging`. Plaintext GetQuote both stacks (FindOptimalRoute/NegotiateRoute
  UNIMPLEMENTED); reflection on; Python registers grpc_channelz. No certgen/TLS/proxy.
- **verify.sh (both stacks) — each failure reproduced + asserted:** (1) UNIMPLEMENTED (call FindOptimalRoute);
  (2) DEADLINE_EXCEEDED (slow path + tight `-max-time`, Ch10 shape); (3) UNAVAILABLE (call a definitively-closed
  in-network port — refused, not timing-flaky); (4) TLS-handshake (grpcurl without `-plaintext` vs plaintext
  server → `assert_tls_rejected`). Diagnosis: reflection asserted both stacks; channelz
  `grpc.channelz.v1.Channelz/GetServers` asserted Python-only (Quarkus absence stated); `GRPC_TRACE` captured
  non-empty (illustrative).

## Waves (no Wave 0)
- **Wave A (parallel):** Ch25 executor (doc + example: lean GetQuote both stacks, @QuarkusTest+@GrpcClient suite,
  pytest in-process grpc.aio suite, build-stage test gating, reflection probes, pinned ghz, verify.sh, ≥2 figures
  incl. `25-grpc-test-pyramid`; re-confirm @GrpcClient/pytest-asyncio via quarkus-agent) · Ch26 executor (doc +
  example: lean GetQuote both stacks, grpc_channelz on Python, the four deliberate mis-calls, GRPC_TRACE capture,
  verify.sh, ≥2 figures incl. `26-debug-failure-modes`). Forbidden to both: `contracts/`, `examples/_lib/lib.sh`,
  `_plans/*`, `coverage-matrix.md`, `_example_pages/index.md`, `_config.yml`.
- **Validation (Opus):** test-suite reality (a seeded failing assertion must red the build); failure-repro honesty
  (UNIMPLEMENTED is a real unwired RPC; UNAVAILABLE deterministic; TLS-handshake a real transport failure);
  channelz honesty (Python-only, Quarkus absence stated); grpcui/UIs illustrative-not-CI; voice 0 ban-tier;
  lgtm-idiomatic-review both stacks; "On the wire" LAST + "Decision" present; callouts safe/warn/danger only.
- **Wrap (serialized):** per-chapter checkpoints; coverage T25/T26 (+ inventory) planned→draft→verified after CI
  green; `_example_pages/index.md` rows; local gates; push; watch CI; r11 PR + merge.

## Acceptance
Contract frozen (buf green); validate.py green (both Ch25/Ch26 Compose CI-gated, have verify.sh, not cluster-tier);
floor cleared; jekyll green; Ch25 verify.sh green both stacks (GetQuote + reflection list/describe + in-process
suites pass [build-stage gated] + ghz smoke loose — acceptance #11); Ch26 verify.sh green both stacks (UNIMPLEMENTED
+ DEADLINE_EXCEEDED + UNAVAILABLE + TLS-handshake each with expected code; reflection + Python channelz);
≥2 figures/chapter incl. reserved names; "On the wire" last + "Decision"; 0 voice ban-tier; prior examples
(Ch00–24) stay green; `_lib/`+`contracts/` byte-unchanged; unique ports (9250/51, 9260/61).
CI-gated: in-process suites, reflection probes, 4 failure repros, Python channelz, ghz smoke.
Illustrative (not CI): grpcui/Insomnia/Yaak, GRPC_TRACE dumps (non-empty only), quarkus channelz (absent), cert-mismatch TLS.

## Risks
In-process test determinism → build-stage mvn verify/pytest is the hard canary; seeded-failure smoke proves the gate ·
channelz across stacks → Python-only assertion, Quarkus absence stated · cold-channel UNAVAILABLE flake → closed
port (refused), not a startup race · TLS-handshake repro → TLS-client-vs-plaintext-server deterministic, assert on
transport text · ghz flakiness → loose bounds + pinned + 3-attempt retry · grpcui/UIs headless → scoped out, CLI
stand-in · pytest-asyncio/grpc.aio drift → re-confirm before authoring, build-stage run is canary · Quarkus
reflection off in container → enable-reflection-service=true · parallel shared-file hazard → unique ports/projects,
example-local helpers, frozen _lib/contracts, serialized wrap.
