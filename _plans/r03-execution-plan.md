---
title: "r03 Execution Plan (Phase 3)"
layout: plan
render_with_liquid: false
---

# r03 Execution Plan — Phase 3 content (Ch6–Ch9)

Relay on branch `docs/r03-content`, mirroring `_plans/r02-execution-plan.md`. Standing
approval: run waves without gating. Verification unchanged: hands-on examples run both
stacks in containers; `verify.sh` asserts response field semantics via grpcurl
(reflection), not just an OK status. The shared harness `examples/_lib/lib.sh` now carries
streaming helpers: `grpc_client_stream` (client/bidi), `json_stream_count`,
`json_stream_field` (server/bidi) — this is the iteration that uses them.

## Scope (from `_plans/iteration-plan.md`)
- **Part 3 — HTTP/2 & the four RPC types.** Ch6 HTTP/2 foundation & why gRPC is fast
  [C + measured H]; Ch7 unary RPCs & the generated code [H]; Ch8 server-streaming [H];
  Ch9 client-streaming & bidirectional [H].

## Depth standard
2,000–2,500 words prose + ≥1 paired SVG+.excalidraw figure. Hands-on chapters end with an
**"On the wire"** box (the grpcurl observation the `verify.sh` encodes). Concept-bearing
chapters close with a **"Decision"** callout keyed to the Ch2 five-axis framework. Voice:
`lgtm-professional-voice` 0 ban-tier. Emphasis boxes light fill (`accent`), never dark.

## Figures (paired svg+excalidraw via `scripts/generate_diagram.py`)
`06-http2-multiplexing` · `07-unary-stub-to-stub` · `08-server-streaming` · `09-client-bidi-streaming`.

## Examples (UNIQUE host ports + compose project names)
- `examples/06-http2-foundation` — **docker-free** "measured H": serialize the same
  `GetQuoteResponse` as protobuf vs proto3-JSON and assert the binary payload is smaller;
  hand-decode a response on the wire (like Ch3). verify runs the size comparison + decode.
- `examples/07-unary-rpcs` — ports 9070/9071, project `ch07-unary`. Both stacks serve
  `RoutingService.GetQuote`; the example demonstrates channel/stub REUSE vs channel-per-call
  (blocking/Mutiny on Quarkus, sync vs `grpc.aio` on Python). verify asserts the unary
  response + that a reused channel answers repeated calls.
- `examples/08-server-streaming` — ports 9080/9081, project `ch08-sstream`. Both stacks serve
  `TrackingService.WatchShipment` emitting an ordered sequence of `TrackingEvent`s for a
  booking. verify uses `json_stream_count` / `json_stream_field` to assert the message COUNT
  and ORDER (and completion).
- `examples/09-client-and-bidi-streaming` — ports 9090/9091, project `ch09-cbstream`. Both
  stacks serve `TrackingService.ReportPositions` (client-stream → one `ReportPositionsResponse`
  with `accepted_count`) and `RoutingService.NegotiateRoute` (bidi: proposal→counter loop).
  verify uses `grpc_client_stream` to send N requests and assert the folded count + the bidi
  counter responses.

Quarkus: re-verify current `quarkus-grpc` streaming APIs via the quarkus-agent MCP — Mutiny
`Multi<Response> m(Request)` for server-streaming, `Uni<Response> m(Multi<Request>)` for
client-streaming, `Multi<Response> m(Multi<Request>)` for bidi. Python: `grpc.aio` async
generators (`async def` + `yield`) for streams. All 5 RoutingService / 3 TrackingService RPCs
must be implemented per service (real ones real, others `UNIMPLEMENTED`). Proven template:
`examples/05-contract-first`. Containerfiles carry the aether named-lock + wagon retry flags.

## Waves
1. **Wave A (parallel):** Ch6 (docker-free) + Ch7 (one docker build). Self-contained chapters
   (prose + figure + example built & `verify.sh` green locally). Executors write files only —
   no git; do NOT touch `_plans/*`, `coverage-matrix.md`, `_example_pages/index.md`, `examples/_lib/`.
2. **Wave B (parallel):** Ch8 + Ch9 (two docker builds; distinct ports). Same rules.
3. **Validation (Opus):** adversarial accuracy pass (HTTP/2, streaming semantics,
   quarkus-grpc), `lgtm-professional-voice` (0 ban-tier), `lgtm-idiomatic-review` on example code.
4. **Wrap:** per-chapter checkpoint commits; coverage rows Ch6–9 → draft, flip → verified
   after CI examples matrix green; update `_example_pages/index.md`; local gates (validate.py +
   wordcount GATE + buf + jekyll); push; watch CI; open r03 PR + merge.

## Acceptance
2,000–2,500 words/chapter + ≥1 figure; 0 voice ban-tier; validate.py + wordcount GATE + buf +
jekyll green; each hands-on example both-stack `verify.sh` green in CI (Ch8 asserts stream
count+order; Ch9 asserts client-stream fold + bidi counters); coverage rows truthful; every
hands-on chapter has an "On the wire" box matching its verify.sh.
