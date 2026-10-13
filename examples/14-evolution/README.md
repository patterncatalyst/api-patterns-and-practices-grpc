# Ch14 — Evolution & versioning: a seeded `buf breaking` drift test

A small, docker-free companion to Chapter 14. There is no service here, no
port, no compose stack — just `buf` and four small proto trees, proving the
chapter's claims about backward compatibility against a tool you can run
yourself:

- `baseline/` — a standalone, trimmed stand-in for
  `contracts/proto/shipping/routing/v1/routing.proto` (**not** the real
  contracts module — this example never touches or imports `contracts/`),
  representing the schema already shipped and running.
- `candidate-safe/` — three backward- and forward-compatible changes: a new
  field, a new RPC, and a defensive `reserved` on numbers and a name nothing
  has used yet.
- `candidate-breaking/` — the seeded-failure proof: two deleted fields and
  one changed field type, each independently caught.
- `v2-migration/` — the package-version escape hatch: a new
  `shipping.routing.v2` package that drops the same field
  `candidate-breaking/` got rejected for deleting, carrying `reserved`
  forward out of hygiene rather than necessity.
- `buf.yaml` — `lint: STANDARD`, `breaking: FILE`, the same two rule sets
  `contracts/buf.yaml` uses, so this example's gate behaves exactly like the
  real one.
- `verify.sh` — runs all four steps from a clean checkout: no pre-installed
  `buf` required (downloads a pinned release binary into `.bin/` the first
  time, same pattern as `examples/03-protobuf/verify.sh`), nothing left
  running afterward.

## Run it

```bash
cd examples/14-evolution
./verify.sh
```

Four steps, all read-only against the proto trees in this directory:

1. **`buf lint` + `buf build` on `baseline/`.** Proves the starting schema
   passes the `STANDARD` lint rules and compiles — the same two gates
   `contracts/buf.yaml` runs before `buf breaking` ever gets a turn.
2. **The safe candidate.** `buf breaking candidate-safe --against baseline`
   must exit `0`.
3. **The breaking candidate.** `buf breaking candidate-breaking --against
   baseline` must exit non-zero, and `verify.sh` greps the output for the
   three specific violations seeded into that candidate — not just "it
   failed" — so a change to `buf`'s own wording, or an unrelated failure,
   can't accidentally masquerade as the expected result.
4. **The v2 migration (bonus).** `buf breaking v2-migration --against
   baseline` must exit `0`, proving that a new package version is not
   merely *allowed* to drop a field — it's structurally invisible to this
   gate, because `buf breaking` only ever diffs files it finds at the same
   path on both sides.

Expect output ending in:

```text
PASS — buf breaking caught every seeded breaking change (deleted fields,
changed field type) in the breaking candidate, passed the safe candidate
(added field, added RPC, defensive reserved) clean, and confirmed that a
new package version sidesteps the same gate by construction.
```

## What the safe candidate actually changes

```protobuf
message GetQuoteRequest {
  reserved 10, 11;
  reserved "internal_only";

  string origin_un_locode = 1;
  string destination_un_locode = 2;
  double weight_kg = 3;
  string legacy_notes = 4;      // untouched
  int32 cargo_count = 5;        // new
}
```

Adding `cargo_count` at a fresh number and adding the `ListRoutes` RPC are
both unconditionally safe: no existing reader's interpretation of any
existing field or method changes. The `reserved 10, 11` and `reserved
"internal_only"` lines are a second kind of safe change — pre-blocking
numbers and a name nothing has used yet, so a future field can never land on
them by accident. `legacy_notes` (field 4) is left in place; see the next
section for why removing it here would fail.

## What the breaking candidate catches, and what it doesn't prove

```text
candidate-breaking/.../routing.proto: field "2" (destination_un_locode) was deleted.
candidate-breaking/.../routing.proto: field "4" (legacy_notes) was deleted.
candidate-breaking/.../routing.proto: field "3" (weight_kg) changed type from "double" to "int32".
```

The second line is the one worth sitting with. `legacy_notes` is dead
weight — nothing in this proto's story sets or reads it — and it still fails
the gate the moment it's deleted. **Marking a field `reserved` does not make
deleting it safe under this gate's `FILE` breaking category.** `reserved`
stops a *future* field from reusing a retired number or name; it does
nothing to permit the deletion itself. (Buf does ship a rule,
`FIELD_NO_DELETE_UNLESS_NAME_RESERVED` / `..._NUMBER_RESERVED`, that grants
exactly that exception — but it lives in the `WIRE_JSON` category, not
`FILE`, which is why `contracts/buf.yaml`'s choice of `FILE` matters: see the
chapter's "Decision" callout on why this book picks the stricter one.)

## What `v2-migration/` proves instead

```protobuf
// shipping/routing/v2/routing.proto
message GetQuoteRequest {
  reserved 4;
  reserved "legacy_notes";
  string origin_un_locode = 1;
  string destination_un_locode = 2;
  double weight_kg = 3;
  int32 cargo_count = 5;
}
```

This message drops field 4 — the exact deletion `candidate-breaking/` got
rejected for — and `buf breaking v2-migration --against baseline` still
exits `0`. Not because `buf` is more lenient about packages; because this
file lives at a different path (`shipping/routing/v2/routing.proto`, not
`v1`), and `buf breaking` only ever compares files it finds at a matching
path in both trees. There is nothing on the baseline side at the v2 path to
diff against, so there is nothing to call breaking. The `reserved` lines
carried into v2 are not required by the tool; they're there so a later v3
(or a second v2 revision) can't reuse field 4 for something a long-lived v1
client might still send.

## Why this lives outside `contracts/`

`contracts/buf.yaml` gates the real schema every stack in this book
generates from; a proto built to fail `buf breaking` has no business
anywhere near it. This example rebuilds just enough of that schema's shape, in its own
throwaway `buf.yaml`, to drive the same two `buf` commands the real CI job
runs — `buf lint` and `buf breaking` — without any risk of the seeded
breaking candidate ever reaching a module a real stack compiles against. The
on-demand script `scripts/ch14-demo-breaking.sh`, documented in the chapter,
is the complementary demo that *does* touch the real `contracts/` module —
on an ephemeral branch, never on `main`, deleted after the reader has
watched the real CI job go red.
