# Appendix A — recorded output

A real run on the authoring machine: CRC 2.64.0, OpenShift 4.22.14
(12 vCPU / 32 GiB / 100 GB disk), on 2026-10-14. This file is evidence, not
a template — every CSV name, pod name, IP, error message and tally below
came from commands actually run against a live cluster this session, not a
predicted or hand-edited value. Two things did **not** work as the chart's
first draft assumed (an edge-terminated Route carrying native gRPC, and
`quarkus.application.name` defaulting usefully) — both are recorded exactly
as they failed, with the real diagnosis, immediately below the fix.

## Bootstrap: `scripts/bootstrap.sh`

```
==> 1/3 CRC sizing and start
    ✓ OpenShift Local already running
    ✓ API: https://api.crc.testing:6443

==> 2/3 OpenShift Service Mesh 3 (Sail)
    ✓ OperatorHub serves servicemeshoperator3
    ✓ InstallPlan for servicemeshoperator3.v3.4.3 proposed
    ✓ servicemeshoperator3.v3.4.3 Succeeded

==> 3/3 Red Hat build of OpenTelemetry
    ✓ OperatorHub serves opentelemetry-product
    ✓ InstallPlan for opentelemetry-operator.v0.158.0-3 proposed
    ✓ opentelemetry-operator.v0.158.0-3 Succeeded
    ✓ bootstrap complete — run ./scripts/deploy.sh next
```

The OpenTelemetry CSV re-checked live on this cluster was
`opentelemetry-operator.v0.158.0-3` — one patch newer than the
`lgtm-crc` skill's 2026-10-09 reference pin of `-2`. `mesh/subscriptions/
opentelemetry.yaml` and `scripts/bootstrap.sh` are pinned to the `-3` this
cluster's `redhat-operators` catalog actually served, per the "re-check
before every live run" rule, not the skill's dated reference table.

## First `deploy.sh` attempt: a real failure, and the real fix

The first run's Maven/S2I build completed and reported success, but the
Helm install that followed it failed outright:

```
==> 3/7 In-cluster image build (binary S2I via quarkus-openshift)
...
✗ no ImageStream tag getquote:v1
```

`oc get bc,is -n appendix-a-grpc` showed why: the BuildConfig and
ImageStream were named `appendix-a-getquote`, not `getquote` —
`quarkus-openshift` names the in-cluster build after
`quarkus.application.name`, which defaults to the Maven **artifactId**
(`appendix-a-getquote`), not the module directory. The fix was one line in
`quarkus/src/main/resources/application.properties`:
`quarkus.application.name=getquote`. The wrongly-named BuildConfig/
ImageStream were deleted (`oc delete bc,is appendix-a-getquote -n
appendix-a-grpc`) and `deploy.sh` was re-run from the top — idempotent, as
designed.

## `deploy.sh`, re-run clean

```
==> 1/7 Project
    ✓ project appendix-a-grpc

==> 2/7 Proto files (contracts/proto is the single source of truth)
    ✓ copied types.proto + quote.proto into src/main/proto/

==> 3/7 In-cluster image build (binary S2I via quarkus-openshift)
    ✓ getquote:v1 sha256:90e9b7dabbf362c70304d0889dd4715d257bd80092c3cca5f5fc5c2f3595ba9b

==> 4/7 helm upgrade --install (workload + Routes)
    ✓ getquote Ready

==> 5/7 Istio control plane (OpenShift Service Mesh 3)
    ✓ IstioCNI Ready
    ✓ Istio v1.30.5 Ready (revision default)

==> 6/7 OpenTelemetry collector + Instrumentation
    ✓ otelcol-collector deployment created
    ✓ otelcol-collector Ready

==> 7/7 Sidecars, STRICT mTLS, canary, Java agent
    ✓ mesh + canary + Java agent applied
POD                                 READY   SCC             VERSION
getquote-1-build                    false   privileged      <none>
getquote-2-build                    false   privileged      <none>
getquote-d4fbb8664-bh7kf            true    restricted-v2   v1
getquote-ddcfd4d4d-rpsnf            true    restricted-v2   v1
getquote-v2-b5b79f559-vt27s         true    restricted-v2   v2
otelcol-collector-d6456cc9b-624wh   true    restricted-v2   <none>
ROUTE                  HOST                                                    TERMINATION
getquote-edge          getquote-edge-appendix-a-grpc.apps-crc.testing          edge
getquote-h2c           getquote-h2c-appendix-a-grpc.apps-crc.testing           edge
getquote-passthrough   getquote-passthrough-appendix-a-grpc.apps-crc.testing   passthrough
```

(The two `getquote-*-build` rows are completed BuildConfig build pods, not
application pods — `READY=false` there is expected; they are not part of
the running workload.) Every workload pod reports `restricted-v2` with no
`runAsUser` override — OpenShift assigned a UID from the namespace range.

Confirming the agent injection and the mesh sidecar landed on every pod:

```
$ oc get pod getquote-ddcfd4d4d-rpsnf -n appendix-a-grpc -o jsonpath='{.spec.initContainers[*].name}'
istio-validation istio-proxy opentelemetry-auto-instrumentation-java
$ oc get pod -n appendix-a-grpc -l app.kubernetes.io/name=getquote -o custom-columns='POD:.metadata.name,SCC:.metadata.annotations.openshift\.io/scc,UID:.spec.containers[0].securityContext.runAsUser'
POD                           SCC             UID
getquote-ddcfd4d4d-rpsnf      restricted-v2   1000670000
getquote-v2-b5b79f559-vt27s   restricted-v2   1000670000
```

## Routes: h2c and plain edge both fail — a real router limitation

With the cluster's ingress CA fetched:

```bash
oc get configmap default-ingress-cert -n openshift-config-managed \
    -o jsonpath='{.data.ca-bundle\.crt}' > /tmp/ingress-ca.crt
```

```
$ grpcurl -cacert /tmp/ingress-ca.crt \
    -d '{"origin":{"un_locode":"USNYC"},"destination":{"un_locode":"NLRTM"},"cargo":[{"weight_kg":500}]}' \
    getquote-h2c-appendix-a-grpc.apps-crc.testing:443 \
    shipping.quote.v1.QuoteService/GetQuote
Failed to dial target host "getquote-h2c-appendix-a-grpc.apps-crc.testing:443": credentials: cannot check peer: missing selected ALPN property. If you upgraded from a grpc-go version earlier than 1.67, your TLS connections may have stopped working due to ALPN enforcement. For more details, see: https://github.com/grpc/grpc-go/issues/434

$ grpcurl -cacert /tmp/ingress-ca.crt \
    -d '{"origin":{"un_locode":"USNYC"},"destination":{"un_locode":"NLRTM"},"cargo":[{"weight_kg":500}]}' \
    getquote-edge-appendix-a-grpc.apps-crc.testing:443 \
    shipping.quote.v1.QuoteService/GetQuote
Failed to dial target host "getquote-edge-appendix-a-grpc.apps-crc.testing:443": credentials: cannot check peer: missing selected ALPN property. If you upgraded from a grpc-go version earlier than 1.67, your TLS connections may have stopped working due to ALPN enforcement. For more details, see: https://github.com/grpc/grpc-go/issues/434
```

Identical failure for both — with and without the `h2c-enable` annotation —
which rules out the annotation as the cause. `curl --http2` against the
same h2c Route confirms it at the TLS layer directly:

```
$ curl -sv --cacert /tmp/ingress-ca.crt --http2 https://getquote-h2c-appendix-a-grpc.apps-crc.testing/ 2>&1 | grep -iE "ALPN|HTTP/"
* ALPN: curl offers h2,http/1.1
* ALPN: server did not agree on a protocol. Uses default.
* using HTTP/1.x
> GET / HTTP/1.1
< HTTP/1.1 415
```

The router's default was `ROUTER_DISABLE_HTTP2=true` on this cluster's
`router-default` Deployment. Annotating the IngressController
(`oc annotate ingresscontroller default
ingress.operator.openshift.io/default-enable-http2=true -n
openshift-ingress-operator`) flips that env var to `false` and rolls the
router — confirmed live — but the ALPN failure above was **unchanged**
after the rollout. Reading the live HAProxy config inside the router pod
explains why:

```
$ oc exec -n openshift-ingress deploy/router-default -- grep -n "no-alpn" /var/lib/haproxy/conf/haproxy.config
145:  bind unix@/var/lib/haproxy/run/haproxy-sni.sock ssl crt ... accept-proxy no-alpn
201:  bind unix@/var/lib/haproxy/run/haproxy-no-sni.sock ssl crt ... accept-proxy no-alpn
```

`fe_sni` — the one frontend every edge- and reencrypt-terminated Route is
dispatched through by SNI — binds with the literal HAProxy option
`no-alpn`, unconditionally. `ROUTER_DISABLE_HTTP2` governs ALPN on the
**backend** (router-to-pod) leg for reencrypt routes (visible on the
`console`/`image-registry` backends' `server ... ssl alpn h2,http/1.1`
lines in the same config) — it does not touch this client-facing bind at
all. The practical conclusion, confirmed by reading the generated config
rather than assumed from documentation: **on this OpenShift version, an
edge- or reencrypt-terminated Route cannot complete a native gRPC client's
TLS handshake, with or without `h2c-enable`**, because gRPC's HTTP/2
transport requires ALPN to select `h2`, and this frontend never offers it.
Passthrough is the one Route type where the client's TLS session is
negotiated directly against the pod, bypassing this frontend entirely.

## Passthrough: an end-to-end gRPC call succeeds

The default chart (plaintext app, mesh carries mTLS) cannot answer a
passthrough Route — a TLS ClientHello hits a plaintext gRPC listener and
gets nothing back:

```
$ grpcurl -cacert /tmp/ingress-ca.crt ... getquote-passthrough-appendix-a-grpc.apps-crc.testing:443 shipping.quote.v1.QuoteService/GetQuote
Failed to dial target host "getquote-passthrough-appendix-a-grpc.apps-crc.testing:443": EOF
```

To get one native-gRPC-over-a-Route call to succeed, a self-signed
cert/key pair was generated for this diagnostic only (Python's
`cryptography` library — this host has no `openssl` on `PATH`; `openssl
req -x509 -newkey rsa:2048 -nodes -days 30 -keyout tls.key -out tls.crt
-subj "/CN=<route-host>"` is the equivalent on a host that has it), loaded
into a Secret, and the chart's diagnostic `tls.enabled` flag turned on
**with the mesh off** — turning it on with the mesh on would break the
mesh-internal canary/STRICT calls on the same port, which is exactly the
"Decision" callout's point:

```bash
oc create secret tls getquote-passthrough-tls -n appendix-a-grpc \
    --cert=tls.crt --key=tls.key
helm upgrade --install getquote helm/ -n appendix-a-grpc --reset-then-reuse-values \
    --set mesh.enabled=false --set observability.enabled=false --set tls.enabled=true
```

```
$ grpcurl -cacert tls.crt \
    -d '{"origin":{"un_locode":"USNYC"},"destination":{"un_locode":"NLRTM"},"cargo":[{"weight_kg":500}]}' \
    getquote-passthrough-appendix-a-grpc.apps-crc.testing:443 \
    shipping.quote.v1.QuoteService/GetQuote
{
  "quote": {
    "currency": "USD",
    "amount": "925.00"
  }
}
```

With `-v`, the response trailer carries the pod identity, exactly the
`x-served-by` convention from `examples/22-mesh-loadbalancing`:

```
Response trailers received:
x-served-by: getquote-5f96d9f558-7brbx
```

`curl --http2` against the same Route confirms real ALPN negotiation this
time — the difference from the edge Route above:

```
$ curl -sv --cacert tls.crt --http2 https://getquote-passthrough-appendix-a-grpc.apps-crc.testing:443/ 2>&1 | grep -iE "ALPN|HTTP/2"
* ALPN: curl offers h2,http/1.1
* ALPN: server accepted h2
* using HTTP/2
> GET / HTTP/2
< HTTP/2 415
```

(`415` is expected — a plain `GET /` isn't a gRPC request; the point is the
ALPN negotiation succeeded, which the h2c/edge Route never managed.) The
server log line for the same call:

```
2026-10-14 15:57:12,628 INFO  [io.quarkus.grpc.runtime.GrpcServerRecorder] Started gRPC server on 0.0.0.0:9000 [TLS enabled: true]
2026-10-14 15:57:12,628 INFO  [com.patterncatalyst.appendixa.getquote.QuoteServiceImpl] (vert.x-eventloop-thread-0) GetQuote served-by=getquote-5f96d9f558-7brbx USNYC -> NLRTM quote=USD 925.00
```

After this diagnostic, the release was returned to its normal shape
(`--set mesh.enabled=true --set mesh.canary.enabled=true --set
observability.enabled=true --set tls.enabled=false`) for the rest of this
run.

## STRICT mTLS: an unmeshed, plaintext caller is rejected

With the mesh back on and `getquote-permissive` (the Route-facing PERMISSIVE
override) **temporarily removed** — it exists specifically so Route
traffic, which the router delivers in plaintext, is not itself rejected by
the namespace's STRICT policy, so leaving it in place would let an
unmeshed caller through too and the test would prove nothing:

```bash
oc delete peerauthentication getquote-permissive -n appendix-a-grpc
```

An unmeshed pod (`sidecar.istio.io/inject: "false"`) calling the
`getquote` Service directly, in plaintext, with a 5-second connect
timeout:

```
$ oc logs pod/debug-unmeshed -n appendix-a-grpc
Failed to dial target host "getquote.appendix-a-grpc.svc.cluster.local:9000": context deadline exceeded
```

A transport-level failure — a timed-out dial, not a gRPC status code the
application returned — the same distinction Ch19 and Ch22 draw for a
plaintext call against a TLS/mTLS-only server. The symptom here (dial
timeout) differs from Ch22's minikube/Istio run (`Connection reset by
peer`): STRICT mode's actual behavior at the TCP level is an
implementation detail of the sidecar's TLS inspection; both symptoms are
the same guarantee — `RoutingServiceServicer`/`QuoteServiceImpl` never ran,
never had the chance to answer. `getquote-permissive` was re-applied
immediately after (`helm upgrade --install` with the same `mesh.*` flags)
to restore the normal, Route-reachable state.

## Weighted canary: a real tally

30 calls from inside the mesh (each its own short-lived pod labeled
`istio.io/rev: default`, since the `fullstorydev/grpcurl` image ships no
shell to loop inside), against the plain `getquote` Service name, reading
the `x-served-by` trailer after each one — the same convention and the
same measurement method as `examples/22-mesh-loadbalancing`'s
`loadclient.py`:

```
call  1/30: served-by=getquote-ddcfd4d4d-b422k
call  2/30: served-by=getquote-ddcfd4d4d-b422k
...
call 22/30: served-by=getquote-v2-b5b79f559-mdn7q
call 23/30: served-by=getquote-ddcfd4d4d-b422k
...
call 30/30: served-by=getquote-ddcfd4d4d-b422k

=== tally ===
     29 getquote-ddcfd4d4d-b422k   (v1)
      1 getquote-v2-b5b79f559-mdn7q (v2)
```

1/30 (3.3%) landed on the configured 10% `v2Weight` — in the right
direction and the right order of magnitude for a 30-sample draw from a
90/10 split, but not a precise 3/30; Ch22's three-replica, 30-call fan-out
tests had enough samples per bucket (10 each) to land exactly on the
expected split, while a 10%-weighted bucket over only 30 calls has much
higher sampling variance. A larger sample (`examples/22-mesh-loadbalancing`
uses 30 calls against a 3-way *even* split, not a 90/10 split) would be
needed to pin the measured ratio closer to 10% with confidence; this run
reports the actual 30-call result rather than a larger, unrun sample.

## Traced: a real span reaches the OpenTelemetry collector

The Instrumentation CR's exporter endpoint was first set to
`http://otelcol-collector:4317` (the collector's OTLP/**gRPC** port). The
operator's injected Java agent defaults to the OTLP/**HTTP** exporter, and
the mismatch produced a real, repeated error in the application pod's
logs:

```
[otel.javaagent] WARN io.opentelemetry.exporter.otlp.internal.HttpExporter - Failed to export spans. Server responded with HTTP status code 415. Error message:
```

The fix was pointing the Instrumentation CR at the collector's OTLP/HTTP
port instead: `http://otelcol-collector:4318`. After `oc apply` and an
`oc rollout restart` of both Deployments, one `GetQuote` call through the
mesh produced a real span the collector's `debug` exporter printed:

```
2026-10-14T16:06:48.746Z info Traces {..., "resource spans": 1, "spans": 2}
ResourceSpans #0
     -> service.name: Str(getquote)
     -> k8s.pod.name: Str(getquote-86dddbf7d8-wskzb)
Span #0
    Trace ID       : 1ca346282445bd9f3ff7f8f59aa5b190
    Name           : shipping.quote.v1.QuoteService/GetQuote
     -> server.address: Str(getquote.appendix-a-grpc.svc.cluster.local)
     -> rpc.method: Str(GetQuote)
```

A real trace ID, a real span name matching the fully-qualified RPC method,
emitted with zero code or pom changes — the operator's Java-agent
injection, confirmed end to end.

## Final cluster state (left running)

```
$ oc get pods -n appendix-a-grpc -o custom-columns='POD:.metadata.name,READY:.status.containerStatuses[*].ready,SCC:.metadata.annotations.openshift\.io/scc,VERSION:.metadata.labels.version'
POD                                 READY   SCC             VERSION
getquote-86dddbf7d8-wskzb           true    restricted-v2   v1
getquote-v2-6544bfb567-r4fx2        true    restricted-v2   v2
otelcol-collector-d6456cc9b-624wh   true    restricted-v2   <none>

$ oc get peerauthentication,destinationrule,virtualservice -n appendix-a-grpc
NAME                                                       MODE         AGE
peerauthentication.security.istio.io/default               STRICT
peerauthentication.security.istio.io/getquote-permissive   PERMISSIVE
NAME                                           HOST
destinationrule.networking.istio.io/getquote   getquote
NAME                                          HOSTS
virtualservice.networking.istio.io/getquote   ["getquote"]

$ oc get instrumentation,opentelemetrycollector -n appendix-a-grpc
NAME                                             ENDPOINT
instrumentation.opentelemetry.io/getquote-java   http://otelcol-collector:4318
NAME                                             MODE         VERSION   READY
opentelemetrycollector.opentelemetry.io/otelcol  deployment   0.158.0   1/1
```

CRC was left **running** in this state at the end of the session, rather
than torn down, so the deployed cluster remains available for inspection;
`scripts/teardown.sh` removes it (workload, both operators, their CRDs and
namespaces, then `crc stop`) whenever it is run.

## What this run did NOT establish

- **A native gRPC client completing a call through an edge- or
  reencrypt-terminated Route.** Confirmed, with the live HAProxy config, to
  be a router-level ALPN limitation on this OpenShift version — not
  something this chart's annotation choice can work around.
- **A precise 90/10 canary measurement.** 1/30 is consistent with, but not
  a tight confirmation of, the configured 10% weight; a larger sample
  would narrow it.
- **Tracing with a real backend (Tempo/Grafana).** The collector here
  exports to `debug` (its own log output) only, specifically to keep this
  appendix's scope to the Routes/mesh/canary story instead of standing up
  a second LGTM stack Ch21 already covers in depth.
