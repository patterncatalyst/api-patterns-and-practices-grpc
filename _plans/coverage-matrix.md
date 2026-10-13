---
title: "Coverage Matrix"
layout: plan
render_with_liquid: false
---

# Coverage Matrix

Every PRD/user topic maps to exactly one chapter. `scripts/validate.py` reads this
file and fails CI when a chapter whose **Status is not `planned`** is missing its
`_docs/*.md` file — so coverage is authored incrementally (all rows start `planned`)
while still guaranteeing no mapped-and-claimed chapter silently disappears.

**Status legend:** `planned` (file not yet written) · `draft` (prose in, unverified) ·
`verified` (both stacks run green, footer flipped).

## Topics → chapters

| # | Topic | Chapter | File | Status |
|---|---|---|---|---|
| T1 | Why gRPC / three paradigms / stub-to-stub | Ch1 | `_docs/01-from-rest-to-rpc.md` | draft |
| T2 | gRPC decision framework (5 axes) | Ch2 | `_docs/02-grpc-decision-framework.md` | draft |
| T3 | Full protobuf coverage + wire encoding | Ch3 | `_docs/03-protobuf-in-depth.md` | verified |
| T4 | Well-known types & JSON mapping | Ch4 | `_docs/04-well-known-types-json-mapping.md` | verified |
| T5 | Buf (lint/build/breaking) + contract-first anchor | Ch5 | `_docs/05-contract-first-with-buf.md` | verified |
| T6 | HTTP/2 foundation + binary vs JSON | Ch6 | `_docs/06-http2-foundation.md` | verified |
| T7 | Unary RPCs + channels/stubs | Ch7 | `_docs/07-unary-rpcs.md` | verified |
| T8 | Server-streaming | Ch8 | `_docs/08-server-streaming.md` | verified |
| T9 | Client-streaming + bidirectional | Ch9 | `_docs/09-client-and-bidi-streaming.md` | verified |
| T10 | Deadlines / timeouts / cancellation | Ch10 | `_docs/10-deadlines-cancellation.md` | verified |
| T11 | Error handling + rich error model + retries | Ch11 | `_docs/11-error-handling.md` | verified |
| T12 | Interceptors | Ch12 | `_docs/12-interceptors.md` | verified |
| T13 | Schema design + pagination + FieldMask | Ch13 | `_docs/13-schema-design.md` | planned |
| T14 | Evolution / versioning + buf breaking + BSR | Ch14 | `_docs/14-evolution-and-versioning.md` | planned |
| T15 | Backend I/O concurrency | Ch15 | `_docs/15-backend-io-concurrency.md` | planned |
| T16 | Async / long-running jobs | Ch16 | `_docs/16-async-long-running-jobs.md` | planned |
| T17 | Streaming at scale + flow control / backpressure | Ch17 | `_docs/17-streaming-at-scale.md` | planned |
| T18 | Performance tuning + ghz | Ch18 | `_docs/18-performance-tuning.md` | planned |
| T19 | TLS / mTLS | Ch19 | `_docs/19-tls-mtls.md` | planned |
| T20 | AuthN / AuthZ (JWT/OAuth2, per-call, interceptors) | Ch20 | `_docs/20-authn-authz.md` | planned |
| T21 | Observability (OTel / Prometheus / Grafana / Tempo) | Ch21 | `_docs/21-observability.md` | planned |
| T22 | Load balancing & service mesh (the L4 problem) | Ch22 | `_docs/22-load-balancing-service-mesh.md` | planned |
| T23 | gRPC-Web & JSON/HTTP transcoding | Ch23 | `_docs/23-grpc-web-transcoding.md` | planned |
| T24 | Cross-protocol choices + HTTP/3 | Ch24 | `_docs/24-cross-protocol-http3.md` | planned |
| T25 | Testing & CLI (grpcurl/grpcui/QuarkusTest/pytest/ghz) | Ch25 | `_docs/25-testing-and-cli.md` | planned |
| T26 | Debugging gRPC | Ch26 | `_docs/26-debugging-grpc.md` | planned |
| T27 | Complete project (capstone) | Ch27 | `_docs/27-complete-project.md` | planned |

## Runtime-tier topics → chapters

| # | Topic | Chapter | File | Status |
|---|---|---|---|---|
| R1 | Docker/Podman Compose tier | Ch0 / Ch5 | `_docs/00-prerequisites-and-the-lab.md` | verified |
| R2 | minikube tier (+ the LB problem) | Ch22 / Ch27 | `_docs/22-load-balancing-service-mesh.md` | planned |
| R3 | CRC / OpenShift Local tier | Appendix A | `_docs/99-appendix-a-openshift-crc.md` | planned |

## Full chapter inventory (28 + appendix)

| Ch | File | Part | Status |
|---|---|---|---|
| 0 | `_docs/00-prerequisites-and-the-lab.md` | Part 0 | verified |
| 1 | `_docs/01-from-rest-to-rpc.md` | Part 1 | draft |
| 2 | `_docs/02-grpc-decision-framework.md` | Part 1 | draft |
| 3 | `_docs/03-protobuf-in-depth.md` | Part 2 | verified |
| 4 | `_docs/04-well-known-types-json-mapping.md` | Part 2 | verified |
| 5 | `_docs/05-contract-first-with-buf.md` | Part 2 | verified |
| 6 | `_docs/06-http2-foundation.md` | Part 3 | verified |
| 7 | `_docs/07-unary-rpcs.md` | Part 3 | verified |
| 8 | `_docs/08-server-streaming.md` | Part 3 | verified |
| 9 | `_docs/09-client-and-bidi-streaming.md` | Part 3 | verified |
| 10 | `_docs/10-deadlines-cancellation.md` | Part 4 | verified |
| 11 | `_docs/11-error-handling.md` | Part 4 | verified |
| 12 | `_docs/12-interceptors.md` | Part 4 | verified |
| 13 | `_docs/13-schema-design.md` | Part 5 | planned |
| 14 | `_docs/14-evolution-and-versioning.md` | Part 5 | planned |
| 15 | `_docs/15-backend-io-concurrency.md` | Part 6 | planned |
| 16 | `_docs/16-async-long-running-jobs.md` | Part 6 | planned |
| 17 | `_docs/17-streaming-at-scale.md` | Part 7 | planned |
| 18 | `_docs/18-performance-tuning.md` | Part 7 | planned |
| 19 | `_docs/19-tls-mtls.md` | Part 8 | planned |
| 20 | `_docs/20-authn-authz.md` | Part 8 | planned |
| 21 | `_docs/21-observability.md` | Part 9 | planned |
| 22 | `_docs/22-load-balancing-service-mesh.md` | Part 9 | planned |
| 23 | `_docs/23-grpc-web-transcoding.md` | Part 10 | planned |
| 24 | `_docs/24-cross-protocol-http3.md` | Part 10 | planned |
| 25 | `_docs/25-testing-and-cli.md` | Part 11 | planned |
| 26 | `_docs/26-debugging-grpc.md` | Part 11 | planned |
| 27 | `_docs/27-complete-project.md` | Part 12 | planned |
| A | `_docs/99-appendix-a-openshift-crc.md` | Part 12 | planned |
