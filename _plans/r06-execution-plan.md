---
title: "r06 Execution Plan (Phase 4c)"
layout: plan
render_with_liquid: false
---

# r06 Execution Plan — Part 6: Concurrency & Long-Running Work (Ch15–Ch16)

Relay on branch `docs/r06-content`, mirroring `_plans/r05-execution-plan.md`. Final slice of
the iteration-plan's Phase 4 (Parts 4–6). New content; runnable BOTH-STACK examples verified in
CI (`verify.sh` asserts field semantics via grpcurl/reflection, not just a status).

## Scope
- **Ch15 — Backend I/O concurrency** [H]: Quarkus event-loop vs `@Blocking` vs `@RunOnVirtualThread`;
  Python `grpc.aio`/asyncio vs thread-pool vs the GIL + free-threaded 3.14; DB+file I/O behind an
  RPC without thread exhaustion, measured. Implements the already-declared `FindOptimalRoute` (no
  contract change).
- **Ch16 — Async & long-running jobs** [H]: the server-owned **Operation** pattern —
  `RecomputeRoutes` starts work; client polls/watches progress; cancellation; rerunnable reconcile.

## Contract change — ONE additive, buf-breaking-safe edit (Ch16), NEEDS SIGN-OFF
The contract can *start* an operation but gives the client no way to re-fetch it by id. Teaching
poll/watch/cancel honestly (the REST→gRPC LRO analog of `GET /operations/{id}`) requires adding to
`RoutingService` (mirrors Google AIP-151, reuses the existing `shipping.type.v1.Operation` as the
return type — only three new request wrappers):
```proto
rpc GetOperation(GetOperationRequest)       returns (shipping.type.v1.Operation);
rpc WatchOperation(WatchOperationRequest)   returns (stream shipping.type.v1.Operation);
rpc CancelOperation(CancelOperationRequest) returns (shipping.type.v1.Operation);
```
Adding RPCs/messages is **non-breaking** under buf `FILE`/`WIRE` — the real `buf breaking --against
main` gate stays green; prior examples (Ch05–Ch14) are unaffected (unimplemented → `UNIMPLEMENTED`).
Done as a SERIAL Wave 0 that re-runs the full examples matrix locally before Ch16 authoring.
*Minimal alternative:* drop `WatchOperation` (poll+cancel only) if we want the smallest change.

## Figures (≥2 per chapter required; concept-first)
- **Ch15:** `15-jvm-execution-models` (event-loop vs @Blocking vs @RunOnVirtualThread + starvation
  path) · `15-python-gil-concurrency` (grpc.aio + asyncio.to_thread vs thread-pool; GIL gate +
  free-threaded caveat) · `15-thread-exhaustion-overlap` (serialized-starve vs overlapped-scale).
- **Ch16:** `16-operation-lifecycle` · `16-poll-vs-watch` (GetOperation polls vs WatchOperation
  stream; the REST seam) · `16-cancel-and-rerun` (operation cancel vs request-scoped cancel; rerun).

## Examples (unique ports / compose projects)
- `examples/15-backend-io-concurrency` — 9150/9151, `ch15-concurrency`. Implements `FindOptimalRoute`
  with a simulated ~400 ms blocking DB+file step in the correct non-starving model (Quarkus
  `@Blocking` + a `@RunOnVirtualThread` variant; Python `grpc.aio` + `asyncio.to_thread`), plus the
  starving path (blocking on the event loop) for contrast. verify.sh (both stacks): correct field
  values; 8 concurrent calls all succeed; overlap under a loose bound (`< 2.5s` vs 8×0.4s serial);
  starve-vs-scale `correct×2 < starving` (2× margin). `ghz` + GIL/free-threaded numbers are
  illustrative in the "On the wire" box, NOT gated. Deterministic gate stays I/O-bound (GIL-agnostic).
- `examples/16-async-long-running-jobs` — 9160/9161, `ch16-operation`. Implements RecomputeRoutes +
  the three new RPCs over an in-process operation registry; bounded (~2 s) progress; cancel flag.
  verify.sh (both stacks): start→`op_` id + done=false; poll `GetOperation` to done=true/100%;
  `WatchOperation` ≥2 snapshots, terminal done; cancel the slow variant → terminal, `cancelled`,
  `<100%`; rerunnable reconcile (two runs → consistent terminal); unimplemented elsewhere → UNIMPLEMENTED.

## Waves
0. **Wave 0 (SERIAL):** the additive `routing.proto` edit; `buf lint` + `buf breaking --against main`
   + full examples discovery matrix green locally. No other file. (Ch15 may start in parallel — it
   needs no contract change.)
1. **Wave A (parallel, after Wave 0):** Ch15 executor (doc + example + 3 figures); Ch16 executor
   (doc + example + 3 figures). Forbidden to both: `contracts/` (frozen after Wave 0),
   `examples/_lib/lib.sh` (verify.sh-local helpers only), `_plans/*`, `coverage-matrix.md`,
   `_example_pages/index.md`.
2. **Validation (Opus):** execution-model accuracy (Java 25 quarkus-grpc; grpc.aio/asyncio;
   honest GIL/free-threaded; Operation/LRO/AIP-151; additive-safe claim) + voice 0 ban-tier +
   lgtm-idiomatic-review on both stacks.
3. **Wrap:** per-chapter checkpoints; coverage Ch15–16 → draft → verified after CI green;
   `_example_pages/index.md`; local gates; push; watch CI; r06 PR + merge.

## Acceptance
Floor cleared; ≥2 paired figures/chapter; 0 voice ban-tier; validate.py + jekyll green; `buf lint` +
`buf breaking` green (additive safe); Ch15 + Ch16 both-stack verify.sh green in CI (assertions above);
all prior examples (Ch05–Ch14) still green after the contract edit; "On the wire" + "Decision" in each
chapter; coverage truthful; Python 3.14 free-threaded caveat documented, not asserted.

## Risks
Concurrency flakiness → loose relative (2× margin), I/O-bound, pinned images, 3× local + CI retry ·
Python 3.14 free-threaded/grpcio (#11) → GIL image is canary, caveat documented not asserted ·
long-op non-determinism → bounded ≤2 s + cancel flag + loose assertions · additive edit disturbs
matrix → non-breaking + Wave-0 full-matrix check · stale Quarkus vthread prose → re-verify via
quarkus-agent · shared-file hazard → serialize contract as Wave 0, no `_lib/` edits · WatchOperation
stream flakiness → assert count≥2 + terminal only.
