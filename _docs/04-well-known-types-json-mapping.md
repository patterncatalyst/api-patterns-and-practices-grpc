---
title: "Well-known types and JSON mapping"
order: 4
part: "Protocol Buffers: the Contract Language"
description: "Timestamp, Duration, FieldMask, Any, Struct and the wrapper types, plus the canonical proto3-to-JSON mapping that renders them at the REST and grpcurl edges."
duration: "15 min read"
---

## Learning objectives

By the end of this chapter you can:

- Pick the right well-known type (`Timestamp`, `Duration`, `FieldMask`, `Any`, `Struct`, the wrappers) for a field.
- Predict how any field renders in proto3 JSON: lowerCamelCase names, RFC 3339 timestamps, 64-bit integers as strings.
- Explain why `grpcurl` prints snake_case while every library's JSON encoder emits camelCase.
- Explain why `shipping.type.v1.Money` uses two strings instead of a `double` or an `int64` of cents.
- Convert a native date-time value to `google.protobuf.Timestamp` on Quarkus and Python.

## Why this matters

Protobuf's binary encoding reduces `Money{currency: "USD", amount: "1250.00"}` to fourteen bytes, with no field name in any of them. That suits two generated stubs reading the same `.proto`. It doesn't suit a person running `grpcurl`, a browser behind a REST gateway, or a log line read at 2 a.m.: none of them has the `.proto` loaded. So proto3 specifies a second representation of every message, JSON. The mapping is part of the Protocol Buffers specification, and every generator implements it the same way, which is why `shipping.routing.v1.RoutingService.FindOptimalRoute` returns the same JSON from the Java and the Python backends.

The mapping covers scalars, messages and enums directly. A point in time, a span of time, a list of field paths and a value whose schema isn't known until runtime have no native proto3 type, so Google ships them as ordinary `.proto` files compiled into every language's standard library. These are the **well-known types**.

## The well-known types

{% include excalidraw.html file="04-wellknown-catalog" alt="A catalog of six google.protobuf well-known types, each paired with the contract field that uses it. Timestamp, an instant, models Leg.departs_at and Leg.arrives_at. Duration, a span measured from nothing, budgets a deadline. FieldMask, a set of field paths, names ListRoutesRequest.field_mask. Any, dynamic-typed, carries google.rpc.Status.details. Struct, untyped JSON, is connected by a dashed line captioned 'no field needs it' to a ghost box reading not in shipping.* today, Booking.labels uses map<string,string> instead. Wrapper types, present versus absent, are connected by a dashed line captioned 'contrasts with' to a ghost box reading FindOptimalRouteRequest.prefer_speed: bool, only two states matter." caption="Figure 4.1: The well-known types, each paired with the contract field that uses it." %}

| Type | Represents | Use it for | In the contract |
|---|---|---|---|
| `Timestamp` | An instant: `int64 seconds` since the Unix epoch plus `int32 nanos`, always UTC | Facts stamped once and compared across services | `Leg.departs_at`, `Leg.arrives_at`, `Booking.created_at`, `TrackingEvent.at` |
| `Duration` | An elapsed span: `seconds` and `nanos`, measured from nothing | Deadline budgets, backoff intervals, staleness bounds | None yet |
| `FieldMask` | A set of field paths, a `repeated string paths` of dotted names | "Only these fields" requests | `ListRoutesRequest.field_mask` |
| `Any` | A type URL plus serialized bytes | An extension point the schema can't close in advance | `google.rpc.Status.details` |
| `Struct` | An untyped JSON object | Payloads whose shape isn't known at compile time, such as a third party's webhook | None |
| Wrappers (`BoolValue`, `Int32Value`, `StringValue`, `DoubleValue` and five more) | A scalar boxed in a one-field message | Telling "never set" from "set to zero" | None |

A `Duration` can't be mistaken for an instant: its wire shape and its JSON rendering both say "elapsed", never "when". A raw `int64` erases that difference.

`FieldMask` replaces the `repeated string included_fields` that every service otherwise reinvents slightly differently. A caller asking for `route.id` and `route.price` skips serializing and transmitting `legs`. What a server does with a mask is a later topic.

`Any` has a cost on the receiving side. Unpacking is a second step after parsing: the receiver resolves the type URL against the message types it has on hand, a compiled-in descriptor or a type registry, and then deserializes the bytes. A type URL the receiver never linked in parses fine as an `Any` but fails at unpack time. That's the mechanism under the rich error model: a client that never linked in `google.rpc.BadRequest` still receives the `Status`, it just can't unpack what's in `details`. Reach for `Any` only where the schema can't name the type; if a field could name it, name it.

`Booking.labels` is a `map<string, string>` rather than a `Struct` because labels are a known shape: flat key-to-string pairs that the type system can describe and the compiler can check. A `Struct` would throw away the one advantage a typed schema has over a free-form JSON body.

The wrappers predate the `optional` keyword and answer one question: how does a proto3 scalar distinguish "never set" from "set to the zero value"? An unset message field is absent rather than zero, so a `BoolValue` carries presence where a bare `bool` can't. `FindOptimalRouteRequest.prefer_speed` is a plain `bool` because `FindOptimalRoute` only acts on two states: set to `true`, or left `false`. A wrapper costs an allocation and a presence check at every read, and `optional` scalars now cover most of the same ground more cheaply. Wrappers still matter for JSON tooling and older APIs that expect them by name.

## Money as a decimal string

`shipping.type.v1.Money` is two `string` fields, `currency` and `amount`:

| Alternative | Failure |
|---|---|
| `double amount` | Binary floating point can't represent most base-10 fractions, so summed `weight_kg * rate` calculations drift by a cent |
| `int64 amount_cents` | Every caller has to know out of band that the integer means cents, not major units or micros; a client with the wrong assumption is off by two orders of magnitude and the parser says nothing |
| Decimal string | `"1250.00"` round-trips through JSON, logs and a database column exactly as written, with no unit to document |

The REST sibling of this contract makes the same call: its `Money` schema component is `{ currency: string, amount: string }`. A `Booking` crossing the REST-to-gRPC seam carries one `Money` through both notations without either side reinterpreting `amount`.

## The canonical proto3 to JSON mapping

Every well-known type and every ordinary field resolves to JSON through one fixed set of rules:

| Proto construct | JSON representation | Example |
|---|---|---|
| field name | lowerCamelCase | `un_locode` to `unLocode` |
| `google.protobuf.Timestamp` | RFC 3339 string | `"2026-02-01T10:00:00Z"` |
| `google.protobuf.Duration` | decimal seconds + `s` suffix | `"3.5s"` |
| `google.protobuf.FieldMask` | comma-joined path string | `"route.id,route.price"` |
| `enum` | the value's name, as a string | `"BOOKING_STATE_CONFIRMED"` |
| `int64`, `uint64`, `sint64`, `fixed64`, `sfixed64` | string | `"9223372036854775807"` |
| `bytes` | base64-encoded string | `"SGVsbG8="` |
| wrapper types (`Int32Value`, etc.) | the bare scalar, or `null` if unset | `0` vs. `null` |
| `google.protobuf.Struct` | the arbitrary JSON object it holds | `{"any": "shape"}` |
| `google.protobuf.Any` | `{"@type": "...", ...fields}` | n/a |

The first row looks cosmetic and isn't. `Location.un_locode` is `snake_case` in `types.proto` and `unLocode` in JSON, by specification and not by house style. 64-bit integers render as strings because JavaScript's `Number` is exact only up to 2^53: an `int64` id or a large counter silently loses precision the moment a browser's `JSON.parse` reads it as a number. proto3 JSON never emits a 64-bit integer as a JSON number.

{% include excalidraw.html file="04-wellknown-json-mapping" alt="A proto3 Leg message with carrier, departs_at, and arrives_at Timestamp fields, and a Money message with currency and amount string fields, each with an amber-highlighted arrow labeled 'proto3 JSON mapping' pointing to its camelCase JSON rendering (departsAt and arrivesAt as RFC 3339 strings, amount as a decimal string, not a number), with a third, dashed box showing that grpcurl's own printed output reverts to snake_case field names like departs_at even though the underlying wire and library JSON is camelCase." caption="Figure 4.2: One proto3 JSON mapping, read in both directions: library JSON renders camelCase; grpcurl's printed output does not." %}

### grpcurl prints snake_case

`grpcurl` accepts a request body in either lowerCamelCase or the declared snake_case names, but prints a response with each message's declared names, whichever casing the request used. Both directions are proto3 JSON. Library encoders and REST gateways emit camelCase; `grpcurl` renders the proto source's spelling. A request of `{"unLocode": "USNYC"}` and a printed `"un_locode": "USNYC"` are the same mapping read forwards and backwards.

### Defaults are omitted

A scalar left at its default (`0`, `""`, `false`) is omitted from proto3 JSON, never emitted as a literal zero. The binary format already treats a default-valued scalar as absent, so JSON doesn't invent a distinction the wire never drew. "Never set" and "set to zero" both render as a key that isn't there. `optional` scalars and the wrapper types restore the distinction: a wrapper set to zero is a present message and is emitted, an absent one serializes as `null`. Every JSON encoder has an opt-in to print default-valued scalars for callers that need the full field set. A `FieldMask` inherits the ambiguity: a path to a never-set scalar and a path to an explicitly zeroed one merge identically.

## Setting a Timestamp

Neither generator makes you build `seconds` and `nanos` by hand. Both ship a conversion from the language's own date-time type:

{% include codetabs.html langs="Quarkus|Python" %}

```java
    // com.google.protobuf.Timestamp ships inside protobuf-java itself (the
    // compiled well-known-type classes, not a separate dependency), the
    // same jar quarkus-grpc already pulls in to generate Leg/Money/Route.
    private static Timestamp toTimestamp(Instant instant) {
        return Timestamp.newBuilder()
                .setSeconds(instant.getEpochSecond())
                .setNanos(instant.getNano())
                .build();
    }
```

```python
def _to_timestamp(when: datetime) -> timestamp_pb2.Timestamp:
    # google.protobuf.timestamp_pb2 ships inside the `protobuf` package
    # itself (the compiled well-known-type module), no extra dependency
    # beyond the grpcio/protobuf pair this project already needs.
    ts = timestamp_pb2.Timestamp()
    ts.FromDatetime(when)
    return ts
```

`java.time.Instant` and Python's timezone-aware `datetime` both force a time zone decision that a bare `long millis` lets you forget. Pass an explicit UTC instant, never "now" read off a wall clock in a test, and both stacks produce the same `seconds` and `nanos`, and so the same RFC 3339 string.

## Choosing a representation

| Instead of | Use | Because |
|---|---|---|
| `int64` epoch | `Timestamp` | A seconds-versus-milliseconds mix-up lands a date decades off with no parse error and no non-`OK` status; `buf breaking` can't catch it either. A bad `Timestamp` is a JSON decode error |
| `repeated string` of field names | `FieldMask` | A path that doesn't exist on the target message is a validation error the server can reject before computing anything, and a new field on `Route` needs no change to the method |
| A bespoke "which fields" enum | `FieldMask` | The enum needs a new value, a new server branch and a release on both sides for every new field |

Write the scalar by hand only when no well-known type names the shape, as with `Money`.

> **🤖 Explore with your agent**
>
> "In examples/04-well-known-types, add a `Duration` field `transit_time` to the `Route` message in contracts/proto/shipping/type/v1/types.proto, populate it on both the Quarkus RouteBuilder.java and the Python route.py with 17 days, 20 hours, and then predict how `FindOptimalRoute` renders it in grpcurl output before you run it. Use a well-known type, not an int64."
>
> Check: `grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"}}' localhost:9007 shipping.routing.v1.RoutingService/FindOptimalRoute` prints `transit_time` as a decimal-seconds string ending in `s`, and port 9008 prints the same.

## Build, run, observe

```bash
cd examples/04-well-known-types
./verify.sh
```

`verify.sh` brings up both stacks (Quarkus on `9007`, Python on `9008`), calls `FindOptimalRoute` on each with `grpcurl`, and prints `PASS` only if both render the same carrier, the same RFC 3339 `departs_at` and `arrives_at`, and the same `price` strings. Both stacks return a fixed `Route` built from fixed instants, so the rendered strings are constants. To call it by hand, run `docker compose up --build`, then:

```bash
grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC"},
  "destination": {"unLocode": "NLRTM"}
}' localhost:9007 shipping.routing.v1.RoutingService/FindOptimalRoute
```

The request says `unLocode`; the response prints `un_locode`, and `departs_at` and `arrives_at` come back as RFC 3339 strings:

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

Port `9008` returns the identical response. `route.price.amount` is `"4200.00"`, a string, on both.

Experiments:

- Send `{"un_locode": "USNYC"}` instead of `{"unLocode": "USNYC"}`: `grpcurl` accepts both spellings.
- Call `GetQuote` on port `9007`: it returns `UNIMPLEMENTED`, because only `FindOptimalRoute` is implemented here.

## For deeper coverage

- Clément Jean, *gRPC Go for Professionals* (Packt): schema design choices like `Money`-as-decimal-string and when to reach for a well-known type over a bespoke field.
- [Protocol Buffers: JSON Mapping reference](https://protobuf.dev/programming-guides/json/): the canonical proto3-to-JSON table.
- [Protocol Buffers: Well-Known Types](https://protobuf.dev/reference/protobuf/google.protobuf/): the full `Timestamp`, `Duration`, `FieldMask`, `Any`, `Struct` and wrapper reference.
- Cloud Native Design Patterns, the *API Error Handling* appendix, where `google.rpc.Status.details` wraps an `Any`.
