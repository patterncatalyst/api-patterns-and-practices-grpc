---
title: "From REST to RPC"
order: 1
part: "Why gRPC, and the Decision Lens"
description: "The three paradigms behind a single call — REST, gRPC, GraphQL — and how a typed method travels from client stub to server skeleton."
duration: "16 min read"
---

## Learning objectives

By the end of this chapter you can:

- Contrast REST, gRPC, and GraphQL's mental models — resource, procedure, and graph — for the same client intent.
- Compare the three paradigms on fetching/round-trips and on what actually travels on the wire (JSON text vs. binary protobuf).
- Trace how a `.proto` file compiles into a client stub and a server skeleton, and explain why `curl` can't call a gRPC method directly.
- Identify the REST→gRPC seam in the shipping domain and state why `booking` calls `RoutingService` over gRPC internally while staying REST at the edge.
- List at least two places gRPC loses to REST (browser access, HTTP caching, huge payloads, ad hoc debugging).

## Why this matters

A booking service needs one thing before it can confirm a shipment: a price and a route for a load of cargo moving from USNYC to NLRTM. Three different API paradigms can answer that question, and each one imposes a different mental model on the caller before a single byte crosses the wire. REST asks the caller to think in resources. gRPC asks it to think in typed method calls. GraphQL asks it to think in a graph the caller traverses. The three live side by side in most real systems, including the one this site shares with its sibling REST tutorial, and picking among them by design rather than by habit is the subject of this chapter and the next.

This chapter builds the vocabulary; Chapter 2 turns it into a decision framework with explicit axes. For now, the goal is to see the three mental models clearly enough to recognize which one a given interaction already fits, and to understand what happens between a client calling a method and a server receiving a request — the mechanism that makes gRPC behave so differently from the other two once code is running.

## One intent, three paradigms

Picture the same intent expressed three ways: get a quote to ship cargo from USNYC to NLRTM.

A **REST** API treats this as a question about a resource. There might be a `routes` collection the client queries with `origin` and `destination` as filters, or a `quote-request` sub-resource it creates under a booking and reads back once priced. Either way the contract is nouns — bookings, routes, quotes — and a small fixed set of HTTP verbs acting on them uniformly. The client sends and receives representations of state: JSON documents describing what a route or a quote currently looks like. Nothing in the call's shape tells the server what algorithm to run; it infers that from the resource and the method.

A **gRPC** API treats the same intent as a procedure. The contract names an operation directly — `GetQuote` — taking typed arguments and returning a typed result. No resource stands between the call and the answer; the client isn't fetching or replacing state, it's invoking behavior and getting a result back. The method lives on `shipping.routing.v1.RoutingService`, declared once in a `.proto` file, and `GetQuote` is its name because quoting a route is what it does, not because a durable "quote" thing exists at a URI waiting to be read.

A **GraphQL** API treats it as a traversal. One schema describes every type the system exposes — `Booking`, `Cargo`, `Route`, `Money` — and the client sends a single query naming the exact fields it wants, nested however deep the schema allows: a booking's route, that route's legs, each leg's carrier and arrival time, all in one request shaped by the caller rather than fixed by the server. The server resolves the graph behind the scenes, however many internal calls that takes, and hands back exactly the shape asked for, no more and no less.

Three paradigms, three contracts, one underlying question. None is a universal answer — each trades different things for different guarantees — which is why picking one is a design decision, not a default.

## Three axes of comparison

The differences sharpen along three axes: mental model, fetching and round trips, and what travels on the wire.

**Mental model.** REST is resource-oriented: think in nouns, act on them with a small uniform verb set. gRPC is procedure-oriented: think in typed methods, call the one that does what's needed. GraphQL is graph-oriented: think in a schema, traverse it to shape exactly the response wanted. A team fluent in REST reaches instinctively for "what resource is this," which strains once the interaction is a calculation or workflow trigger with no durable state of its own — the same seam the sibling REST site's Chapter 1 flags for an operation that reads as a verb rather than a noun. gRPC callers reach instead for "what method does this," which fits a procedure but strains when the thing being modeled is really a long-lived resource with a lifecycle. GraphQL callers reach for "what shape do I need," right when a client's view varies a lot caller to caller, wrong when a fixed contract between two services is what's actually wanted.

**Fetching and round trips.** A REST client gets exactly what one resource's representation contains; if it also needs a route's legs and each leg's carrier, and the API doesn't embed those, that's a second or third request — the classic chatty-API problem, worse the deeper the object graph goes. A gRPC client gets exactly what the method's response message defines; `GetQuoteResponse` carries both the `Money` and the `Route` in one call because the contract's author decided a quote without its route isn't useful, and `RoutingService` can add server-streaming or bidirectional methods when one request-response round trip isn't the right shape at all — later chapters build both for shipment tracking and route negotiation. A GraphQL client gets exactly the fields it asked for, resolved server-side across however many internal lookups that takes, in one round trip from the client's perspective — overfetching and underfetching both disappear from the client's view, at the cost of moving that complexity into the server's resolvers.

**What travels on the wire.** A REST call over HTTP/1.1 or HTTP/2 carries a JSON document: human-readable text, self-describing field names, inspectable with a browser's network tab or `curl`. A GraphQL call is also JSON text, carried as the body of an HTTP `POST` to a single `/graphql` endpoint regardless of what the query asks for — one endpoint, one verb, a query string doing the routing that REST does with URIs. A gRPC call carries protobuf: a binary encoding where field names never appear on the wire, only numbered tags and typed values, framed by HTTP/2's binary layer rather than HTTP/1.1's text request line and headers. That binary encoding is smaller and faster to parse than JSON text, a real part of why gRPC wins on latency and throughput — and the same reason a gRPC call is opaque to a human reading raw bytes in a way a REST or GraphQL call never is.

{% include excalidraw.html file="01-three-paradigms" alt="Three-column comparison diagram showing REST, gRPC, and GraphQL answering the same client intent (get a quote to ship cargo from USNYC to NLRTM). Each column stacks three boxes: the mental model (nouns and verbs for REST, a typed method call for gRPC, one graph to traverse for GraphQL), the concrete call shape (an HTTP request or RPC signature), and the fetching and round-trip behavior. The gRPC column highlights two boxes in a light amber wash: the typed GetQuote method call, and a box reading the .proto is the contract, compiles to client and server code — emphasizing that the contract generates both sides instead of being hand-described documentation." caption="Figure 1.1 — Three paradigms, one intent: REST, gRPC, and GraphQL answering the same quote request." %}

Each axis explains part of why a team reaches for one paradigm over another, and none alone makes the call. Chapter 2 formalizes that into five explicit criteria; this chapter just needs the distinctions on the table.

## How an RPC travels, stub to stub

The mechanism behind a gRPC call is worth tracing once, because it differs most sharply from how a REST or GraphQL call gets made, and it explains both gRPC's biggest strengths and its sharpest limitation.

{% include excalidraw.html file="01-stub-to-stub-path" alt="A single .proto contract for RoutingService.GetQuote feeds one compile step, protoc or buf generate, which produces two outputs from the same source: a client stub and a server skeleton, neither hand-written. On every call, the client stub sends a typed call in, which becomes protobuf on the wire — a binary encoding using numbered tags only, framed by HTTP/2, with no field names on the wire — which arrives at the server skeleton as a typed call out. A dashed line leads from the wire encoding down to a callout stating that no textual form of this request exists, and that curl -X POST routing:9000/GetQuote never works, because there is no request line to type." caption="Figure 1.2 — One .proto compiles into a client stub and a server skeleton; every call travels typed call in, protobuf on the wire, typed call out — with no textual form to hand-write or curl." %}

Everything starts with the `.proto` file. `shipping/routing/v1/routing.proto` declares `RoutingService` and its methods, `GetQuoteRequest` and `GetQuoteResponse` among them:

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

A protobuf compiler reads that file and generates two things, one per side of the call. On the client side, it generates a **stub**: a class whose `GetQuote` method looks and behaves like any other method call in that language, taking a `GetQuoteRequest` object and returning (eventually) a `GetQuoteResponse`. On the server side, it generates a **skeleton**: a base class with an abstract `GetQuote` method the actual service implementation overrides. Neither side is hand-written. Serializing a `GetQuoteRequest` into protobuf's binary wire format, opening an HTTP/2 stream, framing the request, and deserializing the response frames back into a `GetQuoteResponse` — all of that is generated, once, from the same `.proto` file both sides compiled against.

What that buys the people writing the service is that neither side ever touches a wire format or a content-type header directly. Calling `RoutingService.GetQuote` from Quarkus or Python looks like calling any other typed method, because as far as the calling code is concerned, it is one:

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

Notice what's missing: no URL path, no HTTP method, no manual JSON encoding, no response-status branching. The generated stub hides all of it behind a method signature matching the `.proto` exactly.

That generation step is also why a gRPC call can't be hand-written the way a REST call can. A REST request is a line of text any human can type: a method, a path, maybe a JSON body, and `curl` sends it exactly as written. A gRPC request is protobuf bytes inside HTTP/2 frames, and there's no textual form of a `GetQuoteRequest` to type in the first place, only the generated builder API that constructs one in memory. `curl -X POST routing:9000/GetQuote` doesn't work and was never going to; the protocol has no text-request mode to fall back to. Purpose-built tools exist for this gap — `grpcurl` reads the `.proto` (or a reflection endpoint) and lets a human construct a call from the command line, and Chapter 25 covers it alongside `grpcui` and the per-stack test harnesses — but those tools work by doing the same stub-generation step a client would, not by skipping it. The contract-first discipline is the only way a gRPC call gets made at all, and that's the point: a contract that compiles into both sides of the call can't drift out of sync the way a hand-maintained REST client library can, and a typed signature catches a mismatched argument at compile time instead of a runtime 400.

## The REST→gRPC seam

None of this happens in isolation from the REST site this book sits alongside. The shipping domain's booking service is a REST API: a client creates a `Booking`, the server tracks its lifecycle through `PENDING`, `CONFIRMED`, `IN_TRANSIT`, and `DELIVERED`, resource-shaped exactly the way the sibling site describes. But before that booking service can confirm anything, it needs a price — which means calling `shipping.routing.v1.RoutingService.GetQuote` internally, service to service, nowhere near a browser or an external caller.

That internal call is this book's recurring motif: the REST→gRPC seam. A browser or a partner integration talks REST to the booking service, because that boundary needs to be cacheable, human-debuggable, and stable across slow-moving external clients. Inside the system, the booking service talks gRPC to `RoutingService`, `TrackingService`, and `QuoteService`, because that boundary is internal, high-volume, latency-sensitive, and entirely under one team's control. The same `Location`, `Cargo`, and `Money` nouns sit on both sides of the seam — a `Booking`'s origin and destination are the same UN/LOCODEs whether in a REST JSON body or a protobuf `GetQuoteRequest` — but a different paradigm governs each hop, chosen for what that hop needs: one domain, two contracts.

## Where gRPC wins

The seam exists because gRPC is the better choice for what crosses it. Internal, service-to-service traffic is where its design pays off most directly: binary protobuf encoding and HTTP/2 multiplexing shave real latency and CPU off a call path that might run thousands of times a second between `booking` and `routing`, compounding at volume even when the saving on any single call looks small. A typed `.proto` contract shared across Quarkus and Python means both stacks generate code from the same source of truth, so a field added to `GetQuoteRequest` shows up as a compile error in a client that doesn't handle it, not a silent `null` found in production. Streaming is native to the protocol rather than bolted on: `TrackingService.WatchShipment` can push tracking events as they happen, and `RoutingService.NegotiateRoute` can carry a back-and-forth exchange of proposals over one long-lived connection — shapes gRPC supports directly and REST has to simulate with polling or a separate protocol.

## Where gRPC loses

The same design that wins internally loses in a few specific places, and all trace back to one cause: gRPC needs HTTP/2 and a generated stub, and plenty of important clients have neither. A browser can't open a raw HTTP/2 gRPC connection from JavaScript — fetch and XHR don't expose the framing control gRPC needs — so a browser client needs gRPC-Web and a translating proxy, infrastructure Chapter 23 covers in full. Plain HTTP caching doesn't apply: no URI identifies a resource, no `GET` marks it safe and cacheable, no `ETag` gives a shared cache something to key on. Binary framing that makes a small quote response cheap to send becomes a liability for the rare very-large payload — a multi-megabyte manifest fares better as a plain file transfer than as one gRPC message, and streaming helps but doesn't eliminate the mismatch. And the opacity that keeps a gRPC call off a human's radar when things work makes it worse when they don't: a failing REST request reads off a terminal with `curl -v`, while a failing gRPC request needs `grpcurl`, reflection turned on, or a packet-capture decoder. None of this is a reason to avoid gRPC generally — it's a reason to keep it off edges where a browser, a cache, a huge payload, or minimal-tooling debugging is the actual situation.

## When to reach for gRPC

Put the wins and losses together and a rough shape emerges: gRPC fits calls that are internal, frequent, latency-sensitive, naturally streaming, or in need of a strongly typed contract shared across languages — the profile of `booking` calling `RoutingService.GetQuote` thousands of times a day. It fits poorly at edges that need direct browser access, HTTP caching, occasional very large payloads, or ad hoc human debugging without extra tooling. That's a starting instinct, not a checklist — Chapter 2 turns it into five explicit axes (direction and cardinality of the call, performance and volume, client reach, contract strength, and operational tooling) that answer "REST, gRPC, or GraphQL" for any interaction, rather than relying on which paradigm a team already knows.

## Where this goes next

This chapter built the vocabulary: three paradigms, three axes that separate them, and the stub-to-stub mechanism that makes a gRPC call behave so differently from a REST or GraphQL one once it's running. Chapter 2 turns that vocabulary into a decision: a five-axis framework applied directly to the shipping domain's actual services, closing with the explicit Decision callout this book uses from there forward. Chapter 3 goes deeper into the `.proto` contract — the full protobuf type system and the wire encoding behind the binary format discussed here — and Chapter 5 puts a running contract-first service behind `RoutingService.GetQuote` using Buf, the anchor the hands-on chapters build from.

## For deeper coverage

- Sam Newman, *Building Microservices*, 2nd ed. (O'Reilly) — the service-boundary reasoning behind choosing an internal RPC protocol over a public-facing one.
- Clément Jean, *gRPC Go for Professionals* (Packt) — the `.proto`-to-stub compilation step this chapter traces by hand.
- [grpc.io — Core concepts: what is gRPC](https://grpc.io/docs/what-is-grpc/core-concepts/) — the canonical stub/skeleton and HTTP/2-framing reference.
- Cloud Native Design Patterns — the *Communications* chapter, for the same REST-at-the-edge/gRPC-internally/GraphQL-for-composed-reads defaults applied across a whole system.
