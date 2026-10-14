# Ch22 mesh-loadbalancing — recorded output

A real run on the authoring machine: minikube v1.39.0, Kubernetes v1.34.0
(docker driver, containerd), Istio 1.31.1, `ch22-routing-python:dev` built
locally and loaded with `minikube image load` (no registry, no push). This
file is evidence, not a template — every pod name, IP, and tally below came
from one actual `./scripts/bootstrap.sh && ./scripts/run-demo.sh` run on
2026-10-14, not a predicted or hand-edited value.

## Bootstrap record

```
==> using istioctl: client version: 1.31.1
==> [1/4] minikube start (profile=grpc-ch22, kubernetes=v1.34.0)
==> [2/4] istioctl install (context=grpc-ch22, pinned 1.31.1, profile=demo)
✔ Istio core installed ⛵️
✔ Istiod installed 🧠
✔ Egress gateways installed 🛫
✔ Ingress gateways installed 🛬
✔ Installation complete
==> [3/4] demo namespace: create + label for sidecar injection
namespace/mesh-lb-demo created
namespace/mesh-lb-demo labeled
==> [4/4] recording installed versions (copy these into expected-output.md)
minikube version: v1.39.0
kubectl client/server: Client Version: v1.37.1 / Server Version: v1.34.0
istioctl: client version: 1.31.1 / control plane version: 1.31.1 / data plane version: 1.31.1 (2 proxies)
```

## Phase 1 — plain `ClusterIP` Service: the pin

```
=== phase: phase1-plain-pin (target=quote-plain.mesh-lb-demo.svc.cluster.local:9000 lb_policy=pick_first meshed=false) ===
  call   1/30: served-by=quote-786c5744c4-5fmhg
  call   2/30: served-by=quote-786c5744c4-5fmhg
  ...
  call  30/30: served-by=quote-786c5744c4-5fmhg

=== phase1-plain-pin ===
target=quote-plain.mesh-lb-demo.svc.cluster.local:9000 lb_policy=(default: pick_first) calls=30
distinct pods answering: 1
  quote-786c5744c4-5fmhg: 30/30
```

All 30 calls, over one channel, landed on the same pod. The other two
replicas (`quote-786c5744c4-tx68v`, `quote-786c5744c4-w5f49`) were `Running`
and ready the entire time — `kubectl get pods` confirms it:

```
NAME                     READY   STATUS    RESTARTS   AGE   IP            NODE
quote-786c5744c4-5fmhg   1/1     Running   0          7s    10.244.0.10   grpc-ch22
quote-786c5744c4-tx68v   1/1     Running   0          7s    10.244.0.9    grpc-ch22
quote-786c5744c4-w5f49   1/1     Running   0          7s    10.244.0.11   grpc-ch22
```

## Phase 2 — headless Service + client-side `round_robin`: fix #1

```
=== phase: phase2-headless-round-robin (target=dns:///quote-headless.mesh-lb-demo.svc.cluster.local:9000 lb_policy=round_robin meshed=false) ===
  call   1/30: served-by=quote-786c5744c4-5fmhg
  call   2/30: served-by=quote-786c5744c4-tx68v
  call   3/30: served-by=quote-786c5744c4-w5f49
  call   4/30: served-by=quote-786c5744c4-5fmhg
  ...(repeats in the same 3-pod cycle)...
  call  30/30: served-by=quote-786c5744c4-w5f49

=== phase2-headless-round-robin ===
target=dns:///quote-headless.mesh-lb-demo.svc.cluster.local:9000 lb_policy=round_robin calls=30
distinct pods answering: 3
  quote-786c5744c4-5fmhg: 10/30
  quote-786c5744c4-tx68v: 10/30
  quote-786c5744c4-w5f49: 10/30
```

Same three pods, same client code pattern (one channel, N calls), only the
Service type and the channel's LB policy changed. Exactly 10/10/10 — the
expected perfect round-robin split for 30 calls across 3 subchannels.

## Phase 3 — Istio `DestinationRule` (`ROUND_ROBIN`) + STRICT mTLS: fix #2

The Deployment was rolled to pick up the sidecar first (pod names changed
because `kubectl rollout restart` replaces every pod):

```
NAME                     READY   STATUS    RESTARTS   AGE
quote-7f47bcc96-4vt7v    2/2     Running   0          18s
quote-7f47bcc96-b8vqc    2/2     Running   0          23s
quote-7f47bcc96-fgr2l    2/2     Running   0          28s
```

`2/2` — the app container plus the injected `istio-proxy` sidecar. Then,
against the same plain `quote-plain` Service used in Phase 1 (no headless
Service, no client-side LB policy — `loadclient.py`'s `LB_POLICY` is unset,
same as Phase 1):

```
=== phase: phase3-istio-l7 (target=quote-plain.mesh-lb-demo.svc.cluster.local:9000 lb_policy=pick_first meshed=true) ===
  call   1/30: served-by=quote-7f47bcc96-fgr2l
  call   2/30: served-by=quote-7f47bcc96-b8vqc
  call   3/30: served-by=quote-7f47bcc96-4vt7v
  ...
  call  30/30: served-by=quote-7f47bcc96-4vt7v

=== phase3-istio-l7 ===
target=quote-plain.mesh-lb-demo.svc.cluster.local:9000 lb_policy=(default: pick_first) calls=30
distinct pods answering: 3
  quote-7f47bcc96-4vt7v: 10/30
  quote-7f47bcc96-b8vqc: 10/30
  quote-7f47bcc96-fgr2l: 10/30
```

The plain `ClusterIP` Service that pinned every call in Phase 1 now fans
out perfectly — 10/10/10 — with zero changes to `loadclient.py`,
`RoutingServiceServicer`, or the Service object itself. The only things
that changed were cluster configuration: the Deployment's pods are meshed,
and `istio/destination-rule.yaml` is applied.

The load-client Job itself completed cleanly even while meshed:

```
NAME                              READY   STATUS      RESTARTS   AGE
loadclient-phase3-istio-l7-k992w  0/2     Completed   0          15s
```

Its `istio-init` and `istio-proxy` containers (the native-sidecar
mechanism, both running as Kubernetes "sidecar" `initContainers` with
`restartPolicy: Always`) both show `terminated / exitCode 0 / reason
Completed`, confirming the sidecar shut itself down once the `loadclient`
container finished — a Job that would have hung at `1/2` forever on older,
non-native Istio sidecars.

## mTLS cross-check: an unmeshed caller is refused

With `PeerAuthentication` STRICT applied, a load-client Job explicitly
annotated `sidecar.istio.io/inject: "false"` (so it dials `quote-plain`
directly, with no sidecar of its own) fails every call:

```
grpc.aio._call.AioRpcError: <AioRpcError of RPC that terminated with:
	status = StatusCode.UNAVAILABLE
	details = "failed to connect to all addresses; last error: UNAVAILABLE: ipv4:10.102.229.60:9000: recvmsg:Connection reset by peer (104)"
>
```

The connection reset, not a gRPC application error, is the signature of a
transport-layer rejection — the same distinction Chapter 19 draws for a
plaintext call against a TLS-only server: the handshake never got far
enough to produce a `Code:` line.

## Resource state used for these runs

```
$ kubectl --context grpc-ch22 -n mesh-lb-demo get peerauthentication,destinationrule,virtualservice
NAME                                           MODE     AGE
peerauthentication.security.istio.io/default   STRICT   20s

NAME                                              HOST                                          AGE
destinationrule.networking.istio.io/quote-plain   quote-plain.mesh-lb-demo.svc.cluster.local    20s

NAME                                             GATEWAYS   HOSTS                                             AGE
virtualservice.networking.istio.io/quote-plain              ["quote-plain.mesh-lb-demo.svc.cluster.local"]   20s
```
