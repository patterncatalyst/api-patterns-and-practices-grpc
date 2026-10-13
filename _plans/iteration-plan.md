---
title: "Build & Iteration Plan"
layout: plan
render_with_liquid: false
---

# Build & Iteration Plan — API Patterns and Practices: gRPC

Synthesized (ultraplan) from three independent Opus planning passes — risk-first
(engineering spine), simplest-first (release cadence), reader-outcome (pedagogy).
Second of four per-style sites (after REST). Status: **awaiting review**. No chapter
prose or code is written until this plan is approved.

Repo: `patterncatalyst/api-patterns-and-practices-grpc` (public, remote-first).
Mirrors the house style of the REST sibling (`api-patterns-and-practices-rest`):
parts→chapters, [H]/[C] tags, 2,000–2,500 words/chapter + ≥1 paired SVG+.excalidraw
diagram, per-example plan, diagrams list, r01→r06 execution phases with checkpoint
commits, acceptance criteria, risks+detection, resolved-decisions block.

## Approach

- **Contract-first spine = Protocol Buffers under Buf.** The `.proto` files in
  `contracts/proto/` are the single source of truth (gRPC's analog to REST's OpenAPI).
  They are authored before the first implementation; CI gates them with **`buf lint`**
  and **`buf breaking`** (against a committed baseline from day one) and regenerates
  **both** stacks from them. Drift or a breaking change fails the build. `buf breaking`
  is the evolution/drift gate — the direct analog of REST's response-schema-drift gate.
- **The verification spine is behavioral, and it is the top risk.** gRPC's wire is
  binary HTTP/2 — you cannot eyeball a response the way you can a REST JSON body. So the
  thing that must exist and be proven *before any chapter* is a CI harness that stands up
  the running service and asserts **response field semantics against the proto** (via
  `grpcurl` + server reflection, or a generated probe client), not just an `OK` status.
  A chapter's `*Verification status: verified*` footer flips only after both stacks run green.
- **Both stacks are first-class.** Every hands-on chapter ships a **Quarkus**
  (`quarkus-grpc`, UBI 10, Java 25) **and** a **Python** (`grpcio`/`grpcio-tools`,
  Python 3.14, **uv**) example generated from the *same* proto and passing the *same*
  `verify.sh`. Iterations stage work by **part**, never by stack, so the two never diverge.
- **Multi-language tabs architected for Go and C++ later.** Code tabs use a four-slot
  shape — `{% include codetabs.html langs="Quarkus|Python|Go|C++" %}` with Go/C++ marked
  "coming soon" — and the per-example `<stack>/` layout accepts a `go/` and `cpp/` sibling
  against the identical proto and identical `verify.sh`, so the later stacks drop in with
  no restructuring. (The CNDP site already runs this exact six-language gRPC codetab.)
- **Borrowed Quarkus prose is untrusted until re-verified.** The nine
  `~/Dev/quarkus-grpc/doc/*.md` files are mined for structure and worked examples only;
  `quarkus-grpc` has had several recent updates, so every Quarkus claim (Mutiny stub
  shapes, `@Blocking`/`@RunOnVirtualThread`, TLS config keys, health/metrics extensions)
  is re-checked against **current** `quarkus-grpc` on Java 25 via the `quarkus-agent` MCP —
  the `@QuarkusTest` build in CI is the canary.
- **One domain, continuous with the REST site.** gRPC is the internal, latency-sensitive
  **RoutingService** (and the **TrackingService** hot-path, plus a small **QuoteService**)
  that the REST booking service calls. The **REST→gRPC interop seam** is shown throughout
  and exercised whole in the capstone. Reuse the glossary nouns: Booking, Cargo,
  Location/UN-LOCODE, Route, Leg, Operation, Money-as-decimal-string, booking FSM.
- **Three recurring teaching devices** (from the reader-outcome pass):
  1. **The gRPC Decision Framework (Ch2)** — five axes: (a) RPC shape
     (unary/server-stream/client-stream/bidi), (b) sync call vs stream, (c) deadline &
     budget, (d) failure class & retryability, (e) concurrency model. Introduced early,
     then recurs as a **"Decision"** callout closing each concept chapter; the capstone
     asks the reader to defend every axis.
  2. **The "On the wire" box** — because you cannot `curl` gRPC, every [H] chapter ends
     with a concrete observation the reader performs themselves (`grpcurl` a method, `ghz`
     a load run, decode protobuf bytes, read an HTTP/2 frame, inspect reflection/channelz).
     This is the gRPC analog of REST's "Cross-check it yourself" and it *is* the spec each
     `verify.sh` encodes.
  3. **The "REST seam" callout** — a short recurring note showing where each concept
     touches the REST→gRPC seam, keeping continuity with the sibling site.
- **Auditable coverage.** `_plans/coverage-matrix.md` maps every PRD/user topic to a
  chapter; CI fails if a mapped, non-`planned` chapter file is missing.
- **Always releasable.** Ship r01→r06; each ends on a clean Jekyll build with the
  iteration table updated. The earliest "it runs and is traced end to end" moment is a
  **Phase-1/r01 deliverable** (the Ch5 unary anchor), not an r06 one.

Rejected: chapters-first/proto-later (unenforceable drift, no buf-breaking gate);
status-code-only verification (an `OK` with a wrong field value lies louder in binary
than in JSON); single reference stack (violates the both-stacks requirement); RPC-types
before protobuf (hides that the contract is primary); hand-written `protoc` instead of
Buf (loses the breaking-change gate); deferring the K8s single-connection load-balancing
problem to "ops" (it is *the* gRPC production gotcha and must be demoed); big-bang
all-chapters (no releasable checkpoint); Poetry for Python (match the REST site's uv).

## Part → Chapter outline (every PRD/user topic mapped)

Legend: **[H]** hands-on (runnable in BOTH stacks against a committed `.proto`), **[C]** concept.
**Depth standard (every chapter):** 2,000–2,500 words of prose (excl. code listings,
captions, command output) is the **target band, not a hard cap** — a chapter may run
longer when the material earns it. The `wordcount.sh` gate enforces only the 2,000-word
floor; over-target is a non-failing warning.

**Diagrams:** a chapter carries roughly **one focused diagram per major concept** — in
practice **≥2 paired SVG+.excalidraw figures** for any chapter near or above the target
band, and never fewer than one. A ~2,500-word chapter with a single figure is
under-illustrated; prefer several focused figures over one crowded multi-band figure.
(Chapters Ch1–Ch12 predate this convention at one figure each; backfill is deferred, new
chapters from r05 forward follow it.)

**Part 0 — Prerequisites & the Lab** · _r01_
_After this part, the reader has the contract-first (proto + Buf) toolchain generating stubs and serving in both stacks locally._
- **Ch0** Prerequisites & the lab: toolchain pins (quarkus-grpc / UBI 10 / Java 25; `grpcio`+`grpcio-tools` on Python 3.14 via **uv**; `buf`, `protoc`, `grpcurl`, `grpcui`, `ghz`), Docker Compose + LGTM, the shipping/cargo domain + glossary, the continuity-with-REST framing (gRPC = internal routing + tracking hot-path the booking service calls), repo layout. [H-setup]

**Part 1 — Why gRPC, and the decision lens** · _r01_
_After this part, the reader can decide whether gRPC fits an interaction and classify any call on five axes._
- **Ch1** From REST to RPC: three paradigms (resource/procedure/graph), the procedure-oriented mental model, stub-to-stub, gRPC vs REST vs GraphQL vs events, where gRPC wins and loses (browser, caching, large occasional payloads). [C] — *mines CNDP `02-communications`, `14-appendix-a-protocols`; books: Newman, grpc.io*
- **Ch2** The gRPC decision framework: the five axes; introduces the recurring **Decision** callout and seeds the cross-protocol contrast (full treatment Ch24). [C] — *addition: decision framework*

**Part 2 — Protocol Buffers: the contract language** · _r01_
_After this part, the reader can model the shipping domain in protobuf and make it the Buf-enforced single source of truth both stacks generate from._
- **Ch3** Protobuf in depth: `proto3` syntax, scalars, `message`, `enum`, `oneof`, `map`, nested types, packages, options, field presence/defaults/`optional`, and how tag numbers encode on the wire. [C + small H] — *full protobuf; books: Clément Jean, grpc.io proto3 ref*
- **Ch4** Well-known types & JSON mapping: `Timestamp`, `Duration`, `Any`, `Struct`, `FieldMask`, wrappers; the **Money-as-decimal-string** decision; canonical proto3↔JSON mapping (ties to the REST payloads). [H] — *mines quarkus-grpc-streaming (well-known types), re-verify*
- **Ch5** Contract-first with Buf (**ANCHOR**): author `shipping/type/v1/types.proto` + `routing/v1/routing.proto` + `tracking/v1/tracking.proto`; wire `buf lint`/`buf build`/`buf breaking` into CI; both stacks generate stubs and serve a unary `RoutingService.GetQuote`, traced through LGTM; `verify.sh` asserts the quote against the proto. **This is the earliest "it runs and is traced end to end" milestone.** [H] — *addition: Buf; books: Clément Jean, Babal*

**Part 3 — HTTP/2 & the four RPC types** · _r02_
_After this part, the reader can explain why gRPC is fast and implement and choose among all four RPC shapes._
- **Ch6** HTTP/2 foundation & why gRPC is fast: streams, frames, multiplexing, HPACK, one long-lived connection; binary protobuf vs JSON cost — measured; decode a real message on the wire. [C + measured H] — *mines CNDP `14` "why gRPC is fast"; book: Babal*
- **Ch7** Unary RPCs & the generated code: a guided tour of the stub-to-stub path in both stacks; channels & stubs introduced. [H] — *mines CNDP `14` stub-to-stub, quarkus-grpc-service*
- **Ch8** Server-streaming: `TrackingService.WatchShipment` — the live tracking hot-path. [H] — *mines CNDP `14` streaming modes, quarkus-grpc-streaming (re-verify)*
- **Ch9** Client-streaming & bidirectional: `TrackingService.ReportPositions` (bulk ingest) + `RoutingService.NegotiateRoute` (bidi). [H] — *mines quarkus-grpc-streaming (re-verify)*

**Part 4 — Reliability: deadlines, errors & interceptors** · _r03_
_After this part, the reader can make calls fail correctly and bound their own blast radius._
- **Ch10** Deadlines, timeouts & cancellation propagation across the REST→gRPC seam; context cancellation. [H] — *grpc.io, Jean*
- **Ch11** Error & exception handling: canonical status codes as the contract, the **rich error model** (`google.rpc.Status` + error details), retryable vs non-retryable, `service config` retry policy / hedging, idempotency; never collapse to `INTERNAL`. [H] — *mines CNDP `18-appendix-e-errors`*
- **Ch12** Interceptors: client- and server-side cross-cutting concerns (logging, metrics, the auth hook). [H] — *mines quarkus-grpc-interceptor (re-verify)*

**Part 5 — Schema evolution & the living contract** · _r03_
_After this part, the reader can design and evolve a proto without breaking clients, enforced by CI._
- **Ch13** Schema design over gRPC: message granularity, request/response envelopes, pagination (page tokens), `FieldMask` projection, API-guideline conventions. [C + small H] — *Clément Jean, grpc.io*
- **Ch14** Evolution & versioning: field numbers as the contract, `reserved`, backward/forward compatibility, package versioning (`shipping.routing.v1`→`v2`), the **`buf breaking` gate**, and the **Buf Schema Registry** (BSR) + remote packages / generated-SDK distribution. [H] — *mines CNDP `15-appendix-b-versioning`; addition: Buf breaking + BSR*

**Part 6 — Concurrency & long-running work** · _r03_
_After this part, the reader can serve I/O-bound RPCs without exhausting threads and model work that outlives one call._
- **Ch15** Backend I/O concurrency: Quarkus event-loop vs `@Blocking` worker vs `@RunOnVirtualThread`; Python `grpc.aio`/asyncio vs thread-pool server vs the GIL and free-threaded 3.14; DB + file I/O behind an RPC without thread exhaustion, measured. [H] — *mines quarkus-grpc-blocking, -virtual-threads (re-verify on Java 25)*
- **Ch16** Async & long-running jobs over gRPC: the server-owned **`Operation`** pattern (`RecomputeRoutes` → poll / `WatchOperation` server-stream progress), cancellation, a rerunnable reconcile job. [H] — *maps the REST async/LRO concept onto gRPC*

**Part 7 — Streaming at scale & performance** · _r04_
_After this part, the reader can run streaming safely under load and tune and benchmark the service._
- **Ch17** Streaming deep-dive: flow control & backpressure, HTTP/2 window dynamics, reactive backpressure (`Multi`) vs async generators, slow-consumer handling, keepalive on long-lived streams. [H] — *mines quarkus-grpc-streaming, CNDP `14`*
- **Ch18** Performance & tuning: channel/stub **reuse** (the #1 footgun) revisited, keepalive, max message size, compression, connection pooling; benchmarking with **ghz**. [H] — *mines quarkus-grpc-scaling (re-verify); grpc.io*

**Part 8 — Security** · _r04_
_After this part, the reader can encrypt, mutually authenticate, and authorize gRPC calls._
- **Ch19** TLS & mTLS: channel/transport credentials, cert management, Compose cert bootstrap, progression to minikube. [H] — *mines quarkus-grpc-service (TLS, re-verify)*
- **Ch20** AuthN/AuthZ: JWT/OAuth2, per-call credentials in metadata, auth interceptors, per-method authorization. [H] — *mines quarkus-grpc-interceptor; CNDP `12-security`*

**Part 9 — Observability, mesh & load balancing** · _r05_
_After this part, the reader can trace an RPC across the REST→gRPC seam and run gRPC correctly behind Kubernetes._
- **Ch21** Observability: OTel tracing + metrics across the **REST→gRPC seam** (span propagation through metadata), Prometheus/Grafana/Tempo, gRPC health checks. [H] — *mines quarkus-grpc-metrics-collection, -health-check (re-verify); LGTM skills*
- **Ch22** Load balancing & service mesh: **the L4 single-connection problem** (a plain K8s Service pins every call to one pod), client-side LB vs proxy/Envoy xDS, Istio/Linkerd on minikube, mesh mTLS + retries/timeouts. [H] — *mines quarkus-grpc-scaling, CNDP `22-appendix-i-l7-routing`; Newman*

**Part 10 — Browsers, transcoding & cross-protocol** · _r05_
_After this part, the reader can expose gRPC to a browser or REST client and choose gRPC vs alternatives, including over HTTP/3._
- **Ch23** gRPC-Web & JSON/HTTP transcoding: the browser problem, grpc-gateway / Envoy transcoding, exposing a gRPC method as REST; the **REST→gRPC interop seam** made concrete (the booking service calling `RoutingService`). [H] — *addition: gRPC-Web/transcoding; grpc.io, CNDP `14`*
- **Ch24** Cross-protocol choices & HTTP/3: gRPC vs REST-over-HTTP/2 vs WebSockets for streaming; gRPC-over-HTTP/3 — honest, forward-looking, **tier-gated and measured** (QUIC stream isolation vs HTTP/2 TCP head-of-line blocking, 0-RTT, connection migration). [C + measured H] — *additions: cross-protocol + HTTP/3; CNDP `16-appendix-c-websockets`*

**Part 11 — Testing & debugging** · _r05_
_After this part, the reader can prove conformance and debug a gRPC service end to end._
- **Ch25** Testing & the CLI: `grpcurl`, `grpcui`, Insomnia/Yaak, server reflection, `@QuarkusTest`, `pytest` (grpcio testing), load with **ghz**; the `verify.sh` model explained. [H] — *mines quarkus-grpc-testing (re-verify); addition: full testing*
- **Ch26** Debugging gRPC: reflection & channelz, common failure modes (`UNIMPLEMENTED`, deadline exceeded, TLS handshake, `UNAVAILABLE` on a cold channel), decoding frames, `GRPC_TRACE`/`GRPC_VERBOSITY`. [C + H] — *addition: debugging*

**Part 12 — Running it & the capstone** · _r06_
_After this part, the reader can run, observe, and defend a complete gRPC system across all three tiers._
- **Ch27** Capstone: the RoutingService + TrackingService + QuoteService end to end — contract-first protos, all four RPC types, deadlines/retries/rich errors, mTLS + JWT, OTel-traced across the REST→gRPC seam, `buf breaking`-gated, `ghz` load-tested, deployed Compose→minikube (with the LB problem solved), both stacks. Exercises all five Decision-Framework axes and asks the reader to defend each. [H] — *integrative*
- **Appendix A** OpenShift Local (CRC): gRPC over Routes (h2c / edge TLS / passthrough), in-cluster image build, OpenShift Service Mesh STRICT mTLS + a canary (use the `lgtm-crc` skill). [H] — *addition: CRC tier*

**Coverage:** 28 chapters (Ch0–Ch27) + CRC appendix across 13 parts. Every PRD/user topic
maps to a chapter (maintained in `_plans/coverage-matrix.md`, CI-checked): full protobuf→Ch3;
well-known types/JSON→Ch4; HTTP/2→Ch6; 4 RPC types→Ch5/7/8/9; schema design→Ch13;
evolution/versioning + buf breaking + BSR→Ch14; serialization cost→Ch6; channel/stub reuse→Ch7/Ch18;
deadlines/cancellation→Ch10; errors/rich-error model/retries→Ch11; interceptors→Ch12/Ch20;
backend concurrency→Ch15; async/long-running→Ch16; streaming + flow control→Ch8/9/Ch17;
TLS/mTLS→Ch19; JWT/OAuth2/per-call auth→Ch20; observability→Ch21; mesh & LB→Ch22;
Buf→Ch5/Ch14; gRPC-Web & transcoding→Ch23; cross-protocol→Ch24; HTTP/3→Ch24;
testing & CLI→Ch25; debugging→Ch26; performance tuning/ghz→Ch18/Ch25; capstone→Ch27; CRC→Appendix A.

## Proto surface (concrete names)

Protos live under `contracts/proto/shipping/`; shared messages defined **once** in
`type/v1/types.proto` and imported everywhere (the shared-schema analog):

- `shipping.type.v1` — `Booking`, `Cargo`, `Location` (UN/LOCODE), `Route`, `Leg`,
  `Money { string currency; string amount; }`, `Operation`, enum
  `BookingState { PENDING, CONFIRMED, IN_TRANSIT, DELIVERED, CANCELLED }`, `oneof`
  result/error, `map<string,string> labels`, WKTs `google.protobuf.Timestamp`/`FieldMask`,
  `google.rpc.Status`.
- `shipping.routing.v1` — `RoutingService`: `GetQuote` (unary, anchor), `FindOptimalRoute`
  (unary), `ListRoutes` (pagination + FieldMask), `NegotiateRoute` (bidi stream),
  `RecomputeRoutes` → `Operation` (async/long-running).
- `shipping.tracking.v1` — `TrackingService`: `WatchShipment` (server-stream),
  `ReportPositions` (client-stream), `Sync` (bidi).
- `shipping.quote.v1` — `QuoteService`: `GetQuote` (rich-error + deadline-propagation target).

## Per-hands-on example plan (both stacks, against `contracts/proto/`)

Each [H] example additionally ships `architecture.{svg,excalidraw}` and a `verify.sh`
whose assertions are exactly the chapter's "On the wire" box.

- **Ch0** boot skeleton + Compose/LGTM; a stub `RoutingService` returns a canned `RouteResponse`; health check reachable.
- **Ch3** `type/v1/types.proto` with scalars/enum/oneof/map/nested compiles; `buf generate` produces stubs in both stacks; a type round-trip is asserted.
- **Ch4** well-known types + Money decimal-string round-trip proto↔JSON, asserted.
- **Ch5** both stacks serve `RoutingService.GetQuote` (unary); `verify.sh` calls via grpcurl+reflection, asserts the `Money` quote against the proto; an OTel span lands in Tempo. **(earliest traced-end-to-end)**
- **Ch6** same `GetQuote` measured: protobuf vs JSON payload size + latency on one multiplexed connection; decode a response on the wire.
- **Ch7** one shared channel + reused stub vs channel-per-call; blocking vs Mutiny/async stub tour.
- **Ch8** `WatchShipment` server-stream emits ordered `TrackingEvent`s; client reads to completion; verify asserts count/order.
- **Ch9** `ReportPositions` client-stream folds N reports → one `ReportAck`; `NegotiateRoute` bidi proposal/counter loop.
- **Ch10** `GetQuote`/`FindOptimalRoute` with a client deadline; server observes cancellation; propagation to a downstream `QuoteService` call.
- **Ch11** error path returns `NOT_FOUND`/`FAILED_PRECONDITION`/`UNAVAILABLE` with `google.rpc.Status` details; verify asserts code + detail + retryability (retryable `UNAVAILABLE` vs non-retryable `INVALID_ARGUMENT`).
- **Ch12** logging+timing interceptor on both client and server; asserted via a probe RPC.
- **Ch13** `ListRoutes` with page-token pagination + `FieldMask` projection; verify asserts the projected shape.
- **Ch14** evolve `RouteResponse` (add a field, `reserved` a tag, bump to `v2`); `verify.sh` runs `buf breaking` — a deliberate tag reuse **fails** CI; a safe additive edit passes; a BSR/remote-package consumption demo.
- **Ch15** `FindOptimalRoute` doing blocking DB/IO: Quarkus `@Blocking` vs `@RunOnVirtualThread`; Python `grpc.aio` vs thread-pool — measured under `ghz` concurrency; verify asserts no thread starvation.
- **Ch16** `RecomputeRoutes` → `Operation` → `WatchOperation` progress stream + cancel; verify asserts terminal state.
- **Ch17** slow consumer throttles producer (backpressure) on `WatchShipment`; keepalive holds a quiet stream open; verify asserts incremental delivery + throttling.
- **Ch18** keepalive + max-message-size + gzip compression + pooled channels; `ghz` before/after asserts throughput/latency thresholds (loose bounds).
- **Ch19** TLS then mTLS on `RoutingService`; `verify.sh` self-generates certs, connects with a client cert, and asserts plaintext is refused.
- **Ch20** JWT in call metadata; auth interceptor rejects missing/invalid token with `UNAUTHENTICATED`; per-method authz.
- **Ch21** OTel trace spanning REST booking → gRPC `GetQuote` → `QuoteService`, visible in Tempo; Prometheus metrics + gRPC health; verify asserts span presence + metric scrape.
- **Ch22** scale `RoutingService` to 3 replicas; show calls pinning to one pod on a plain Service, fixed by headless+client-LB and by Istio; verify asserts fan-out across replicas over one channel.
- **Ch23** Envoy/grpc-gateway transcodes JSON/HTTP → `GetQuote`; a browser grpc-web client calls it; the REST booking service calls it natively; verify hits both the JSON edge and the internal gRPC path.
- **Ch24** `GetQuote` over h2 (everywhere) and h3 (tier-permitting), measured; verify asserts h2 everywhere, h3 where supported; documents fallback.
- **Ch25** `grpcurl`/`grpcui` reflection probes, `@QuarkusTest` + pytest integration, `ghz` smoke; verify runs the suites green.
- **Ch26** reproduce `UNIMPLEMENTED`/deadline/TLS-handshake/`UNAVAILABLE` failures and diagnose via reflection/channelz/`GRPC_TRACE`.
- **Ch27** capstone: all services, all four RPC modes, deadlines/retries/rich errors, mTLS+JWT, OTel seam, buf-gated, ghz-tested, Compose→minikube; verify asserts the end-to-end booking→route→track flow both stacks.
- **Appendix A** CRC deploy; verify asserts a traced call through an HTTP/2 Route + STRICT mTLS canary.

## Diagrams (one per major concept — ≥2 per full-length chapter from r05 on; paired `.svg`+`.excalidraw` in `assets/diagrams/`)

Generated via the ported `scripts/generate_diagram.py` (lgtm-diagram-generator), house
amber on Red Hat fonts; captions unique and sequential per doc (version-aware sort —
`float("5.10")==5.1` trap noted).

`00-lab-topology` · `01-three-paradigms` · `02-decision-framework` (reused throughout) ·
`03-protobuf-anatomy` (tag-number wire encoding) · `04-wellknown-json-mapping` ·
`05-contract-first-buf-flow` (proto→buf→stubs both stacks→CI gate) ·
`06-http2-multiplexing` (one connection, HPACK, binary vs JSON) · `07-unary-stub-to-stub` ·
`08-server-streaming` · `09-client-bidi-streaming` · `10-deadline-propagation` ·
`11-rich-error-model` (status + `google.rpc.Status` details) · `12-interceptor-chain` ·
`13-schema-design-pagination` · `14-evolution-field-numbers` (buf breaking gate + BSR) ·
`15-concurrency-models` (blocking/reactive/vthreads | asyncio/threads/GIL) ·
`16-operation-lifecycle` · `17-streaming-backpressure` (flow control) · `18-performance-levers` ·
`19-tls-mtls-handshake` · `20-per-call-auth` (JWT metadata interceptor) ·
`21-otel-trace-seam` (REST→gRPC span propagation) · `22-grpc-lb-problem` (L4 single-connection
+ client-side/mesh fix) · `23-grpc-web-transcoding-seam` · `24-http3-crossprotocol` (QUIC vs
TCP HOL) · `25-grpc-test-pyramid` · `26-debug-failure-modes` · `27-capstone-architecture` ·
`A-crc-grpc-routes`.

## Execution phases (checkpoint commit after each; ordered to retire the biggest risk first)

Each code phase runs as a relay: Opus plan in hand → Sonnet executors author one
chapter+example each (with lgtm-idiomatic-review + lgtm-professional-voice in their
validation step) → Opus validates against the acceptance criteria → checkpoint commit
per chapter that lands green.

- **Phase 1 — Contract + CI + behavioral-verify spine** *(retires the top risks; blocks all chapters).*
  Lay out `contracts/proto/shipping/{type,routing,tracking,quote}/v1/*.proto` with real
  services/messages; `buf.yaml` + `buf.gen.yaml` + `buf.lock`; wire
  `.github/workflows/contracts.yml` to run **`buf lint`**, **`buf breaking`** against a
  committed baseline, **generate BOTH stacks**, stand up one real RPC (`GetQuote`) in
  each, and run a `verify.sh` that decodes the response with `grpcurl`+reflection and
  **asserts field values vs the proto**; port `examples/_lib/lib.sh` + the
  `discover-examples` matrix + `examples-summary` gate + the 3× verify retry wrapper; port
  `scripts/generate_diagram.py`, `scripts/validate.py` (front-matter/diagram/coverage +
  cluster-dir-no-verify guard), `scripts/wordcount.sh`; seed `_plans/coverage-matrix.md`
  + `_plans/domain-glossary.md` (gRPC-flavored, continuous with REST); `_config.yml`
  excludes `contracts/` + `examples/` + `presentation/` + `node_modules/`; scaffold both-stack
  skeletons with four-slot codetabs (Go/C++ "coming soon"); **strip all lgtm-jekyll /
  REST / eBPF template residue** from `index.html` + placeholder chapters. **Then land the
  Ch5 anchor** (unary `GetQuote`, both stacks, traced on Compose). Commit
  `ci: contract-first proto + buf + behavioral-verify spine`.
- **Phase 2 — r01 content:** Parts 0–2 (Ch0–5) prose + both-stack examples + concept diagrams + deck-map seed. **r01 ships: it runs and is traced end to end.**
- **Phase 3 — r02:** Part 3 (Ch6–9). Proves dual-stack codegen parity and the four-RPC-mode harness on real content.
- **Phase 4 — r03:** Parts 4–6 (Ch10–16). Ch14 hardens the `buf breaking` gate with a deliberate-drift test; streaming backpressure assertions land.
- **Phase 5 — r04:** Parts 7–8 (Ch17–20). Concurrency + perf (`ghz`) + TLS/mTLS cert bootstrap in CI.
- **Phase 6 — r05:** Parts 9–11 (Ch21–26). Ch22 retires the K8s single-connection load-balancing risk; Ch23 retires gRPC-Web/transcoding; Ch24 handles HTTP/3 honestly.
- **Phase 7 — r06:** Part 12 (Ch27 + Appendix A) — minikube + capstone + CRC via lgtm-minikube-stack / lgtm-crc.
- **Phase 8 — Decks + polish + release:** build **three decks** via lgtm-presentation — a
  100-level "Protobuf & gRPC" concepts deck, a 201 Quarkus-implementation deck, a 201
  Python-implementation deck (diagrams AND code on slides; overflow → appendix slides).
  Run lgtm-idiomatic-review (Quarkus + Python checklists; Go/C++ ready) and
  lgtm-professional-voice across site and decks. Hub: hand-add the entry to
  `patterncatalyst-workshops-tutorials-list/_data/sites.yml` and the 6 reference books to
  `_data/books.yml` (**do NOT run `gen-books.py` — it clobbers curated data**). Tag +
  release via lgtm-github.

**"Shippable r01"** = Jekyll builds clean with Parts 0–2 authored to depth; the proto
contract exists and CI lints it, runs `buf breaking`, and validates BOTH stacks against
it on Compose; every r01 [H] chapter has verified-run Quarkus + Python examples whose
`verify.sh` asserts response *semantics*; r01 diagrams paired; nav/cards resolve; zero
template residue; one unary RPC running and traced end to end through LGTM.

## Acceptance criteria

1. `docker/podman compose up` brings up a gRPC service + LGTM; one RPC is traced end to end in Tempo (met in r01).
2. Every `examples/*/verify.sh` calls the running service (grpcurl/client) and asserts **response field semantics** against the proto — not just a status; a deliberately wrong field value **fails** the build.
3. Both stacks (Quarkus + Python) exist for every [H] chapter and pass the **same** `verify.sh`, generated from the **same** `.proto`.
4. `buf lint` passes and `buf breaking` runs against a committed baseline on every push; a deliberate breaking change (reused tag / changed type) **fails** CI; a safe additive edit passes.
5. Codetab shells and the `contracts/proto/` layout accept a `go/` or `cpp/` stack with no proto or harness change (demonstrated by a stubbed discovery entry).
6. `_plans/coverage-matrix.md` maps every PRD/user topic to a chapter; CI fails on a missing mapped-and-claimed file.
7. Each chapter clears the 2,000-word floor (`scripts/wordcount.sh`; 2,000–2,500 is a soft target, over-target warns not fails); every chapter embeds paired SVG+.excalidraw figures — one per major concept, ≥2 for a full-length chapter (r05 on); the verification footer flips only on green in both stacks.
8. `bundle exec jekyll build` green on every push; no lgtm-jekyll / REST / eBPF template residue.
9. Runs on all three tiers: Compose (Ch27), minikube with the LB problem demonstrated and fixed (Ch22/Ch27), CRC (Appendix A), each with a traced call.
10. All four RPC types are implemented and verified (unary Ch5/7; server/client/bidi Ch8/9); Ch17 asserts streaming order/completion + backpressure.
11. Ch18/Ch25 run a `ghz` load test green in CI; Ch19 refuses plaintext and requires a client cert; Ch20 rejects a missing JWT with `UNAUTHENTICATED`.
12. All Quarkus content builds and `@QuarkusTest`-passes on current `quarkus-grpc` / Java 25 (no stale borrowed-doc claims).
13. Three decks build via lgtm-presentation and cover every mapped topic; lgtm-professional-voice + lgtm-idiomatic-review report zero flagged items.
14. Hub `_data/sites.yml` has a live entry and `_data/books.yml` lists all 6 reference books (hand-edited); release PR to `main` is green and deploys.
15. **Pedagogical:** each Part's "After this part, the reader can…" maps to a concrete artifact; the Decision Framework (Ch2) recurs as a "Decision" callout and is defended in Ch27; every [H] chapter ends with an "On the wire" box matching its `verify.sh`.

## Resolved decisions (fixed product facts, stated as decisions)

- **Contract spine:** Protocol Buffers; `.proto` in `contracts/proto/` is the single source of truth; **Buf** (`buf lint` + `buf breaking`) is the CI gate, `buf breaking` being the drift/evolution analog to REST's schema-drift gate. ✅
- **Verification:** each [H] ships a `verify.sh` that calls the running service (grpcurl/client) and asserts response semantics against the proto, not just a status. ✅
- **Stacks:** BOTH Quarkus (`quarkus-grpc`, UBI 10, Java 25) **and** Python (`grpcio`/`grpcio-tools`, Python 3.14, **uv** — not Poetry) per [H] chapter; four-slot codetabs + example layout architected so **Go and C++ drop in later**. ✅
- **Domain:** shared shipping/cargo, continuous with the REST site; gRPC is the internal routing + tracking hot-path (+ a small QuoteService) the REST booking service calls; the **REST→gRPC seam** is shown throughout; glossary nouns reused. ✅
- **Runtime tiers:** Docker Compose → minikube → CRC appendix (skills lgtm-docker-stack, lgtm-minikube-stack, lgtm-crc); observability via LGTM + OpenTelemetry. ✅
- **Granularity:** 28 chapters (Ch0–Ch27) + CRC appendix across 13 parts — REST-parity depth (REST = 27 + appendix / 12 parts); one extra part reflects gRPC's larger protocol-mechanics surface and smaller HTTP-semantics surface. ✅
- **Decks:** three via lgtm-presentation — 100-level Protobuf & gRPC concepts, 201 Quarkus, 201 Python — diagrams + code on slides, overflow → appendix slides. ✅
- **Teaching devices:** the gRPC Decision Framework (Ch2) + per-[H] "On the wire" box + "REST seam" callout + per-Part capability headers. ✅
- **Gates:** lgtm-idiomatic-review + lgtm-professional-voice in the validation phase of every content iteration. ✅
- **Borrowed Quarkus content is re-verified against current `quarkus-grpc`, never trusted as-is.** ✅
- **Hub addition hand-edited** (`sites.yml` + 6 books into `books.yml`); the base `gen-books.py` is not run. ✅

## Reference books (bibliography)

| Book | Author(s) | Publisher | Use |
|---|---|---|---|
| *gRPC Microservices in Go* | Hüseyin Babal | Packt | Performance, scaling, worked service patterns |
| *gRPC Go for Professionals* | Clément Jean | Packt | Protobuf language, schema design, evolution |
| *Building Microservices* (2e) | Sam Newman | O'Reilly | Resilient distributed systems, inter-service calls |
| grpc.io official docs | — | CNCF | Canonical RPC/channel/deadline/error reference |
| Cloud Native Design Patterns (our site) gRPC sections | PatternCatalyst | — | Paradigms, stub-to-stub, why-fast, versioning, errors |
| Quarkus gRPC guides (`/guides/grpc`, `/guides/grpc-reference`) | Quarkus | Red Hat | quarkus-grpc specifics (re-verified) |

## Risks (ordered biggest-first; detection → retiring phase)

1. **Behavioral verification over binary HTTP/2 is hard** — an `OK` can carry a wrong-shaped message. `verify.sh` decodes responses via grpcurl+reflection (or a generated probe client) and asserts field values; a seeded wrong-value case must fail. *Retired Phase 1.*
2. **`buf breaking` gate not wired / no baseline** — without a committed baseline the evolution chapters have no teeth. CI `buf breaking` against a baseline + a deliberate tag-reuse test. *Retired Phase 1, hardened Ch14/Phase 4.*
3. **Dual-stack codegen divergence** — Quarkus (Mutiny stubs) and Python (`grpcio-tools`/`buf generate`) can drift in generated APIs or WKT handling. Both stacks generated in CI from the same proto and run through the same `verify.sh`. *Retired Phase 1, proven Phase 3.*
4. **Borrowed quarkus-grpc prose is stale** (recent updates) — re-verify every borrowed snippet against current `quarkus-grpc` via the `quarkus-agent` MCP before authoring; the compiled example is the canary. *Gated every content phase.*
5. **Streaming semantics hard to assert in CI** — `verify.sh` counts/asserts streamed messages + ordering + a slow-consumer backpressure check. *Retired Phase 3 (Ch8/9) / Phase 4 (Ch17).*
6. **The K8s single-connection load-balancing problem** — gRPC multiplexes over one long-lived HTTP/2 connection, so a plain L4 Service pins all calls to one pod. Ch22 scales to 3 replicas, shows the pin, then fixes it (headless+client-LB and Istio); verify asserts fan-out. *Retired Phase 6 (Ch22), re-shown in the capstone.*
7. **gRPC-Web / transcoding plumbing is fiddly** — Ch23 `verify.sh` drives the method through the gRPC-Web proxy and the REST-transcoded path. *Retired Phase 6 (Ch23).*
8. **gRPC-over-HTTP/3 is nascent** — support is uneven across Quarkus/Python/proxies. Ch24 tier-gates h3, verifies h2 everywhere, measures h3 only where it stands up, documents fallback. *Retired Phase 6 (Ch24).*
9. **TLS/mTLS cert bootstrap in CI/Compose flakes** — Ch19 `verify.sh` self-generates certs, connects with a client cert, asserts plaintext is refused. *Retired Phase 5 (Ch19).*
10. **`ghz` thresholds flaky in CI** — assert loose/relative bounds with the contracts.yml 3-attempt retry; pin the image. *Phases 5/6.*
11. **Python 3.14 free-threaded / grpcio wheel availability** — pin in Ch0 Containerfiles; CI build is the canary; document the GIL-vs-free-threaded measured caveat in Ch15. *Phase 1, watched after.*
12. **Scope overrun (28 ch × 2 stacks)** — r01–r06 cadence; each iteration independently shippable; coverage matrix is the burndown. *Managed every phase.*
13. **Toolchain pin drift** (UBI 10 / Java 25, Python 3.14 / uv, buf, grpc versions) — pinned in Ch0 + Containerfiles; the CI build is the canary. *Retired Phase 1, watched after.*
14. **Hub `gen-books.py` clobbers curated data** — Phase 8 hand-edits `sites.yml`/`books.yml`; never invoke the generator. *Retired Phase 8.*

## Source decks to mine (Notion PRD)

- "API Patterns and Practices gRPC (Final)" (Google Slides, mod 2024-04-09)
- "Quarkus Communication with gRPC (Final)" (Google Slides, mod 2026-05-30)

Both to be mined for the three decks and the chapter examples; Quarkus deck content
re-verified against current `quarkus-grpc`.
