---
title: "Outline"
order: 0
overview: true
part: "Prerequisites & the Lab"
description: "What this site covers and how it's organized — 28 chapters across 13 parts, both stacks against one Protobuf contract."
---

This site teaches gRPC API design against a single Protocol Buffers contract for a
shipping and cargo domain. gRPC here is the internal, latency-sensitive routing and
tracking service that the sibling REST booking service calls. Every hands-on chapter
ships the same example in **both Quarkus and Python**, generated from the same proto,
and CI asserts each response against the contract so the two stacks never drift. The
full arc is below; the build &amp; iteration plan, coverage matrix and domain glossary
(linked in the footer) carry the detail.

## Part 0 — Prerequisites & the Lab
- [Ch0 · Prerequisites & the lab](../00-prerequisites-and-the-lab/)

## Part 1 — Why gRPC, and the Decision Lens
- [Ch1 · From REST to RPC](../01-from-rest-to-rpc/)
- [Ch2 · The gRPC decision framework](../02-grpc-decision-framework/)

## Part 2 — Protocol Buffers: the Contract Language
- [Ch3 · Protocol Buffers in depth](../03-protobuf-in-depth/)
- [Ch4 · Well-known types and JSON mapping](../04-well-known-types-json-mapping/)
- [Ch5 · Contract-first with Buf](../05-contract-first-with-buf/)

## Part 3 — HTTP/2 & the Four RPC Types
- [Ch6 · HTTP/2 foundation and why gRPC is fast](../06-http2-foundation/)
- [Ch7 · Unary RPCs and the generated code](../07-unary-rpcs/)
- [Ch8 · Server-streaming](../08-server-streaming/)
- [Ch9 · Client-streaming and bidirectional](../09-client-and-bidi-streaming/)

## Part 4 — Reliability: Deadlines, Errors & Interceptors
- [Ch10 · Deadlines, timeouts and cancellation](../10-deadlines-cancellation/)
- [Ch11 · Error and exception handling](../11-error-handling/)
- [Ch12 · Interceptors](../12-interceptors/)

## Part 5 — Schema Evolution & the Living Contract
- [Ch13 · Schema design over gRPC](../13-schema-design/)
- [Ch14 · Evolution and versioning](../14-evolution-and-versioning/)

## Part 6 — Concurrency & Long-Running Work
- [Ch15 · Backend I/O concurrency](../15-backend-io-concurrency/)
- [Ch16 · Async and long-running jobs over gRPC](../16-async-long-running-jobs/)

## Part 7 — Streaming at Scale & Performance
- [Ch17 · Streaming deep-dive](../17-streaming-at-scale/)
- [Ch18 · Performance and tuning](../18-performance-tuning/)

## Part 8 — Security
- [Ch19 · TLS and mTLS](../19-tls-mtls/)
- [Ch20 · AuthN and AuthZ](../20-authn-authz/)

## Part 9 — Observability, Mesh & Load Balancing
- [Ch21 · Observability](../21-observability/)
- [Ch22 · Load balancing and service mesh](../22-load-balancing-service-mesh/)

## Part 10 — Browsers, Transcoding & Cross-Protocol
- [Ch23 · gRPC-Web and JSON transcoding](../23-grpc-web-transcoding/)
- [Ch24 · Cross-protocol choices and HTTP/3](../24-cross-protocol-http3/)

## Part 11 — Testing & Debugging
- [Ch25 · Testing and the CLI](../25-testing-and-cli/)
- [Ch26 · Debugging gRPC](../26-debugging-grpc/)

## Part 12 — Running It & the Capstone
- [Ch27 · The complete project](../27-complete-project/)
- [Appendix A · OpenShift Local (CRC)](../99-appendix-a-openshift-crc/)
