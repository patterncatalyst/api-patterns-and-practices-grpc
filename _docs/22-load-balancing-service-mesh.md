---
title: "Load balancing & service mesh"
order: 22
part: "Observability, Mesh & Load Balancing"
description: "The L4 single-connection problem behind a plain Kubernetes Service, the client-side (headless + round_robin) and mesh (Istio/Envoy) fixes, and STRICT mTLS + retries/timeouts — run by hand on minikube."
duration: "27 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why a Kubernetes `ClusterIP` Service's pick-once-per-TCP-connection routing silently pins a long-lived gRPC channel to a single pod, even with multiple healthy replicas.
- Fix the pin client-side with a headless Service (`clusterIP: None`) plus a `dns:///` channel target and `grpc.lb_policy_name=round_robin`.
- Contrast that client-side fix with Istio's sidecar-based L7 balancing, which re-picks a backend per HTTP/2 stream instead of per connection, with zero client code change.
- Enable STRICT `PeerAuthentication` mTLS and recognize a sidecar-rejected call as a transport-level connection reset, not a gRPC status code.
- Configure Istio `VirtualService` retries/timeouts and `DestinationRule` outlier detection, and explain why a retry is a fresh load-balancing pick rather than a replay to the same pod.

## Why this matters

Chapter 7 established the rule every example since has followed without comment: build one `grpc.aio` channel, reuse it for the life of the process, never dial a fresh one per call. That discipline is correct, and every chapter in this book has rewarded it — a channel is one long-lived HTTP/2 connection, and reusing it is what lets gRPC multiplex hundreds of concurrent calls over a single socket instead of paying a TLS handshake and a TCP three-way handshake per request. This chapter puts that same correctly-built, correctly-reused channel behind a Kubernetes `Deployment` running three replicas of `RoutingService.GetQuote`, and shows the failure mode a single-container Compose stack can never expose: the channel's one connection terminates at exactly one of those three pods, and it never moves. Every chapter before this one ran against one server process, so "the client's one connection goes to the one server" was never a choice — it was the only option. The moment a service has more than one replica, which is the moment it is actually ready to carry production traffic, reusing one connection turns into a routing decision nobody actually made.

This chapter's example is different from every other one in the book in one respect: it needs a running Kubernetes cluster, so it runs on minikube by hand rather than inside CI. `examples/22-mesh-loadbalancing/`'s `README.md` covers the full procedure; `scripts/bootstrap.sh` starts minikube and installs Istio, and `scripts/run-demo.sh` builds the server image, deploys it, and runs the three phases this chapter walks through. There is no `verify.sh` in that directory, and `scripts/validate.py`'s `cluster-dir-no-verify` check fails the build if one ever appears there, because the clusterless `examples` CI matrix auto-discovers every `verify.sh` it finds and would try to run this one without a cluster to run it against. The contract is untouched: `GetQuoteRequest`/`GetQuoteResponse` are byte-for-byte what Chapter 5 defined, and the pod-identity signal this chapter's whole demo depends on — `x-served-by: <HOSTNAME>` — is a response trailer, gRPC metadata riding outside the message entirely, plus a server log line. `git diff main -- contracts/` stays empty.

{% include excalidraw.html file="22-grpc-lb-problem" alt="A gRPC client holding one long-lived HTTP/2 connection reaches a quote-plain ClusterIP Service, which forwards to Pod A inside a Deployment of three replicas. Pods B and C sit idle, labeled idle for this connection. A note states all 30 GetQuote calls over this channel answer from Pod A, and B and C never see one." caption="Figure 22.1 — a plain ClusterIP Service, three replicas, one channel: every call lands on whichever single pod kube-proxy picked when the connection was first opened." %}

## The L4 problem: one connection, one pod, for life

A Kubernetes `ClusterIP` Service is a virtual IP with no process behind it. `kube-proxy` programs iptables (or IPVS) rules that intercept a packet addressed to that virtual IP and rewrite its destination to one of the Service's backing pods — and it makes that choice **once per TCP connection**, not once per request. For an HTTP/1.1-style client that opens a new connection per request, this is invisible: every request gets its own fresh roll of the dice, and traffic spreads across the backing pods on its own. For a gRPC client, it is a trap, because the entire design point of HTTP/2 — and the entire reason Chapter 7 told you to build one channel and keep it — is that one connection carries every call for as long as the process runs. `kube-proxy` rewrites that connection's destination exactly once, and from that moment on, every RPC the channel ever carries, no matter how many, goes to the same pod.

`examples/22-mesh-loadbalancing/k8s/service-plain.yaml` is an entirely ordinary `ClusterIP` Service — nothing is misconfigured, nothing is a toy example of bad YAML. It is also the first thing `scripts/run-demo.sh`'s `plain` phase points `loadclient.py` at, and the result demonstrates exactly this mechanism on a real cluster: `loadclient.py` opens one channel to `quote-plain.mesh-lb-demo.svc.cluster.local:9000`, makes 30 `GetQuote` calls over it, and reads the `x-served-by` trailer after each one.

```
=== phase1-plain-pin ===
target=quote-plain.mesh-lb-demo.svc.cluster.local:9000 lb_policy=(default: pick_first) calls=30
distinct pods answering: 1
  quote-786c5744c4-5fmhg: 30/30
```

Thirty calls, one pod, while `kubectl get pods` confirmed the other two replicas (`quote-786c5744c4-tx68v`, `quote-786c5744c4-w5f49`) were `Running` and ready the entire time. Nothing about this is a bug in Kubernetes or in grpc-core's default LB policy, `pick_first` — `pick_first` does exactly what its name says, and a `ClusterIP` Service resolves to exactly one address, so there is only ever one thing to pick first. The failure is architectural: a stateless, horizontally-scaled service, fronted by the one Kubernetes primitive most engineers reach for first, silently collapses to a single replica for every long-lived client — and nothing in that client's logs, metrics, or return values says so. A naive load test that opens a fresh connection per request (the next section names the specific tool that does this) would show perfectly even traffic and hide the problem completely, right up until a real client — a backend service holding one reused channel open for its process lifetime, exactly as Chapter 7 recommends — sends every request to one pod indefinitely.

<div class="callout callout--warn"><p class="callout__title">Watch out</p><p>Running <code>grpcurl</code> in a bash loop as a load generator looks like an equivalent test and is not one. Every <code>grpcurl</code> invocation is a fresh process that dials a brand-new channel for that one call and exits, so a loop of 30 invocations opens 30 independent TCP connections — against the plain <code>ClusterIP</code> Service above, that means kube-proxy rolls a fresh backend pod for each of the 30 connections, and the loop reports a perfectly even fan-out across all three pods. That result is real, and it is also not what any actual long-lived client experiences. <code>loadclient.py</code> exists specifically to avoid this trap: it builds exactly one channel and reuses it for all 30 calls, the way Chapter 7's reuse client — and every correctly-written gRPC client — already does.</p></div>

## Fix #1: a headless Service, and client-side `round_robin`

The first fix changes nothing about the client's code path and everything about what DNS tells it. `examples/22-mesh-loadbalancing/k8s/service-headless.yaml` sets `clusterIP: None` — a headless Service has no virtual IP at all, and `kube-proxy` is not involved in routing to it in any way. What it does instead is purely a DNS trick: resolving `quote-headless.mesh-lb-demo.svc.cluster.local` returns one A record **per ready pod**, not one virtual IP standing in for all of them. A client that asks for all of those records, and uses more than the first one, gets real load distribution with no server-side change at all.

grpc-core already knows how to do this. `loadclient.py` builds its channel with a `dns:///` scheme target and an explicit LB policy:

```python
options = [("grpc.lb_policy_name", LB_POLICY)] if LB_POLICY else []
async with grpc.aio.insecure_channel(TARGET, options=options) as channel:
    stub = routing_pb2_grpc.RoutingServiceStub(channel)
```

With `TARGET=dns:///quote-headless.mesh-lb-demo.svc.cluster.local:9000` and `LB_POLICY=round_robin`, the channel's DNS resolver returns three addresses instead of one, and `round_robin` opens a persistent subchannel — its own HTTP/2 connection — to each of them, cycling through all three for successive RPCs. This is still exactly one channel object and still exactly the "build once, reuse for the process lifetime" discipline Chapter 7 teaches; what changed is that the channel now holds three connections instead of one, because there are three addresses behind the name instead of one virtual IP standing in for all of them.

{% include excalidraw.html file="22-lb-fixes-headless-and-mesh" alt="Two side-by-side panels. The left panel, fix one, headless Service plus client round_robin, shows a gRPC client opening three separate subchannels, one each to Pod A, Pod B, and Pod C. The right panel, fix two, Istio sidecar per-request L7 balancing, shows a gRPC client with unchanged code sending one connection to a local client-side Envoy sidecar, which itself opens connections to Pod A, Pod B, and Pod C and picks one per individual request." caption="Figure 22.2 — two different fixes for the same problem: one moves the load-balancing decision onto the client by giving it every address; the other moves it onto a sidecar the client's code never has to know exists." %}

`scripts/run-demo.sh`'s `headless` phase runs the identical 30-call loop against this target, and the real tally is a clean three-way split:

```
=== phase2-headless-round-robin ===
target=dns:///quote-headless.mesh-lb-demo.svc.cluster.local:9000 lb_policy=round_robin calls=30
distinct pods answering: 3
  quote-786c5744c4-5fmhg: 10/30
  quote-786c5744c4-tx68v: 10/30
  quote-786c5744c4-w5f49: 10/30
```

Same three pods that answered Phase 1's pinned calls, same client shape (one channel, 30 calls, read the trailer after each), only the Service type and one channel option changed. This is a real fix, and it is also entirely the client's responsibility: every service this pattern protects needs its callers to know to ask for a headless name and set `round_robin` explicitly, which means every language's client stack, every internal caller, and every future caller all have to get this right independently, forever. That is the opening for the second fix.

## Fix #2: the mesh — Envoy balances at Layer 7, not Layer 4

Istio does not ask the client to do anything differently. `scripts/run-demo.sh`'s `istio` phase flips the Deployment's pods into the mesh — `kubectl patch` sets `sidecar.istio.io/inject: "true"` on the pod template (overriding the `"false"` `k8s/deployment.yaml` ships by default, so the base kustomize manifest stays mesh-agnostic), then `kubectl rollout restart` recreates every pod with an `istio-proxy` sidecar alongside the application container:

```
NAME                     READY   STATUS    RESTARTS   AGE
quote-7f47bcc96-4vt7v    2/2     Running   0          18s
quote-7f47bcc96-b8vqc    2/2     Running   0          23s
quote-7f47bcc96-fgr2l    2/2     Running   0          28s
```

It then applies `examples/22-mesh-loadbalancing/istio/destination-rule.yaml`, which tells every meshed client's sidecar how to spread calls to `quote-plain` across its endpoints:

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

The mechanism behind this fix differs from Fix #1 in kind, not just in degree. Once a pod is meshed, Istio's `iptables` rules redirect its outbound traffic through its own local Envoy sidecar **before** the packet ever reaches `kube-proxy`'s Service-VIP rewrite. The client's gRPC channel still opens exactly one connection — to its own sidecar, over loopback — but the sidecar, which already knows every pod behind `quote-plain` from Istio's control plane (Pilot/istiod), opens its own upstream connections to all three pods and picks one **per individual HTTP/2 stream**, not once for the whole connection. A stream is one RPC. The client's channel is still one TCP connection, end to end, from its point of view; the fan-out happens one layer below that, inside the sidecar, which is exactly why this fix needs no client code change at all.

{% include excalidraw.html file="22-l4-vs-l7-balancing" alt="Two stacked panels. The top panel, L4, one load-balancing decision per connection, shows one HTTP/2 connection carrying three requests all arriving at Pod A, the only pod reached. The bottom panel, L7, one load-balancing decision per request, shows one HTTP/2 connection carrying the same three requests, but each one is routed individually: request one to Pod A, request two to Pod B, request three to Pod C." caption="Figure 22.3 — the granularity difference in one picture: an L4 load balancer commits to a backend when the connection opens; an L7 load balancer re-decides for every request multiplexed over that same connection." %}

Running the identical `loadclient.py` — same 30 calls, same request, `LB_POLICY` unset, same `pick_first` default — against the exact same `quote-plain` Service Phase 1 pinned to one pod now produces this:

```
=== phase3-istio-l7 ===
target=quote-plain.mesh-lb-demo.svc.cluster.local:9000 lb_policy=(default: pick_first) calls=30
distinct pods answering: 3
  quote-7f47bcc96-4vt7v: 10/30
  quote-7f47bcc96-b8vqc: 10/30
  quote-7f47bcc96-fgr2l: 10/30
```

A perfect 10/10/10 split, over the plain `ClusterIP` Service, with no headless Service and no client-side LB policy anywhere in sight. Figure 22.1's Pod B and Pod C, idle for the life of a pinned connection, are now receiving a third of the traffic each — and the client that produced this tally is byte-for-byte the same client that produced Figure 22.1's pinned tally minutes earlier, pointed at the same Service name, with `LB_POLICY` unset both times.

## STRICT mTLS: the other half of putting a service in the mesh

`examples/22-mesh-loadbalancing/istio/peer-authentication.yaml` sets mesh-wide mTLS to `STRICT` for the demo namespace — every meshed pod now refuses a plaintext connection from anything that isn't also meshed, with no change to `RoutingServiceServicer` or `loadclient.py`, because the TLS origination and termination both happen in the sidecars, transparently, around application code that still just calls `grpc.aio.insecure_channel`. This is Chapter 19's mTLS, applied at the infrastructure layer instead of hand-rolled per service: the same mutual-authentication guarantee, without `certgen`, without a Java keystore, without either stack's `application.properties` or `main.py` knowing TLS exists.

The cost of that guarantee is real, and `scripts/run-demo.sh` makes it observable by accident: a load-client Job explicitly annotated `sidecar.istio.io/inject: "false"` — the same annotation that keeps Phases 1 and 2 out of the mesh — now fails every call against the meshed `quote-plain` Service, once STRICT mode is active:

```
grpc.aio._call.AioRpcError: <AioRpcError of RPC that terminated with:
	status = StatusCode.UNAVAILABLE
	details = "failed to connect to all addresses; last error: UNAVAILABLE: ipv4:10.102.229.60:9000: recvmsg:Connection reset by peer (104)"
>
```

A connection reset, not a gRPC status code the application chose — the same transport-versus-application distinction Chapter 19 draws for a plaintext call against a TLS-only server. The rejection happens in the sidecar, before a single byte of a `GetQuoteRequest` is deserialized; `RoutingServiceServicer.GetQuote` never runs, never gets the chance to return `UNAUTHENTICATED`, because the call never reaches gRPC's own status-code machinery at all.

## Retries, timeouts, and why a retry is a new load-balancing decision

`examples/22-mesh-loadbalancing/istio/virtual-service.yaml` layers retry and timeout policy on top of the `DestinationRule`'s load-balancing policy:

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

A retry here is not a replay against the same backend — it is a **new** pick from the same `ROUND_ROBIN` pool the `DestinationRule` configures, made by the same sidecar that made the original pick. If Pod B is answering `GetQuote` correctly but happens to be momentarily overloaded and returns `RESOURCE_EXHAUSTED`, Envoy's retry lands on whichever pod its load-balancing policy selects next — which, under round robin, is very likely a different pod — with zero code in `RoutingServiceServicer` or `loadclient.py` aware that a retry even happened. The `outlierDetection` block on the `DestinationRule` closes the loop: three consecutive 5xx-equivalent failures from one pod get it temporarily ejected from the pool for 30 seconds, so an unhealthy pod stops receiving new picks at all rather than merely getting retried around.

## Native sidecars and why the load-client Job still completes

Older Istio releases had a well-known rough edge with exactly this book's load-client pattern: a sidecar container that runs for the life of the pod, with no concept of "the main work is done," kept a `Job`'s pod alive forever, because the pod could not be considered complete while the sidecar was still running — the Job would sit at `1/2` indefinitely until something killed it by hand. Istio 1.29 and later ship **native sidecars**, built on the Kubernetes "sidecar containers" feature: `istio-proxy` runs as an `initContainer` with `restartPolicy: Always`, a lifecycle Kubernetes itself understands as "stays up alongside the main containers, and shuts down automatically once they're all done." `scripts/run-demo.sh`'s Istio phase meshes the load-client Job too — it needs its own sidecar for the same mTLS reasons the server pods do — and the real run shows exactly this working as designed:

```
NAME                              READY   STATUS      RESTARTS   AGE
loadclient-phase3-istio-l7-k992w  0/2     Completed   0          15s
```

Both of its containers — `istio-init` and `istio-proxy` — report `terminated / exitCode 0 / reason Completed`, confirming the sidecar shut itself down the moment the `loadclient` container finished its 30 calls, rather than hanging.

## Build, run, observe

```bash
cd examples/22-mesh-loadbalancing
./scripts/bootstrap.sh    # minikube start + pinned istioctl install + namespace
./scripts/run-demo.sh     # all three phases: plain, headless, istio
```

`run-demo.sh` builds `ch22-routing-python:dev` from `python/Containerfile`, loads it straight into minikube with `minikube image load` (no registry involved), applies the kustomize base in `k8s/`, and then runs each phase's `loadclient-<phase>` `Job`, deleting and recreating it so the whole script is safe to re-run from the top after a transient failure — `README.md` and `expected-output.md` carry the complete recorded transcript from the run quoted throughout this chapter, including the `kubectl`/`istioctl` version record from `bootstrap.sh`: minikube v1.39.0, Kubernetes v1.34.0, Istio 1.31.1.

## What CI validates, and what it does not

This chapter's example sits outside the Compose-based `examples` CI matrix entirely, because that matrix auto-discovers every `verify.sh` it finds under `examples/*/` and this directory has none — `scripts/validate.py`'s `cluster-dir-no-verify` check fails the build the moment one appears here, which is the mechanism that keeps a future contributor from accidentally wiring this cluster-only example into a CI runner with no cluster. The one piece of this example CI *does* check is purely structural: the `k8s-manifests` job runs `kubectl kustomize examples/22-mesh-loadbalancing/k8s | kubeconform -strict -summary` against the four resources in `k8s/` — the namespace, the Deployment, and both Services — confirming they parse as schema-valid core Kubernetes objects on every push. That check cannot and does not prove the pin happens, that `round_robin` fans out, or that mTLS rejects an unmeshed caller; those are cluster-behavior claims, and this chapter's "Verification status" footer says so directly. The three Istio custom resources live in `istio/`, a separate directory the `k8s-manifests` job never touches, because `kubeconform -strict` has no schema for a `PeerAuthentication` or a `DestinationRule` and would fail outright the moment one showed up in the same pipe.

## Cross-check

`loadclient.py`'s tally comes entirely from the client side — the `x-served-by` trailer each pod sets on its own responses. An independent confirmation that those pods really are the ones doing the work is a plain `kubectl logs` against each one, which shows the exact same identity, logged server-side, for every call:

```bash
kubectl --context grpc-ch22 -n mesh-lb-demo logs deploy/quote --all-containers=false --prefix | grep "GetQuote served-by"
```

```
[pod/quote-7f47bcc96-4vt7v/quote] GetQuote served-by=quote-7f47bcc96-4vt7v: USNYC -> NLRTM, 1 cargo item(s), quote=USD 3001.25
[pod/quote-7f47bcc96-b8vqc/quote] GetQuote served-by=quote-7f47bcc96-b8vqc: USNYC -> NLRTM, 1 cargo item(s), quote=USD 3001.25
[pod/quote-7f47bcc96-fgr2l/quote] GetQuote served-by=quote-7f47bcc96-fgr2l: USNYC -> NLRTM, 1 cargo item(s), quote=USD 3001.25
```

Two completely independent signals — a client-read response trailer and a server-emitted log line, produced by two different code paths in `routing_service.py` that never share state — agree on which pod answered which call. That agreement is what makes the fan-out claim trustworthy rather than an artifact of one observation method.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Reach for the headless Service plus client-side <code>round_robin</code> fix when every caller of a service is code you control and can audit — an internal library, a shared client wrapper — because it costs nothing to run (no sidecar, no extra hop, no mesh to operate) and is easy to reason about from the client alone. Reach for a service mesh when callers are heterogeneous, numerous, or simply not all under one team's control: the fix becomes infrastructure configuration instead of a convention every caller has to independently remember, and it comes bundled with mTLS and retry/timeout policy that would otherwise need reimplementing per language, per client. Turn on STRICT mTLS for any internal namespace where every legitimate caller can reasonably be meshed — it is the same mutual-authentication guarantee Chapter 19 builds by hand, with certificate issuance and rotation handled by the mesh's own identity system instead of a demo <code>certgen</code> script. Keep retry budgets and outlier detection paired, never one without the other: a retry policy with no outlier detection keeps hammering a broken pod with every caller's retries; outlier detection with no retry policy still leaves the first unlucky request on a failing pod to simply fail.</p></div>

## What you learned

- A Kubernetes `ClusterIP` Service makes its backend-pod choice once per TCP connection, not once per request — invisible to a client that opens a connection per call, and a silent trap for a gRPC client correctly following Chapter 7's "build one channel, reuse it" rule.
- A headless Service (`clusterIP: None`) removes `kube-proxy` from the path entirely and exposes every ready pod as its own DNS record; a channel built with a `dns:///` target and `grpc.lb_policy_name=round_robin` opens one subchannel per pod and spreads calls across all of them, with real measured output of exactly 10/10/10 across three pods for 30 calls.
- Istio moves the same load-balancing decision into the client's own sidecar, which balances individual HTTP/2 **streams** — one gRPC call each — across upstream connections it manages itself, so the identical client code, the identical `ClusterIP` Service, and zero application changes produce the identical 10/10/10 fan-out once the Deployment is meshed and a `DestinationRule` is applied.
- STRICT `PeerAuthentication` secures every meshed-to-meshed call automatically and rejects an unmeshed caller with a transport-layer connection reset, never a gRPC status code — confirmed on this chapter's own cluster by running an unmeshed load-client Job against the now-STRICT namespace and watching it fail exactly that way.
- A `grpcurl`-in-a-loop load generator opens a fresh connection per call and would mask the pin this chapter demonstrates; `loadclient.py` builds one channel and reuses it specifically so the demo measures what a real long-lived client experiences.
- Native sidecars (Istio 1.29+, built on Kubernetes' own "sidecar containers" feature) let a meshed `Job` complete normally once its main container exits, instead of hanging at `1/2` the way older Istio releases did.

Chapter 23 moves outside the cluster entirely: it exposes `RoutingService.GetQuote` to a browser that cannot speak native gRPC at all, and compares a grpc-web proxy against a REST transcoding gateway for doing it.

## On the wire

Start the cluster and run all three phases:

```bash
cd examples/22-mesh-loadbalancing
./scripts/bootstrap.sh
./scripts/run-demo.sh
```

Check which Istio actually landed, and confirm the data-plane proxies are on the same pinned version as the control plane:

```bash
istioctl version --context grpc-ch22
# client version: 1.31.1
# control plane version: 1.31.1
# data plane version: 1.31.1 (5 proxies)   # 3 meshed GetQuote pods + ingress + egress gateways
```

Confirm the Istio custom resources are actually applied before trusting a fan-out result:

```bash
kubectl --context grpc-ch22 -n mesh-lb-demo get peerauthentication,destinationrule,virtualservice
```

```
NAME                                           MODE     AGE
peerauthentication.security.istio.io/default   STRICT   20s

NAME                                              HOST                                          AGE
destinationrule.networking.istio.io/quote-plain   quote-plain.mesh-lb-demo.svc.cluster.local    20s

NAME                                             GATEWAYS   HOSTS                                             AGE
virtualservice.networking.istio.io/quote-plain              ["quote-plain.mesh-lb-demo.svc.cluster.local"]   20s
```

Re-run just the load-client tally for one phase, without rebuilding or redeploying anything:

```bash
./scripts/run-demo.sh plain       # expect: 1 pod, 30/30
./scripts/run-demo.sh headless    # expect: 3 pods, 10/10/10
./scripts/run-demo.sh istio       # expect: 3 pods, 10/10/10 — plain Service, zero client changes
```

And the static check CI actually runs on this example, reproducible without a cluster at all:

```bash
kubectl kustomize examples/22-mesh-loadbalancing/k8s | kubeconform -strict -summary
# Summary: 4 resources found parsing stdin - Valid: 4, Invalid: 0, Errors: 0, Skipped: 0
```

---

## For deeper coverage

- Cloud Native Design Patterns — "Appendix I — L7 Routing & Traffic Management" chapter, for the four-layer (edge/gateway/mesh/in-app) view this chapter's L4-versus-L7 split is one slice of.
- Michael T. Nygard, *Release It!, Second Edition*, Pragmatic Bookshelf, 2018 — retries, timeouts, and the failure-isolation thinking behind this chapter's outlier-detection policy.
- [Istio — Traffic Management concepts](https://istio.io/latest/docs/concepts/traffic-management/) and [`PeerAuthentication` reference](https://istio.io/latest/docs/reference/config/security/peer_authentication/).
- [Kubernetes — Headless Services](https://kubernetes.io/docs/concepts/services-networking/service/#headless-services).
