---
title: "Appendix A — OpenShift Local (CRC)"
order: 99
part: "Running It & the Final Project"
appendix: true
appendix_label: "A"
description: "Run the gRPC services on OpenShift Local (CRC): gRPC over Routes with h2c, edge, or passthrough TLS, an in-cluster image build, and OpenShift Service Mesh STRICT mTLS with a canary."
duration: "24 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why an edge- or reencrypt-terminated OpenShift Route can't complete a native gRPC client's ALPN-negotiated TLS handshake, and when to reach for `passthrough` instead.
- Build and push a Quarkus image inside the cluster via binary S2I (`BuildConfig`/`ImageStream`), and name the two Quarkus properties (`quarkus.openshift.namespace`, `quarkus.openshift.version`) that commonly get this wrong.
- Configure OpenShift Service Mesh 3 `PeerAuthentication` for namespace-wide STRICT mTLS plus a scoped PERMISSIVE carve-out for Route-facing traffic.
- Stand up a `DestinationRule`/`VirtualService` weighted canary and verify the split from a response trailer plus the server's own log line.
- Wire zero-code OpenTelemetry Java-agent injection to a collector, including matching the agent's exporter protocol to the collector's listening port.

## Why this matters

Every example before this one ran on something you control end to end: a Compose stack on your own machine, or a minikube cluster where you install exactly the Kubernetes primitives the chapter asks for. OpenShift is different in one way that matters a great deal to a gRPC service: it ships its own HTTP ingress layer, the Route, with its own TLS termination choices, and those choices are made by a router you did not write and mostly cannot change — only configure. Chapter 6 spent an entire chapter establishing that gRPC's wire contract is non-negotiable about one thing: it needs HTTP/2, end to end, with trailers carrying the final status after the response body. Put a gRPC service behind the wrong kind of Route, and that non-negotiable requirement quietly breaks, often with an error message that points nowhere near the real cause. This appendix runs `shipping.quote.v1.QuoteService.GetQuote` — the same frozen contract Ch27's final project serves — on OpenShift Local (CRC), and the headline result is not a tidy "it works": it is a live-cluster discovery that an edge-terminated Route on OpenShift 4.22.14 cannot carry a native gRPC client's TLS handshake *at all*, regardless of the annotation the official documentation tells you to add. That finding, and the real evidence behind it, is most of what makes this appendix worth reading rather than skipping.

The deployment target changes nothing about the contract. `contracts/proto/shipping/quote/v1/quote.proto` and its `shipping/type/v1/types.proto` import are copied — never edited — into `examples/99-appendix-a-openshift-crc/quarkus/src/main/proto/` by `scripts/deploy.sh`, the same pattern Ch27's Containerfile uses for its own four proto files. `git diff main -- contracts/` stays empty for this entire appendix. What is different is everything downstream of the contract: instead of a hand-rolled `certgen` script and `quarkus.grpc.server.ssl.*` properties doing application-level mTLS the way Ch19 and Ch27 do it, this server runs **plaintext** gRPC and leans on OpenShift Service Mesh 3's sidecar to carry mTLS transparently — the same architectural choice Ch22 makes with Istio on minikube, here with Red Hat's OSSM 3 (the Sail operator) instead. Instead of a Docker build or a `kubectl apply` against manifests you wrote, the image is built *inside* the cluster, with no container engine on the host, and the workload reaches the outside world through Routes instead of NodePorts, port-forwards, or tunnels.

## Building inside the cluster: binary S2I, not a Dockerfile

`examples/99-appendix-a-openshift-crc/quarkus/pom.xml` carries an inactive Maven profile, `openshift`, that adds exactly one dependency: `quarkus-openshift`. `mvn verify` and every other runtime's build are unaffected by its presence — the profile only activates with `-Popenshift`, which is exactly what `scripts/deploy.sh` passes:

```bash
mvn -B -q package -DskipTests -Popenshift \
    -Dquarkus.container-image.build=true \
    -Dquarkus.container-image.tag=v1 \
    -Dquarkus.openshift.version=v1 \
    -Dquarkus.openshift.base-jvm-image=registry.access.redhat.com/ubi10/openjdk-25:1.24-15 \
    -Dquarkus.openshift.namespace=appendix-a-grpc \
    -Dquarkus.kubernetes.deploy=false
```

{% include excalidraw.html file="A-crc-incluster-build" alt="A host running mvn package feeds a binary S2I BuildConfig based on ubi10 openjdk-25, which produces an ImageStream tag getquote colon v1 that the Helm-managed Deployment pulls." caption="Figure A.1 — the in-cluster build: Maven runs on the host, but the image itself is built and pushed entirely inside OpenShift." %}

Five of those flags matter more than they look. `quarkus.container-image.build=true` turns on the extension's image-building machinery at all; without `quarkus.openshift.version=v1`, the ImageStream tag that comes out the other end is the project's Maven version (`1.0.0-SNAPSHOT`), not `v1`, because `quarkus.container-image.tag` alone is ignored for the OpenShift build path. `quarkus.kubernetes.deploy=false` keeps this step to build-and-push only — the Helm chart, not the Quarkus Kubernetes extension, owns the Deployment. `quarkus.openshift.namespace=appendix-a-grpc` controls where the build lands in a way the Quarkus 3.40 release notes do not call out: `crc start` resets the kubeconfig context's namespace to `default`, and the extension ignores both `quarkus.kubernetes-client.namespace` and the `KUBERNETES_NAMESPACE` environment variable for the OpenShift build specifically, so without this property the BuildConfig silently lands in the wrong project. And the base image itself, `ubi10/openjdk-25:1.24-15`, is the newest UBI major carrying the newest supported JDK, pinned to an exact tag rather than a floating `latest` — the same discipline every other chapter in this book applies to its own image references.

What Quarkus actually does with those flags: it packages a fast-jar the ordinary way, then creates a `BuildConfig` (Source strategy, binary input) and a matching `ImageStream`, uploads the jar as the build's binary input, and OpenShift runs the image's own S2I assemble script against it — `/usr/libexec/s2i/assemble`, baked into the UBI OpenJDK image — before pushing the result to the internal registry as `getquote:v1`. None of this touches Maven Central from inside the cluster; the only thing that crosses the cluster boundary is the already-built jar. The first live run of this build took about fifteen to seventeen seconds end to end, confirmed with `oc get istag getquote:v1`.

The image's own entrypoint is not the project's Containerfile at all — there is no Containerfile for this runtime — but `run-java.sh`, baked into the UBI OpenJDK S2I image. That script reads `JAVA_TOOL_OPTIONS` for JVM flags and `JAVA_MAX_MEM_RATIO` (not the similarly-named `JAVA_MAX_RAM_RATIO`) for heap sizing; this chart happens not to need either, since the GetQuote service has no custom JVM flags, but a service that did would set them through the chart's Deployment template, not a Containerfile nobody runs.

One build mistake is worth recording here, because it is the kind of thing a reader will hit too: the first live run's `deploy.sh` reported a successful Maven build and then failed outright at the Helm step with `no ImageStream tag getquote:v1`. The real ImageStream it had created was named `appendix-a-getquote` — the Quarkus extension names the in-cluster build after `quarkus.application.name`, which defaults to the Maven **artifactId**, not the directory or the chart's expected service name. The fix was one property, `quarkus.application.name=getquote`, in `application.properties`; `expected-output.md` keeps the exact failing output next to the fix, because a reader who hits the identical error deserves to see it was real, not hypothetical.

## Three Routes, one Service, and a real limitation

OpenShift exposes a Service to the outside world through a `Route`, and a Route's `tls.termination` field has three values that matter here: `edge` (the router terminates TLS and speaks to the pod however it is configured to), `passthrough` (the router never touches TLS at all — it is pure TCP forwarding, chosen by SNI), and `reencrypt` (the router terminates the client's TLS and re-originates a new TLS session to the pod). `examples/99-appendix-a-openshift-crc/helm/templates/routes.yaml` renders all three edge/passthrough variants for the same `getquote` Service, gated by `values.yaml`'s `routes.h2c`, `routes.edge`, and `routes.passthrough` flags, all `true` by default:

{% include excalidraw.html file="A-crc-grpc-routes" alt="Three stacked rows comparing h2c, plain edge, and passthrough Routes. The h2c and plain edge rows both show the router terminating TLS from the client then failing or succeeding differently toward the pod; the passthrough row shows the router untouched and TLS negotiated directly between client and pod." caption="Figure A.2 — h2c, plain edge, and passthrough for the same gRPC Service: which hop actually carries HTTP/2, and where each one breaks." %}

The `haproxy.router.openshift.io/h2c-enable: "true"` annotation on the `getquote-h2c` Route is the one Red Hat's own documentation names for gRPC: without it, an edge-terminated Route's default behavior toward the backend is HTTP/1.1, which cannot carry gRPC's length-prefixed framing or its trailers-only final status. With it, the router is supposed to speak cleartext HTTP/2 (h2c) to the pod on that same hop. On a live OpenShift 4.22.14 cluster, calling that Route with `grpcurl` produced this, verbatim:

```
Failed to dial target host "getquote-h2c-appendix-a-grpc.apps-crc.testing:443": credentials: cannot check peer: missing selected ALPN property.
```

The identical error, byte for byte, came back from `getquote-edge` — the plain edge Route with no `h2c-enable` annotation at all. Two Routes, one annotated for exactly this purpose and one not, failing identically, ruled out the annotation as either the cause or the fix. `curl --http2` against the same h2c Route host showed the mechanism directly: `ALPN: server did not agree on a protocol. Uses default` — the TLS handshake with the *client* never offers `h2` as a possibility, so a strict-ALPN gRPC client (grpc-go 1.67 and later enforces ALPN selection, and `grpcurl` is built on grpc-go) refuses to proceed before a single byte of the actual request is sent. Reading the router pod's generated HAProxy configuration directly confirmed it is not a transient bug or a missing feature flag: `fe_sni`, the one frontend every edge- and reencrypt-terminated Route on the cluster is dispatched through by SNI, binds with the literal option `no-alpn`, unconditionally. Flipping the cluster-wide `ingress.operator.openshift.io/default-enable-http2` annotation to `true` — which does roll the router and does flip `ROUTER_DISABLE_HTTP2` to `false` in its environment — changed nothing about this particular bind, because that setting governs ALPN on the **router-to-backend** leg of a reencrypt Route (visible on the console and image-registry backends' own `ssl alpn h2,http/1.1` lines in the same generated config), not the client-facing leg every edge Route shares.

Passthrough is the Route type that sidesteps this entirely, because the router never terminates TLS on a passthrough Route — it inspects only the TLS ClientHello's SNI field to pick a backend, then forwards the raw bytes, meaning the client and the pod negotiate ALPN directly with each other with the router doing nothing but TCP plumbing. Proving that live required the pod to actually speak TLS, which this chart's normal shape deliberately does not do — the whole point of running behind OpenShift Service Mesh 3 is that the **sidecar**, not the application, carries TLS. The chart has a diagnostic-only flag for exactly this test, `tls.enabled`, which mounts a self-signed cert/key pair as a Secret and overrides three Quarkus gRPC properties at the environment-variable level (`QUARKUS_GRPC_SERVER_PLAIN_TEXT=false` plus the certificate and key paths) with no rebuild required. Run with the mesh switched off — turning on app-level TLS while the mesh is also on would break every mesh-internal call on the same port, which is exactly the point the "Decision" callout below makes — a real `grpcurl` call against the passthrough Route returned a real quote:

```
{
  "quote": { "currency": "USD", "amount": "925.00" }
}
```

`curl --http2` against the same passthrough Route this time reported `ALPN: server accepted h2` and `using HTTP/2` — the one Route type, of the three, where a native gRPC client's handshake actually completes on this cluster.

## OpenShift Service Mesh 3: STRICT mTLS, a PERMISSIVE carve-out, and a canary

With the Sail-operator-managed `Istio` control plane up (`spec.version: v1.30.5`, the newest release OSSM 3.4.3 offers, never the floating `v1.30-latest`), the chart's `mesh.enabled` flag adds the pod-template label `istio.io/rev: default` — Sail's revisioned-injection matches pods to a control plane by this label, not a mutating webhook watching a namespace annotation — and `istio-proxy` joins every `getquote` pod as a native sidecar, an `initContainer` with `restartPolicy: Always`, a lifecycle Kubernetes itself understands as "stays up for as long as the main containers do, and shuts down automatically once they finish." A namespace-wide `PeerAuthentication` named `default` sets `mtls.mode: STRICT`: every meshed workload now refuses a connection that is not itself coming through another sidecar's mTLS.

{% include excalidraw.html file="A-ossm-strict-mtls-canary" alt="A meshed client's sidecar negotiates STRICT mTLS with the getquote Service, which a VirtualService splits ninety-ten between the v1 and v2 DestinationRule subsets; a separate panel shows an unmeshed caller's plaintext connection being refused." caption="Figure A.3 — STRICT mTLS plus a weighted canary: the mesh-internal path that works, and the unmeshed path that is refused." %}

STRICT at the namespace level has one well-known cost this appendix hits directly: the OpenShift router is not itself a mesh member, so every Route request — h2c, edge, or passthrough alike — arrives at a STRICT-protected pod as plaintext (or raw TLS bytes the sidecar does not recognize as its own mTLS), and a strict policy would answer every single one with a connection failure. `getquote-permissive`, a second `PeerAuthentication` scoped to just this one workload with `mtls.mode: PERMISSIVE`, is the carve-out: PERMISSIVE accepts both mTLS and plaintext, so Route traffic gets through while mesh-internal callers still get full mutual TLS. Proving the STRICT guarantee actually holds for anything that is *not* carved out meant temporarily deleting that one PermissiveAuthentication and sending a plaintext call from an explicitly unmeshed pod (`sidecar.istio.io/inject: "false"`) straight at the `getquote` Service's ClusterIP name. The result was a dial that simply timed out — `context deadline exceeded` after a five-second connect timeout — never a gRPC status code, because the call never reached far enough into gRPC's own machinery to produce one. `QuoteServiceImpl.getQuote` never ran.

The canary split works the same way Ch27's `destination-rule.yaml`/`virtual-service.yaml` pattern does, applied here to a live OpenShift cluster instead of static manifests: a second Deployment, `getquote-v2`, identical image, one pod label difference (`version: v2`), a `DestinationRule` defining `v1`/`v2` subsets by that label, and a `VirtualService` splitting traffic 90/10 by default. Because OSSM 3 provisions no ingress gateway of its own — the Route *is* the edge — this weighted split governs only sidecar-to-sidecar calls, the same scoping note the `lgtm-crc` skill's own verified run records. Thirty calls from inside the mesh, each one reading the `x-served-by` response trailer exactly the way `examples/22-mesh-loadbalancing`'s `loadclient.py` does, landed 29 on `v1` and 1 on `v2` — in the right direction for a 10% weight, though a single sample out of thirty against a 90/10 split carries real sampling variance that a three-way *even* split over the same sample size would not.

## A traced call, with zero code changes

The Red Hat build of OpenTelemetry operator's `Instrumentation` custom resource is how a Quarkus pod gets distributed tracing without a single line of code or a pom dependency: the pod-template annotation `instrumentation.opentelemetry.io/inject-java` (added by the chart's `observability.enabled` flag) tells the operator's admission webhook to inject the OpenTelemetry Java agent as another init container, which appends a `-javaagent` flag to `JAVA_TOOL_OPTIONS` before the JVM ever starts. The first attempt pointed the agent at the wrong port — `http://otelcol-collector:4317`, the collector's OTLP/**gRPC** receiver, when the operator's injected agent defaults to the OTLP/**HTTP** exporter — and produced a real, repeating `HTTP status code 415` in the pod's own logs until the Instrumentation CR's endpoint moved to port `4318`. After that single fix, one `GetQuote` call produced a real span the collector's own debug exporter printed to its log: a trace ID, a span named `shipping.quote.v1.QuoteService/GetQuote`, and the resource attributes identifying exactly which pod answered.

## What CI validates, and what it does not

This directory sits entirely outside the Compose-based `examples` CI matrix, by design: that matrix auto-discovers every `verify.sh` under `examples/*/`, and `scripts/validate.py`'s `cluster-dir-no-verify` check fails the build the instant one appears here, because there is no cluster behind a GitHub Actions runner to run it against. What CI *does* check is the `k8s-manifests` job's `helm lint examples/99-appendix-a-openshift-crc/helm` followed by `helm template ... | kubeconform -ignore-missing-schemas -summary` — a static, schema-level pass confirming the Deployment, Service, and (with every flag on) the second canary Deployment parse as valid Kubernetes objects; `kubeconform` has no schema for a `Route`, a `PeerAuthentication`, a `DestinationRule`, or a `VirtualService`, so `-ignore-missing-schemas` lets those seven resources through unchecked rather than failing the whole pipe. That check cannot and does not prove the in-cluster build works, that STRICT mTLS actually rejects anyone, or that the canary split lands anywhere near 90/10 — those are live-cluster claims, and this chapter's closing footer says exactly which ones a real run on this machine confirmed.

## Cross-check

The `x-served-by` trailer each canary call reads comes entirely from the client side. An independent confirmation sits in the pod's own log line, written by a completely separate code path inside `QuoteServiceImpl.getQuote`:

```
2026-10-14 15:57:12,628 INFO  [...QuoteServiceImpl] GetQuote served-by=getquote-5f96d9f558-7brbx USNYC -> NLRTM quote=USD 925.00
```

The pod name in the server's own log line matches the trailer the client read after the same call, and the quote amount matches the formula (`250.00` base fee plus `1.35` per kilogram on 500 kg: `250.00 + 675.00 = 925.00`) — two independent signals agreeing is what makes the canary tally and the passthrough success trustworthy rather than an artifact of how one side logged it.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Reach for a <strong>passthrough</strong> Route when a native gRPC client must reach your service directly through OpenShift's router: it is the only termination type, confirmed on a live OpenShift 4.22.14 cluster, where a strict-ALPN client's TLS handshake completes at all — but it requires the workload to terminate its own TLS, so plan for certificate issuance and rotation the way Ch19's <code>certgen</code> does. Reach for <strong>edge</strong> only when the caller is not a native gRPC client at all — a grpc-web proxy or a REST-transcoding gateway (Ch23) sitting in front, itself speaking ordinary HTTP/1.1 or HTTP/2-without-ALPN-enforcement to the router. Do not rely on <code>h2c-enable</code> alone to make an edge Route carry gRPC; it governs only the router-to-pod hop, and this chapter's live run shows the client-facing hop failing identically with or without it. Reach for <strong>mesh mTLS</strong> (OSSM's STRICT <code>PeerAuthentication</code>) over application-level mTLS when every legitimate caller can reasonably run inside the mesh: certificate issuance and rotation become the mesh's problem instead of a per-service <code>certgen</code> script, at the cost of a PERMISSIVE carve-out for anything — like a Route — that the mesh cannot itself reach in cleartext. Reach for application-level mTLS (Ch19's shape) instead when a workload must also be reachable over a passthrough Route, since app TLS and transparent mesh mTLS cannot both own the same port on the same pod without breaking one of the two.</p></div>

## What you learned

- OpenShift Routes have three TLS termination modes, and for a gRPC backend they are not interchangeable: a live OpenShift 4.22.14 run found edge and reencrypt Routes structurally unable to complete a native gRPC client's ALPN-negotiated TLS handshake, confirmed by reading the router's own generated HAProxy configuration (`no-alpn` on the shared SNI frontend), while passthrough — raw TCP, TLS negotiated directly against the pod — worked on the first real attempt once the pod served its own certificate.
- `haproxy.router.openshift.io/h2c-enable: "true"` affects only the router-to-backend hop of an edge/reencrypt Route; it does not and cannot fix the client-facing ALPN gap, demonstrated by an annotated and an unannotated edge Route failing with the byte-for-byte identical error.
- A binary S2I build inside OpenShift needs `quarkus.openshift.namespace` set explicitly on Quarkus 3.40 — the extension ignores the Kubernetes client's own namespace configuration for this specific build path, and `crc start` resets the kubeconfig context's namespace to `default`.
- `quarkus.openshift.version`, not `quarkus.container-image.tag`, controls the ImageStream tag the in-cluster build produces; `quarkus.application.name`, which defaults to the Maven artifactId, controls the BuildConfig/ImageStream *name* — getting this wrong produced a real, recorded failure this chapter's own live run hit and fixed.
- OpenShift Service Mesh 3's STRICT `PeerAuthentication` secures mesh-internal traffic automatically, but a Route-facing workload needs a scoped PERMISSIVE carve-out to stay reachable — and that carve-out, confirmed live, also means an unmeshed caller hitting the Service directly (not through the Route) gets through too, unless the carve-out is removed for the duration of a real STRICT-rejection test.
- The Red Hat build of OpenTelemetry's Java-agent injection produces real distributed traces with zero application code changes — but the agent's default exporter protocol (OTLP/HTTP) must match the collector's receiving port, a mismatch this chapter's own live run hit and fixed by moving from port 4317 (gRPC) to 4318 (HTTP).

## On the wire

Bring the cluster up and deploy (12 vCPU / 32 GiB; both operators pinned with `installPlanApproval: Manual` and an exact `startingCSV`):

```bash
cd examples/99-appendix-a-openshift-crc
./scripts/bootstrap.sh
./scripts/deploy.sh
```

Fetch the cluster's own ingress CA — never `--insecure` — and confirm the edge/h2c Route's real ALPN failure:

```bash
eval "$(crc oc-env)"
oc get configmap default-ingress-cert -n openshift-config-managed \
    -o jsonpath='{.data.ca-bundle\.crt}' > /tmp/ingress-ca.crt

grpcurl -cacert /tmp/ingress-ca.crt \
    -d '{"origin":{"un_locode":"USNYC"},"destination":{"un_locode":"NLRTM"},"cargo":[{"weight_kg":500}]}' \
    getquote-h2c-appendix-a-grpc.apps-crc.testing:443 \
    shipping.quote.v1.QuoteService/GetQuote
# Failed to dial target host "...": credentials: cannot check peer: missing selected ALPN property.
```

Run the one-off passthrough diagnostic (self-signed cert, mesh off) and get a real quote back:

```bash
oc create secret tls getquote-passthrough-tls -n appendix-a-grpc --cert=tls.crt --key=tls.key
helm upgrade --install getquote helm/ -n appendix-a-grpc --reset-then-reuse-values \
    --set mesh.enabled=false --set observability.enabled=false --set tls.enabled=true

grpcurl -cacert tls.crt \
    -d '{"origin":{"un_locode":"USNYC"},"destination":{"un_locode":"NLRTM"},"cargo":[{"weight_kg":500}]}' \
    getquote-passthrough-appendix-a-grpc.apps-crc.testing:443 \
    shipping.quote.v1.QuoteService/GetQuote
# {"quote": {"currency": "USD", "amount": "925.00"}}
```

Restore the normal mesh/canary/tracing shape, then confirm STRICT rejects a plaintext caller with the Route carve-out removed:

```bash
helm upgrade --install getquote helm/ -n appendix-a-grpc --reset-then-reuse-values \
    --set mesh.enabled=true --set mesh.canary.enabled=true --set observability.enabled=true

oc delete peerauthentication getquote-permissive -n appendix-a-grpc
# an unmeshed pod calling getquote.appendix-a-grpc.svc.cluster.local:9000 plaintext:
# Failed to dial target host "...": context deadline exceeded
./scripts/deploy.sh   # re-applies getquote-permissive
```

Confirm the mesh custom resources and the weighted canary are actually in place before trusting any tally:

```bash
oc get peerauthentication,destinationrule,virtualservice -n appendix-a-grpc
```

And the static check CI actually runs on this example, reproducible without a cluster at all:

```bash
helm lint examples/99-appendix-a-openshift-crc/helm
helm template examples/99-appendix-a-openshift-crc/helm \
    --set mesh.enabled=true --set mesh.canary.enabled=true --set observability.enabled=true \
    | kubeconform -ignore-missing-schemas -summary
# Summary: 10 resources found parsing stdin - Valid: 3, Invalid: 0, Errors: 0, Skipped: 7
```

Tear down when finished (or leave CRC running and note it, as this chapter's own live run did):

```bash
./scripts/teardown.sh
```

---

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

## For deeper coverage

- OpenShift documentation — Route configuration and TLS termination types (edge, passthrough, reencrypt).
- Red Hat OpenShift Service Mesh documentation — `PeerAuthentication` and mTLS modes (STRICT, PERMISSIVE).
- [grpc.io — Core concepts](https://grpc.io/docs/what-is-grpc/core-concepts/) — the HTTP/2 and ALPN requirements behind this chapter's Route findings.
- Cloud Native Design Patterns — Appendix S, "Running Example 05 on OpenShift Local," companion coverage of the same platform.
- Cloud Native Design Patterns — Appendix R, "Running Example 05 on minikube," the architectural parallel to this appendix's `DestinationRule`/`VirtualService` canary on a different cluster.
