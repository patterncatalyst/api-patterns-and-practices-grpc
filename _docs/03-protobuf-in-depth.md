---
title: "Protocol Buffers in depth"
order: 3
part: "Protocol Buffers: the Contract Language"
description: "The proto3 language in full: scalars, messages, enums, oneof, map, packages, options, field presence, and the tag-number math that turns a message into bytes."
duration: "24 min"
---

## Learning objectives

By the end of this chapter you can:

- Map every proto3 scalar type to its wire type (VARINT, I64, I32, LEN) and explain why `sint32` and `sint64` exist alongside `int32` and `int64`.
- Choose between `repeated`, `map<K, V>` and `oneof` for a field shape, and state the contract each enforces.
- Explain why a field's tag number, not its name, is Protobuf's wire-level contract, and why reusing a shipped tag number corrupts old data silently.
- Hand-decode a small message's wire bytes field by field with the key-byte formula `(field_number << 3) | wire_type`.
- State why proto3 has no `required` and how `optional` restores the field-presence information a bare scalar can't carry.

## Why this matters

Every type in the shipping domain (`Booking`, `Cargo`, `Money`, `Route`) is a `.proto` message in `contracts/proto/`, read once by `buf` and generated into both the Quarkus and Python stacks. The sibling REST course models the same nouns as JSON Schema components: two contract languages for the same domain, because the nouns don't change when the transport does. A JSON Schema can describe a number's range. It can't tell a parser which bits on the wire belong to that number. Protobuf's type system and its wire format are one document, and you need both.

## Scalars, messages and wire types

A `message` is a named set of fields, each with a type and a field number:

```proto
message Money {
  string currency = 1;  // ISO 4217, e.g. "USD"
  string amount = 2;    // decimal string, e.g. "1250.00"
}
```

The field number (`= 1`, `= 2`) is neither a default value nor an array index. It is the field's permanent identifier on the wire. Every scalar maps to one of four wire types:

| Wire type | Scalars | Encoding |
|---|---|---|
| VARINT (0) | `int32`, `int64`, `uint32`, `uint64`, `sint32`, `sint64`, `bool`, `enum` | Variable length: small values take one byte, growing a byte at a time |
| I64 (1) | `fixed64`, `sfixed64`, `double` | Always eight bytes; cheaper than VARINT for usually large values |
| LEN (2) | `string`, `bytes`, embedded messages, packed repeated fields | A length prefix, then exactly that many bytes, so a parser needs no delimiter scan |
| I32 (5) | `fixed32`, `sfixed32`, `float` | Always four bytes |

`sint32` and `sint64` aren't redundant. Plain `int32` VARINT-encodes a negative number as its unsigned 64-bit two's-complement value, always ten bytes. `sint32` and `sint64` apply ZigZag encoding first, mapping small-magnitude negatives to small unsigned values, so `-1` costs one byte instead of ten. Choose them when a field is often negative. They're not a safer default than `int32`.

## Nested messages and the enum zero value

A field's type can be another message. `Booking` embeds `Location` twice, a repeated `Cargo` and a `Money`, each defined once and reused:

```proto
message Booking {
  string id = 1;            // "bkg_" prefix, ULID-shaped
  Location origin = 2;
  Location destination = 3;
  repeated Cargo cargo = 4;
  BookingState state = 5;
  Money quote = 6;
  google.protobuf.Timestamp created_at = 7;
  map<string, string> labels = 8;
}
```

An `enum` is a closed set of named integer constants, and proto3 requires the value mapped to `0` to exist. By convention it is named `<ENUM_NAME>_UNSPECIFIED`. `BookingState`'s zero value is `BOOKING_STATE_UNSPECIFIED`, not `BOOKING_STATE_PENDING`, even though every real booking starts pending. Proto3 can't distinguish "never assigned" from "assigned zero", so whatever sits at `0` is what every unset field reads back as, including in messages built before the field existed. Naming it `UNSPECIFIED` keeps a missing value from being misread as meaningful. Enum constants carry the enum's name as a prefix (`BOOKING_STATE_CONFIRMED`, not `CONFIRMED`) because they share a namespace with their enclosing scope, and two enums in one file can't both declare a bare `CONFIRMED`.

## repeated, map and oneof

| Shape | Contract | On the wire |
|---|---|---|
| `repeated` | Zero or more, in order (`Booking.cargo`, `Route.legs`) | One LEN-prefixed entry per element, or one packed run for repeated scalars |
| `map<K, V>` | A dictionary in every generated language (`Booking.labels`), with no iteration order | A repeated message of implicit `{key, value}` entries, which is why a map can't itself be `repeated` |
| `oneof` | Of a named group, at most one is ever set; setting another clears the first | Nothing for an unset branch; the exclusivity is generated-code behavior (`WhichOneof()` in Python, a `case` enum in Java) over fields sharing one storage slot |

None of the shipping types needs a `oneof`, but the shape recurs: a `PaymentMethod` that is a credit card, a purchase order or an escrow reference, never two. A `oneof` enforces that in the type of every generated language instead of in a comment a caller will eventually violate.

{% include excalidraw.html file="03-field-shapes" alt="Three side-by-side panels contrasting the composite field shapes. Left, repeated: a Booking message with repeated Cargo cargo pointing to three ordered boxes, cargo[0] through cargo[2], chained left to right, with a note that order is part of the contract. Middle, map<K,V>: a Booking message with map<string,string> labels pointing with dashed sugar-over arrows to two {key,value} entry boxes positioned with no implied sequence, with a note that there is no guaranteed iteration order. Right, oneof: a PaymentMethod message with oneof method pointing to three member boxes, credit_card filled solid and labeled SET reached by a solid amber set arrow, purchase_order and escrow_ref both dashed and labeled cleared, with a note that setting purchase_order would clear credit_card because the exclusivity is a generated-code guarantee, not a convention." caption="Figure 3.1: Three composite field shapes. Repeated keeps order, map wraps unordered key and value pairs, and oneof clears every other member the moment one is set." %}

## Packages, imports and options

`package shipping.type.v1;` namespaces every message and enum in the file, so `shipping.type.v1.Location` never collides with another service's `Location`. The trailing `v1` is a convention, since Protobuf has no built-in package version. An incompatible `Location` gets a new package, `shipping.type.v2`, beside the old one, and callers compiled against `v1` keep working. `buf breaking` enforces that convention.

`import "shipping/type/v1/types.proto";` pulls another file's declarations into scope, resolved against the include path the compiler is given. `buf.yaml`'s `modules: - path: proto` lets `types.proto` and `routing.proto` resolve against each other without knowing each other's location. `routing.proto` imports `types.proto` for `Location`, `Cargo`, `Money` and `Route`, and `google/protobuf/field_mask.proto`, a **well-known type** shipped with every compiler.

`option` statements configure code generation without changing the wire format. A file-level `option java_package` or `option go_package` tells a generator where to emit. The `shipping.type.v1` files set none, because the generators derive a default from the proto package. A contract shared across teams with stricter layouts should pin them.

## proto3 defaults, presence and no `required`

An unset scalar reads back as its type's zero value (`0`, `""`, `false`), never `null`. That's the biggest semantic gap from a JSON Schema or ORM model, where "absent" and "present but zero" differ. In bare proto3 a `Cargo.weight_kg` of `0.0` is indistinguishable from one nobody set. Message-typed fields don't have the problem: an unset `Booking.quote` is a null pointer, not an empty `Money{}`.

The `optional` keyword, added in protoc 3.15, restores presence. `optional int32 progress_pct = 4;` generates a `HasProgressPct()` accessor that tells "set to 0" from "never touched". It is implemented as a synthetic single-field `oneof`, so it behaves like a declared `oneof` on the wire. It costs a `Has*()` check at every call site, and most fields don't need it: `Cargo.hazardous` unset and `Cargo.hazardous` false are the same fact to every consumer. Use `optional` when "was this ever set" is something the caller must act on.

Proto3 removed `required`. A `required` field made the whole message fail to parse when absent, so a server could never safely stop sending it and a client could never safely add one without breaking a fleet that hadn't upgraded. To make sure a field is populated, validate in your own code, not in a parser constraint that can never relax.

## Tag numbers are the contract

A key byte is `(field_number << 3) | wire_type`. A VARINT byte carries seven payload bits and the wire type takes three of them, so numbers 1 through 15 fit in one key byte and 16 needs two. Fields serialized on every call, such as the hot fields of `Booking` and `Cargo`, should take 1 through 15, a one-byte tax instead of two at `RoutingService` volume.

{% include excalidraw.html file="03-protobuf-anatomy" alt="A Money message with two string fields, currency (tag 1) and amount (tag 2), shown alongside its 14-byte serialized form: a 0x0A key byte decoding to field 1 wire type 2, a length byte, the UTF-8 bytes for USD, a 0x12 key byte decoding to field 2 wire type 2, a length byte, and the UTF-8 bytes for 1250.00, with a legend of the four wire types VARINT, I64, LEN, and I32." caption="Figure 3.2: A message's anatomy: fields and tag numbers on the left, the wire bytes they produce on the right." %}

A shipped field number is permanent in a way a field name is not. Renaming `Booking.id` to `Booking.bookingId` changes the generated accessor and nothing on the wire, since the string `"id"` never appears there. Reusing tag `1` for a different field after `Booking.id` has shipped is the failure case. Every message serialized under the old definition still carries a `1`-tagged LEN value, and a parser built against the new definition decodes it as whatever `1` means now, silently, with no error. The number is the contract and the name is documentation.

## Hand-decoding a message

Serializing `Money{currency: "USD", amount: "1250.00"}` produces exactly these 14 bytes:

```text
0A 03 55 53 44 12 07 31 32 35 30 2E 30 30
```

`0x0A` is binary `0000 1010`. The low three bits, `010`, are wire type 2 (LEN), and the rest is field number 1, `currency`. `0x03` is a VARINT length: three bytes follow, `55 53 44`, the UTF-8 for `"USD"`. `0x12` is `0001 0010`: LEN again, field number 2, `amount`. `0x07` announces seven bytes, `"1250.00"`. Two key-length-value runs, no bytes spent on field names.

The JSON form, `{"currency":"USD","amount":"1250.00"}`, is 37 bytes, more than twice as many, nearly all of it syntax and field-name text both ends already agree on.

## Why binary beats JSON

The gap compounds in three ways minifying JSON can't close:

- **Field identity** is a one- or two-byte integer instead of a quoted key, so a long descriptive name like `weight_kg` costs the same as `w`.
- **Numbers** use VARINT and fixed-width encodings instead of decimal ASCII, so small integers and booleans cost one byte.
- **Parsing** never tokenizes. A LEN prefix says how many bytes to consume and a VARINT's continuation bit says where an integer ends, so decoding is fixed-size reads, not a text scan with escape handling.

None of this is specific to gRPC; plain HTTP/1.1 keeps every advantage. HTTP/2 adds multiplexed, HPACK-compressed framing on top, and the two wins stack.

## Choosing oneof over separate fields

Run the choice through the decision axes. Shape and sync-or-stream are neutral, since a `oneof` serializes the same on a unary or streamed call. Failure class matters when the alternatives are outcomes a caller must branch on. A `RouteConstraint` that is a max transit time or a max cost is one choice with two shapes, and a `oneof` turns a missed case into a gap in a generated `switch` instead of a runtime bug when both fields arrive set. Concurrency matters when independent writers could otherwise race to populate what should be exclusive state, because a `oneof` makes "exactly one" a property of the data. Evolution cuts the other way. Adding a branch to an existing `oneof` is additive like any new field. Converting an existing plain field into a `oneof` member after it shipped is not safe, because an already-serialized message with that field set still parses as "field N present" and older code must agree on what that now means.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Use a <code>oneof</code> when fields are alternative shapes of one value, such as a payment method that is a card, a purchase order or an escrow reference, and the exclusivity is a domain fact. Keep plain fields when values are independent and can coexist, even if usually absent: <code>Booking.labels</code> is an open-ended set of key/value pairs, which is what a <code>map</code> is for. Default to plain fields when unsure. Converting independent fields into a <code>oneof</code> later is the safe direction. Converting a <code>oneof</code> back to independent fields after callers depend on its exclusivity is not.</p></div>

> **🤖 Explore with your agent**
>
> "Read contracts/proto/shipping/type/v1/types.proto. For every message, list any group of fields that are mutually exclusive and should become a oneof, every enum whose zero value is not *_UNSPECIFIED, and any frequently serialized field numbered above 15. Do not renumber or reuse any shipped tag; propose changes as new fields only, and add a Notification-style oneof example to examples/03-protobuf/oneof_demo.proto if you find a case."
>
> Check: run `buf build contracts` and `examples/03-protobuf/verify.sh`; both must still pass, and no existing field number may change in the diff.

## Build, run, observe

```bash
cd examples/03-protobuf
./verify.sh
```

There is no server, port or container. `verify.sh` runs `buf build` against `contracts/`, generates Python stubs for `shipping.type.v1` and a small standalone `oneof` demo proto (`Notification`) in a throwaway virtualenv, then runs `roundtrip.py`. That script hand-decodes `Money`'s 14 bytes with a 20-line VARINT reader using the key-byte arithmetic above, and round-trips a `Money`, a `Booking` (nested message, enum, map, repeated field, `Timestamp`) and the demo through `SerializeToString()` and `ParseFromString()`. A run ends with a `PASS:` line. `buf` comes from `PATH` if installed; otherwise `verify.sh` downloads a pinned release into `.bin/` on first run.

## For deeper coverage

- Clément Jean, *gRPC Go for Professionals* (Packt): Protobuf language, schema design, and the evolution concerns tag numbers exist to protect.
- [Protocol Buffers: Language Guide (proto3)](https://protobuf.dev/programming-guides/proto3/): the canonical scalar types, wire types and field-presence reference.
- [buf: breaking change detection](https://buf.build/docs/breaking/overview/): the check that enforces the tag-number contract.
- Cloud Native Design Patterns, the *Versioning & Evolution* appendix, for what counts as a breaking change in Protobuf alongside REST and GraphQL's own versioning stories.
