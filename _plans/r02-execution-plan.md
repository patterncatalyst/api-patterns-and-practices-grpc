---
title: "r02 Execution Plan (Phase 2)"
layout: plan
render_with_liquid: false
---

# r02 Execution Plan — Phase 2 content (Ch0–Ch5)

Relay on branch `docs/r02-content`, mirroring the REST site's proven phase pattern.
Standing approval: run waves without gating between them. Verification unchanged:
hands-on examples run both stacks in containers; `verify.sh` asserts **response field
semantics** against the proto via grpcurl (reflection), not just an OK status. The Ch5
anchor example already exists and is CI-green (r01); Ch5 here is prose only.

## Scope (from `_plans/iteration-plan.md`)
- **Part 0 — Prerequisites & the Lab:** Ch0 prerequisites & the lab [H-setup].
- **Part 1 — Why gRPC, and the decision lens:** Ch1 From REST to RPC [C]; Ch2 the gRPC decision framework [C].
- **Part 2 — Protocol Buffers: the contract language:** Ch3 Protobuf in depth [C + small H];
  Ch4 well-known types & JSON mapping [H]; Ch5 contract-first with Buf [H] (anchor — example done r01).

## Depth standard (every chapter)
2,000–2,500 words of prose (excl. code listings, captions, command output) + **≥1 paired
SVG+.excalidraw diagram**. Hands-on chapters end with an **"On the wire"** box (the reader-run
grpcurl/buf observation that the `verify.sh` encodes). Concept chapters close with a **"Decision"**
callout keyed to the Ch2 five-axis framework. Recurring **"REST seam"** note where a concept
touches the REST→gRPC boundary. Voice: run `lgtm-professional-voice`; 0 ban-tier.

## Figures (paired svg+excalidraw via `scripts/generate_diagram.py`; one per chapter)
`00-lab-topology` · `01-three-paradigms` · `02-decision-framework` (reused later) ·
`03-protobuf-anatomy` · `04-wellknown-json-mapping` · `05-contract-first-buf-flow`.
Emphasis boxes: light fill + dark text (`accent` = honey wash) — never dark/ink boxes.

## Examples (hands-on; UNIQUE host ports + compose project names to avoid collisions)
- `examples/00-prerequisites` — ports 9000/9001, project `ch00-prereq`. Minimal both-stack gRPC
  skeleton: a stub `RoutingService.GetQuote` returning a canned quote + reflection/health; compose
  with opt-in `observability` profile. verify asserts the server answers over reflection + a canned field.
- `examples/03-protobuf` — docker-free "small H": `buf build` the contract + a Python round-trip
  (serialize→bytes→parse) asserting a `Booking`/`Money` survives the wire. verify runs buf + the round-trip.
- `examples/04-well-known-types` — ports 9007/9008, project `ch04-wkt`. Both stacks: a method using
  `Timestamp`/`FieldMask` + Money-as-decimal-string; verify asserts the proto3↔JSON mapping (camelCase,
  Timestamp RFC3339, Money string) is exact on both stacks.
- Ch5 reuses `examples/05-contract-first` (already CI-green).

Quarkus code: re-verify against **current** `quarkus-grpc` via the quarkus-agent MCP; the proven
template is `examples/05-contract-first/quarkus` (needs `<packaging>quarkus</packaging>`; all proto
RPCs implemented; `quarkus.grpc.server.enable-reflection-service=true`).

## Waves
1. **Wave 1 (parallel, no docker):** Ch1, Ch2, Ch3 (+ docker-free buf/round-trip check), Ch5 (prose
   for the existing anchor). Each: prose to depth + its paired figure + callouts. Executors write files
   only — no git, and do NOT touch `_plans/*`, `_plans/coverage-matrix.md`, or `_example_pages/index.md`.
2. **Wave 2 (sequential docker builds, to avoid thrash):** Ch0 example+prose, then Ch4 example+prose.
   Each example `verify.sh` green locally before handing back.
3. **Validation (Opus):** adversarial pass — technical accuracy (protobuf/HTTP2/Buf/quarkus-grpc),
   voice (lgtm-professional-voice), idiom (lgtm-idiomatic-review on example code), domain consistency.
4. **Wrap:** per-chapter checkpoint commits; flip coverage rows (Ch0/Ch3/Ch4/Ch5 → verified after CI
   green; Ch1/Ch2 → draft); update `_example_pages/index.md`; local gate run (validate.py + wordcount
   GATE + buf lint + jekyll build); push; watch CI; open r02 PR + merge.

## Acceptance (same bar as r01)
2,000–2,500 words/chapter + ≥1 paired figure; 0 voice ban-tier; validate.py + wordcount GATE + buf +
jekyll build green; each hands-on example both-stack `verify.sh` green in CI; coverage rows truthful;
the Ch2 decision framework is defined and recurs as a Decision callout; every hands-on chapter has an
"On the wire" box matching its verify.sh.
