# Ch3 — Protobuf in depth: a hand-decode and round-trip, no server required

A small, docker-free companion to Chapter 3. There is no service here, no
port, no compose stack — just the proto compiler and the Python protobuf
runtime, proving the chapter's claims against bytes you can inspect yourself:

- `oneof_demo.proto` — a tiny standalone proto (not part of the contract
  under `contracts/`) with one message: `Notification`, whose three fields
  live inside a `oneof`.
- `roundtrip.py` — builds `shipping.type.v1.Money` and
  `shipping.type.v1.Booking` (the real shipping contract from
  `contracts/proto/shipping/type/v1/types.proto`), plus `Notification`,
  serializes each to bytes, and asserts every field survives
  `SerializeToString()` → `ParseFromString()`. It also hand-decodes `Money`'s
  bytes field-by-field with the same tag-number math the chapter's
  "Hand-decoding a message's bytes" section walks through on paper.
- `verify.sh` — runs the whole thing from a clean checkout: no pre-installed
  `buf`, no pre-installed Python packages, no server left running afterward.

## Run it

```bash
cd examples/03-protobuf
./verify.sh
```

Three steps, all torn down automatically when the script exits:

1. **`buf build` on `contracts/`.** Proves the real shipping contracts
   compile as one Buf module — the same module Chapter 5 onward generates
   stubs from and serves. `buf` is used from `PATH` if already installed
   (`~/.local/bin/buf` on this machine); otherwise `verify.sh` downloads a
   pinned release binary into `.bin/` the first time it runs.
2. **Generate Python stubs.** A throwaway virtualenv under a temp directory
   installs `grpcio-tools` and `protobuf`, then runs
   `python -m grpc_tools.protoc` against `shipping/type/v1/types.proto` (the
   contract) and `oneof_demo.proto` (this example's own file). Nothing is
   installed or written outside the temp directory and `.bin/`.
3. **Round-trip and assert.** `roundtrip.py` builds the messages, serializes,
   hand-decodes `Money`'s bytes, parses back, and checks every field —
   printing one `ok —` line per assertion and a final `PASS`.

Expect output ending in:

```text
PASS — buf build succeeded, Python stubs generated from shipping.type.v1
(the real contract) plus the oneof demo, and every round-tripped message
survived serialize -> parse with every field intact.
```

## What it's actually proving

`Money { currency = "USD"; amount = "1250.00" }` always serializes to the
same 14 bytes, because proto3's wire format is a deterministic function of
field number, wire type, and value — not a format version, not a struct
layout. `roundtrip.py` asserts the exact key bytes:

```text
byte 0: 0x0A  =  (1 << 3) | 2   → field 1 (currency), wire type 2 (LEN)
byte 5: 0x12  =  (2 << 3) | 2   → field 2 (amount),   wire type 2 (LEN)
```

then walks the rest of the bytes with a 20-line varint reader and confirms
the decoded strings match what went in — the same exercise Chapter 3's prose
performs by hand on paper, run here against the real generated code.

`Booking` exercises the constructs the chapter spends the most time on: a
nested message (`origin`/`destination` are `Location`), an `enum`
(`BookingState`, including the zero-value `*_UNSPECIFIED` check on an unset
message), a `map<string, string>` (`labels`), a `repeated` field (`cargo`),
and a well-known type pulled in from another `.proto` (`created_at` is a
`google.protobuf.Timestamp`). `Notification` (in `oneof_demo.proto`) proves
the one construct the real shipping contract doesn't currently need:
`WhichOneof("channel")` reports whichever single branch is set, and setting
a second branch silently clears the first — on the wire as well as in
memory.

## Why a separate `oneof_demo.proto`

None of `contracts/proto/shipping/type/v1/types.proto`'s messages use
`oneof` today, and this example doesn't modify the committed contract to
manufacture one. `oneof_demo.proto` is a standalone, three-line teaching
proto that lives only in this example directory; `buf build` in Step 1 never
looks at it; `verify.sh`'s own `protoc` invocation in Step 2 is the only
thing that compiles it.
