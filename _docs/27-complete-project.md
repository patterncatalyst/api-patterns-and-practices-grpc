---
title: "The final project"
order: 27
part: "Running It & the Final Project"
description: "Routing, tracking and quote services with all four RPC shapes behind mTLS, JWT and OpenTelemetry, buf-gated and load-tested, on Quarkus and Python."
duration: "20 min read"
---

## Learning objectives

By the end of this chapter you can:

- Run all four RPC shapes (unary, bidirectional, server streaming, client streaming) together across `RoutingService`, `QuoteService` and `TrackingService`.
- Layer mTLS, a JWT `AuthzInterceptor` with per-method scopes, and OpenTelemetry tracing onto the same calls, each working on its own layer.
- Follow one `traceparent` across the REST, `RoutingService` and `QuoteService` hops and confirm the trace id in logs.
- Tell a transport rejection, `UNAUTHENTICATED` and `PERMISSION_DENIED` apart as three failure classes, met in that order.
- Run the same frozen contract on Compose, minikube and OpenShift Local.

## Why this matters

Each mechanism so far was added to one RPC with everything else held constant: mTLS on `GetQuote`, then a bearer token, then tracing across a REST-to-gRPC seam. The open question is whether they still work when all are on at once, against a service that implements every RPC shape the contract declares.

One process per stack runs `shipping.routing.v1.RoutingService` (`GetQuote`, unary; `NegotiateRoute`, bidirectional), `shipping.quote.v1.QuoteService` (the downstream hop) and `shipping.tracking.v1.TrackingService` (`WatchShipment`, server streaming; `ReportPositions`, client streaming). All of them sit behind mTLS, a JWT interceptor with per-method scopes and OpenTelemetry tracing, on Quarkus and on Python, with a Grafana LGTM stack and a `ghz` load-test gate. One `verify.sh` runs on every push.

Nothing here is a new RPC. The contracts under `contracts/proto/shipping/` are unchanged, and `buf breaking` in CI keeps them that way. What changes is that `NegotiateRoute`, `WatchShipment` and `ReportPositions` answered `UNIMPLEMENTED` in every single-topic example, and here all three run together.

{% include excalidraw.html file="27-final-project-architecture" alt="A large band labeled final project, Compose, both stacks contains five boxes. A light-blue box at upper left is labeled REST front door, POST slash booking slash quote. An amber-accented box to its right is labeled RoutingService, GetQuote unary, NegotiateRoute bidi. A plain box further right is labeled QuoteService, GetQuote unary. Below RoutingService, a second plain box is labeled TrackingService, WatchShipment stream, ReportPositions stream. A grey sub box at lower left is labeled certgen, mTLS CA plus certs, connected upward to the REST front door and RoutingService boxes. A dark ink box at right is labeled LGTM stack, Tempo plus Grafana, connected by dashed lines labeled OTel spans from the REST front door, RoutingService, and QuoteService boxes. Solid amber arrows labeled mTLS plus JWT connect REST to RoutingService, RoutingService to QuoteService, and REST to TrackingService. Below the main band, a second band labeled CI gates contains two smaller boxes: buf lint slash build slash breaking, contracts frozen, and ghz smoke, GetQuote, loose bounds. A bold note across the top reads all four RPC modes, mTLS plus JWT at every hop, one trace REST arrow Routing arrow Quote." caption="Figure 27.1: The whole system: four RPC shapes behind mTLS and JWT, one OpenTelemetry trace crossing the REST-to-gRPC seam, and buf and ghz gating CI." %}

## Four RPC shapes, one system

| RPC | Shape | Why |
|---|---|---|
| `GetQuote` | Unary | One question (origin, destination, cargo), one answer (`Money` and a `Route`) |
| `NegotiateRoute` | Bidirectional | A negotiation is a back-and-forth: each proposal gets a response with a `counter` route and an `accepted` flag |
| `WatchShipment` | Server streaming | A location feed of unknown length: four deterministic `TrackingEvent`s (`PENDING` and `CONFIRMED` at the origin, `IN_TRANSIT` and `DELIVERED` at the destination) over one HTTP/2 stream |
| `ReportPositions` | Client streaming | Many reports folded into one `ReportPositionsResponse` carrying `accepted_count`, the number seen |

`NegotiateRoute`'s policy is small and deterministic. A proposal at or under $5,000.00 is accepted as sent, and anything over is countered at 90% of the proposed price, using the same decimal round-half-up arithmetic as every quote formula. A $2,500.00 proposal comes back `accepted: true` with the counter equal to the proposal, and a $9,000.00 proposal comes back `accepted: false` with a counter of $8,100.00.

## The REST seam carries a certificate and a token

The REST front door calls `RoutingService.GetQuote` over a loopback channel. That channel presents the mTLS client certificate minted by `certgen` and attaches an internal service token as `authorization: Bearer <jwt>` metadata. The certificates share one CA, and the server identity covers the `quarkus` and `python` container names plus `localhost`. The same `AuthzInterceptor` that rejects an external caller's missing or wrong-scope token rejects an internal one, because no code path treats a loopback hop as trusted. `RoutingService` calling `QuoteService` presents the same certificate and token on its own hop, behind a second independent check.

The internal token carries the scopes this code needs, including `quote:read` for `GetQuote` on both services. Any other token is held to the per-method map:

| Method | Required scope |
|---|---|
| `GetQuote` | `quote:read` |
| `NegotiateRoute` | `routes:negotiate` |
| `ListRoutes` | `routes:admin`, which no demo token carries |

`ListRoutes` is still `UNIMPLEMENTED`, which is why it works as the `PERMISSION_DENIED` case: the interceptor rejects the call before any handler runs, so authorization is shown to be independent of whether a handler exists.

## Tracing through the guards

A W3C `traceparent` is ordinary gRPC metadata. It rides in the same HEADERS frame as the `authorization` entry, and TLS encrypts that frame without inspecting it. The interceptor runs after the handshake and reads one key without touching the other, so tracing, authentication and authorization are three independent checks on one wire format. Zero-code OpenTelemetry instrumentation injects and extracts `traceparent` on both stacks. The REST handler logs the trace id from the current span, `RoutingService` logs the same id a hop later, and `QuoteService` logs it a hop after that.

{% include excalidraw.html file="27-booking-route-track-flow" alt="A band labeled one verify dot sh run, traceparent threaded contains five boxes arranged left to right and one box below. At far left, a light-blue box labeled grpcurl slash curl, the caller. To its right, an amber box labeled REST front door. To its right, a second amber box labeled RoutingService. To its right, a plain box labeled QuoteService. Below RoutingService, a plain box labeled TrackingService. Numbered arrows trace a round trip: arrow 1 POST slash booking slash quote from the caller to the REST front door; arrow 2 GetQuote traceparent, amber, from the REST front door to RoutingService; arrow 3 GetQuote traceparent, amber, from RoutingService to QuoteService; arrow 4 Money, dashed, back from QuoteService to RoutingService; arrow 5 quote plus route, dashed, back from RoutingService to the REST front door; arrow 6 traceId plus quote, dashed, back from the REST front door to the caller. A double-headed amber arrow 7 labeled WatchShipment stream slash ReportPositions stream connects RoutingService down to TrackingService. A second double-headed amber arrow 8 labeled NegotiateRoute bidi, proposals left right arrow counters, connects the caller directly across to RoutingService. A bold note above reads same trace id logged by the REST handler, RoutingService, and QuoteService." caption="Figure 27.2: The unary GetQuote path threads one trace id through three hops. NegotiateRoute, WatchShipment and ReportPositions are called directly over gRPC." %}

`WatchShipment`, `ReportPositions` and `NegotiateRoute` are called directly over gRPC, the way a mesh sidecar or another internal service would, not through the REST front door. They are still authenticated, authorized and mTLS-protected by the same interceptor and server configuration; they are just outside the three-hop trace-id check, which follows the REST path. A production system exposing `WatchShipment` to a browser would put it behind its own instrumented gateway hop, as `GetQuote` sits behind this one.

## Three failure classes, in order

A call to the gRPC port can fail for unrelated reasons, met in a fixed order.

| Order | Failure | What the caller sees |
|---|---|---|
| 1 | No client certificate against a `client-auth: REQUIRED` server, or `-plaintext` against a TLS server | A transport error such as `tls: certificate required`, `EOF` or a dial-level `context deadline exceeded`, never a gRPC status |
| 2 | Valid mTLS, no `authorization` metadata | `UNAUTHENTICATED` |
| 3 | Valid mTLS, a valid, unexpired token without the method's scope | `PERMISSION_DENIED` |

The first class happens below gRPC, so no status exists to carry. The other two come from the interceptor. A caller debugging `PERMISSION_DENIED` needs to know the credentials were accepted and the entitlements weren't, which one merged "auth failed" bucket would hide.

## Load and contract gates

`buf lint`, `buf build` and `buf breaking` run against `contracts/`. Since no proto changed, they only confirm that nothing slipped in. The `ghz` smoke test runs a short burst of `GetQuote` against one stack from a pinned image, with the `.proto` mounted read-only because `ghz` needs the file and doesn't use reflection. Latency and error-rate bounds are loose enough to absorb shared-runner jitter, backed by three retries. The point isn't a performance claim: it shows the mTLS-and-JWT server behaves under concurrent load as it does one request at a time.

## Three tiers, one contract

{% include excalidraw.html file="27-three-tier-deploy" alt="Three side-by-side vertical bands. The left band is labeled CI-gated and contains an amber box labeled Tier 1 Compose, both stacks, mTLS plus JWT, above a dark ink box labeled traced call, REST arrow Routing arrow Quote, Tempo-ingested trace id. The middle band is labeled run by hand and contains a plain box labeled Tier 2 minikube, headless plus round_robin, Istio DestinationRule, above a dark ink box labeled traced call, GetQuote plus NegotiateRoute, trace id in pod logs. The right band is also labeled run by hand and contains a plain box labeled Tier 3 CRC Appendix A, OSSM STRICT mTLS plus canary, above a dark ink box labeled traced call, GetQuote over an HTTP slash 2 Route. Amber arrows connect Tier 1 to Tier 2 labeled same contract, same quote formula, and Tier 2 to Tier 3 labeled same contract, STRICT mTLS. A bold note along the bottom reads one contract, three deployment tiers, a traced call proving each one." caption="Figure 27.3: One contract in three tiers: a CI-gated Compose stack, a minikube load-balancing fix and an OpenShift Local mesh canary, each shown by a traced call." %}

The Compose stack is the CI-gated tier. The `k8s/`, `istio/`, `scripts/` and `loadclient/` directories in `examples/27-complete-project` are a separate run-by-hand tier on minikube, using a plaintext, unauthenticated build of the same service logic. That tier shows the load-balancing fix:

- A plain `ClusterIP` Service pins one gRPC channel to a single pod, so none of the other pods answer.
- A headless Service with client-side `round_robin` fans the same 30 calls out roughly evenly across all three pods.
- Moving the Deployment into an Istio mesh with a `ROUND_ROBIN` `DestinationRule` makes the plain Service fan out evenly too, because the sidecar now owns the upstream connections.

None of its scripts is named `verify.sh`, so CI never discovers them, and results are recorded by hand in `expected-output.md`. The split is deliberate: a fast, deterministic contract gate runs on every push, and the slower, environment-dependent proof (a real cluster, mesh and load balancer) runs by hand without being lost. mTLS and JWT are absent there to keep the load-balancing mechanism visible. The OpenShift Local tier covers STRICT mesh-wide mTLS at the platform layer. A final step fires `GetQuote`, `NegotiateRoute` and `WatchShipment` at the deployed service and greps the trace id out of `kubectl logs` on both the `RoutingService` and `QuoteService` lines. That hop runs in-process on the pod, so it shows application-level continuity, not a trace through the sidecar, and needs no Tempo inside minikube.

## Design decisions

| Axis | Choice here |
|---|---|
| RPC shape | Each method keeps the shape its pattern needs: unary, bidirectional, server streaming, client streaming |
| Sync or stream | The REST front door is one request and response. The tracking RPCs stay streams, because a location history and a batch of reports aren't single messages |
| Deadline and budget | The `GetQuote` to `QuoteService` hop propagates the unary deadline. `NegotiateRoute` needs its own idle-timeout and overall-duration policy, and this build sets none |
| Failure class | Transport, authentication and authorization are asserted as separate outcomes |
| Concurrency | Every handler is non-blocking: Mutiny `Uni` and `Multi` on Quarkus, `grpc.aio` coroutines on Python, including the loopback calls |

For production, replace the long-lived internal service token with a short-lived, rotated, IdP-issued credential, and give `NegotiateRoute` an explicit stream-level deadline before trusting it with real negotiations.

## Build, run, observe

```bash
cd examples/27-complete-project && ./verify.sh
```

`verify.sh` starts both stacks with Compose (gRPC on 9270 and 9271, REST on 8270 and 8271), runs every assertion and prints `PASS`. It also runs `buf` and the `ghz` smoke test. Reflection with the client certificate lists the health, reflection, quote, routing and tracking services:

```bash
grpcurl -cacert .host-out/ca.crt -cert .host-out/client.crt -key .host-out/client.key \
  -servername quarkus localhost:9270 list
```

The REST front door runs the whole flow, with the `traceId` matching the three log lines:

```bash
curl -s -X POST localhost:8270/booking/quote -H 'content-type: application/json' \
  -d '{"origin":"USNYC","destination":"NLRTM","cargoKg":1000}'
```

The Python stack answers identically on 8271 and 9271.

The response carries `"amount": "2500.00"` and route `rte_USNYC-NLRTM`.

Experiments:

- **Drop TLS.** Run `grpcurl -plaintext localhost:9270 list`: it fails with `tls: first record does not look like a TLS handshake` and no status.
- **Drop the token.** Make the mTLS `grpcurl` call to `GetQuote` above without `-H "authorization: Bearer ..."`: it returns `Code: Unauthenticated` with `missing 'authorization: Bearer <jwt>' metadata`, before `RoutingServiceImpl` runs.
- **Seed a wrong expectation.** Change the expected `GetQuote` amount for the 1,000 kg booking in `verify.sh` from `2500.00` to `2500.01`: the run fails at that assertion with an expected-versus-actual mismatch from `assert_eq`. A check never seen to fail proves nothing. Revert it afterward.

---

## For deeper coverage

- Sam Newman, *Building Microservices*, 2nd ed., O'Reilly, 2021: resilient inter-service calls, the pattern behind every hop that carries mTLS and JWT here.
- Clément Jean, *gRPC Go for Professionals*, Packt, 2023: protobuf schema design and evolution behind the frozen contract the `buf breaking` gate protects.
- [Quarkus gRPC guides](https://quarkus.io/guides/grpc) ([reference](https://quarkus.io/guides/grpc-reference)): `quarkus-grpc` specifics for the mTLS, JWT and tracing stack.
- Cloud Native Design Patterns, Appendix I, "L7 Routing & Traffic Management": the `DestinationRule` and `VirtualService` canary pattern the minikube tier reruns.
- Cloud Native Design Patterns, Appendix R, "Running Example 05 on minikube": companion coverage of the same run-by-hand cluster tier.
