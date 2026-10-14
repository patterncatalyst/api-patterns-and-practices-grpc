# Final Project — minikube subtree: recorded output

Run by hand, NOT CI-gated (there is no `verify.sh` anywhere in this subtree —
see `scripts/bootstrap.sh`, `scripts/run-demo.sh`, `scripts/teardown.sh`). The
output below is a real run captured on 2026-10-14 against a fresh minikube
profile `grpc-ch27` (Kubernetes v1.34.0) with Istio (pinned istioctl 1.31.1),
reusing the unchanged `contracts/proto/` and the one `ch27-final-project-mesh`
image built from the repo root and loaded into minikube (no registry).

It shows the Chapter 22 load-balancing lesson re-proven on the full system: a
plain Service pins one long-lived gRPC connection to a single pod; a headless
Service with client `round_robin` and an Istio L7 DestinationRule each fan the
same calls across all three replicas — and a traced GetQuote whose trace id is
logged by both the RoutingService and the QuoteService handler on a deployed
cluster pod (the in-process RoutingService->QuoteService hop).

## `./scripts/bootstrap.sh` (installed versions)

```
==> [4/4] recording installed versions (copy these into expected-output.md)
# Final Project minikube subtree — bootstrap record, 2026-10-14T15:27:28Z
minikube profile: grpc-ch27
minikube version: v1.39.0
commit: 7a9f6a841470a207de8cf4bafcccee0969d8ba10

kubectl client/server:
Client Version: v1.37.1
Kustomize Version: v5.8.1
Server Version: v1.34.0
Warning: version difference between client (1.37) and server (1.34) exceeds the supported minor version skew of +/-1

istioctl:
client version: 1.31.1
control plane version: 1.31.1
data plane version: 1.31.1 (2 proxies)

bootstrap complete. Next: ./scripts/run-demo.sh
```

## `./scripts/run-demo.sh` — phase 1: plain Service pins to one pod

```
  call  23/30: served-by=finalproject-54bb87b7f8-7jj52
  call  24/30: served-by=finalproject-54bb87b7f8-7jj52
  call  25/30: served-by=finalproject-54bb87b7f8-7jj52
  call  26/30: served-by=finalproject-54bb87b7f8-7jj52
  call  27/30: served-by=finalproject-54bb87b7f8-7jj52
  call  28/30: served-by=finalproject-54bb87b7f8-7jj52
  call  29/30: served-by=finalproject-54bb87b7f8-7jj52
  call  30/30: served-by=finalproject-54bb87b7f8-7jj52

=== phase1-plain-pin ===
target=finalproject-plain.final-project-demo.svc.cluster.local:9000 lb_policy=(default: pick_first) calls=30
distinct pods answering: 1
```

## phase 2: headless Service + client round_robin fans out across 3 pods

```
  call  23/30: served-by=finalproject-54bb87b7f8-svl7j
  call  24/30: served-by=finalproject-54bb87b7f8-ql6x5
  call  25/30: served-by=finalproject-54bb87b7f8-7jj52
  call  26/30: served-by=finalproject-54bb87b7f8-svl7j
  call  27/30: served-by=finalproject-54bb87b7f8-ql6x5
  call  28/30: served-by=finalproject-54bb87b7f8-7jj52
  call  29/30: served-by=finalproject-54bb87b7f8-svl7j
  call  30/30: served-by=finalproject-54bb87b7f8-ql6x5

=== phase2-headless-round-robin ===
target=dns:///finalproject-headless.final-project-demo.svc.cluster.local:9000 lb_policy=round_robin calls=30
distinct pods answering: 3
```

## phase 3: Istio L7 DestinationRule fans out across 3 pods

```
  call  23/30: served-by=finalproject-cc47b5875-hj5n9
  call  24/30: served-by=finalproject-cc47b5875-4thrm
  call  25/30: served-by=finalproject-cc47b5875-c224t
  call  26/30: served-by=finalproject-cc47b5875-hj5n9
  call  27/30: served-by=finalproject-cc47b5875-4thrm
  call  28/30: served-by=finalproject-cc47b5875-c224t
  call  29/30: served-by=finalproject-cc47b5875-hj5n9
  call  30/30: served-by=finalproject-cc47b5875-4thrm

=== phase3-istio-l7 ===
target=finalproject-plain.final-project-demo.svc.cluster.local:9000 lb_policy=(default: pick_first) calls=30
distinct pods answering: 3
```

## traced call: one trace id logged by BOTH RoutingService and QuoteService (on a deployed cluster pod)

<!-- The RoutingService->QuoteService hop runs in-process on the pod, so both handlers
     log the same trace id. This is the Ch21 propagate-and-log pattern surviving a real
     cluster deployment; it is NOT a cross-pod/through-the-sidecar trace. -->


```
--- propagated trace id, logged by BOTH RoutingService and QuoteService (grep across all 3 pods) ---
2026-10-14 15:27:59,377 INFO ch27-finalproject-mesh: RoutingService.GetQuote trace_id=4ee9e01cec8041219fc58e83e78be4c2 served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM, calling QuoteService
2026-10-14 15:27:59,377 INFO ch27-finalproject-mesh: QuoteService.GetQuote trace_id=4ee9e01cec8041219fc58e83e78be4c2 served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM quote=USD 3001.25
2026-10-14 15:27:59,382 INFO ch27-finalproject-mesh: RoutingService.GetQuote trace_id=f2e453fc468044a583be7025477bf073 served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM, calling QuoteService
2026-10-14 15:27:59,383 INFO ch27-finalproject-mesh: QuoteService.GetQuote trace_id=f2e453fc468044a583be7025477bf073 served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM quote=USD 3001.25
2026-10-14 15:27:59,387 INFO ch27-finalproject-mesh: RoutingService.GetQuote trace_id=4201d41b874f43e196d63e79c5c5a262 served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM, calling QuoteService
2026-10-14 15:27:59,388 INFO ch27-finalproject-mesh: QuoteService.GetQuote trace_id=4201d41b874f43e196d63e79c5c5a262 served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM quote=USD 3001.25
2026-10-14 15:27:59,392 INFO ch27-finalproject-mesh: RoutingService.GetQuote trace_id=40cd34581f4943628706ff9cf937b58e served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM, calling QuoteService
2026-10-14 15:27:59,393 INFO ch27-finalproject-mesh: QuoteService.GetQuote trace_id=40cd34581f4943628706ff9cf937b58e served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM quote=USD 3001.25
2026-10-14 15:27:59,396 INFO ch27-finalproject-mesh: RoutingService.GetQuote trace_id=436f8cb4ac3e4102ad7a85b95b623b19 served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM, calling QuoteService
2026-10-14 15:27:59,397 INFO ch27-finalproject-mesh: QuoteService.GetQuote trace_id=436f8cb4ac3e4102ad7a85b95b623b19 served_by=finalproject-54bb87b7f8-svl7j USNYC -> NLRTM quote=USD 3001.25

done. finalproject pods for this run:
NAME                            READY   STATUS        RESTARTS   AGE   IP            NODE        NOMINATED NODE   READINESS GATES
finalproject-54bb87b7f8-7jj52   1/1     Terminating   0          43s   10.244.0.6    grpc-ch27   <none>           <none>
```
