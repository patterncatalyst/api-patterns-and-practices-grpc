---
title: "Protocol Buffers in depth"
order: 3
part: "Protocol Buffers: the Contract Language"
description: "The proto3 language in full: scalars, messages, enums, oneof, map, packages, options, field presence, and the tag-number math that turns a message into bytes."
duration: "24 min"
---

Chapter 2 gave you a lens for classifying a call. This chapter gives you the language for describing the data that call carries. Every type this book's shipping domain uses — `Booking`, `Cargo`, `Money`, `Route` — is a `.proto` message, and every one lives in one place: `contracts/proto/`, read once by `buf` and generated into both the Quarkus and the Python stack. That arrangement is the gRPC analog of something the sibling REST site already leans on hard: the same `Booking` and `Money` shapes that site models as JSON Schema components, this site models as proto messages — two contract languages describing the same domain nouns, because the nouns don't change when the transport does. A JSON Schema can describe a number's range; it cannot tell a parser which bits on the wire belong to that number. Protobuf's type system and its wire format are the same document, and understanding both is what this chapter is for.

## Scalars, messages, and the wire types underneath them

A `message` in proto3 is a named, ordered set of fields, each with a type and a field number:

```proto
message Money {
  string currency = 1;  // ISO 4217, e.g. "USD"
  string amount = 2;    // decimal string, e.g. "1250.00"
}
```

That field number — the `= 1`, the `= 2` — is not a default value and not an array index. It is the field's permanent identifier on the wire, and this chapter keeps returning to why that matters. Every scalar type proto3 offers maps to one of four wire types, fixed by the language: `int32`, `int64`, `uint32`, `uint64`, `sint32`, `sint64`, `bool`, and `enum` encode as **VARINT** (wire type 0) — a variable-length integer where small values take one byte, growing a byte at a time as the value does. `fixed64`, `sfixed64`, and `double` encode as **I64** (wire type 1) — always eight bytes, cheaper than VARINT for values that are usually large. `fixed32`, `sfixed32`, and `float` encode as **I32** (wire type 5) — always four bytes. `string`, `bytes`, embedded messages, and packed repeated fields encode as **LEN** (wire type 2) — a length prefix followed by exactly that many bytes, so a parser knows where a variable-length value ends without scanning for a delimiter.

`sint32`/`sint64` look redundant with `int32`/`int64` and aren't. Plain `int32` VARINT-encodes a negative number as the equivalent unsigned 64-bit two's-complement value — always ten bytes, regardless of magnitude. `sint32`/`sint64` apply ZigZag encoding first, mapping small-magnitude negatives to small-magnitude unsigned values before VARINT-encoding, so `-1` costs one byte instead of ten — a deliberate trade for a specific access pattern, not a safer general-purpose default than `int32`.

## Nested messages and the enum zero-value rule

A message field's type can be another message, nested as deeply as needed. `Booking` embeds `Location` twice, a repeated `Cargo`, and a `Money` — each independently defined, reused instead of inlined:

```proto
message Booking {
  string id = 1;
  Location origin = 2;
  Location destination = 3;
  repeated Cargo cargo = 4;
  BookingState state = 5;
  Money quote = 6;
  google.protobuf.Timestamp created_at = 7;
  map<string, string> labels = 8;
}
```

`enum` is a closed, named set of integer constants, and proto3 enforces one rule with no proto2 equivalent: the value mapped to `0` must exist, and by strong convention is named `<ENUM_NAME>_UNSPECIFIED`. `BookingState`'s zero value is `BOOKING_STATE_UNSPECIFIED`, not `BOOKING_STATE_PENDING`, even though `PENDING` is the state every real booking starts in. The reason: proto3 doesn't distinguish "never assigned" from "explicitly assigned its zero value," so whatever sits at `0` is what every unset `BookingState` field reads back as, forever, including in messages built before that field existed. Naming that default `UNSPECIFIED` keeps a missing value from being silently misread as meaningful. Enum constants are conventionally prefixed with the enum's name (`BOOKING_STATE_CONFIRMED`, not bare `CONFIRMED`) because they share a single namespace with their enclosing scope — two enums in the same file can't both declare a bare `CONFIRMED` without colliding.

## oneof, map, and repeated: three field shapes with different contracts

`repeated` says "zero or more of this type, in order" — `Booking.cargo` and `Route.legs` are ordinary repeated fields, one LEN-prefixed entry per element, or a single packed run for repeated scalars. `map<K, V>` is sugar over a repeated message of implicit `{key, value}` entries; `Booking.labels` behaves like a dictionary in every generated language, but what's on the wire is a sequence of two-field submessages — worth knowing the day you need map ordering (there isn't any) or wonder why a map field can't itself be `repeated` (it already is, underneath).

`oneof` says something `repeated` and plain fields can't: of this named group, **at most one is ever set**, and setting a second clears whichever was set first. None of the shipping types need one, but the shape recurs — a `PaymentMethod` that's a credit card *or* a purchase order *or* an escrow reference, never two at once. A `oneof` enforces that exclusivity at the type level, in every generated language, instead of leaving it an unenforced comment a caller will eventually violate. On the wire, an unset branch contributes nothing — the same LEN/VARINT/I64/I32 encoding every other field uses; the exclusivity is a generated-code guarantee (`WhichOneof()` in Python, a `case` enum in Java) layered over fields sharing one storage slot.

## Packages, imports, and options

`package shipping.type.v1;` does two jobs. It namespaces every message and enum in the file, so `shipping.type.v1.Location` and some unrelated service's `Location` never collide, and the trailing `v1` is a versioning convention — protobuf has no built-in concept of a package version. An incompatible `Location` shape gets a new package, `shipping.type.v2`, beside the old one rather than replacing it (the convention `buf breaking` enforces, Chapter 14), so callers compiled against `v1` keep working untouched.

`import "shipping/type/v1/types.proto";` pulls another file's declarations into scope, resolved against an include path the compiler is given — `buf.yaml`'s `modules: - path: proto` lets `types.proto` and `routing.proto` resolve against each other without either knowing the other's filesystem location. `routing.proto` imports `types.proto` to reuse `Location`, `Cargo`, `Money`, and `Route`, and separately imports `google/protobuf/field_mask.proto` — a **well-known type** shipped with every protobuf compiler, covered in Chapter 4.

`option` statements configure code generation without changing the wire format — a file-level `option java_package` or `option go_package` tells each language's generator which package to emit into. None of `shipping.type.v1`'s files set one, since this book's generators derive a sensible default from the proto package name; a contract shared across teams with stricter layouts would typically pin them explicitly instead.

## proto3 semantics: defaults, presence, and no `required`

Every scalar field in proto3 has a type-defined zero value — `0` for numeric types, `""` for `string`, `false` for `bool` — and an unset field reads back as that zero value, never as `null` or an error. This is the biggest semantic difference from a typical JSON Schema or ORM model, where "absent" and "present but zero" are usually distinguishable; in bare proto3 they are not: a `Cargo.weight_kg` of `0.0` is indistinguishable from one nobody ever set. Message-typed fields don't have this problem — `Booking.quote` can be present or absent, because an unset message field is a null pointer, not an empty `Money{}` — but for singular scalars the ambiguity is real and by design.

The `optional` keyword, added in the 3.15 compiler release, closes that gap: `optional int32 progress_pct = 4;` generates a `HasProgressPct()` accessor that tells "explicitly set to 0" apart from "never touched," implemented as a synthetic single-field `oneof` — why `optional` and manually-declared `oneof` fields share the same explicit-presence behavior on the wire. It isn't free: it costs a `Has*()` check at every call site, and most fields don't need the distinction — `Cargo.hazardous` false because nobody set it, and explicitly declared non-hazardous, are the same fact to every consumer. Reach for `optional` when "was this ever set" is information the caller must act on, not as a blanket default.

proto3 has no `required` keyword — proto2 had one, and proto3 removed it permanently. A `required` field made an entire message fail to parse if that field was missing, so a server could never safely stop sending it, and an older client could never safely add one, without risking a parse failure in a fleet that hadn't upgraded. Chapter 14 covers evolution in depth; the short version is that proto3's answer to "make sure this field is populated" is validation in your own code, not a parser constraint that can never relax without breaking the systems it protects.

## Tag numbers: the real contract

Field numbers are typed as `int32`, but the usable range is far narrower, for wire efficiency. A key byte is computed as `(field_number << 3) | wire_type`. Numbers 1 through 15 fit that into a single VARINT byte; 16 needs a second byte, because `16 << 3 | wire_type` exceeds one byte's 7 usable bits. Fields reached for first in `Booking` or `Cargo` — serialized every call — should get tag numbers 1 through 15: a one-byte tax instead of a two-byte one, a real cost at `RoutingService`'s volume.

{% include excalidraw.html file="03-protobuf-anatomy" alt="A Money message with two string fields, currency (tag 1) and amount (tag 2), shown alongside its 14-byte serialized form: a 0x0A key byte decoding to field 1 wire type 2, a length byte, the UTF-8 bytes for USD, a 0x12 key byte decoding to field 2 wire type 2, a length byte, and the UTF-8 bytes for 1250.00, with a legend of the four wire types VARINT, I64, LEN, and I32." caption="Figure 3.1 — A message's anatomy: fields and tag numbers on the left, the wire bytes they produce on the right." %}

This is also why a field number, once shipped, is permanent in a way a field *name* never has to be. Renaming `Booking.id` to `Booking.bookingId` changes nothing over the wire — the generated accessor name changes, the bytes do not, since the wire format never encodes the string `"id"` anywhere. Reusing tag `1` for a different field after `Booking.id` has shipped is a different story: every message serialized under the old definition still has a `1`-tagged LEN value in its bytes, and a parser built against the new definition decodes those old bytes as whatever `1` means now, silently, with no error. The field number is the contract; the field name is documentation for humans. Chapter 14 builds an evolution discipline on exactly this distinction.

## Hand-decoding a message's bytes

The clearest way to see tag-number math stop being abstract is to decode a real message by hand. Serializing `Money{currency: "USD", amount: "1250.00"}` produces this exact 14-byte sequence:

```text
0A 03 55 53 44 12 07 31 32 35 30 2E 30 30
```

Reading it left to right: `0x0A` is the first key byte. Split it with the inverse of the formula above — binary `0000 1010`; the low three bits, `010`, are wire type `2` (LEN); the remaining bits are `1` — field number 1, `currency`, wire type LEN. The next byte, `0x03`, is a VARINT length: three bytes follow, `55 53 44`, the UTF-8 encoding of `"USD"`. That's the whole first field: key, length, value. `0x12` is binary `0001 0010` — wire type LEN again, field number 2, `amount`; `0x07` says seven bytes follow, decoding to `"1250.00"`. Two fields, two key-length-value runs, zero bytes spent on field names — only field numbers, wire types, and values.

Notice what's absent: no `{`, no `}`, no `"currency":`, no `,`. A JSON encoding of the same value — `{"currency":"USD","amount":"1250.00"}` — runs 38 bytes, nearly three times as many, and every extra byte is syntax and field-name text both ends already agree on. `roundtrip.py` in this chapter's example performs exactly this decode in code — a 20-line VARINT reader that walks these same bytes and asserts the values it finds match what went in — so this paragraph's arithmetic and the generated Python stub agree on the same fourteen bytes.

## Why binary beats JSON on the wire

The size difference in the `Money` example generalizes, and compounds in three ways JSON-over-HTTP can't close by minifying whitespace. Field identity is a 1-to-2-byte integer tag instead of a quoted string key, so a field's name costs nothing proportional to how descriptive it is — `weight_kg` and `w` would serialize identically, since the name never appears in the bytes. Numeric values use VARINT and fixed-width binary encodings instead of decimal ASCII text, so small integers and booleans cost one byte instead of several characters of digits and separators. And a protobuf parser never tokenizes: no scanning for the next `"`, `:`, `,`, or `}`, no escape handling, no distinguishing a number from a string by inspecting characters. A LEN-prefixed field tells the parser exactly how many bytes to consume, and a VARINT's continuation bit tells it exactly when the integer ends — decoding is fixed-size reads driven by lengths the format carries, not a text scan.

None of this is specific to gRPC — plain HTTP/1.1 keeps every advantage above. Chapter 6 adds what happens when this already-compact format rides HTTP/2's multiplexed, HPACK-compressed framing instead of a verbose text header block per call: the per-message win here and the per-connection win there stack, and measuring that total is where "gRPC is fast" stops being a slogan and becomes a number you can reproduce.

## Choosing oneof over separate fields

Run this question through the five-axis decision framework from Chapter 2. RPC shape and the sync-call-vs-stream axis are usually neutral — a `oneof` serializes the same way on a unary or streamed call — but the other three aren't. Failure class and retryability matter when the alternatives represent different outcomes a caller must branch on: a `RouteConstraint` that's a max-transit-time *or* a max-cost isn't two knobs a caller might forget to check both of, it's one choice with two shapes, and a `oneof` makes a missed case a compile-time gap in a generated `switch` instead of a runtime bug found when both fields are set and the service has to guess which wins. Concurrency model matters when independent writers might otherwise race to populate what should be mutually exclusive state — a `oneof` makes "exactly one of these" a property of the data, not a convention two services must remember. Evolution pressure, the axis Chapter 14 returns to, cuts the other way: adding a branch to an existing `oneof` is safe and additive like adding any new field, but converting an existing plain field into a `oneof` member after it's shipped is not, because an already-serialized message with that field set still parses as "field N present," and older code needs to agree on what that now means.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Reach for a `oneof` when a message's fields represent alternative shapes of the same conceptual value — a payment method that's a card, a purchase order, or an escrow reference, never more than one at a time for a given booking — and the exclusivity is a fact about the domain, not a convention you're hoping callers remember. Keep separate plain fields when values are independent and can coexist freely, even if several of them are usually absent at once: `Booking.labels` holds an open-ended, co-occurring set of key/value pairs, which is exactly what a `map` is for and exactly what a `oneof` is not. Default to plain fields when you're unsure; converting independent fields into a `oneof` later is the safe direction, while converting a `oneof` back out to independent fields after callers depend on its exclusivity is not.</p></div>

## Running the example

```bash
cd examples/03-protobuf
./verify.sh
```

`verify.sh` runs `buf build` against `contracts/`, generates Python stubs for `shipping.type.v1` plus a tiny standalone `oneof` demo proto, then round-trips a `Money`, a `Booking`, and the demo — asserting the hand-decoded `Money` bytes match the tag-number math above. No server, no port, no container; see the example's `README.md` for the full walkthrough.

## Where this goes next

Chapter 4 picks up the well-known types named only in passing here — `Timestamp`, `Duration`, `FieldMask`, `Struct`, the wrapper types — and the proto3-to-JSON mapping that lets `Booking.created_at` render as an RFC 3339 string at the REST↔gRPC seam without either side hand-rolling a converter. Chapter 14 returns to tag numbers as an evolution problem: which changes `buf breaking` passes, which silently corrupt old data, and why the field-number contract introduced here is what that gate enforces.

<div class="callout"><p class="callout__title">On the wire</p><p>Run <code>examples/03-protobuf/verify.sh</code> yourself before moving on. It does three things worth watching: <code>buf build</code> compiles the real <code>contracts/</code> module from scratch, proving the proto you just read about actually parses as one coherent Buf module; <code>python -m grpc_tools.protoc</code> generates fresh Python stubs for <code>shipping.type.v1</code> into a throwaway virtualenv, proving the generated code and the hand-written proto agree; and <code>roundtrip.py</code> hand-decodes a serialized <code>Money</code>'s 14 bytes field-by-field with a 20-line VARINT reader, checking <code>byte 0 == 0x0A</code> and <code>byte 5 == 0x12</code> against the exact tag-number arithmetic worked through above, before parsing the bytes back with the generated stub and asserting every field — including a nested message, an enum, a map, a repeated field, and a well-known <code>Timestamp</code> — survived the trip.</p></div>
