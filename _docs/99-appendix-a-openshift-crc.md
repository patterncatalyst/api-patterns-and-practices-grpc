---
title: "Appendix A: OpenShift Local (CRC)"
order: 99
part: "Running It & the Final Project"
appendix: true
appendix_label: "A"
description: "Run the gRPC service on OpenShift Local: Route TLS modes and ALPN, an in-cluster image build, and OpenShift Service Mesh STRICT mTLS with a canary."
duration: "18 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why an edge- or reencrypt-terminated OpenShift Route can't complete a native gRPC client's ALPN-negotiated TLS handshake, and when to use `passthrough` instead.
- Build and push a Quarkus image inside the cluster with binary S2I (`BuildConfig` and `ImageStream`), and name the Quarkus properties that commonly go wrong.
- Configure OpenShift Service Mesh 3 `PeerAuthentication` for namespace-wide STRICT mTLS with a scoped PERMISSIVE carve-out for Route traffic.
- Stand up a `DestinationRule` and `VirtualService` weighted canary and verify the split from a response trailer and the server's log line.
- Wire zero-code OpenTelemetry Java-agent injection to a collector, matching the exporter protocol to the collector port.

## Why this matters

OpenShift ships its own HTTP ingress, the Route, with TLS termination choices made by a router you configure but don't write. gRPC needs HTTP/2 end to end, with trailers carrying the final status. Behind the wrong Route type that requirement breaks, often with an error that points nowhere near the cause.

This appendix runs `shipping.quote.v1.QuoteService.GetQuote`, the same frozen contract the final project serves, on OpenShift Local (CRC). The headline result: on OpenShift 4.22.14, an edge-terminated Route can't carry a native gRPC client's TLS handshake, whatever annotation the documentation tells you to add. The router's own generated HAProxy configuration confirms it.

The contract doesn't change. `scripts/deploy.sh` copies `quote.proto` and its `types.proto` import, unedited, into `src/main/proto/` of the Quarkus project. What changes is everything downstream:

- The server runs **plaintext** gRPC and the OpenShift Service Mesh 3 sidecar (the Sail operator) carries mTLS, instead of `certgen` and `quarkus.grpc.server.ssl.*`.
- The image is built inside the cluster, with no container engine on the host.
- The workload reaches the outside through Routes, not NodePorts or tunnels.

## Building inside the cluster: binary S2I

The Quarkus `pom.xml` has an inactive `openshift` profile that adds one dependency, `quarkus-openshift`. It activates only with `-Popenshift`, which `scripts/deploy.sh` passes. Quarkus packages a fast-jar, creates a `BuildConfig` (Source strategy, binary input) and an `ImageStream`, and uploads the jar as the build input. OpenShift runs the UBI OpenJDK image's own `/usr/libexec/s2i/assemble` against it and pushes `getquote:v1` to the internal registry. Only the built jar crosses the cluster boundary, and the build takes about fifteen seconds.

`scripts/deploy.sh` runs the build:

```bash
( cd "$MAVEN_DIR" && mvn -B -q package -DskipTests -Popenshift \
    -Dquarkus.container-image.build=true \
    -Dquarkus.container-image.tag="$IMAGE_TAG" \
    -Dquarkus.openshift.version="$IMAGE_TAG" \
    -Dquarkus.openshift.base-jvm-image="$BASE_JVM_IMAGE" \
    -Dquarkus.openshift.namespace="$NS" \
    -Dquarkus.kubernetes.deploy=false ) \
    || fail "Maven/S2I build failed (oc get builds -n $NS; oc logs build/<name> -n $NS)"
```

{% include excalidraw.html file="A-crc-incluster-build" alt="A host running mvn package feeds a binary S2I BuildConfig based on ubi10 openjdk-25, which produces an ImageStream tag getquote colon v1 that the Helm-managed Deployment pulls." caption="Figure A.1: The in-cluster build. Maven runs on the host, and OpenShift builds and pushes the image." %}

| Property | Why it matters |
|---|---|
| `quarkus.container-image.build=true` | Turns on the image-building machinery |
| `quarkus.openshift.version=v1` | Sets the ImageStream tag. `quarkus.container-image.tag` alone is ignored on the OpenShift path, and the tag becomes the Maven version (`1.0.0-SNAPSHOT`) |
| `quarkus.openshift.namespace` | `crc start` resets the kubeconfig context's namespace to `default`, and the extension ignores both `quarkus.kubernetes-client.namespace` and `KUBERNETES_NAMESPACE` for this build, so without it the BuildConfig lands in the wrong project |
| `quarkus.kubernetes.deploy=false` | Build and push only, because the Helm chart owns the Deployment |
| `quarkus.openshift.base-jvm-image` | The newest UBI major with the newest supported JDK (`ubi10/openjdk-25`), pinned to an exact tag |
| `quarkus.application.name=getquote` | Names the BuildConfig and ImageStream. It defaults to the Maven artifactId |

Without the last property, Maven succeeded and Helm then failed with `no ImageStream tag getquote:v1`, because the ImageStream was named `appendix-a-getquote`.

The image's entrypoint is `run-java.sh` from the UBI OpenJDK S2I image, not a Containerfile. It reads `JAVA_TOOL_OPTIONS` for JVM flags and `JAVA_MAX_MEM_RATIO` (not `JAVA_MAX_RAM_RATIO`) for heap sizing. This service needs neither, but one that did would set them in the chart's Deployment template.

## Three Routes, one Service, and a real limitation

A Route's `tls.termination` has three modes:

| Mode | What the router does |
|---|---|
| `edge` | Terminates TLS and speaks to the pod however it is configured |
| `reencrypt` | Terminates the client's TLS and opens a new TLS session to the pod |
| `passthrough` | Never touches TLS: forwards raw TCP, chosen by SNI |

The chart's `routes.yaml` renders the h2c, edge and passthrough variants for the same `getquote` Service, each behind a `values.yaml` flag (`routes.h2c`, `routes.edge`, `routes.passthrough`, all `true` by default).

{% include excalidraw.html file="A-crc-grpc-routes" alt="Three stacked rows comparing h2c, plain edge, and passthrough Routes. The h2c and plain edge rows both show the router terminating TLS from the client then failing or succeeding differently toward the pod; the passthrough row shows the router untouched and TLS negotiated directly between client and pod." caption="Figure A.2: h2c, plain edge and passthrough Routes for one gRPC Service, showing which hop carries HTTP/2 and where each breaks." %}

Red Hat's documentation names `haproxy.router.openshift.io/h2c-enable: "true"` for gRPC. Without it an edge Route speaks HTTP/1.1 to the backend, which can't carry gRPC framing or trailers. With it the router speaks cleartext HTTP/2 (h2c) to the pod. On a live 4.22.14 cluster, `grpcurl` against the annotated `getquote-h2c` Route failed with:

```
Failed to dial target host "getquote-h2c-appendix-a-grpc.apps-crc.testing:443": credentials: cannot check peer: missing selected ALPN property.
```

The plain `getquote-edge` Route, with no annotation, failed with the identical error, so the annotation is neither the cause nor the fix. `curl --http2` shows the mechanism: `ALPN: server did not agree on a protocol. Uses default`. The router never offers `h2` to the client, and a strict-ALPN gRPC client refuses to send anything. grpc-go 1.67 and later enforces ALPN selection, and `grpcurl` is built on grpc-go.

The router's generated HAProxy configuration shows why. `fe_sni`, the frontend that dispatches every edge and reencrypt Route by SNI, binds with the literal option `no-alpn`. Setting the cluster-wide `ingress.operator.openshift.io/default-enable-http2` annotation to `true` rolls the router and flips `ROUTER_DISABLE_HTTP2` to `false`, but changes nothing here. That setting governs ALPN on the router-to-backend leg of a reencrypt Route, not the client-facing leg every edge Route shares.

Passthrough avoids the problem, because the router reads only the ClientHello SNI and forwards raw bytes, so the client and pod negotiate ALPN directly. That needs a pod that speaks TLS, which the normal chart shape doesn't, since the sidecar carries TLS. A diagnostic flag, `tls.enabled`, mounts a self-signed cert and key as a Secret and overrides `QUARKUS_GRPC_SERVER_PLAIN_TEXT=false` plus the certificate and key paths through environment variables, with no rebuild. Turn the mesh off first: app-level TLS and mesh mTLS on one port would break every mesh-internal call. Then `grpcurl` against the passthrough Route returns a quote, and `curl --http2` reports `ALPN: server accepted h2` and `using HTTP/2`. Of the three Route types, passthrough is the only one where a native gRPC client's handshake completes on this cluster.

## OpenShift Service Mesh 3: STRICT mTLS, a PERMISSIVE carve-out, a canary

The Sail-operator-managed `Istio` control plane uses `spec.version: v1.30.5`, the newest release OSSM 3.4.3 offers, never the floating `v1.30-latest`. With the chart's `mesh.enabled` flag, pods get the label `istio.io/rev: default`, which is how Sail's revisioned injection matches pods to a control plane, not a namespace annotation. `istio-proxy` then joins every `getquote` pod as a native sidecar: an `initContainer` with `restartPolicy: Always` that stays up as long as the main containers and stops when they finish. A namespace-wide `PeerAuthentication` named `default` sets `mtls.mode: STRICT`, so every meshed workload refuses a connection that doesn't arrive through another sidecar's mTLS.

{% include excalidraw.html file="A-ossm-strict-mtls-canary" alt="A meshed client's sidecar negotiates STRICT mTLS with the getquote Service, which a VirtualService splits ninety-ten between the v1 and v2 DestinationRule subsets; a separate panel shows an unmeshed caller's plaintext connection being refused." caption="Figure A.3: STRICT mTLS plus a weighted canary. The mesh-internal path works and the unmeshed path is refused." %}

The OpenShift router isn't a mesh member, so every Route request arrives at a STRICT pod as plaintext or as raw TLS the sidecar doesn't recognize, and STRICT would refuse all of them. `getquote-permissive`, a second `PeerAuthentication` scoped to this workload with `mtls.mode: PERMISSIVE`, is the carve-out. It accepts both mTLS and plaintext, so Route traffic gets through while mesh-internal callers still get mutual TLS. The cost: an unmeshed caller hitting the Service directly gets through too.

To confirm STRICT holds for anything not carved out, delete that one resource and call the `getquote` ClusterIP name in plaintext from a pod with `sidecar.istio.io/inject: "false"`. The dial times out (`context deadline exceeded` after a five-second connect timeout) with no gRPC status, and `QuoteServiceImpl.getQuote` never runs.

The canary uses the same `DestinationRule` and `VirtualService` shape as the minikube mesh example: a second Deployment, `getquote-v2`, with the same image and a `version: v2` pod label, a `DestinationRule` defining `v1` and `v2` subsets by that label, and a `VirtualService` splitting 90/10. OSSM 3 provisions no ingress gateway, because the Route is the edge, so the split governs only sidecar-to-sidecar calls. Thirty calls from inside the mesh, each reading the `x-served-by` response trailer, landed 29 on `v1` and 1 on `v2`. That fits a 10% weight, though one sample of thirty against 90/10 carries real sampling variance.

The server's own log line is an independent signal from a separate code path. Its pod name matches the trailer the client read, and the amount matches the formula (`250.00` base fee plus `1.35` per kilogram on 500 kg is `925.00`):

```
2026-10-14 15:57:12,628 INFO  [...QuoteServiceImpl] GetQuote served-by=getquote-5f96d9f558-7brbx USNYC -> NLRTM quote=USD 925.00
```

## A traced call with zero code changes

The Red Hat build of OpenTelemetry operator's `Instrumentation` resource gives a Quarkus pod distributed tracing with no code and no pom dependency. The pod-template annotation `instrumentation.opentelemetry.io/inject-java`, added by the chart's `observability.enabled` flag, makes the operator's admission webhook inject the OpenTelemetry Java agent as an init container and append `-javaagent` to `JAVA_TOOL_OPTIONS` before the JVM starts.

The agent's default exporter is OTLP/**HTTP**. Pointing it at `http://otelcol-collector:4317`, the collector's OTLP/**gRPC** receiver, produced a repeating `HTTP status code 415` in the pod logs until the `Instrumentation` endpoint moved to port `4318`. After that, one `GetQuote` call produced a span the collector's debug exporter printed: a trace id, the span name `shipping.quote.v1.QuoteService/GetQuote`, and resource attributes naming the pod that answered.

## What CI validates

This directory sits outside the Compose-based `examples` CI matrix. That matrix discovers every `verify.sh` under `examples/*/`, and `scripts/validate.py` fails the build if one appears here, because no cluster sits behind a CI runner. CI runs `helm lint` and `helm template ... | kubeconform -ignore-missing-schemas -summary`, a schema-level pass that confirms the Deployment, Service and canary Deployment parse as Kubernetes objects. `kubeconform` has no schema for `Route`, `PeerAuthentication`, `DestinationRule` or `VirtualService`, so those seven resources pass unchecked. The in-cluster build, STRICT rejection and the canary split are live-cluster claims that only a run on CRC confirms.

## Choosing a termination

| Situation | Use | Trade-off |
|---|---|---|
| A native gRPC client reaches the service directly through the router | `passthrough` | The only type where a strict-ALPN handshake completes, but the workload terminates its own TLS, so plan certificate issuance and rotation as `certgen` does |
| The caller isn't a native gRPC client, such as a grpc-web proxy or REST-transcoding gateway | `edge` | `h2c-enable` governs only the router-to-pod hop and doesn't make edge carry native gRPC |
| Every legitimate caller can run inside the mesh | Mesh mTLS (STRICT `PeerAuthentication`) | The mesh owns certificates, at the cost of a PERMISSIVE carve-out for anything it can't reach in cleartext, like a Route |
| The workload must also be reachable over a passthrough Route | Application-level mTLS | App TLS and transparent mesh mTLS can't both own one port on one pod |

## Build, run, observe

Bring the cluster up (12 vCPU, 32 GiB; both operators pinned with `installPlanApproval: Manual` and an exact `startingCSV`) and deploy:

```bash
cd examples/99-appendix-a-openshift-crc
./scripts/bootstrap.sh
./scripts/deploy.sh
```

Fetch the cluster's ingress CA (never `--insecure`) and call the h2c Route. Expect the ALPN error above:

```bash
eval "$(crc oc-env)"
oc get configmap default-ingress-cert -n openshift-config-managed \
    -o jsonpath='{.data.ca-bundle\.crt}' > /tmp/ingress-ca.crt

grpcurl -cacert /tmp/ingress-ca.crt \
    -d '{"origin":{"un_locode":"USNYC"},"destination":{"un_locode":"NLRTM"},"cargo":[{"weight_kg":500}]}' \
    getquote-h2c-appendix-a-grpc.apps-crc.testing:443 \
    shipping.quote.v1.QuoteService/GetQuote
```

Run the passthrough diagnostic (self-signed cert, mesh off). It returns `{"quote": {"currency": "USD", "amount": "925.00"}}`:

```bash
oc create secret tls getquote-passthrough-tls -n appendix-a-grpc --cert=tls.crt --key=tls.key
helm upgrade --install getquote helm/ -n appendix-a-grpc --reset-then-reuse-values \
    --set mesh.enabled=false --set observability.enabled=false --set tls.enabled=true

grpcurl -cacert tls.crt \
    -d '{"origin":{"un_locode":"USNYC"},"destination":{"un_locode":"NLRTM"},"cargo":[{"weight_kg":500}]}' \
    getquote-passthrough-appendix-a-grpc.apps-crc.testing:443 \
    shipping.quote.v1.QuoteService/GetQuote
```

Restore the mesh, canary and tracing, then check the custom resources:

```bash
helm upgrade --install getquote helm/ -n appendix-a-grpc --reset-then-reuse-values \
    --set mesh.enabled=true --set mesh.canary.enabled=true --set observability.enabled=true

oc get peerauthentication,destinationrule,virtualservice -n appendix-a-grpc
```

The static check CI runs needs no cluster:

```bash
helm lint examples/99-appendix-a-openshift-crc/helm
helm template examples/99-appendix-a-openshift-crc/helm \
    --set mesh.enabled=true --set mesh.canary.enabled=true --set observability.enabled=true \
    | kubeconform -ignore-missing-schemas -summary
```

Expect `Valid: 3, Invalid: 0, Errors: 0, Skipped: 7`.

Experiments:

- **Remove the carve-out.** Run `oc delete peerauthentication getquote-permissive -n appendix-a-grpc`, then call `getquote.appendix-a-grpc.svc.cluster.local:9000` in plaintext from an unmeshed pod: the dial fails with `context deadline exceeded` and no gRPC status. Re-run the `helm upgrade --install` with the mesh flags above to restore it.
- **Compare the edge Routes.** Call `getquote-edge` and `getquote-h2c`: both fail with the same `missing selected ALPN property` error, with or without the `h2c-enable` annotation.

Tear down with `./scripts/teardown.sh` when finished.

---

## For deeper coverage

- OpenShift documentation: Route configuration and TLS termination types (edge, passthrough, reencrypt).
- Red Hat OpenShift Service Mesh documentation: `PeerAuthentication` and mTLS modes (STRICT, PERMISSIVE).
- [grpc.io: Core concepts](https://grpc.io/docs/what-is-grpc/core-concepts/): the HTTP/2 and ALPN requirements behind the Route findings.
- Cloud Native Design Patterns, Appendix S, "Running Example 05 on OpenShift Local," companion coverage of the same platform.
- Cloud Native Design Patterns, Appendix R, "Running Example 05 on minikube," the architectural parallel to this appendix's `DestinationRule` and `VirtualService` canary on a different cluster.
