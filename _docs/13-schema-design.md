---
title: "Schema design over gRPC"
order: 13
part: "Schema Evolution & the Living Contract"
description: "Message granularity, request and response envelopes, pagination with page tokens, and FieldMask projection."
duration: "16 min read"
---

## Learning objectives

By the end of this chapter you can:

- Size a protobuf message around one reusable concept, and choose between nesting a field and referencing it by id.
- Wrap even a single scalar in a dedicated `FooRequest`/`FooResponse` envelope so the schema can grow a field without breaking a caller.
- Page a collection with an opaque, server-defined `page_token` instead of a client-supplied offset or page number.
- Project a response with `google.protobuf.FieldMask`, with an unset mask staying backward compatible.

## Why this matters

`RoutingService.ListRoutes` has been in `routing.proto` since the contract was declared. It is the RPC whose job is the shape of a whole catalog rather than the correctness of one call. Pagination and projection are schema questions, settled when the message is built and before any handler code exists: how big to make a message, how to wrap a response so it can grow, and how a client gets exactly the fields it asked for from a catalog neither side wants to ship in full on every call.

{% include excalidraw.html file="13-message-granularity" alt="Two panels. Nest: a Route message with repeated Leg legs, each Leg an embedded box with no identity outside Route.legs. Reference by id: a Route with a carrier_id string pointing by a dashed arrow to a Carrier with its own list and lifecycle, fetched via CarrierService.Get." caption="Figure 13.1: Message granularity. Nest when identity depends on the parent, reference by id when the value has its own lifecycle." %}

## Message granularity

A message is exactly as big as one reusable concept. `Money`, `Location`, `Leg` and `Route` in `shipping.type.v1` each mean one thing (an amount, a port, one hop, a planned path), so `RoutingService`, `BookingService` and `TrackingService` can share them without importing a type built for another service's convenience.

The opposite failure is a message sized around one call site. A `GetQuoteRouteInfo` that mixes `Route` fields with pricing fields works for `GetQuote` and is wrong for `ListRoutes`, which needs a `Route` with no quote. Keeping `Route` and `Money` separate lets `ListRoutes` return a bare `Route` and `GetQuote` return a `Route` with a `Money` from the same types.

The second axis is nesting depth. Embedding full `Booking` objects in `Route`, or full `Route` objects in every `Leg`, hands a client asking for a small thing a tree most of which it discards. The rule:

| Situation | Model it as | Example |
| --- | --- | --- |
| The child's identity depends on its parent | Nest the message | `Route` holds `repeated Leg legs`; a leg only means something in a route's sequence |
| The child has its own lifecycle and its own callers | Reference by id (a `string` field, resolved by a separate call) | A `Route.carrier_id` references a `Carrier`, which is looked up and listed independently |

## Request and response envelopes

Every RPC takes a dedicated `FooRequest` and returns a dedicated `FooResponse`, never a bare domain type and never two RPCs sharing a request. gRPC's single-message rule forces the request wrapper. The reason to keep it for one scalar anyway is that a message can grow a field and a bare parameter cannot, without changing the method signature and breaking every caller's generated code.

`ListRoutesRequest` already carries `page_size`, `page_token` and `field_mask`. A future filter, such as routes from one carrier, is one new optional field, source- and wire-compatible with every client built today. `ListRoutesResponse` holds `repeated Route routes` next to `next_page_token`; a bare `repeated Route` would have had nowhere to put the token.

What the response omits matters as much: no total count, no "has more" boolean, no page number. A count is a second query that must stay consistent with every page already returned, and a boolean must agree with a catalog that may change between page 1 and page 2. `next_page_token` is the whole continuation protocol, because a token only describes where this sequence of calls left off, which the server knows from the page it just built. An envelope padded with every value a UI might someday show becomes the god-message that granularity warns against.

## Pattern: Pagination with Page Tokens

{% include excalidraw.html file="13-pagination-page-tokens" alt="Call 1 sends page_size=3 and an empty page_token and gets routes 0 to 2 with next_page_token '3'. That token is carried into Call 2, which sends page_size=3 and page_token '3' and gets routes 3 and 4 with an empty next_page_token, meaning done." caption="Figure 13.2: Pagination chains calls with an opaque, server-defined page token. An empty token is the only exhaustion signal." %}

### The problem

A `ListRoutes` that returns the whole catalog works with five routes and fails with five million. Without pagination every caller pays for the worst-case catalog on every call, including the one who wanted the first three. Slicing on the client is slower over the wire and impossible to bound in advance.

### The solution

**A paginated list takes a `page_size` hint and an opaque `page_token`, and returns a `next_page_token` that is empty on the last page.**

The convention is Google's AIP-158, in the same family as AIP-161 (field masks) and AIP-131 (standard methods). None of them is gRPC specific, and a paginated REST collection follows the same rules.

- `page_size` is a hint. The server may return fewer items; a full page is a courtesy.
- `page_token` is opaque. A client never parses it or builds one by hand.
- The loop is the same whatever the encoding: call with `page_token=""`, keep calling with the previous `next_page_token`, stop when it comes back empty.

### How Quarkus and Python model it

Both stacks run the same four steps over the same fixed catalog of five routes (`RouteCatalog.java`, `app/catalog.py`):

1. Clamp `page_size`: zero or less becomes the default of 3, and above the maximum of 5 it is clamped down, so the server protects itself without making the client guess.
2. Resolve `page_token` to a start index. An empty token starts at 0. A token that doesn't parse, or parses out of range, returns `INVALID_ARGUMENT` with a `BadRequest` naming `page_token`, the same rich-error shape as before.
3. Slice with `end = min(start + page_size, catalog.size())`. `next_page_token` is `end` as a string while `end` is short of the catalog, and empty otherwise.
4. Project each route in the slice through the request's `field_mask`, once per route, because the mask describes one `Route` and never the response envelope.

Tokens here are stringified offsets (`"3"`), the simplest deterministic thing a static in-memory list can produce. Over a changing datastore an offset breaks: a row inserted ahead of the caller's position makes the next page skip or repeat rows, with no error anywhere. A real token encodes a stable cursor, such as a last-seen sort key with a filter fingerprint, and the client contract is identical because the token is opaque.

## Pattern: FieldMask Projection

{% include excalidraw.html file="13-fieldmask-projection" alt="A ListRoutesRequest with field_mask.paths of id and price. The server merges those paths from the full catalog Route (id, legs, price) into a projected Route that has only id and price; legs is absent. An unset field_mask means everything." caption="Figure 13.3: FieldMask projects a response down to the fields a client asked for." %}

### The problem

A `Route` with legs, carriers and timestamps suits a client rendering a detailed itinerary and wastes bandwidth and serialization for one that wants a price list. Without projection, every caller pays for the richest consumer's needs, or the service grows a second RPC and a second message for each view.

### The solution

**A request carries a `google.protobuf.FieldMask` naming the fields it wants, and the server populates only those.**

Fields not named stay at their zero value, which proto3's wire format and JSON mapping omit, so "not asked for" and "absent" are the same observable fact.

Projection only narrows. An unset or empty mask means everything, the one reading that keeps `ListRoutes` compatible with a client built before `field_mask` existed: it never sets the field and gets the full `Route` it always got. Adding the field was a safe additive change, and the absent-field default had to preserve what existing callers relied on.

### How Quarkus and Python model it

{% include codetabs.html langs="Quarkus|Python" %}

```java
    /**
     * Returns {@code route} unchanged when the caller sent no mask (an unset
     * {@code FieldMask} means "I want everything", the only reading that
     * keeps {@code ListRoutes} backward compatible with a client built before
     * this field existed). Otherwise builds a FRESH, empty {@code Route}
     * builder and merges only the named top-level paths into it, so any field
     * not named in the mask stays at its zero value and is therefore absent
     * from the wire (proto3 omits unset/default scalar and message fields).
     * {@link FieldMaskUtil#normalize} sorts and de-duplicates the paths first,
     * which also happens to be where an unrecognized path is rejected via
     * {@link FieldMaskUtil#isValid}, never silently ignored.
     */
    private static Types.Route applyFieldMask(Types.Route route, FieldMask mask) {
        if (mask.getPathsCount() == 0) {
            return route;
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
    """Returns `route` unchanged when the caller sent no mask (an unset
    FieldMask means "I want everything", the only reading that keeps
    ListRoutes backward compatible with a client built before this field
    existed). Otherwise builds a FRESH, empty Route and merges only the named
    top-level paths into it, so any field not named in the mask stays at its
    zero value and is therefore absent from the wire (proto3 omits
    unset/default scalar and message fields). Raises ValueError for a path
    Route does not have, rather than silently ignoring it."""
    if not mask.paths:
        return route
    if not mask.IsValidForDescriptor(types_pb2.Route.DESCRIPTOR):
        raise ValueError(f"field_mask names a path Route does not have: {list(mask.paths)}")
    projected = types_pb2.Route()
    mask.MergeMessage(route, projected)
    return projected
```

Both use the well-known-type library each stack ships instead of hand-rolled field clearing. They reject a path the target message doesn't have, start from a fresh, empty builder, and merge only the named paths into it. Starting empty is what turns merge into project: `FieldMaskUtil.merge` and `FieldMask.MergeMessage` copy named fields from source to destination and clear nothing. A path can name a nested field (`price.currency`) as readily as a top-level one, and the validity check turns a typo into `INVALID_ARGUMENT` instead of a silently empty projection.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Use an opaque page token over an offset or page number whenever the collection can change between calls, which is any collection backed by a live datastore. Use <code>FieldMask</code> when one message serves callers with different needs, such as a summary list and a detail view of <code>Route</code>, instead of defining two RPCs or two response messages; the cost is that a client must know which paths exist, and the validity check makes a wrong one fail loudly. Skip both for a small, fixed collection cheap to return whole, like a lookup table of supported currencies.</p></div>

> **🤖 Explore with your agent**
>
> "In `examples/13-schema-design`, review `ListRoutes` on both stacks (`RoutingServiceImpl.java` and `python/app/routing_service.py`) against this rule: an unset `field_mask` returns the full route, a mask only narrows, and the mask applies to each `Route`, never to the response envelope. Confirm that the path `price.currency` returns only the currency inside `price` on both stacks, and change only what fails."
>
> Check: `grpcurl -plaintext -d '{"pageSize":1,"fieldMask":{"paths":["price.currency"]}}' localhost:9130 shipping.routing.v1.RoutingService/ListRoutes` returns `price` holding only `currency`, and the same call on port 9131 returns identical JSON.

## Build, run, observe

`examples/13-schema-design/verify.sh` starts both stacks with `docker compose` (Quarkus on 9130, Python on 9131), pages the five-route catalog through both, and checks the projection. By hand:

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

`next_page_token` is absent from the second response, not present and empty. proto3 omits a string at its zero value from JSON like any default, so a missing field is the signal that there is no next page. The mask goes in as a message, not the comma-string shorthand a compiled client could use:

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

`legs` is gone: not empty, not null, never written. The Python stack on port 9131 returns byte-identical JSON for all three calls, and the two pages don't overlap.

Experiments:

- Send `"pageToken":"nope"`: the call fails with `INVALID_ARGUMENT` and a `BadRequest` naming `page_token`.
- Send a mask path `Route` doesn't have, such as `"paths":["nope"]`: the call fails with `INVALID_ARGUMENT` instead of returning an empty route.
- Send `"pageSize":0` and then `"pageSize":50`: the first returns 3 routes, the second all 5.

## For deeper coverage

- [Google AIP-158: Pagination](https://google.aip.dev/158): the opaque-page-token convention `ListRoutes` follows.
- [Google AIP-161: Field masks](https://google.aip.dev/161): the standard the projection implements.
- [Protocol Buffers: Proto3 language guide](https://protobuf.dev/programming-guides/proto3/): message design, nesting, and the well-known types, `FieldMask` among them.
- Cloud Native Design Patterns, "Composition": the same granularity and envelope questions applied to composing responses across services.
- Clément Jean, *gRPC Go for Professionals*, Packt, 2023: Protobuf schema design in depth.
