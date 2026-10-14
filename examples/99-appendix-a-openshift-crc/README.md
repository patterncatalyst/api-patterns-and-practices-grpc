# Appendix A — OpenShift Local (CRC)

`shipping.quote.v1.QuoteService.GetQuote` — the same frozen contract Ch27's
final project serves — run on OpenShift Local (CRC) instead of Docker
Compose or minikube: an in-cluster binary S2I build, a Helm chart with
three gRPC Route variants (h2c / plain edge / passthrough), and OpenShift
Service Mesh 3 (Sail) with STRICT mTLS and a weighted canary. Zero contract
change — `contracts/proto/shipping/quote/v1/quote.proto` and its
`shipping/type/v1/types.proto` import are copied in by `scripts/deploy.sh`,
never edited.

This is a **CLUSTER-tier example**: it needs a running CRC instance and is
driven by hand, never in CI. This directory has no `verify.sh` —
`scripts/validate.py`'s `cluster-dir-no-verify` check fails the build if one
ever appears, because the clusterless `examples` CI matrix auto-discovers
every `verify.sh` it finds and would try to run it with no cluster behind
it. CI's own involvement with this directory is the `k8s-manifests` job's
`helm lint` + `helm template | kubeconform -ignore-missing-schemas` against
`helm/` — a static, schema-level check, never a live cluster assertion.

## Layout

```
examples/99-appendix-a-openshift-crc/
├── quarkus/              # the GetQuote server (plaintext gRPC; no app-level TLS)
├── helm/                 # the chart CI lints/templates (Chart.yaml at the top level)
├── mesh/                 # operator Subscriptions, the Istio control plane, the OTel collector
├── scripts/
│   ├── lib.sh            # shared helpers (require_crc, install_operator) — sourced, not run
│   ├── bootstrap.sh      # crc start + pinned OSSM/OpenTelemetry operator install
│   ├── deploy.sh         # in-cluster image build + helm install + mesh/canary/tracing
│   └── teardown.sh       # remove the workload, both operators, their CRDs and namespaces, then crc stop
└── expected-output.md    # the real transcript this chapter quotes from
```

## Run it

Needs `crc`, `oc`, `helm`, `jq`, and Maven + JDK 25 on the host — no local
container engine; the image builds inside the cluster.

```bash
cd examples/99-appendix-a-openshift-crc
./scripts/bootstrap.sh    # crc start (12 vCPU / 32 GiB) + OSSM + OpenTelemetry operators, pinned
./scripts/deploy.sh       # build, deploy, mesh, STRICT mTLS, canary, Java-agent injection
```

Then drive it by hand (see the chapter's "On the wire" box for the full
sequence — the ingress CA, the three Routes, the canary tally, and the
STRICT-mTLS rejection):

```bash
eval "$(crc oc-env)"
oc get configmap default-ingress-cert -n openshift-config-managed \
    -o jsonpath='{.data.ca-bundle\.crt}' > /tmp/ingress-ca.crt

# This call FAILS on OpenShift 4.22.14 — see "What it demonstrates" below
# and expected-output.md for why, and for the passthrough Route that works.
grpcurl -cacert /tmp/ingress-ca.crt \
    -d '{"origin":{"un_locode":"USNYC"},"destination":{"un_locode":"NLRTM"},"cargo":[{"weight_kg":500}]}' \
    getquote-h2c-appendix-a-grpc.apps-crc.testing:443 \
    shipping.quote.v1.QuoteService/GetQuote
```

Tear down when done:

```bash
./scripts/teardown.sh                # clean up, then crc stop
./scripts/teardown.sh --keep-running # clean up, leave CRC running
```

## What it demonstrates

- **Zero contract change.** `GetQuoteRequest`/`GetQuoteResponse` are
  byte-for-byte what Chapter 5 defined; only the deployment target changed.
- **Three Route termination strategies for the same gRPC Service — and a
  real, hard-won finding about which one actually works.** A live run
  found that OpenShift 4.22.14's router hard-codes `no-alpn` on the shared
  frontend every edge- and reencrypt-terminated Route goes through, so a
  native gRPC client's TLS handshake cannot complete there *regardless* of
  the `haproxy.router.openshift.io/h2c-enable: "true"` annotation (that
  annotation governs the router-to-pod hop only). Passthrough — raw TCP,
  no router-side TLS termination at all — is the one Route type where a
  real `grpcurl` call completes end to end, and only once the pod
  terminates TLS itself (a diagnostic-only chart flag, `tls.enabled`, run
  with the mesh off — see `expected-output.md`).
- **Mesh mTLS instead of app mTLS.** Unlike Ch19/Ch27's hand-rolled
  `quarkus.grpc.server.ssl.*` + `certgen`, this server runs plaintext gRPC
  and lets OpenShift Service Mesh 3's STRICT `PeerAuthentication` terminate
  mTLS in the Envoy sidecar — the mesh equivalent of Ch22's
  `peer-authentication.yaml`, here on OpenShift instead of minikube.
- **A weighted canary.** `getquote-v2` (10% of mesh-internal traffic by
  default) is distinguished purely by the `x-served-by` response trailer —
  the same pod-identity convention `examples/22-mesh-loadbalancing` uses —
  so no proto field carries the canary split.
- **An unmeshed, plaintext caller is rejected under STRICT.** A debug pod
  with no sidecar calling the `getquote` Service directly (not through a
  Route, and with the Route-facing PERMISSIVE override temporarily
  removed) times out at the transport layer — never a gRPC status code —
  confirmed on a live run, recorded in `expected-output.md`.
- **A traced call.** The Red Hat build of OpenTelemetry's Java-agent
  injection (zero code, zero pom change) produces a real span for
  `shipping.quote.v1.QuoteService/GetQuote`, captured by an in-namespace
  OpenTelemetry Collector.

## Verification status

See the chapter's closing footer and `expected-output.md` for exactly what
ran on a real CRC instance, what succeeded, and what did not.
