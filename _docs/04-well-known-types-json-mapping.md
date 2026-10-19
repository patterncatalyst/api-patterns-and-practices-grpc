---
title: "Well-known types and JSON mapping"
order: 4
part: "Protocol Buffers: the Contract Language"
description: "Timestamp, Duration, FieldMask, Any, Struct, and the wrapper types, plus the canonical proto3-to-JSON mapping that renders them at the REST and grpcurl edges."
duration: "19 min read"
---

## Learning objectives

By the end of this chapter you can:

- Name the well-known types (`Timestamp`, `Duration`, `FieldMask`, `Any`, `Struct`, the wrapper types) and pick the right one for a given field shape.
- Read the canonical proto3-to-JSON mapping table and predict how any field renders — field-name casing, `Timestamp` as RFC 3339, 64-bit integers as strings.
- Explain why `grpcurl` prints snake_case while every library's JSON encoder emits camelCase, and why both are the same mapping.
- State why `shipping.type.v1.Money` uses two decimal strings instead of a `double` or an `int64` cents field.
- Convert a native date-time value to and from `google.protobuf.Timestamp` on both Quarkus and Python.

## Why this matters

Chapter 3 decoded `Money{currency: "USD", amount: "1250.00"}` down to fourteen wire bytes and explained why no field name ever appears in them. That's the right way to think about a message between two generated stubs that both read the same `.proto`. It's the wrong way to think about a message read by a human running `grpcurl`, a browser calling through a REST gateway, or a log line a developer has to eyeball at 2 a.m. — none of those readers has the `.proto` file loaded, and none of them wants to hand-decode a VARINT. proto3 solves that with a second, officially specified representation of every message: JSON. The mapping between the two isn't a convention this site invented; it's part of the Protocol Buffers specification itself, implemented identically by every generator, which is exactly why `shipping.routing.v1.RoutingService.FindOptimalRoute`'s response looks the same whether `protoc`'s Java backend or its Python backend produced the code that serialized it.

That mapping only covers scalars, messages, and enums outright. A handful of concepts — a point in time, a span of time, a sparse list of field paths, a value whose schema isn't known until runtime — don't have a native proto3 type, so Google ships them as ordinary `.proto` files, compiled into every language's standard library alongside the compiler itself: the **well-known types**. `shipping/type/v1/types.proto` already imports one of them without comment; this chapter makes that import, and the five or six types like it, the main subject.

## The well-known types: a catalog grounded in this contract

{% include excalidraw.html file="04-wellknown-catalog" alt="A catalog of six google.protobuf well-known types, each paired with the contract field that uses it. Timestamp, an instant, models Leg.departs_at and Leg.arrives_at. Duration, a span measured from nothing, budgets a deadline covered in Chapter 10. FieldMask, a set of field paths, names ListRoutesRequest.field_mask. Any, dynamic-typed, carries google.rpc.Status.details from Chapter 11. Struct, untyped JSON, is connected by a dashed line captioned 'no field needs it' to a ghost box reading not in shipping.* today, Booking.labels uses map<string,string> instead. Wrapper types, present versus absent, are connected by a dashed line captioned 'contrasts with' to a ghost box reading FindOptimalRouteRequest.prefer_speed: bool, only two states matter." caption="Figure 4.1 — the well-known types, grouped by the problem each solves and the contract field that uses it." %}

`google.protobuf.Timestamp` represents an instant — a point in civil time, not a duration and not a local wall-clock reading. It's two fields, `int64 seconds` (since the Unix epoch) and `int32 nanos` (the fractional remainder), always UTC, always absolute. `Leg.departs_at` and `Leg.arrives_at` are `Timestamp`s because a shipment's departure is a fact about the world everyone needs to agree on in the same instant, regardless of which time zone origin, destination, or a caller's own server happens to sit in. `Booking.created_at` and `TrackingEvent.at` use it for the same reason: these are facts stamped once, compared across services, and never meant to be read as "3pm local."

`google.protobuf.Duration` represents an elapsed span instead of a point — also `seconds` and `nanos`, but measured from nothing rather than from the epoch. Nothing in this contract declares one yet, but the shape recurs the moment a method needs to say "this long," not "at this time": a deadline budget handed to a downstream call (Chapter 10), a retry backoff interval, a staleness bound on a cached route. The distinction from `Timestamp` is the one a raw `int64` erases entirely — a `Duration` can't be mistaken for an instant, because its wire shape and its JSON rendering both say "elapsed," never "when."

`google.protobuf.FieldMask` represents a set of field paths — `ListRoutesRequest.field_mask` lets a caller ask for only `route.id` and `route.price` out of a full `Route`, skipping the cost of serializing and transmitting `legs` it doesn't need. It's a `repeated string paths` under the hood, each entry a dotted path into the response message's own field names. Chapter 13 covers what a server does with one in depth; this chapter only needs that it exists as a reusable, generator-supported way to say "a subset of these fields," rather than a bespoke `repeated string included_fields` every service reinvents slightly differently.

`google.protobuf.Any` solves a narrower problem: embedding a message whose concrete type the embedding message's schema doesn't name. It stores a type URL alongside the serialized bytes, so a generic container — most visibly `google.rpc.Status.details`, which Chapter 11's rich error model wraps around `google.rpc.BadRequest` and friends — can carry one of several message types without a `oneof` enumerating them all up front, at the cost of the receiver needing to know how to unpack whatever type URL shows up. Nothing in `shipping.*` uses one today; it's the right tool for an extension point a service's own schema can't close off in advance, which is rarer than it looks and shouldn't be reached for as a substitute for a field the schema could just name.

Unpacking an `Any` is a second, independent step from parsing it, and that's where the cost above lands. A receiver resolves the type URL against whatever message types it has on hand — a compiled-in descriptor, or a type registry for a receiver that can't know in advance what will show up — and only then deserializes the bytes into that concrete type. A type URL the receiver never linked in resolves to nothing: the outer `Any` parsed cleanly, but no code on hand knows how to turn its bytes into a typed message, so the failure is a runtime unpack error at the call site, not a decode failure on the wire. That's the mechanism Chapter 11's `google.rpc.Status.details` rides on — a client that never linked in `google.rpc.BadRequest` can still receive the `Status`, just not unpack what's inside `details`.

`google.protobuf.Struct` goes further still: an arbitrary, untyped JSON-like object — a map of string keys to values that are themselves strings, numbers, bools, nested structs, or lists. It's the direct way to accept "whatever JSON shape the caller sends," the opposite of everything Chapter 3 recommended. `Booking.labels` is a `map<string, string>` rather than a `Struct` for exactly this reason: labels are a known shape (flat key-to-string pairs) that proto3's type system can describe and validate directly, and reaching for `Struct` there would throw away the one advantage a typed schema has over a REST site's free-form JSON body — a compiler that catches the field that doesn't exist. `Struct` is worth using only when the shape isn't known at compile time, such as a webhook payload defined by a third party this contract doesn't control.

The wrapper types — `google.protobuf.BoolValue`, `Int32Value`, `StringValue`, `DoubleValue`, and five more scalar siblings — exist to answer a question Chapter 3 raised and left open: how does a proto3 scalar distinguish "never set" from "set to the zero value," before the `optional` keyword existed to do it directly? A wrapper boxes a scalar inside a one-field message, and an unset message field is absent rather than zero, so `BoolValue`'s absence and its presence-set-to-false are distinguishable where a bare `bool`'s aren't. `FindOptimalRouteRequest.prefer_speed` is a plain `bool`, not a `BoolValue`, because this contract never needs to ask "did the caller express a preference at all" — a caller who cares about speed sets it `true`, one who doesn't leaves it `false`, and those are the only two states `FindOptimalRoute` ever has to act on. A wrapper buys real information at a real cost — an extra allocation and a `Has*()`-style check at every read site — and `optional` scalar fields now cover most of the same ground more cheaply for a single proto3 file; wrappers still matter for interop with JSON tooling and older proto2-era APIs that expect them by name, which is why they're worth recognizing on sight even where this contract doesn't reach for one.

## Money as a decimal string: the REST↔gRPC seam, in one message

`shipping.type.v1.Money` isn't a well-known type — it's two plain `string` fields, `currency` and `amount` — and that's deliberate rather than an oversight. A `double amount` would serialize compactly and look natural, until two services summed enough `weight_kg * rate` calculations to drift by a cent through ordinary binary floating-point rounding, the same failure IEEE 754 guarantees for any base-10 fraction it can't represent exactly. An `int64 amount_cents` avoids the rounding problem but creates a silent-units problem instead: every caller has to know, out of band, that the integer means cents and not the currency's major unit or micros, and a client built against the wrong assumption is off by two orders of magnitude with no error from the parser. A decimal string sidesteps both: `"1250.00"` round-trips through JSON, logs, and a database column exactly as written, with no base-2 approximation and no unit ambiguity to document separately.

This is the one point where this site and its REST sibling make the identical call for the identical reason: the REST contract's `Money` JSON Schema component is `{ currency: string, amount: string }`, the same two fields, the same decimal-string rule, because the domain fact — money shouldn't be a binary float — doesn't change when the transport does. A `Booking` crossing the REST↔gRPC seam at the booking service carries one `Money` value through both notations without either side reinterpreting what `amount` means.

## The canonical proto3 ↔ JSON mapping

Every well-known type above, and every ordinary field, resolves to JSON through one fixed set of rules, and this is the chapter's spine: learn this table once and every `grpcurl` response, every REST-gateway payload, and every log line this site produces becomes legible without a lookup.

| Proto construct | JSON representation | Example |
|---|---|---|
| field name | lowerCamelCase | `un_locode` → `unLocode` |
| `google.protobuf.Timestamp` | RFC 3339 string | `"2026-02-01T10:00:00Z"` |
| `google.protobuf.Duration` | decimal seconds + `s` suffix | `"3.5s"` |
| `google.protobuf.FieldMask` | comma-joined path string | `"route.id,route.price"` |
| `enum` | the value's name, as a string | `"BOOKING_STATE_CONFIRMED"` |
| `int64`, `uint64`, `sint64`, `fixed64`, `sfixed64` | string | `"9223372036854775807"` |
| `bytes` | base64-encoded string | `"SGVsbG8="` |
| wrapper types (`Int32Value`, etc.) | the bare scalar, or `null` if unset | `0` vs. `null` |
| `google.protobuf.Struct` | the arbitrary JSON object it holds | `{"any": "shape"}` |
| `google.protobuf.Any` | `{"@type": "...", ...fields}` | — |

The first row is the one that trips people up fastest, because it looks cosmetic and isn't: `Location.un_locode`, a `snake_case` field exactly as declared in `types.proto`, becomes the JSON key `unLocode` on the wire and in every library's generated accessor, by specification, not by this project's house style. 64-bit integer types render as JSON strings rather than numbers because JavaScript's `Number` only represents integers exactly up to 2^53, and a `Money`-adjacent `int64` id or a large counter silently loses precision the moment a browser's `JSON.parse` touches it as a number — proto3 JSON sidesteps that entire class of bug by never emitting a 64-bit integer as a JSON number in the first place.

{% include excalidraw.html file="04-wellknown-json-mapping" alt="A proto3 Leg message with carrier, departs_at, and arrives_at Timestamp fields, and a Money message with currency and amount string fields, each with an amber-highlighted arrow labeled 'proto3 JSON mapping' pointing to its camelCase JSON rendering — departsAt and arrivesAt as RFC 3339 strings, amount as a decimal string, not a number — with a third, dashed box showing that grpcurl's own printed output reverts to snake_case field names like departs_at even though the underlying wire and library JSON is camelCase." caption="Figure 4.2 — One proto3 JSON mapping, read in both directions: library JSON renders camelCase; grpcurl's printed output does not." %}

One tool-specific wrinkle is worth knowing before it looks like a contradiction: `grpcurl` **accepts** a request body in either lowerCamelCase or the original snake_case field names, but **prints** a response back using each message's original, declared field names — snake_case, not camelCase — regardless of which casing the request used. Both directions are still proto3 JSON; `grpcurl` just chooses to render output in the proto source's own spelling rather than the canonical wire casing, which means the camelCase rule above is what every library-level JSON encoder emits, and what every REST gateway sees, even on the one call path — `grpcurl` on your own terminal — where the printed text looks like it disagrees. A request of `{"unLocode": "USNYC"}` and a printed response field `"un_locode": "USNYC"` describe the identical mapping read forwards and backwards; neither is wrong, and conflating them is the single easiest proto3-JSON mistake to make the first time a `grpcurl` session doesn't match what the generated Java or Python code just handed you.

One more consequence of this table is easy to miss until it causes a real bug: a scalar field left at its default — `0`, `""`, `false` — is omitted from proto3 JSON entirely, never emitted as a literal zero. That's not an encoder shortcut; proto3's wire format already treats a default-valued scalar as absent, so JSON doesn't invent a distinction the binary encoding never drew. "Never set" and "set to zero" look identical on the wire and in every log line — both render as a key that simply isn't there. `optional` scalars and the wrapper types restore the distinction this chapter already introduced: a wrapper set to zero is still a present one-field message and gets emitted, where an absent wrapper serializes as `null`. Every JSON encoder ships an opt-in to print default-valued scalars anyway, for a caller that needs the full field set. Chapter 13's `FieldMask` inherits this same ambiguity: a path resolving to a never-set scalar and one resolving to an explicitly-zeroed scalar merge identically, because the mask can't tell which one happened.

## Setting a Timestamp: the well-known type in generated code

Neither stack's generator makes you build `Timestamp`'s two raw integer fields by hand. Both ship a conversion between the well-known type and the host language's native date-time type, because every language already has one and reinventing a `seconds`/`nanos` pair at every call site would be the thing well-known types exist to prevent:

{% include codetabs.html langs="Quarkus|Python" %}

```java
// com.google.protobuf.Timestamp ships inside protobuf-java itself — no
// extra dependency beyond quarkus-grpc, which already pulls it in.
private static final Instant DEPARTS_AT = Instant.parse("2026-02-01T10:00:00Z");

private static Timestamp toTimestamp(Instant instant) {
    return Timestamp.newBuilder()
            .setSeconds(instant.getEpochSecond())
            .setNanos(instant.getNano())
            .build();
}
```

```python
# google.protobuf.timestamp_pb2 ships inside the `protobuf` package itself —
# already a runtime dependency, not something grpcio-tools adds.
_DEPARTS_AT = datetime(2026, 2, 1, 10, 0, 0, tzinfo=timezone.utc)

def _to_timestamp(when: datetime) -> timestamp_pb2.Timestamp:
    ts = timestamp_pb2.Timestamp()
    ts.FromDatetime(when)
    return ts
```

`Instant.getEpochSecond()`/`getNano()` and `Timestamp.FromDatetime()` are each stack's native bridge between the well-known type's wire shape and a type the rest of the language's standard library already understands — `java.time.Instant` and Python's timezone-aware `datetime`, both of which refuse to let you forget a time zone the way a bare `long millis` never stops you from forgetting. Get the input instant right — UTC, explicit, never "now" read off a wall clock mid-test — and both stacks produce the identical `seconds`/`nanos` pair, which is what turns into the identical RFC 3339 string on the way out.

## On the wire

`examples/04-well-known-types/verify.sh` makes this exact call against both stacks — Quarkus on `9007`, Python on `9008` — and both return byte-identical `Timestamp` and `Money` renderings, because both were generated from the same `.proto` through the same specification:

```bash
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"}
}' localhost:9007 shipping.routing.v1.RoutingService/FindOptimalRoute
```

Expect this back — note the request's `unLocode` versus the response's printed `un_locode`, the same `grpcurl` quirk this chapter called out above, and `departs_at`/`arrives_at` rendered as RFC 3339 strings exactly as the mapping table predicts:

```json
{
  "route": {
    "id": "rte_USNYC-NLRTM",
    "legs": [
      {
        "carrier": "MAERSK",
        "origin": {"un_locode": "USNYC"},
        "destination": {"un_locode": "NLRTM"},
        "departs_at": "2026-02-01T10:00:00Z",
        "arrives_at": "2026-02-18T06:00:00Z"
      }
    ],
    "price": {"currency": "USD", "amount": "4200.00"}
  }
}
```

Swap port `9007` for `9008` and run the identical command against the Python stack for the identical answer — `route.price.amount` comes back `"4200.00"`, a decimal string, never a JSON number, on both.

## Where this goes next

This chapter's mapping table is the thing every later chapter assumes without re-deriving: Chapter 10 sends a `Duration`-shaped deadline budget down the same call chain Chapter 2 named; Chapter 11 wraps `google.rpc.Status.details` around an `Any` holding a typed error payload; Chapter 13 builds `ListRoutes`'s pagination and projection logic directly on the `FieldMask` introduced here; and the REST site's own OpenAPI contract keeps rendering `Money`, `Location`, and every `Timestamp`-backed field through this exact JSON shape at the one seam both sites share. Chapter 5 is where all of this stops being a table to read and starts being a response you call for yourself: `RoutingService.GetQuote`, generated on both stacks from the same `.proto`, gated by `buf`, and checked by a `verify.sh` that asserts response fields the way this chapter's own example already does.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Choosing <code>Timestamp</code> over a raw <code>int64</code> epoch, and <code>FieldMask</code> over a bespoke <code>repeated string</code> of field names, both come down to the same two axes from Chapter 2's framework, even though neither is strictly about RPC shape. Failure class is the sharper one: a raw epoch integer's failure mode is a <em>silent</em> misread — seconds decoded as milliseconds lands a date fifty-some years in the wrong direction with no parse error, no non-<code>OK</code> status, nothing a caller's retry logic or <code>buf breaking</code> would ever catch, because the field still type-checks as an integer either way. <code>Timestamp</code> and <code>FieldMask</code> convert that into a loud failure instead: a value that doesn't parse as RFC 3339 is a JSON decode error, not a plausible-looking wrong answer, and a field mask path that doesn't exist on the target message is a validation error a server can reject before it ever computes a response. The other axis is evolution, which Chapter 14 covers in full: a <code>FieldMask</code>-driven <code>ListRoutes</code> keeps working unmodified the day a new field is added to <code>Route</code>, because the mask names paths the caller already knows about and the server doesn't have to special-case; a bespoke "which fields do you want" enum would need a new value, a new server branch, and a new release on both sides for the same change. Reach for the well-known type whenever the alternative is a convention two independently-deployed services have to agree on silently; write the scalar by hand only when there's no well-known type that already names the exact shape you need, the way <code>Money</code>'s decimal-string case has none.</p></div>

## For deeper coverage

- Clément Jean, *gRPC Go for Professionals* (Packt) — schema design choices like `Money`-as-decimal-string and when to reach for a well-known type over a bespoke field.
- [Protocol Buffers — JSON Mapping reference](https://protobuf.dev/programming-guides/json/) — the canonical proto3-to-JSON table this chapter's own table is built from.
- [Protocol Buffers — Well-Known Types](https://protobuf.dev/reference/protobuf/google.protobuf/) — the full `Timestamp`/`Duration`/`FieldMask`/`Any`/`Struct`/wrapper-type reference.
- Cloud Native Design Patterns — the *API Error Handling* appendix, where `google.rpc.Status.details` wraps an `Any` the way this chapter introduces it.
