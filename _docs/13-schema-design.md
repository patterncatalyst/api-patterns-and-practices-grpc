---
title: "Schema design over gRPC"
order: 13
part: "Schema Evolution & the Living Contract"
description: "Message granularity, request and response envelopes, pagination with page tokens, and FieldMask projection."
duration: "22 min read"
---

`RoutingService.ListRoutes` has sat in `routing.proto` since Chapter 5, returning `UNIMPLEMENTED` through every chapter that followed — the one RPC in the service whose job was never about a single call's correctness but about a whole catalog's shape. This chapter is where it finally gets a body. Pagination and field-mask projection aren't RPC-shape questions the way a deadline or a status code is; they're schema-design questions, about how a message is built before the first line of handler code runs. Part 5 opens here: after four chapters on keeping a single call reliable, this one steps back to the messages themselves — how big to make one, how to wrap a response so it can grow, and how a client gets exactly the fields it asked for out of a catalog neither side wants to ship in full on every call.

The code is in `examples/13-schema-design/`. The run script there (`verify.sh`) builds and starts both stacks and asserts the pagination and field-mask claims this chapter makes; its `README.md` covers what it does and how to drive it by hand.

## Message granularity: how big should one message be?

`shipping.type.v1.types.proto` already answers this question by example, and it's worth naming the rule it follows: a message should be exactly as big as one reusable concept, no bigger. `Money`, `Location`, `Leg`, and `Route` are each small enough to mean one thing — a currency amount, a port, one hop, a planned path — and that smallness is what let Chapter 2 share all four across `RoutingService`, and later `BookingService` and `TrackingService`, without any of them importing a type built for a different service's convenience. The opposite failure is a message sized around one call site instead of one concept: a hypothetical `GetQuoteRouteInfo` that bundled `Route` fields with quote-specific pricing fields in one flat message would work fine for `GetQuote`, then immediately be wrong for `ListRoutes`, which needs a `Route` with no quote attached at all. Splitting `Route` and `Money` into their own messages, rather than inlining price fields everywhere, is what lets `ListRoutes` return a bare `Route` and `GetQuote` return a `Route` paired with a `Money` from the same shared type.

The granularity question has a second axis beyond reuse: how much nesting is too much. A `Route` with `repeated Leg legs` is one level of nesting a client reasonably wants in full — a route without its legs isn't a route, it's an id. Had the schema instead embedded full `Booking` objects inside `Route`, or full `Route` objects inside every `Leg`, a client asking for one small thing would receive a message tree several services deep, most of which it throws away. The rule this chapter leans on: nest a message when the nested value's identity depends on its parent (a `Leg` only means something as part of a specific `Route`'s sequence), and reference by id — a plain `string` field, resolved with a separate call — when the referenced value has its own independent lifecycle and its own reasonable list of callers who want it without the parent attached. `Route` nests `Leg` because legs are never useful detached from the route that orders them, but a hypothetical `Route.carrier_id` would reference a `Carrier` by id rather than embed one, because a carrier is looked up and listed independently of any route.

{% include excalidraw.html file="13-message-granularity" alt="Two side-by-side panels contrasting nesting with referencing. Left panel, labeled Nest: a Route message with repeated Leg legs sits above two Leg boxes, each connected by an arrow labeled embedded; the boxes read Leg (1 of N), no identity outside Route.legs, and Leg (2 of N), ordinal position only. A caption below reads: nest when the child's identity only makes sense as part of the parent. Right panel, labeled Reference by id: a Route message with a carrier_id string field sits above a dashed Carrier box, connected by a dashed arrow labeled carrier_id (reference); the Carrier box reads own list, own lifecycle, fetched via CarrierService.Get. A caption below reads: reference by id when the value has its own callers and lifecycle." caption="Figure 13.1 — Message granularity: nest when identity depends on the parent, reference by id when the value has its own lifecycle." %}

## Request/response envelopes

Every RPC on `RoutingService` takes a dedicated `FooRequest` message and returns a dedicated `FooResponse` message, never a bare domain type and never two RPCs sharing one request shape. `ListRoutesRequest` could, in principle, have been a bare `int32` for page size plus a `string` for page token, passed as two scalar RPC arguments — gRPC's single-request-message rule makes that illegal outright, but even in a protocol that allowed it, wrapping them in a named message is the right call for a reason that outlives this chapter: a message can grow a field; a bare scalar parameter list cannot, without changing the method's signature and breaking every existing caller's generated code. `ListRoutesRequest` already carries three fields — `page_size`, `page_token`, `field_mask` — and when a future chapter wants to add a filter (routes only from a given carrier, say), that's one new optional field on an existing message, source- and wire-compatible with every client compiled against today's version. `ListRoutesResponse` gets the same treatment: `repeated Route routes` sits next to `next_page_token`, and a bare `repeated Route` return value would have had nowhere to put that token at all.

The response envelope earns a second justification once you look at what it *doesn't* carry: no total count, no "has more pages" boolean, no page number. `next_page_token` alone is the entire continuation protocol, because a boolean or a count would need to stay consistent with a catalog that might be changing between page 1 and page 2 — counting is a second query a server has to run and keep consistent with every page it has already returned, while an opaque token only has to describe "where this specific sequence of calls left off," which a server can compute from the page it just built without any extra work. An envelope that resists the temptation to add fields a client doesn't strictly need to continue is doing its job; one padded with every value a UI might someday want to display is quietly becoming the kind of god-message granularity warns against.

## Pagination with page tokens

{% include excalidraw.html file="13-pagination-page-tokens" alt="A pagination call chain. Call 1 sends page_size=3 and an empty page_token; the response returns routes 0 through 2 and next_page_token='3'. An arrow labeled token carried forward connects that token into Call 2, which sends page_size=3 and page_token='3'; the response returns routes 3 and 4 and an empty next_page_token, labeled done. A caption below reads: an empty next_page_token is the only exhaustion signal — no count, no boolean." caption="Figure 13.2 — Pagination chains calls with an opaque, server-defined page token." %}

A `ListRoutes` call that returned the entire catalog in one `ListRoutesResponse` would work today, with five routes, and stop working the day the catalog holds five million — a service with no pagination doesn't fail gracefully at scale, it fails by making every caller pay for the worst-case catalog size on every call, including the caller who only wanted the first three. `page_size` and `page_token` exist to make "give me a slice" a first-class request instead of "give me everything and let the client slice it client-side," which is both slower over the wire and impossible to bound in advance.

The convention this chapter follows — page_size as a request hint rather than a guarantee, page_token as an opaque string rather than a raw offset — matches Google's AIP-158 pagination standard, the same family of API-design guidelines that AIP-161 (field masks) and AIP-131 (standard methods) belong to. None of those AIPs are gRPC-specific; they're conventions for consistent API shape that this book's `.proto` files happen to express in Protobuf, and the same rules apply nearly verbatim to a paginated REST collection endpoint. A server is free to return fewer items than `page_size` asked for — a full page is a courtesy, not a contract — and a client is required to treat `page_token` as opaque: never parse it or construct one by hand. This chapter's example tokens are stringified offsets (`"3"`, `"6"`) because that's the simplest thing a 5-route in-memory list can produce deterministically; a catalog over a real datastore should encode a stable cursor instead — a last-seen sort key, possibly with a filter fingerprint — so a row inserted or deleted between two calls doesn't shift every subsequent offset out from under a token issued before the change. The client-visible contract is identical either way: call once with `page_token=""`, keep calling with whatever `next_page_token` the previous response carried, and stop when that field comes back empty. Nothing about that loop changes if the token's internal encoding changes tomorrow, which is exactly the point of keeping it opaque.

## FieldMask projection

{% include excalidraw.html file="13-fieldmask-projection" alt="A FieldMask projection flow. A ListRoutesRequest with field_mask.paths=['id','price'] points, via an arrow labeled server computes, to a dashed Catalog Route box holding the full object: id, legs, price. A second arrow, labeled FieldMaskUtil.merge, points from the Catalog Route to a Projected Route box with only id and price set and legs marked absent (unmasked). A caption below reads: unset field_mask means everything — projection is opt-in narrowing only." caption="Figure 13.3 — FieldMask projects a response down to only the fields a client asked for." %}

`google.protobuf.FieldMask` solves a different problem than pagination: not "how much of the catalog," but "how much of each returned message." A `Route` with legs and carriers and timestamps is the right shape for a client rendering a detailed itinerary and a wasteful one for a client that only wants a price list — fetching all of it every time makes every caller pay the bandwidth and serialization cost of the richest consumer's needs. `field_mask.paths` lets a request say exactly which top-level fields it wants populated; everything else comes back at its protobuf zero value, which proto3's wire format and JSON mapping both omit outright, so "didn't ask for it" and "absent from the response" are the same observable fact, not two different things a client has to reconcile.

Projection is an **opt-in narrowing**, never an expansion: an unset or empty `FieldMask` means "give me everything," not "give me nothing," which is the only reading that keeps `ListRoutes` compatible with a client built before `field_mask` existed on the request at all — that client never sets the field, gets the full `Route` it always got, and never notices the schema grew a new capability underneath it. This is the same backward-compatibility discipline Chapter 14 names for field numbers in general, applied here to one specific field: adding `field_mask` to `ListRoutesRequest` was itself a safe, additive schema change, and the default behavior when it's absent had to be chosen to preserve what every existing caller already relied on.

{% include codetabs.html langs="Quarkus|Python" %}

```java
private static Types.Route applyFieldMask(Types.Route route, FieldMask mask) {
    if (mask.getPathsCount() == 0) {
        return route; // unset mask -> full object, the backward-compatible default
    }
    if (!FieldMaskUtil.isValid(Types.Route.getDescriptor(), mask)) {
        throw new IllegalArgumentException("field_mask names a path Route does not have: "
                + mask.getPathsList());
    }
    FieldMask normalized = FieldMaskUtil.normalize(mask);
    Types.Route.Builder projected = Types.Route.newBuilder();
    FieldMaskUtil.merge(normalized, route, projected);
    return projected.build();
}
```

```python
def _apply_field_mask(route: types_pb2.Route, mask: field_mask_pb2.FieldMask) -> types_pb2.Route:
    if not mask.paths:
        return route  # unset mask -> full object, the backward-compatible default
    if not mask.IsValidForDescriptor(types_pb2.Route.DESCRIPTOR):
        raise ValueError(f"field_mask names a path Route does not have: {list(mask.paths)}")
    projected = types_pb2.Route()
    mask.MergeMessage(route, projected)
    return projected
```

Both sides do the identical three things in the identical order, using a well-known-type library each stack already ships rather than hand-rolled field clearing: reject a path the target message doesn't have, start from a **fresh, empty** builder rather than mutating a copy of the source, and merge only the named paths into it. Starting from empty is what turns "merge" into "project" — `FieldMaskUtil.merge` and `FieldMask.MergeMessage` both copy named fields *from* a source *into* a destination, and clear nothing. The library also buys correctness a hand-rolled version would have to re-derive: a mask path can name a nested field (`price.currency`) as cleanly as a top-level one, and `isValid`/`IsValidForDescriptor` check every path exists on the target descriptor before merging, rejecting a typo'd path as `INVALID_ARGUMENT` instead of silently returning an empty projection.

## How the code works

`ListRoutes` runs the same four steps on both stacks, over the identical fixed, in-memory catalog of five routes (`RouteCatalog.java` / `app/catalog.py`) — a real routing engine would page over a database query ordered by a stable key, but the catalog's only job here is to give pagination and projection deterministic data to walk.

**Clamp `page_size`, resolve `page_token` to a start index.** `page_size <= 0` falls back to a default of 3; a `page_size` above a maximum of 5 is clamped down to it rather than honored or rejected — a server protecting itself from an unreasonable request without forcing the client to guess the right value in advance. An empty `page_token` starts at index 0. A non-empty one is parsed as the offset it encodes in this demo; a token that doesn't parse, or parses to an out-of-range index, returns `INVALID_ARGUMENT` with a `BadRequest` naming `page_token` — the same rich-error shape Chapter 11 built, reused here because an invalid continuation token is exactly the kind of malformed-request failure that detail type exists for.

**Slice the catalog, compute `next_page_token`.** `end = min(start + page_size, catalog.size())` bounds the slice at the catalog's actual length regardless of what `page_size` asked for — asking for 3 more routes than exist returns however many are left, never an error. `next_page_token` is `end` restringified when `end` is still short of the catalog's length, and the empty string the moment it isn't; that empty string is the entire "you've reached the last page" signal a client checks for, with no separate boolean to keep in sync.

**Project each route in the slice through the request's `field_mask`**, using the `applyFieldMask`/`_apply_field_mask` helper shown above — called once per route in the page, never once for the whole response, because the mask describes the shape of one `Route`, not the shape of the `ListRoutesResponse` envelope around it (`next_page_token` is never subject to projection).

**Build the response envelope** from the projected list plus the computed token: `Routing.ListRoutesResponse.newBuilder().addAllRoutes(projected).setNextPageToken(nextPageToken).build()` on Quarkus, `routing_pb2.ListRoutesResponse(routes=projected, next_page_token=next_page_token)` on Python. Both other RPCs this module declares — `GetQuote`, `FindOptimalRoute`, `RecomputeRoutes`, `NegotiateRoute` — return `UNIMPLEMENTED`, the same discipline every prior chapter's example has followed: one RPC gets a real body per chapter, and the rest report that status rather than a stub value that would look like success.

This demo's page token is a raw offset into a `List`/`list` that never changes between calls — the simplification a real service over a changing datastore cannot make, for the reasons "Pagination with page tokens" above lays out.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Reach for an opaque, server-defined page token over a client-supplied offset or page number whenever the underlying collection can change between calls — which is any collection backed by a live datastore rather than a fixed, in-process list. An offset is cheap to implement and reads naturally, but it silently breaks the moment a row is inserted or removed ahead of the caller's current position, shifting every subsequent "page 3" to skip or repeat rows with no error raised anywhere; a token derived from a stable cursor doesn't have that failure mode, because it names a position in the data rather than a position in an index. Reach for <code>FieldMask</code> projection whenever a message serves callers with meaningfully different needs — a summary list view and a detail view of the same <code>Route</code> — rather than defining two separate RPCs or two separate response messages for the same underlying data; the mask keeps one schema serving both, at the cost of a client having to know which paths exist, which <code>isValid</code>/<code>IsValidForDescriptor</code> makes a loud, immediate rejection rather than a silent gap. Skip both for a collection that's small, fixed, and cheap to return in full on every call — the <code>RoutingService</code> methods this book never bothers to paginate, like a lookup table of supported currencies, aren't wrong for omitting <code>page_size</code>; they're correctly sized for data that will never need it.</p></div>

## Build, run, observe

```bash
cd examples/13-schema-design && ./verify.sh
```

`verify.sh` brings both services up with `docker compose`, waits for each to answer reflection's `list`, pages the identical 5-route catalog through both stacks, and asserts the field-mask projection on both. Expect `PASS` once every assertion holds for both stacks; the full input/output tables are in `examples/13-schema-design/README.md`.

## What you learned

- A message is sized around one reusable concept, not one call site; an envelope (`FooRequest`/`FooResponse`) wraps even a single scalar so the schema can grow a field without breaking an existing caller's generated code.
- `page_size`/`page_token` page a collection with an opaque, server-defined continuation token rather than a client-supplied offset, so the server is free to change how it computes "where we left off" without any client-visible contract change.
- `google.protobuf.FieldMask` projects a response down to exactly the fields a client named, using each stack's well-known-type library (`FieldMaskUtil` / `FieldMask.MergeMessage`) rather than hand-rolled field clearing — an unset mask means "everything," which is what keeps the field backward compatible with every caller that predates it.

Chapter 14 turns from designing a message well today to keeping it compatible as it changes tomorrow — field numbers, `reserved`, and the `buf breaking` gate that catches a schema edit before it ships a version two independently-deployed stacks no longer agree on.

## On the wire

```bash
grpcurl -plaintext -d '{"pageSize":3}' \
  localhost:9130 shipping.routing.v1.RoutingService/ListRoutes
```

```
{
  "routes": [
    { "id": "rte_001", "legs": [...], "price": { "currency": "USD", "amount": "1200.00" } },
    { "id": "rte_002", "legs": [...], "price": { "currency": "USD", "amount": "2400.00" } },
    { "id": "rte_003", "legs": [...], "price": { "currency": "USD", "amount": "1800.50" } }
  ],
  "next_page_token": "3"
}
```

```bash
grpcurl -plaintext -d '{"pageSize":3,"pageToken":"3"}' \
  localhost:9130 shipping.routing.v1.RoutingService/ListRoutes
```

```
{
  "routes": [
    { "id": "rte_004", "legs": [...], "price": { "currency": "USD", "amount": "1150.75" } },
    { "id": "rte_005", "legs": [...], "price": { "currency": "USD", "amount": "2600.25" } }
  ]
}
```

Note `next_page_token` is entirely absent from the second response, not present-and-empty — proto3 omits a string field at its zero value from JSON the same way it omits any other default, so "the field doesn't appear" *is* "there is no next page," with no separate boolean to check. One more call, with `field_mask` spelled out as the message it actually is rather than the comma-string shorthand a statically-compiled client could use:

```bash
grpcurl -plaintext -d '{"pageSize":1,"fieldMask":{"paths":["id","price"]}}' \
  localhost:9130 shipping.routing.v1.RoutingService/ListRoutes
```

```
{
  "routes": [
    { "id": "rte_001", "price": { "currency": "USD", "amount": "1200.00" } }
  ]
}
```

`legs` is gone — not empty, not null, simply never written. Swap `9130` for `9131` and every one of these three calls returns byte-identical JSON from the Python stack; `examples/13-schema-design/verify.sh` asserts exactly that, plus the no-overlap claim between the two pages, for both stacks on every run.
