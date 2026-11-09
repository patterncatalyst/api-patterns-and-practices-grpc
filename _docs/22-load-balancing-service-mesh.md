---
title: "Load balancing & service mesh"
order: 22
part: "Observability, Mesh & Load Balancing"
description: "Why a plain Kubernetes Service pins a gRPC channel to one pod, the client-side (headless Service plus round_robin) and mesh (Istio) fixes, and STRICT mTLS with retries and timeouts, run by hand on minikube."
duration: "27 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why a Kubernetes `ClusterIP` Service pins a long-lived gRPC channel to one pod, even with several healthy replicas.
- Fix the pin on the client with a headless Service (`clusterIP: None`), a `dns:///` target and `grpc.lb_policy_name=round_robin`.
- Contrast that with Istio's sidecar balancing, which re-picks a backend per HTTP/2 stream with no client change.
- Enable STRICT `PeerAuthentication` mTLS and recognize a sidecar-rejected call as a connection reset, not a gRPC status.
- Configure `VirtualService` retries and timeouts and `DestinationRule` outlier detection, and explain why a retry is a fresh load-balancing pick.

## Why this matters

Build one channel and reuse it for the life of the process: it multiplexes hundreds of calls over one HTTP/2 connection instead of paying a TCP and TLS handshake per request. Put that channel in front of a Kubernetes `Deployment` with three replicas of `RoutingService.GetQuote` and the rule has a side effect Compose never showed. The channel's one connection ends at exactly one pod and never moves. A single process made that invisible; a second replica turns connection reuse into a routing decision nobody made.

The demo needs a cluster, so it runs by hand on minikube rather than in CI. `scripts/bootstrap.sh` starts minikube and installs Istio, and `scripts/run-demo.sh` builds the image, deploys it and runs three phases. The contract is untouched. The pod-identity signal is `x-served-by: <HOSTNAME>`, a response trailer, plus a server log line.

{% include excalidraw.html file="22-grpc-lb-problem" alt="A gRPC client holding one long-lived HTTP/2 connection reaches a quote-plain ClusterIP Service, which forwards to Pod A inside a Deployment of three replicas. Pods B and C sit idle, labeled idle for this connection. A note states all 30 GetQuote calls over this channel answer from Pod A, and B and C never see one." caption="Figure 22.1: a plain ClusterIP Service, three replicas, one channel: every call lands on the pod kube-proxy picked when the connection opened." %}

## The L4 problem

A `ClusterIP` Service is a virtual IP with no process behind it. `kube-proxy` programs iptables or IPVS rules that rewrite the destination to one backing pod, and it chooses **once per TCP connection**. A client that opens a connection per request gets a fresh pick each time, so traffic spreads. A gRPC client keeps one connection for as long as the process runs, so every RPC it ever makes goes to the same pod.

`loadclient.py` opens one channel to `quote-plain.mesh-lb-demo.svc.cluster.local:9000` (an ordinary `ClusterIP` Service), makes 30 `GetQuote` calls and reads the `x-served-by` trailer after each:

```
=== phase1-plain-pin ===
target=quote-plain.mesh-lb-demo.svc.cluster.local:9000 lb_policy=(default: pick_first) calls=30
distinct pods answering: 1
  quote-786c5744c4-5fmhg: 30/30
```

The other two replicas were `Running` and ready the whole time. Neither Kubernetes nor grpc-core's default `pick_first` policy is at fault: a `ClusterIP` resolves to one address, so there is one thing to pick first. A stateless, horizontally scaled service collapses to one replica for every long-lived client, and nothing in the client's logs or return values says so.

<div class="callout callout--warn"><p class="callout__title">Watch out</p><p>A <code>grpcurl</code> loop is not an equivalent load test. Each invocation is a new process with a new channel, so 30 calls open 30 connections and kube-proxy rolls a backend for each. The loop reports an even fan-out that no long-lived client ever sees. <code>loadclient.py</code> builds one channel and reuses it for all 30 calls, as a real client does.</p></div>

## Fix 1: headless Service and round_robin

A headless Service (`k8s/service-headless.yaml` sets `clusterIP: None`) has no virtual IP and no `kube-proxy` involvement. DNS returns one A record **per ready pod**. A client that uses all of them gets real distribution with no server change. `loadclient.py` builds its channel with a `dns:///` target and an explicit policy:

```python
    options = [("grpc.lb_policy_name", LB_POLICY)] if LB_POLICY else []

    # One channel, built once, reused for every call below: see the module
    # docstring for why this is the entire point of the exercise.
    async with grpc.aio.insecure_channel(TARGET, options=options) as channel:
        stub = routing_pb2_grpc.RoutingServiceStub(channel)
```

With `TARGET=dns:///quote-headless.mesh-lb-demo.svc.cluster.local:9000` and `LB_POLICY=round_robin`, the resolver returns three addresses and `round_robin` opens a subchannel (an HTTP/2 connection) to each. It is still one channel, reused for the process lifetime, now holding three connections:

```
=== phase2-headless-round-robin ===
target=dns:///quote-headless.mesh-lb-demo.svc.cluster.local:9000 lb_policy=round_robin calls=30
distinct pods answering: 3
  quote-786c5744c4-5fmhg: 10/30
  quote-786c5744c4-tx68v: 10/30
  quote-786c5744c4-w5f49: 10/30
```

This is a real fix, and it is the client's job. Every language stack and every internal caller must ask for a headless name and set `round_robin`, independently, forever.

{% include excalidraw.html file="22-lb-fixes-headless-and-mesh" alt="Two side-by-side panels. The left panel, fix one, headless Service plus client round_robin, shows a gRPC client opening three separate subchannels, one each to Pod A, Pod B, and Pod C. The right panel, fix two, Istio sidecar per-request L7 balancing, shows a gRPC client with unchanged code sending one connection to a local client-side Envoy sidecar, which itself opens connections to Pod A, Pod B, and Pod C and picks one per individual request." caption="Figure 22.2: two fixes for the same problem. One gives the client every address; the other moves the decision into a sidecar the client never sees." %}

## Fix 2: the mesh balances at Layer 7

Istio changes nothing in the client. The `istio` phase patches `sidecar.istio.io/inject: "true"` onto the pod template (the base manifest ships `"false"`, so it stays mesh-agnostic) and restarts the pods, each now `2/2` with an `istio-proxy` sidecar. It then applies `istio/destination-rule.yaml`:

```yaml
spec:
  host: quote-plain.mesh-lb-demo.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      simple: ROUND_ROBIN
    outlierDetection:
      consecutive5xxErrors: 3
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
```

Istio's iptables rules redirect a meshed pod's outbound traffic through its local Envoy sidecar before `kube-proxy`'s rewrite. The client still opens one connection, to its own sidecar over loopback. The sidecar knows every pod behind `quote-plain` from istiod, holds upstream connections to all three, and picks one **per HTTP/2 stream**, which is one RPC. The fan-out happens below the channel.

{% include excalidraw.html file="22-l4-vs-l7-balancing" alt="Two stacked panels. The top panel, L4, one load-balancing decision per connection, shows one HTTP/2 connection carrying three requests all arriving at Pod A, the only pod reached. The bottom panel, L7, one load-balancing decision per request, shows one HTTP/2 connection carrying the same three requests, but each one is routed individually: request one to Pod A, request two to Pod B, request three to Pod C." caption="Figure 22.3: an L4 balancer commits to a backend when the connection opens; an L7 balancer re-decides for every request on that connection." %}

The same `loadclient.py`, with `LB_POLICY` unset and the same `quote-plain` Service that pinned to one pod in the first phase:

```
=== phase3-istio-l7 ===
target=quote-plain.mesh-lb-demo.svc.cluster.local:9000 lb_policy=(default: pick_first) calls=30
distinct pods answering: 3
  quote-7f47bcc96-4vt7v: 10/30
  quote-7f47bcc96-b8vqc: 10/30
  quote-7f47bcc96-fgr2l: 10/30
```

| | Plain `ClusterIP` | Headless + `round_robin` | Istio sidecar |
| --- | --- | --- | --- |
| Decision made | Per connection | Per call, by the client | Per stream, by the sidecar |
| Client change | None | `dns:///` target and LB policy | None |
| Result for 30 calls | 1 pod | 10/10/10 | 10/10/10 |

## STRICT mTLS

`istio/peer-authentication.yaml` sets mesh-wide mTLS to `STRICT` for the namespace. Meshed pods refuse plaintext from anything not meshed, with no change to `RoutingServiceServicer` or `loadclient.py`, because the sidecars originate and terminate TLS around code that still calls `grpc.aio.insecure_channel`. It is mutual TLS without `certgen` or a Java keystore, with issuance and rotation owned by the mesh.

An unmeshed caller, here a load-client Job annotated `sidecar.istio.io/inject: "false"`, now fails every call:

```
grpc.aio._call.AioRpcError: <AioRpcError of RPC that terminated with:
	status = StatusCode.UNAVAILABLE
	details = "failed to connect to all addresses; last error: UNAVAILABLE: ipv4:10.102.229.60:9000: recvmsg:Connection reset by peer (104)"
>
```

That is a connection reset in the sidecar before any `GetQuoteRequest` is deserialized, so the handler never runs and could not return `UNAUTHENTICATED`. The client sees `UNAVAILABLE` only because the channel could not connect.

## Retries, timeouts and outlier detection

`istio/virtual-service.yaml` layers retry and timeout policy over the `DestinationRule`:

```yaml
  http:
    - route:
        - destination:
            host: quote-plain.mesh-lb-demo.svc.cluster.local
      retries:
        attempts: 2
        perTryTimeout: 1s
        retryOn: unavailable,resource-exhausted
      timeout: 3s
```

A retry is a **new** pick from the same `ROUND_ROBIN` pool, made by the same sidecar, not a replay to the same pod. If one pod answers `RESOURCE_EXHAUSTED`, the retry very likely lands on another, and neither `RoutingServiceServicer` nor the client knows. The `outlierDetection` block closes the loop: three consecutive 5xx-equivalent failures eject a pod from the pool for 30 seconds, so an unhealthy pod stops receiving picks instead of only being retried around.

## Native sidecars and Jobs

Older Istio releases kept a `Job` pod alive forever because the sidecar never learned the main work was done, leaving it at `1/2`. Istio 1.29 and later use Kubernetes sidecar containers: `istio-proxy` runs as an `initContainer` with `restartPolicy: Always` and shuts down when the main containers finish. The meshed load-client Job ends `0/2 Completed`, with both containers terminated at exit code 0.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Use a headless Service with client-side <code>round_robin</code> when you control and can audit every caller, such as an internal library or shared client wrapper: it needs no sidecar, no extra hop and no mesh to operate. Use a mesh when callers are numerous, heterogeneous or owned by other teams: the fix becomes infrastructure configuration instead of a convention each caller must remember, and it brings mTLS and retry policy that would otherwise be reimplemented per language. Turn on STRICT mTLS for any namespace where every legitimate caller can be meshed. Pair retries with outlier detection: retries alone keep hammering a broken pod, and outlier detection alone leaves the first unlucky request on it to fail.</p></div>

> **🤖 Explore with your agent**
>
> "In `examples/22-mesh-loadbalancing`, add a fourth replica to `k8s/deployment.yaml` and extend `istio/destination-rule.yaml` so `quote-plain` ejects a pod after two consecutive 5xx responses. Do not change `loadclient.py` or `RoutingServiceServicer`. Then say which of the plain, headless and Istio phases should show four pods answering and which should still show one."
>
> Check: re-run `./scripts/run-demo.sh plain`, `headless` and `istio`; `plain` must still report one pod, 30/30.

## Build, run, observe

```bash
cd examples/22-mesh-loadbalancing
./scripts/bootstrap.sh    # minikube start + pinned istioctl install + namespace
./scripts/run-demo.sh     # all three phases: plain, headless, istio
./scripts/run-demo.sh plain   # or headless, or istio, for one phase
```

`run-demo.sh` builds `ch22-routing-python:dev`, loads it into minikube with `minikube image load` (no registry), applies the kustomize base in `k8s/` and runs each phase as a `loadclient-<phase>` Job, deleted and recreated so a failed run restarts from the top. Expect one pod at 30/30 for `plain`, and three pods at 10/10/10 for `headless` and `istio`. `README.md` and `expected-output.md` hold the recorded run (minikube v1.39.0, Kubernetes v1.34.0, Istio 1.31.1).

Independent confirmation comes from the pods themselves. Each logs its own identity for every call, from a different code path than the trailer the client reads:

```bash
kubectl --context grpc-ch22 -n mesh-lb-demo logs deploy/quote --all-containers=false --prefix | grep "GetQuote served-by"
```

Before trusting a fan-out result, confirm the Istio resources are applied with `kubectl --context grpc-ch22 -n mesh-lb-demo get peerauthentication,destinationrule,virtualservice` (mode `STRICT`), and that `istioctl version --context grpc-ch22` shows the data plane on the same version as the control plane.

CI cannot run any of this. There is no `verify.sh` here, because the `examples` matrix auto-discovers every `verify.sh`, and `scripts/validate.py` fails the build if one appears here. CI checks only that the core manifests parse:

```bash
kubectl kustomize examples/22-mesh-loadbalancing/k8s | kubeconform -strict -summary
```

That covers the namespace, Deployment and both Services. The three Istio resources live in `istio/`, outside that pipe, because `kubeconform -strict` has no schema for them. The pin, the fan-out and the mTLS rejection are cluster behavior and are checked only by the manual run.

Experiments:

- **Swap the load client for a `grpcurl` loop.** Thirty `grpcurl` calls against `quote-plain` before meshing open thirty connections and report an even spread across all three pods, hiding the pin that one reused channel shows.
- **Unmeshed caller under STRICT.** Run the load client with `sidecar.istio.io/inject: "false"` after STRICT is on: every call fails with the connection reset above.

## What you learned

- A `ClusterIP` Service picks a backend once per TCP connection, which is invisible to a per-request client and a silent trap for a gRPC client that reuses its channel.
- A headless Service plus a `dns:///` target and `round_robin` spreads calls across every pod, at the cost of every caller doing the same.
- Istio moves the decision into the sidecar, which balances per HTTP/2 stream, so unchanged clients and the same `ClusterIP` Service fan out evenly.
- STRICT mTLS rejects an unmeshed caller with a connection reset, never a gRPC status the handler chose.
- A `grpcurl` loop hides the pin because it opens a connection per call.

The next topic moves outside the cluster: exposing `RoutingService.GetQuote` to a browser that cannot speak native gRPC, comparing a grpc-web proxy with a REST transcoding gateway.

## For deeper coverage

- Cloud Native Design Patterns, "Appendix I, L7 Routing & Traffic Management" chapter: the four-layer (edge, gateway, mesh, in-app) view that L4 versus L7 is one slice of.
- Michael T. Nygard, *Release It!, Second Edition*, Pragmatic Bookshelf, 2018: retries, timeouts and failure isolation.
- [Istio: Traffic Management concepts](https://istio.io/latest/docs/concepts/traffic-management/) and [`PeerAuthentication` reference](https://istio.io/latest/docs/reference/config/security/peer_authentication/).
- [Kubernetes: Headless Services](https://kubernetes.io/docs/concepts/services-networking/service/#headless-services).
