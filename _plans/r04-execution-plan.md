---
title: "r04 Execution Plan (Phase 4a)"
layout: plan
render_with_liquid: false
---

# r04 Execution Plan — Part 4: Reliability (Ch10–Ch12)

Relay on branch `docs/r04-content`, mirroring `_plans/r03-execution-plan.md`. Standing
approval: run waves without gating. First half of the iteration-plan's Phase 4 (Parts 4–6,
Ch10–16); Ch13–16 follow in r05. Verification unchanged: both stacks in containers,
`verify.sh` asserts response/error semantics via grpcurl, not just a status.

## Scope (from `_plans/iteration-plan.md`)
- **Part 4 — Reliability: deadlines, errors & interceptors.** Ch10 deadlines, timeouts &
  cancellation propagation [H]; Ch11 error & exception handling — status codes + the
  `google.rpc.Status` rich-error model + retryable/service-config retries [H]; Ch12
  interceptors — client/server cross-cutting (logging, metrics, auth hook) [H].

## No contract/Buf changes
The rich-error detail types (`google.rpc.Status`, `ErrorInfo`, `RetryInfo`, `BadRequest`)
come from the grpc LIBRARIES at runtime — Java `grpc-protobuf` + `proto-google-common-protos`
(`io.grpc.protobuf.StatusProto`), Python `grpcio-status` (`google.rpc.status_pb2`,
`error_details_pb2`). Add those as example deps in pom.xml / pyproject.toml; do NOT modify
`contracts/` or `buf.yaml`. (The googleapis Buf dep is only needed if we define custom
detail messages in our own proto — we don't.)

## Harness
`examples/_lib/lib.sh` already has `grpc_expect_code` (asserts a status code) and now
`grpc_error_output` (prints the full error incl. Details, for `assert_contains` on a detail).

## Depth standard
2,000–2,500 words prose + ≥1 paired SVG+.excalidraw figure; hands-on chapters end with an
"On the wire" box; concept-bearing sections close with a "Decision" callout (Ch2 five axes).
Voice: lgtm-professional-voice 0 ban-tier. Emphasis boxes light `accent`, never dark.

## Figures
`10-deadline-propagation` · `11-rich-error-model` · `12-interceptor-chain`.

## Examples (UNIQUE ports + compose project names)
- `examples/10-deadlines-cancellation` — ports 9100/9101, project `ch10-deadline`. Each stack
  runs `RoutingService.GetQuote` which makes a DOWNSTREAM gRPC call to `QuoteService.GetQuote`
  (slow/configurable). A client **deadline** propagates: a tight deadline → `DEADLINE_EXCEEDED`
  (and the server observes cancellation of the downstream call); a generous deadline → OK.
  verify asserts both outcomes. (Routing may call quote via a loopback channel in one container,
  or quote as a second container — whatever is reliable.)
- `examples/11-error-handling` — ports 9110/9111, project `ch11-errors`. A method returns
  canonical codes with `google.rpc.Status` **details**: `INVALID_ARGUMENT` + `BadRequest`
  field violation on bad input; `FAILED_PRECONDITION`/`NOT_FOUND` where apt; a retryable
  `UNAVAILABLE` + `RetryInfo` vs a non-retryable `INVALID_ARGUMENT`. verify uses
  `grpc_expect_code` (code) + `grpc_error_output` | `assert_contains` (detail payload).
- `examples/12-interceptors` — ports 9120/9121, project `ch12-intercept`. A server (and client)
  interceptor adds logging/timing (and a simple auth-hook check). verify drives a probe RPC and
  asserts the interceptor ran (e.g. an injected response-header/trailer via metadata, or the
  auth-hook rejecting a call missing a token with `UNAUTHENTICATED`).

Quarkus: re-verify current `quarkus-grpc` interceptor + error APIs via the quarkus-agent MCP
(`@GlobalInterceptor`/`ServerInterceptor`; `StatusRuntimeException` / `StatusProto.toStatusRuntimeException`).
Python: `grpc.aio` `ServerInterceptor`; `grpcio-status` `rpc_status`. All service RPCs implemented
(real real, rest `UNIMPLEMENTED`). Proven template: `examples/05-contract-first` + `07-unary-rpcs`.
Containerfiles carry the aether named-lock + wagon retry flags.

## Waves
1. **Wave A (parallel):** Ch11 + Ch12 (single-service each). Self-contained (prose + figure +
   example built & `verify.sh` green locally). Files only — no git; don't touch `_plans/*`,
   `coverage-matrix.md`, `_example_pages/index.md`, `examples/_lib/`, `contracts/`.
2. **Wave B:** Ch10 (the two-service downstream-deadline example — most complex, run solo).
3. **Validation (Opus):** accuracy (deadline propagation, status/rich-error model, interceptors,
   quarkus-grpc) + lgtm-professional-voice (0 ban-tier) + lgtm-idiomatic-review on example code.
4. **Wrap:** per-chapter checkpoint commits; coverage Ch10–12 → draft then → verified after CI
   green; update `_example_pages/index.md`; local gates (validate.py + wordcount GATE + buf +
   jekyll); push; watch CI; open r04 PR + merge.

## Acceptance
2,000–2,500 words/chapter + ≥1 figure; 0 voice ban-tier; validate.py + wordcount + buf + jekyll
green; each hands-on example both-stack `verify.sh` green in CI (Ch10 asserts tight→DEADLINE_EXCEEDED
and generous→OK; Ch11 asserts code + a google.rpc.Status detail; Ch12 asserts the interceptor
ran / auth-hook rejects); coverage rows truthful; every hands-on chapter has an "On the wire" box.
