---
title: "Verification log"
layout: plan
render_with_liquid: false
---

Verification-status notes removed from reader-facing chapters (site chrome shows reader content only; these are banked here in the unrendered plans collection). One section per chapter, verbatim.

## 15-backend-io-concurrency

*Verification status: <span class="status status--unverified">unverified</span>.
`verify.sh` ran green against both stacks on the authoring machine (a 22-core
host), including the eight-concurrent-call overlap and starve-vs-scale
assertions, across repeated runs; the highest-risk things a reader's own run
should confirm are that the timing margins (`< 2.5s`,
`correct_total * 2 < starving_total`) hold on meaningfully slower or more
contended hardware, and that `Vertx#getOrCreateContext()`'s single-context
behavior (what `starvingContext()` depends on to make the starving path's
serialization reproducible regardless of host core count) continues to
return the same context on repeated calls across future Quarkus/Vert.x
point releases.*


## 17-streaming-at-scale

*Verification status: <span class="status status--unverified">unverified</span>.
`verify.sh` ran green against both stacks on the authoring machine, including
the count/order/fields check, the incremental-delivery lower bound, the
slow-consumer backpressure relative gate, and the keepalive quiet-stream
check — a real run measured `bkg_demo`'s consecutive deltas at roughly 260ms
and `bkg_eager`'s at microseconds, comfortably clearing the assertions'
margins. The highest-risk things a reader's own run should confirm: that the
`~200ms` and `~0.6s` timing floors hold on meaningfully slower or more
contended hardware than the authoring machine, and that the
`MultiEmitter.onRequest` prefetch-timing detail this chapter documents (the
generated bridge's initial `request(256)` landing before `onRequest` is
registered) holds across future `quarkus-grpc` releases rather than being an
implementation detail of the pinned 3.40.1 version this chapter verified
against.*


## 18-performance-tuning

*Verification status: <span class="status status--unverified">unverified</span>.
`verify.sh` ran green against both stacks on the authoring machine across
repeated runs, including the channel-reuse ratio, the max-message-size
`RESOURCE_EXHAUSTED`-then-succeeds pair, the gzip functional check, the
keepalive idle-gap survival, and the `ghz` loose bounds. The highest-risk
things a reader's own run should confirm: that the channel-reuse factor
(`footgun_total > pooled_total * 1.8`) and the `ghz` bounds (`p99 < 1.5s`,
`rps > 20`) hold on meaningfully slower or more contended hardware than the
authoring machine, and that the exact channel-argument strings this chapter
cites for `grpcio` 1.83 (`grpc.keepalive_time_ms`,
`grpc.http2.min_ping_interval_without_data_ms`, and the rest) and the
`quarkus-grpc` 3.40.1 config keys this chapter cites continue to resolve
identically on a future point release of either.*


## 19-tls-mtls

*Verification status: <span class="status status--unverified">unverified</span>.
`verify.sh` ran green against both stacks on the authoring machine across
repeated runs, including both the TLS-only phase (CA-only success, plaintext
refused) and the mTLS phase (client-cert success, CA-only rejected) on each
of Quarkus and Python. The highest-risk things a reader's own run should
confirm: that `registry.access.redhat.com/ubi10/ubi-minimal` continues to
ship a `java-21-openjdk-headless` package reachable via `microdnf` (re-check
with `skopeo list-tags` before bumping the pin, same discipline as this
book's other base-image pins), that the exact `quarkus.grpc.server.ssl.*`
keys and the PKCS12-trust-store gotcha this chapter documents continue to
hold on a future `quarkus-grpc` point release, and that a Docker Engine
other than the Linux-native one this book was authored against still
produces host-readable files under the `certs` named volume's bind-mounted
export directory.*


## 20-authn-authz

*Verification status: <span class="status status--verified">verified</span>. `examples/20-authn-authz/verify.sh` was run end to end against both stacks: reflection answered with no token, a `valid` token returned the correct `GetQuote` quote, a missing/bad-signature/expired token was rejected with `UNAUTHENTICATED` in every case, and a `wrong-scope` token calling `ListRoutes` was rejected with `PERMISSION_DENIED` — on both Quarkus (port 9200) and Python (port 9201). The cross-check's HMAC computation was independently confirmed against a freshly-minted `valid` token using Python's stdlib `hmac`/`hashlib` (matching signature byte for byte); the `openssl` CLI form shown above was not re-run in the authoring sandbox, which has no `openssl` binary installed — confirm it with a local `openssl` before relying on that exact command.*


## 21-observability

*Verification status: <span class="status status--verified">verified</span>. `examples/21-observability/verify.sh` was run end to end against both stacks, twice, with the always-on `lgtm` service included in the bring-up: `POST /booking/quote` returned the correct quote (`USD`/`2500.00`/`rte_USNYC-NLRTM`/`MAERSK`) on both Quarkus (port 8210) and Python (port 8211); the SAME trace id appeared in a Routing-handler log line and a Quote-handler log line in each stack's own `docker compose logs` output; Tempo's `/api/traces/<id>` endpoint showed three distinct `service.name`/`rpc.service` values per trace on both runs (exceeding the two-service-minimum the check requires); each app's own metrics endpoint (`/q/metrics` on Quarkus, `/metrics` on Python) showed a nonzero gRPC server metric count; and `grpc.health.v1.Health/Check` answered `SERVING` on both stacks. One real defect was found and fixed during this verification, not assumed away: the `grafana/otel-lgtm:0.36.0` image has no `wget` binary, so its healthcheck was changed to `curl`; and the Python health servicer had to use `grpc_health.v1.health.aio.HealthServicer`, not the classic synchronous one, to work under `grpc.aio`.*


## 22-load-balancing-service-mesh

*Verification status: <span class="status status--unverified">unverified</span>.
This example runs on minikube by hand, never in CI — `scripts/validate.py`'s
`cluster-dir-no-verify` check confirms no `verify.sh` exists under
`examples/22-mesh-loadbalancing/` to be auto-discovered by the clusterless
`examples` matrix, and the `k8s-manifests` CI job validates only that
`k8s/`'s four resources are schema-correct, never that the demo's claims
hold on a live cluster. All three phases, the STRICT mTLS rejection, and
the native-sidecar Job-completion behavior described in this chapter were
run on an actual minikube cluster, v1.39.0 (docker driver, containerd), with
Kubernetes v1.34.0 and a self-downloaded, pinned Istio 1.31.1 — see
`examples/22-mesh-loadbalancing/expected-output.md` for the complete
recorded transcript this chapter's numbers are drawn from. The highest-risk
things a reader's own run should confirm: that Kubernetes v1.34.0 stays
inside whatever Kubernetes range the Istio release they install officially
supports (re-check both projects' release notes before bumping either),
that `registry.access.redhat.com/ubi10/python-314-minimal:10.2-1791464217`
continues to resolve (re-check with `skopeo list-tags` first, same
discipline as Chapter 7's and Chapter 19's identical pin), and that a
minikube profile on a machine with less than the roughly 4 CPU / 6 GiB this
chapter's `bootstrap.sh` requests still schedules Istio's control plane and
three application replicas without eviction.*


## 23-grpc-web-transcoding

*Verification status: <span class="status status--verified">verified</span>.
`./verify.sh` was run end to end against a real Docker Engine: both app
stacks and both Envoy containers built and started, and native gRPC, the
REST shim, the JSON/HTTP transcoder, and the grpc-web filter all returned the
expected quote on both the Quarkus and the Python stack, including the
non-fatal malformed-JSON -> HTTP 400 check.*


## 24-cross-protocol-http3

*Verification status: <span class="status status--unverified">unverified</span>.
`verify.sh` ran green against both stacks on the authoring machine across
repeated runs, including the `GetQuote` correctness checks, the `ghz`
measured baseline (both stacks comfortably inside the loose bounds quoted
above), and the HTTP/3 transport probe, which completed a real QUIC
handshake and received a 200 from Caddy every time it was run. The
highest-risk things a reader's own run should confirm: that the `ghz`
bounds (`p99 < 1.5s`, `rps > 20`) hold on meaningfully slower or more
contended hardware than the authoring machine; that the HTTP/3 transport
probe's non-fatal `SKIP` path, exercised only by simulating a UDP-blocked
network during authoring, behaves as described on a CI runner that blocks
UDP outright; and that the claim at this chapter's center — that grpc-java and
grpcio have no native gRPC-over-HTTP/3 transport — still holds against
whatever release of either project a reader is running, since this is
exactly the kind of gap an upstream project can close in a later release.*


## 25-testing-and-cli

*Verification status: <span class="status status--unverified">unverified</span>.
`verify.sh` ran green against both stacks on the authoring machine across
repeated runs, including `GetQuote` correctness, the reflection
`list`/`describe` probe, the one-shot `mvn test`/`pytest` re-run, and the
`ghz` loose bounds; the build-stage gate was separately confirmed to fail
the image build with a seeded wrong assertion in each stack's suite, then
reverted. The highest-risk things a reader's own run should confirm: that
`@GrpcClient`'s no-configuration self-wiring inside `@QuarkusTest` and the
`grpc.aio` ephemeral-port fixture pattern continue to resolve identically
on a future point release of `quarkus-grpc` or `grpcio`, that
`grpcio-reflection`'s method-symbol limitation documented above hasn't
changed upstream, and that the `ghz` bounds (`p99 < 1.5s`, `rps > 20`) hold
on meaningfully slower or more contended hardware than the authoring
machine.*


## 26-debugging-grpc

*Verification status: <span class="status status--verified">verified</span>.
`examples/26-debugging/verify.sh` was run end to end against both stacks: the
baseline `GetQuote` correctness check passed on both; `FindOptimalRoute`
failed `UNIMPLEMENTED` on both; a 1-second deadline against the
artificially-delayed `GetQuote` failed `DEADLINE_EXCEEDED` on both (a 5-second
deadline succeeded on both); a call against each stack's own closed port
9999 failed with `grpc.StatusCode.UNAVAILABLE`; a TLS-defaulting `grpcurl`
call against each plaintext server failed at the handshake
(`tls: first record does not look like a TLS handshake`); reflection's
service-level `list`/`describe` succeeded on both, and the method-level
`describe` asymmetry between `grpc-java` and `grpcio-reflection` documented
above was reproduced directly, not inferred; channelz's `GetServers`
returned live server data on the Python stack; and `GRPC_TRACE`/
`GRPC_VERBOSITY` produced non-empty C-core trace output from a grpc-python
caller against both stacks. The `GRPC_TRACE`/`GRPC_VERBOSITY` log lines
quoted above are copied verbatim (four lines selected out of 60+ total) from
one real captured run — a reader's own run will show the same four kinds of
line with different timestamps, thread IDs, and object addresses, since
those vary every run by construction, and `verify.sh` asserts only that
output appeared at all, not these exact bytes.*


## 99-appendix-a-openshift-crc

*Verification status: <span class="status status--unverified">unverified</span>.
This appendix runs on OpenShift Local by hand, never in CI — `scripts/validate.py`'s
`cluster-dir-no-verify` check confirms no `verify.sh` exists under
`examples/99-appendix-a-openshift-crc/` to be auto-discovered by the clusterless
`examples` matrix, and the `k8s-manifests` CI job validates only that `helm/`
lints and templates to schema-valid resources, never that any of this
chapter's live-cluster claims hold. On 2026-10-14, against a real CRC 2.64.0 /
OpenShift 4.22.14 instance (12 vCPU / 32 GiB), this run actually: installed
both operators pinned (`servicemeshoperator3.v3.4.3`,
`opentelemetry-operator.v0.158.0-3`); built `getquote:v1` in-cluster via
binary S2I; deployed the workload under `restricted-v2` with the Istio
sidecar and the OpenTelemetry Java agent both injected; confirmed, with the
router's own generated HAProxy configuration, that an edge-terminated
Route cannot complete a native gRPC client's TLS handshake on this
OpenShift version regardless of the `h2c-enable` annotation; got a real
`GetQuote` response through a passthrough Route once the pod briefly
terminated its own TLS (mesh off, a diagnostic-only chart flag); confirmed
STRICT `PeerAuthentication` times out a plaintext caller once the
Route-facing PERMISSIVE carve-out was temporarily removed; measured a
29/30-to-1/30 canary split against a configured 10% weight; and captured a
real OpenTelemetry span for `shipping.quote.v1.QuoteService/GetQuote` after
correcting the exporter's protocol/port mismatch. CRC was left running in
this deployed state rather than torn down. What this run did **not**
establish: a tight confirmation of the 90/10 canary ratio (one sample in
thirty is directionally consistent, not statistically precise), and a
native gRPC client completing a call through edge or reencrypt termination
on any OpenShift version other than the one tested — both are named
explicitly, with the exact commands and output, in
`examples/99-appendix-a-openshift-crc/expected-output.md`. A reader's own
run should re-check both pinned operator CSVs against `oc get
packagemanifest` before starting (OLM catalogs drift), and re-confirm the
router's ALPN behavior if running against a newer OpenShift release, since
this is exactly the kind of platform-internal detail a future OpenShift
version could change.*


