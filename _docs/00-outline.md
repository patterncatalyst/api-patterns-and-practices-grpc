---
title: "Outline"
order: 0
overview: true
part: "Prerequisites & the Lab"
description: "What this site covers and how it's organized: 28 chapters across 13 parts, both stacks against one Protobuf contract."
---

This site teaches gRPC API design against a single Protocol Buffers contract for a
shipping and cargo domain. gRPC here is the internal, latency-sensitive routing and
tracking service that the sibling REST booking service calls. Every hands-on chapter
ships the same example in **both Quarkus and Python**, generated from the same proto,
and CI asserts each response against the contract so the two stacks never drift. The
full arc is below.

## Part 0: Prerequisites & the Lab
- [Prerequisites & the lab](../00-prerequisites-and-the-lab/)

## Part 1: Why gRPC, and the Decision Lens
- [From REST to RPC](../01-from-rest-to-rpc/)
- [The gRPC decision framework](../02-grpc-decision-framework/)

## Part 2: Protocol Buffers: the Contract Language
- [Protocol Buffers in depth](../03-protobuf-in-depth/)
- [Well-known types and JSON mapping](../04-well-known-types-json-mapping/)
- [Contract-first with Buf](../05-contract-first-with-buf/)

## Part 3: HTTP/2 & the Four RPC Types
- [HTTP/2 foundation and why gRPC is fast](../06-http2-foundation/)
- [Unary RPCs and the generated code](../07-unary-rpcs/)
- [Server-streaming](../08-server-streaming/)
- [Client-streaming and bidirectional](../09-client-and-bidi-streaming/)

## Part 4: Reliability: Deadlines, Errors & Interceptors
- [Deadlines, timeouts and cancellation](../10-deadlines-cancellation/)
- [Error and exception handling](../11-error-handling/)
- [Interceptors](../12-interceptors/)

## Part 5: Schema Evolution & the Living Contract
- [Schema design over gRPC](../13-schema-design/)
- [Evolution and versioning](../14-evolution-and-versioning/)

## Part 6: Concurrency & Long-Running Work
- [Backend I/O concurrency](../15-backend-io-concurrency/)
- [Async and long-running jobs over gRPC](../16-async-long-running-jobs/)

## Part 7: Streaming at Scale & Performance
- [Streaming deep-dive](../17-streaming-at-scale/)
- [Performance and tuning](../18-performance-tuning/)

## Part 8: Security
- [TLS and mTLS](../19-tls-mtls/)
- [AuthN and AuthZ](../20-authn-authz/)

## Part 9: Observability, Mesh & Load Balancing
- [Observability](../21-observability/)
- [Load balancing and service mesh](../22-load-balancing-service-mesh/)

## Part 10: Browsers, Transcoding & Cross-Protocol
- [gRPC-Web and JSON transcoding](../23-grpc-web-transcoding/)
- [Cross-protocol choices and HTTP/3](../24-cross-protocol-http3/)

## Part 11: Testing & Debugging
- [Testing and the CLI](../25-testing-and-cli/)
- [Debugging gRPC](../26-debugging-grpc/)

## Part 12: Running It & the Final Project
- [The final project](../27-complete-project/)
- [Appendix A · OpenShift Local (CRC)](../99-appendix-a-openshift-crc/)
