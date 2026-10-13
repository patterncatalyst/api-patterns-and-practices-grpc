# Ch6 — HTTP/2 foundation: measuring protobuf against proto3 JSON

A small, docker-free companion to Chapter 6. There is no service here, no
port, no compose stack, no packet capture — observing HTTP/2 framing on the
wire needs a running connection, which this example doesn't stand up.
Instead it measures the half of "gRPC is fast" that's deterministic without
one: the payload size protobuf puts on a stream against the proto3 JSON
equivalent of the same message, plus a hand-decode that ties the result back
to Chapter 3's tag-number math.

- `measure.py` — builds a real `shipping.routing.v1.GetQuoteResponse` (the
  `RoutingService.GetQuote` reply this site has used as its anchor example
  since Chapter 2: a `Money` quote and a `Route` with one `Leg`), serializes
  it with `SerializeToString()` and with
  `google.protobuf.json_format.MessageToJson()`, and asserts the protobuf
  form is strictly smaller. It then hand-decodes the first bytes of the
  protobuf form field by field.
- `verify.sh` — runs the whole thing from a clean checkout: no
  pre-installed `buf`, no pre-installed Python packages, no server left
  running afterward.

## Run it

```bash
cd examples/06-http2-foundation
./verify.sh
```

Three steps, all torn down automatically when the script exits:

1. **`buf build` on `contracts/`.** The same check Chapter 3's and
   Chapter 5's examples run — proves the real shipping contracts still
   compile as one Buf module. `buf` is used from `PATH` if already
   installed; otherwise `verify.sh` downloads a pinned release binary into
   `.bin/` the first time it runs.
2. **Generate Python stubs.** A throwaway virtualenv under a temp directory
   installs `grpcio-tools` and `protobuf`, then runs
   `python -m grpc_tools.protoc` against `shipping/type/v1/types.proto` and
   `shipping/routing/v1/routing.proto` — the real contract, not a
   standalone demo proto.
3. **Measure and decode.** `measure.py` builds the message, serializes it
   two ways, asserts protobuf is smaller, prints both sizes and the ratio,
   then hand-decodes the protobuf bytes.

Expect output ending in something close to:

```text
protobuf bytes : 122
proto3 JSON bytes: 363
ratio (JSON / protobuf): 2.98x
...
PASS — protobuf (122B) beat proto3 JSON (363B) by 2.98x on the same
GetQuoteResponse, and the tag-number math from Chapter 3 decoded the real
bytes at every level: the outer message's quote field, Money's own currency
field one level down, and the route field immediately after it.
```

The exact byte counts are deterministic for a given `protobuf` version —
expect them to hold across runs and across machines, not to shift with
proto field order or timing the way a packet-capture measurement would.

## What it's actually proving

A `GetQuoteResponse` carrying one `Money` and one `Route` with one `Leg`
serializes to a fixed number of protobuf bytes every time, because the wire
format is a deterministic function of field number, wire type, and value.
The same message run through `json_format.MessageToJson()` carries every
field's name as a quoted string key, decimal ASCII text for the embedded
timestamps, and the JSON punctuation — braces, colons, commas — that
protobuf's LEN-prefixed, tag-keyed encoding never needs. That's the entire
gap: not a different set of fields, the same fields, encoded two ways.

The hand-decode reuses the exact tag-number math Chapter 3 worked through on
a standalone `Money`. `GetQuoteResponse.quote` is field 1, a message, so its
key byte is `(1 << 3) | 2 = 0x0A` — the same arithmetic, one level higher in
the message. Immediately inside that embedded `Money`, its own field 1
(`currency`) produces the identical `0x0A` key, because a key byte encodes a
field number and a wire type, never how deep the field sits. The byte
immediately after the embedded `Money` ends belongs to `GetQuoteResponse`'s
field 2 (`route`): `(2 << 3) | 2 = 0x12`. Three asserted bytes, each tied to
the same formula, confirm nesting doesn't change the rule Chapter 3 already
established — it just applies it more than once in the same message.

## Why no HTTP/2 connection or packet capture

This example stays consistent with the rest of the site's docker-free
examples: no server, no port, no compose stack. Showing HTTP/2's
multiplexing and HPACK compression on an actual wire would need two
processes holding a real connection open and a capture tool reading its
frames — a different kind of example than this site's chapter companions
run. What's measurable without any of that infrastructure, and what stays
identical on every machine and every run, is the payload one message
produces under each encoding. That's the number this example asserts.
