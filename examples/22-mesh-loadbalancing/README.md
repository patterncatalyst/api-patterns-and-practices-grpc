# Ch22 — Load balancing & service mesh (minikube, cluster-tier)

`shipping.routing.v1.RoutingService.GetQuote` again, with zero contract
change, behind three replicas on a real Kubernetes cluster. This is the
one example in the book that is **not** run by CI: it needs a live
minikube cluster, so it runs by hand and its evidence lives in
[`expected-output.md`](expected-output.md), not in a `verify.sh` the
`examples` CI matrix auto-discovers. `scripts/validate.py`'s
`cluster-dir-no-verify` check enforces that this directory never grows one.

See `_docs/22-load-balancing-service-mesh.md` for the full explanation of
*why* a plain Kubernetes Service pins a gRPC client to one pod and what
each fix actually changes. This README covers *how to run it*.

## Layout

- `k8s/` — a kustomize base of CORE Kubernetes resources only: the
  `mesh-lb-demo` namespace, a 3-replica `Deployment` of the GetQuote server,
  a plain `ClusterIP` Service (`quote-plain`, the pin demo), and a
  `headless` Service (`quote-headless`, `clusterIP: None`, for client-side
  `round_robin`). This is the only part of the example the `k8s-manifests`
  CI job validates: `kubectl kustomize k8s | kubeconform -strict -summary`.
- `istio/` — the Istio custom resources, kept **out** of `k8s/`:
  `kubeconform -strict` has no schema for Istio CRDs and would fail the CI
  job if they were mixed in. `peer-authentication.yaml` (STRICT mesh mTLS),
  `destination-rule.yaml` (`ROUND_ROBIN` load balancing + outlier
  detection), `virtual-service.yaml` (retries + timeouts).
- `python/` — the server (`app/main.py`, `app/routing_service.py`,
  `app/quote.py` — identical formula to Ch5/Ch7) and the load client
  (`app/loadclient.py`), built into one image. Quarkus is a reasonable
  alternative for this server (every other chapter in the book implements
  both stacks); this chapter uses Python alone because UBI's minimal Python
  image starts in a few hundred milliseconds on minikube, where this
  demo recreates the Deployment several times per run and a JVM cold start
  would make every phase slower to observe.
- `scripts/bootstrap.sh` — one-time cluster setup: `minikube start`, a
  pinned `istioctl install`, demo-namespace creation and labeling.
- `scripts/run-demo.sh` — build the image, load it into minikube, deploy,
  and run the three phases (`plain`, `headless`, `istio`, or `all`).
- `scripts/teardown.sh` — remove the demo namespace and Istio CRs (add
  `--full` to also uninstall Istio and delete the minikube profile).
- `expected-output.md` — the actual recorded tallies from a real run.

## Prerequisites

`minikube`, `kubectl`, `docker`, and `curl` on `PATH`. `istioctl` is
optional — `bootstrap.sh` pins Istio 1.31.1 and downloads that exact
`istioctl` release into `scripts/.bin/` if the one on `PATH` is a different
version, because `istioctl install` installs whatever control-plane version
is embedded in the binary itself, not a version chosen by a flag.

## Run it

```bash
cd examples/22-mesh-loadbalancing
./scripts/bootstrap.sh      # minikube start + istioctl install + namespace
./scripts/run-demo.sh       # all three phases, in order
```

Or one phase at a time (useful while iterating, or to re-run just the one
that hit a transient Istio hiccup — see "Idempotency" below):

```bash
./scripts/run-demo.sh plain       # the pin
./scripts/run-demo.sh headless    # fix #1
./scripts/run-demo.sh istio       # fix #2
```

Each phase deletes and recreates a `loadclient-<phase>` Job, waits for it
to reach `Complete`, and prints its log — the exact tally of which pod
served each of the 30 calls, then a summary. `scripts/run-demo.sh istio`
additionally flips the Deployment's pods into the mesh
(`sidecar.istio.io/inject: "true"`, `kubectl rollout restart`) and applies
`istio/` before running its phase.

```bash
./scripts/teardown.sh           # namespace + Istio CRs
./scripts/teardown.sh --full    # + istioctl uninstall + minikube delete
```

## Why a Job, not `grpcurl` in a loop

`loadclient.py`'s module docstring covers this in detail, but it is worth
repeating here because it is the single easiest way to invalidate this
entire demo: `grpcurl` dials a fresh channel and opens a fresh TCP
connection for every invocation. A bash loop around `grpcurl` therefore
opens N independent connections, and against a plain `ClusterIP` Service
that means kube-proxy's iptables rule picks a (potentially different)
backend pod for each one — the loop would show a fan-out across all three
pods even in Phase 1, hiding the exact failure mode this chapter exists to
demonstrate. `loadclient.py` builds exactly one `grpc.aio` channel and
reuses it for all 30 calls, the way every real client should.

## Idempotency

`bootstrap.sh` is safe to re-run: it skips `minikube start` if the profile
is already running, and `istioctl install` reconciles an existing
installation in place rather than failing. `run-demo.sh` is safe to re-run
in full or by single phase: every `kubectl apply` is declarative, and the
load-client Job for a given phase is deleted before being recreated. If
`run-demo.sh istio` fails because Envoy has not yet picked up the new
`DestinationRule` (a timing issue, not a correctness one), re-running
`./scripts/run-demo.sh istio` alone clears it.

## Pins

- minikube v1.39.0 (docker driver, containerd runtime) — the book's
  standard minikube target (see Appendix A for the OpenShift Local
  alternative).
- Kubernetes v1.34.0 — inside Istio 1.31's officially supported 1.32-1.36
  range. Re-check both support matrices (`istioctl x precheck` and the
  Istio release notes) before bumping either version.
- Istio 1.31.1 — `bootstrap.sh` self-downloads this exact `istioctl`
  release if the one on `PATH` differs. Re-check with
  `gh release list -R istio/istio --exclude-pre-releases` and the release's
  own Kubernetes support-matrix callout before bumping.
- `registry.access.redhat.com/ubi10/python-314-minimal:10.2-1791464217` —
  the same pin Ch7 and Ch19 use. Re-check with `skopeo list-tags` before
  bumping.

## Verification status

`run on minikube, not CI` — see `expected-output.md` for the real recorded
tallies (pin, headless+round_robin fan-out, Istio fan-out, and the STRICT
mTLS cross-check against an unmeshed caller) from an actual
`bootstrap.sh && run-demo.sh` run. `scripts/validate.py`'s
`cluster-dir-no-verify` check confirms this directory carries no
`verify.sh` that the clusterless `examples` CI matrix could auto-discover;
the only CI coverage for this example is the static
`kubectl kustomize k8s | kubeconform -strict` check in the `k8s-manifests`
job, which validates schema correctness only, never cluster behavior.
