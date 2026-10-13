---
title: "r07 Execution Plan (Phase 5a)"
layout: plan
render_with_liquid: false
---

# r07 Execution Plan — Part 7: Streaming at Scale & Performance (Ch17–Ch18)

Relay on branch `docs/r07-content`, mirroring `_plans/r06-execution-plan.md`. New content;
both-stack examples verified in CI. **Zero contract change** — reuse existing RPCs (the r06
lesson: adding an RPC to an already-implemented service is wire-safe but source-breaking under
quarkus-grpc's abstract interface). No Wave 0.

## Scope
- **Ch17 — Streaming deep-dive** [H]: flow control & backpressure, HTTP/2 window dynamics,
  reactive backpressure (Mutiny `Multi` demand) vs async-generator pull, slow-consumer handling,
  keepalive on long-lived streams. Reuses `TrackingService.WatchShipment`.
- **Ch18 — Performance & tuning** [H]: channel/stub **reuse** (the #1 footgun), keepalive,
  max-message-size, gzip compression, connection pooling; benchmarking with **ghz**. Reuses
  `RoutingService.GetQuote` (fast unary) + `ListRoutes` (large payload).

## Figures (≥2/chapter; concept-first; generate_diagram.py, amber, ASCII arrows)
- **Ch17:** `17-http2-flow-control-window` · `17-slow-consumer-backpressure` (demand-paced vs eager/buffered) · `17-keepalive-quiet-stream`.
- **Ch18:** `18-channel-reuse-before-after` · `18-performance-levers` (keepalive/max-size/gzip/pooling) · `18-compression-size-tradeoff`.

## Examples
- `examples/17-streaming-at-scale` — ports 9170/9171, project `ch17-streaming`. WatchShipment as a
  DEMAND-DRIVEN feed (Quarkus `Multi` generator producing on demand; Python async generator),
  ~150ms pacing, each event stamped with server production wall-clock (`event.at`) + `note=seq=<i>`.
  Modes via `booking_id` (demo-only selector, documented): `bkg_demo` (6-event demand feed),
  `bkg_eager` (pre-materialized, all stamped t≈0), `bkg_quiet` (2 events, ~2s gap, final event).
  Server keepalive configured both stacks. Bundled `python/app/slow_consumer.py` (read, sleep ~300ms,
  read) run via `docker compose run` against BOTH servers.
  **verify.sh (both stacks):** (1) count=6 + order + fields (json_stream_count/field); (2) incremental
  delivery — whole-stream wall-clock ≥ loose floor (~0.6s); (3) **slow-consumer backpressure** — against
  `bkg_demo` server-stamped `at` deltas ≥ ~200ms, against `bkg_eager` deltas ≈ 0; relative gate
  `eager_spread * K < backpressure_spread` (K≈3, the Ch15 shape); (4) keepalive quiet stream delivers
  the post-gap event + elapsed ≥ ~2s; (5) ReportPositions/Sync → UNIMPLEMENTED. HTTP/2 window numbers +
  keepalive-past-proxy-reaping are ILLUSTRATIVE (prose/figure/On-the-wire), not gated.
- `examples/18-performance-tuning` — ports 9180/9181, project `ch18-performance`. GetQuote + ListRoutes
  tuned: keepalive, raised max-inbound-message-size, gzip, pooling (prose). ListRoutes returns a
  deterministic LARGE page (>4MB via padded data). Bundled clients in the Python image:
  `footgun_client.py` (new channel per call), `pooled_client.py` (one reused channel), gzip + keepalive
  helpers; run via `docker compose run`.
  **verify.sh (both stacks):** (1) GetQuote/ListRoutes correctness; (2) **channel-reuse before/after** —
  `footgun_total > pooled_total * FACTOR` (loose ~2–3×); (3) max-message-size — default cap →
  RESOURCE_EXHAUSTED, raised `-max-msg-sz 8388608` → success + correct count; (4) gzip functional
  (identical payload); (5) keepalive — reused channel survives an idle gap; (6) **ghz loose bounds**.
  **ghz:** PIN image (e.g. `bojand/ghz:0.120.0`, with a re-check note), run on the compose network,
  fed `--proto contracts/proto/.../routing.proto --import-paths contracts/proto` (no reflection),
  `-O json`; assert errors==0, p99 < generous ceiling, rps > low floor — never tight absolutes.
  Covered by contracts.yml's existing 3-attempt verify retry (no CI-YAML change).

## Waves (no Wave 0)
- **Wave A (parallel):** Ch17 executor (doc + example + slow_consumer + 3 figures); Ch18 executor
  (doc + example + footgun/pooled/gzip/keepalive clients + ghz + 3 figures). Forbidden to both:
  `contracts/`, `examples/_lib/lib.sh` (verify.sh-local helpers only), `_plans/*`, `coverage-matrix.md`,
  `_example_pages/index.md`, `_config.yml`. Re-verify quarkus-grpc keepalive/compression/max-size/Multi
  keys on Java 25 via quarkus-agent MCP before authoring.
- **Validation (Opus):** flow-control/backpressure/keepalive accuracy; perf accuracy (channel reuse,
  compression tradeoff, max-size/RESOURCE_EXHAUSTED, ghz); the asserted-vs-illustrative split is honest;
  voice 0 ban-tier; lgtm-idiomatic-review both stacks.
- **Wrap:** per-chapter checkpoints; coverage Ch17/Ch18 → draft → verified after CI green;
  `_example_pages/index.md`; local gates; push; watch CI; r07 PR + merge.

## Acceptance
Zero contract change (`git diff main -- contracts/` empty; buf green); floor cleared; ≥2 figures/chapter;
validate.py + jekyll green; Ch17 verify.sh green (count/order, incremental, backpressure relative gate,
keepalive quiet stream); Ch18 verify.sh green (correctness, channel-reuse before/after, max-size
RESOURCE_EXHAUSTED vs raised, gzip functional, keepalive survives idle, ghz loose bounds); ghz pinned +
fed-proto + loose + retried; ports 9170/71 + 9180/81; "On the wire" + "Decision" per chapter; 0 voice
ban-tier; all prior examples (Ch00–16) stay green; coverage truthful.

## Risks
Backpressure flakiness (#5) → gate on server-stamped timestamps + relative eager*K<backpressure + lower-bound
incremental; real bundled slow consumer, not throttled grpcurl · ghz flakiness (#10) → loose/relative +
pinned + fed-proto + 3-attempt retry · window/keepalive-reaping not directly assertable → illustrative only ·
stale quarkus-grpc keys → re-verify via quarkus-agent · >4MB payload determinism → fixed padded data ·
bundled-client stubs → generated at image build, run via compose run · parallel shared-file hazard → contracts/_lib/plans off-limits.
