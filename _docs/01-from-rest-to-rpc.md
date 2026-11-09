---
title: "From REST to RPC"
order: 1
part: "Why gRPC, and the Decision Lens"
description: "The three paradigms behind a single call (REST, gRPC and GraphQL), and how a typed method travels from client stub to server skeleton."
duration: "16 min read"
---

## Learning objectives

By the end of this chapter you can:

- Contrast the resource, procedure and graph mental models of REST, gRPC and GraphQL for the same client intent.
- Compare the three on round trips and on what travels on the wire (JSON text or binary Protobuf).
- Trace how a `.proto` file compiles into a client stub and a server skeleton, and say why `curl` can't call a gRPC method.
- Identify the REST to gRPC seam in the shipping domain: `booking` calls `RoutingService` over gRPC internally while staying REST at the edge.
- List at least two places gRPC loses to REST (browser access, HTTP caching, huge payloads, ad hoc debugging).

## Why this matters

A booking service needs a price and a route before it can confirm a shipment of cargo from USNYC to NLRTM. Three API paradigms can answer that, and each imposes a different mental model on the caller before a byte crosses the wire. REST thinks in resources, gRPC in typed method calls, GraphQL in a graph the caller traverses. Most real systems run all three side by side, so the choice should come from the interaction, not from habit.

## One intent, three paradigms

The intent is the same in each: get a quote to ship cargo from USNYC to NLRTM.

A **REST** API treats it as a question about a resource. A `routes` collection takes `origin` and `destination` filters, or a `quote-request` sub-resource is created under a booking and read back once priced. The contract is nouns and a small fixed set of HTTP verbs. The client exchanges JSON representations of state, and nothing in the call's shape names the algorithm to run.

A **gRPC** API treats it as a procedure. The contract names the operation, `GetQuote`, with typed arguments and a typed result. The method lives on `shipping.routing.v1.RoutingService`, declared once in a `.proto` file. The client invokes behavior; no durable "quote" exists at a URI waiting to be read.

A **GraphQL** API treats it as a traversal. One schema describes every type (`Booking`, `Cargo`, `Route`, `Money`), and one query names the exact fields wanted, nested as deep as the schema allows: a booking's route, its legs, each leg's carrier and arrival time. The server resolves the graph however many internal calls that takes and returns the shape asked for.

## Three axes of comparison

| Axis | REST | gRPC | GraphQL |
|---|---|---|---|
| Mental model | Resources and a uniform verb set | Typed methods | A schema to traverse |
| Round trips | One representation per resource; legs and carriers need more requests unless embedded | One response message defined by the contract; streaming methods when request-response is the wrong shape | One query, resolved server-side across any number of lookups |
| Wire | JSON text, readable in a network tab or `curl` | Binary Protobuf: numbered tags and typed values, no field names, framed by HTTP/2 | JSON text, an HTTP `POST` to a single `/graphql` endpoint |
| Strains when | The interaction is a calculation or workflow trigger with no durable state | The thing modeled is a long-lived resource with a lifecycle | A fixed contract between two services is what's wanted |

Chattiness is REST's classic cost and worsens with object-graph depth. In gRPC, `GetQuoteResponse` carries both the `Money` and the `Route` because the contract's author decided a quote without its route isn't useful. GraphQL removes overfetching and underfetching from the client's view and moves the complexity into the server's resolvers. Protobuf's binary encoding is smaller and faster to parse than JSON, which is part of why gRPC wins on latency and throughput, and why a raw gRPC message is opaque to a human.

{% include excalidraw.html file="01-three-paradigms" alt="Three-column comparison diagram showing REST, gRPC, and GraphQL answering the same client intent (get a quote to ship cargo from USNYC to NLRTM). Each column stacks three boxes: the mental model (nouns and verbs for REST, a typed method call for gRPC, one graph to traverse for GraphQL), the concrete call shape (an HTTP request or RPC signature), and the fetching and round-trip behavior. The gRPC column highlights two boxes in a light amber wash: the typed GetQuote method call, and a box reading the .proto is the contract, compiles to client and server code, emphasizing that the contract generates both sides instead of being hand-described documentation." caption="Figure 1.1: Three paradigms, one intent: REST, gRPC, and GraphQL answering the same quote request." %}

## How an RPC travels, stub to stub

{% include excalidraw.html file="01-stub-to-stub-path" alt="A single .proto contract for RoutingService.GetQuote feeds one compile step, protoc or buf generate, which produces two outputs from the same source: a client stub and a server skeleton, neither hand-written. On every call, the client stub sends a typed call in, which becomes protobuf on the wire (a binary encoding using numbered tags only, framed by HTTP/2, with no field names on the wire), which arrives at the server skeleton as a typed call out. A dashed line leads from the wire encoding down to a callout stating that no textual form of this request exists, and that curl -X POST routing:9000/GetQuote never works, because there is no request line to type." caption="Figure 1.2: One .proto compiles into a client stub and a server skeleton; every call travels typed call in, protobuf on the wire, typed call out, with no textual form to hand-write or curl." %}

Everything starts with the `.proto` file. `shipping/routing/v1/routing.proto` declares `RoutingService` and its messages:

```proto
service RoutingService {
  rpc GetQuote(GetQuoteRequest) returns (GetQuoteResponse);
  // FindOptimalRoute, ListRoutes, NegotiateRoute, RecomputeRoutes elided here
}

message GetQuoteRequest {
  shipping.type.v1.Location origin = 1;
  shipping.type.v1.Location destination = 2;
  repeated shipping.type.v1.Cargo cargo = 3;
}

message GetQuoteResponse {
  shipping.type.v1.Money quote = 1;
  shipping.type.v1.Route route = 2;
}
```

A Protobuf compiler generates one artifact per side. The client gets a **stub**: a class whose `GetQuote` method takes a `GetQuoteRequest` and eventually returns a `GetQuoteResponse`, like any other method in that language. The server gets a **skeleton**: a base class with an abstract `GetQuote` the service implementation overrides. Serializing to the binary wire format, opening an HTTP/2 stream, framing the request and deserializing the response are all generated from the one `.proto` both sides compiled against. Calling the service from Quarkus or Python looks like calling any typed method:

{% include codetabs.html langs="Quarkus|Python" %}
```java
@GrpcClient("routing")
RoutingService routing;

Uni<GetQuoteResponse> quote = routing.getQuote(
        GetQuoteRequest.newBuilder()
                .setOrigin(usnyc)
                .setDestination(nlrtm)
                .addAllCargo(cargoItems)
                .build());
```
```python
async with grpc.aio.insecure_channel("routing:9000") as channel:
    stub = RoutingServiceStub(channel)
    response = await stub.GetQuote(
        GetQuoteRequest(origin=usnyc, destination=nlrtm, cargo=cargo_items)
    )
```

No URL path, HTTP method, JSON encoding or status branching appears. The stub hides them behind a signature that matches the `.proto`.

That is also why a gRPC call can't be typed by hand. A REST request is a line of text. A gRPC request is Protobuf bytes inside HTTP/2 frames with no textual form, so `curl -X POST routing:9000/GetQuote` never works. `grpcurl` (from the `.proto` or a reflection endpoint), `grpcui` and per-stack test harnesses fill the gap by running the same stub-generation step a client would. The payoff is a contract that compiles into both sides of the call and can't drift the way a hand-maintained REST client library can. A mismatched argument is a compile error, not a runtime 400.

## The REST to gRPC seam

The booking service is a REST API. A client creates a `Booking`, and the server tracks it through `PENDING`, `CONFIRMED`, `IN_TRANSIT` and `DELIVERED`. Before it can confirm anything it needs a price, so it calls `shipping.routing.v1.RoutingService.GetQuote` service to service, away from any browser or external caller.

That internal call is the **REST to gRPC seam**. The outer boundary, where browsers and partner integrations connect, needs to be cacheable, human-debuggable and stable across slow-moving clients, so it's REST. Inside, `booking` talks gRPC to `RoutingService`, `TrackingService` and `QuoteService`, a boundary that is high-volume, latency-sensitive and under one team's control. The same `Location`, `Cargo` and `Money` nouns sit on both sides (the same UN/LOCODEs appear in a REST JSON body and a Protobuf `GetQuoteRequest`), but a different paradigm governs each hop: one domain, two contracts.

## Where gRPC wins and loses

**Wins, internally.** Binary encoding and HTTP/2 multiplexing save latency and CPU on a path that might run thousands of times a second between `booking` and `routing`. A `.proto` shared across Quarkus and Python means a field added to `GetQuoteRequest` becomes a compile error in a client that ignores it, not a silent `null` in production. Streaming is native: `TrackingService.WatchShipment` pushes events as they happen and `RoutingService.NegotiateRoute` carries an exchange of proposals over one long-lived connection, where REST needs polling or a second protocol.

**Losses.** All trace to one cause: gRPC needs HTTP/2 and a generated stub, and plenty of clients have neither.

| Loss | Why |
|---|---|
| Browsers | `fetch` and XHR don't expose the HTTP/2 framing gRPC needs, so a browser needs gRPC-Web and a translating proxy |
| HTTP caching | No URI identifies a resource, no `GET` marks it safe, no `ETag` gives a shared cache a key |
| Very large payloads | A multi-megabyte manifest fares better as a file transfer than as one gRPC message; streaming helps but doesn't remove the mismatch |
| Debugging | A failing REST request reads off a terminal with `curl -v`; a failing gRPC request needs `grpcurl`, reflection or a packet-capture decoder |

## When to reach for gRPC

gRPC fits calls that are internal, frequent, latency-sensitive, naturally streaming, or need a strongly typed contract across languages, which is the profile of `booking` calling `RoutingService.GetQuote` thousands of times a day. It fits poorly at edges that need direct browser access, HTTP caching, occasional very large payloads or debugging without extra tooling. That is a starting instinct. A five-axis framework (direction and cardinality, performance and volume, client reach, contract strength, operational tooling) turns it into a repeatable choice.

> **🤖 Explore with your agent**
>
> "In contracts/proto/shipping/routing/v1/routing.proto, list each RoutingService RPC (GetQuote, FindOptimalRoute, ListRoutes, NegotiateRoute, RecomputeRoutes) and classify it as REST-shaped (a resource read or write), a procedure, or a stream. Apply this rule: gRPC fits internal, latency-sensitive, streaming or strongly typed calls, and REST fits browser, cacheable or ad hoc-debuggable edges. Then name which calls the REST booking service should make over gRPC and which of those a browser could never call directly."
>
> Check: the reply keeps GetQuote unary and flags NegotiateRoute as bidirectional streaming, which a browser can't call without gRPC-Web.

## For deeper coverage

- Sam Newman, *Building Microservices*, 2nd ed. (O'Reilly): the service-boundary reasoning behind choosing an internal RPC protocol over a public-facing one.
- Clément Jean, *gRPC Go for Professionals* (Packt): the `.proto`-to-stub compilation step in detail.
- [grpc.io: Core concepts, what is gRPC](https://grpc.io/docs/what-is-grpc/core-concepts/): the canonical stub, skeleton and HTTP/2-framing reference.
- Cloud Native Design Patterns: the *Communications* chapter, for the same REST-at-the-edge, gRPC-internally, GraphQL-for-composed-reads defaults applied across a whole system.
