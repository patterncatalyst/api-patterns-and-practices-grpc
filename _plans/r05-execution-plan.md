---
title: "r05 Execution Plan (Phase 4b)"
layout: plan
render_with_liquid: false
---

# r05 Execution Plan — Part 5: Schema Evolution & the Living Contract (Ch13–Ch14)

Relay on branch `docs/r05-content`, mirroring `_plans/r04-execution-plan.md`. Standing
approval: run waves without gating. Second half of the iteration-plan's Phase 4 (Ch13–16
followed r04's Ch10–12); r05 ships **Part 5** (Ch13–14) on the actual one-part-per-iteration
cadence, with Part 6 (Ch15–16) to follow in r06. Verification unchanged: both stacks in
containers, `verify.sh` asserts response/semantics via grpcurl, not just a status — and for
Ch14 the evolution gate asserts `buf breaking` **fails on a seeded breaking change**.

## Scope (from `_plans/iteration-plan.md`)
- **Part 5 — Schema evolution & the living contract.** Ch13 schema design over gRPC —
  message granularity, request/response envelopes, pagination (page tokens), `FieldMask`
  projection, API-guideline conventions [C + small H]; Ch14 evolution & versioning — field
  numbers as the contract, `reserved`, backward/forward compatibility, package versioning
  (`shipping.routing.v1`→`v2`), the **`buf breaking` gate** (deliberate-drift test), and the
  **Buf Schema Registry** (BSR) + remote packages / generated-SDK distribution [H].

## Existing scaffolding to lean on (no NEW contract methods required)
- `contracts/proto/shipping/routing/v1/routing.proto` **already declares** `ListRoutes`
  with `page_size` / `page_token` / `google.protobuf.FieldMask field_mask` and a
  `next_page_token` response. **Ch13 implements this existing RPC** — it does not add new
  methods to `contracts/`. Only safe, additive edits (if any) to `contracts/`, and only if a
  chapter truly needs them; prefer implementing what's already declared.
- The `buf breaking` gate is already wired: `.github/workflows/contracts.yml` runs
  `buf breaking --against "../.git#branch=main,subdir=contracts"`. `buf.yaml` uses
  `breaking: use: [FILE]`. **Ch14 must not break the real `contracts/` module** (that would
  red the CI gate for the whole repo). The deliberate-drift demo lives in a **self-contained
  example module** (below), not in `contracts/`.

## Depth standard
2,000–2,500 words prose + ≥1 paired SVG+.excalidraw figure; hands-on chapters end with an
"On the wire" box; concept-bearing sections close with a "Decision" callout. Voice:
lgtm-professional-voice 0 ban-tier. Emphasis boxes light `accent`, never dark.

## Figures
`13-message-granularity` (nest vs reference) · `13-pagination-page-tokens` · `13-fieldmask-projection` ·
`14-evolution-compatibility` (field-number contract, wire-compat matrix, v1→v2 + the breaking gate).

## Examples (UNIQUE ports + compose project names)
- `examples/13-schema-design` — ports 9130/9131, project `ch13-schema`. Each stack implements
  the existing `RoutingService.ListRoutes` over a small in-memory catalog: honors `page_size`,
  returns `next_page_token`, and applies `field_mask` projection to the returned `Route`s.
  verify asserts: page 1 returns `page_size` routes **plus** a non-empty `next_page_token`;
  page 2 (that token) continues without overlap and ends with an empty `next_page_token`; a
  request with `field_mask` of a subset of paths returns **only** those fields populated
  (unmasked fields absent/zero). Uses `grpcurl` + `assert_contains` / field-value checks.
- `examples/14-evolution` — project `ch14-evolution`. **Tooling example, not a server** (no
  ports). A self-contained mini buf module under the example with a `baseline/` proto and a
  `candidate/` proto. `verify.sh` runs `buf breaking candidate --against baseline` and asserts:
  a **safe** change (add a field, `reserved` a retired number, add an RPC) exits **0**; a
  **breaking** change (reuse/renumber a field, change a type, remove a field/RPC) exits
  **non-zero** — the seeded-failure proof the risk register calls for. Pin the `buf` image/
  version used elsewhere. This is the **durable, CI-green, rendered-in-the-book proof** and
  demonstrates the same gate CI runs, in isolation, without touching `contracts/`.
- `scripts/ch14-demo-breaking.sh` — the **authentic "real gate fires on a PR" experience**,
  on demand and ephemeral (never a committed red branch). Forks `demo/ch14-breaking` off
  **current** `main` (so it never rots — it re-derives from whatever `main` is now), applies a
  seeded breaking edit to the real `contracts/` (e.g. renumber a field), pushes, and lets the
  reader watch the real `buf breaking --against main` job go **red**; `--cleanup` deletes the
  branch. The **script** (and its walkthrough in the chapter) is the durable artifact — the red
  branch exists only while demonstrating. Document it as intentionally-red and safe to delete.

Quarkus: re-verify current `quarkus-grpc` server + `FieldMask`/pagination handling via the
quarkus-agent MCP. Python: `grpc.aio` server; `google.protobuf.field_mask_pb2` for mask paths.
BSR + remote packages / generated-SDK distribution are covered in **prose + a Decision callout**
(BSR needs an account/registry) — documented honestly, not stood up live. All service RPCs
implemented (real real, rest `UNIMPLEMENTED`). Proven template: `examples/07-unary-rpcs`.
Containerfiles carry the aether named-lock + wagon retry flags.

## Waves
1. **Wave A (parallel):** Ch13 (single-service pagination/field-mask) + Ch14 (prose + the
   `examples/14-evolution` buf-breaking tooling example). Self-contained (prose + figure +
   example built & `verify.sh` green locally). Files only — no git; don't touch `_plans/*`,
   `coverage-matrix.md`, `_example_pages/index.md`, `examples/_lib/`, and (except safe additive
   edits if truly needed) `contracts/`.
2. **Validation (Opus):** accuracy (pagination/page-token semantics, `FieldMask` projection,
   field-number compatibility rules, `reserved`, v1→v2 versioning, BSR claims, the `buf breaking`
   rule set) + lgtm-professional-voice (0 ban-tier) + lgtm-idiomatic-review on example code.
3. **Wrap:** per-chapter checkpoint commits; coverage Ch13–14 → draft then → verified after CI
   green; update `_example_pages/index.md`; local gates (validate.py + wordcount GATE + buf +
   jekyll); push; watch CI; open r05 PR + merge.

## Acceptance
2,000–2,500 words/chapter + ≥1 figure; 0 voice ban-tier; validate.py + wordcount + buf + jekyll
green; Ch13 both-stack `verify.sh` green in CI (asserts page-token continuation + field-mask
projection); Ch14 `examples/14-evolution` `verify.sh` green in CI (asserts `buf breaking`
passes the safe change and **fails** the seeded breaking change); `scripts/ch14-demo-breaking.sh`
runs clean locally (forks the demo branch, shows the real gate red, `--cleanup` removes it) but
is NOT part of the green-CI gate — no permanent red branch is committed; the real `contracts/`
buf breaking gate stays green; coverage rows truthful; every hands-on chapter has an "On the wire" box.
