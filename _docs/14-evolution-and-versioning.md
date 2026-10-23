---
title: "Evolution and versioning"
order: 14
part: "Schema Evolution & the Living Contract"
description: "Field numbers as the contract, reserved, backward/forward compatibility, package versioning from shipping.routing.v1 to v2, the buf breaking gate with a deliberate-drift test, and the Buf Schema Registry."
duration: "24 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why a field's number, not its name, is the part of a protobuf contract that can never move once a message ships.
- Classify a schema change as safe (add a field or RPC, widen a numeric type, rename) or breaking (renumber, reuse a number, retype, remove a field a reader needs).
- State precisely what `reserved` does and does not buy: it blocks reuse of a retired number, it does not make the deletion itself safe.
- Decide when an additive change is enough and when a change needs a new package version (`v1` to `v2`) instead.
- Read a `buf breaking` failure and explain why `FILE`'s `FIELD_NO_DELETE` rejects a deletion even when the field was `reserved` first.

## Why this matters

`shipping.routing.v1.GetQuoteRequest` has shipped. Chapter 5 built it, Chapter 10 put a deadline on calling it, Chapter 11 taught it to fail with a code a client can act on. None of that matters if the next change to `routing.proto` quietly changes what field 3 means to a client compiled against last week's version of the file. gRPC's wire format doesn't carry field names; it carries field numbers, and a message that's valid Protobuf only means one thing if every reader and every writer agrees on what those numbers stand for. This chapter is about keeping that agreement intact as the schema moves: what changes a field number tolerates, what `reserved` actually buys you, when a package needs a new major version instead of a new field, and the `buf breaking` gate that turns all of this from a code-review discipline into a command that exits non-zero when someone gets it wrong.

## Field numbers are the contract

A Protobuf message on the wire is a sequence of `(field number, wire type, value)` tuples, nothing else. `shipping.type.v1.Money { currency = "USD"; amount = "1250.00" }` serializes to bytes that encode "field 1, length-delimited, these 3 bytes" followed by "field 2, length-delimited, these 7 bytes." The field *names* `currency` and `amount` exist only in the `.proto` source and the generated code; they never touch the wire. A reader with a different generated class, built from a different `.proto` revision, decodes those same bytes by field number alone: that's what makes `GetQuote`'s identical behavior on Quarkus and Python possible in the first place, and exactly what a careless schema edit can break.

This is why renaming a field is always safe and changing its number almost never is. `string origin_un_locode = 1;` renamed to `string origin = 1;` changes nothing on the wire: byte 0 is still "field 1, LEN," and every existing client's generated code already binds field 1 to whatever local name it compiled with. Renumbering the same field from `1` to `6` is different: an old binary still emits field 1, a new binary now expects field 6, and the two stop understanding each other the moment both run in production at once, which, during any rolling deploy, they do. The field number is the part of the contract that can never move once a message has shipped; the name is a detail for the humans reading the source.

Three changes are safe by construction, because none of them alter what an existing reader already does with an existing number:

- **Adding a new field** at an unused number. An old reader built before the field existed never looks for it and drops the bytes on the floor: proto3 skips unknown fields instead of rejecting the message, which is the property every safe change below leans on.
- **Adding a new RPC** to a service. A client generated from the old `.proto` has no stub method for it and never calls it; a server that hasn't implemented it yet returns `UNIMPLEMENTED`, which Chapter 5 already relies on for `RoutingService`'s four not-yet-built methods.
- **Widening certain numeric types** proto3 treats as wire-compatible: `int32` to `int64`, for instance, both encode as the `varint` wire type, so an old reader decoding a value a new writer sent as the wider type still gets the right number back, as long as it fits.

Three changes are breaking, because each one makes an old reader misinterpret bytes a new writer sends, or a new reader misinterpret bytes an old writer already sent:

- **Reusing a field number** for a different field. The new field's bytes land exactly where the old field's reader expects the old field's type, and nothing in the wire format tells it otherwise; it just produces a wrong answer, silently.
- **Changing a field's type** to something with a different wire type, such as `double` to `string`, or even to a same-wire-type value whose meaning differs, such as `double weight_kg` becoming `double weight_lb` at the same number.
- **Removing a field a reader still depends on.** The bytes simply stop arriving; a reader that doesn't handle absence as a real case (treating a missing optional as "zero" rather than "unset," for example) draws a wrong conclusion from silence.

The two lists line up column for column: renaming a field is safe because the number never moves, renumbering it is breaking for the same reason in reverse.

{% include excalidraw.html file="14-evolution-compatibility" alt="A matrix of schema changes under buf breaking's FILE category. Safe row: rename a field (origin_un_locode to origin, number 1 unchanged), add a field (cargo_count at an unused number), add an RPC (ListRoutes, an old stub never calls it), widen a numeric type (int32 to int64, same varint wire type). Breaking row, aligned under it: renumber a field (field 1 to field 6, an old binary still sends field 1), reuse a number (a new field lands on an old number and is read as the wrong type), change a field's type (double to string, a different wire type), remove a field a reader needs (bytes stop arriving). A dashed line connects rename to renumber, calling out that the field number, not the name, is what can never move once a message has shipped." caption="Figure 14.1: safe changes leave every existing field number's meaning untouched; breaking changes move, reuse, retype, or remove one a reader still depends on." %}

## `reserved`: what it actually buys you

Protobuf's `reserved` keyword blocks the compiler from accepting a field declaration that reuses a given number or name:

```protobuf
message GetQuoteRequest {
  reserved 4;
  reserved "legacy_notes";

  string origin_un_locode = 1;
  string destination_un_locode = 2;
  double weight_kg = 3;
}
```

This is easy to overstate. `reserved` does not make deleting a field safe: a field that mattered to any reader still goes missing the moment it's removed, `reserved` or not. What it prevents is a second, unrelated mistake: a future engineer, with no memory of what field 4 used to mean, adds a new field and lets the compiler hand them the first free number, which happens to be 4. Without the reservation that compiles cleanly, and any service still running the pre-removal binary (plausible for a rolling deploy, or an old client nobody's redeployed in a year) decodes the new field's bytes as the old field's type. `reserved` turns that into a compile error instead of a production incident, a real and durable benefit. It just isn't the benefit of "now this deletion is safe," because the deletion itself already broke anyone who still read it.

`examples/14-evolution/candidate-breaking/` proves the distinction directly: it deletes `legacy_notes` (field 4), and `buf breaking` rejects the deletion whether or not the field is marked `reserved` on the way out. "The `buf breaking` gate" below walks through why, and what the real escape hatch looks like.

## Backward and forward compatibility, named precisely

**Backward compatibility** is the property a *new* reader needs: it correctly interprets a message a client built against the *old* schema sends. **Forward compatibility** is the opposite direction: an *old* reader correctly interprets a message built against the *new* schema, typically by ignoring fields it doesn't recognize rather than rejecting the message outright. A rolling deploy of `RoutingServiceImpl` needs both at once, since old and new binaries serve traffic side by side for the length of the rollout: an old server must tolerate a new client's extra field (forward compatibility), and a new server must keep making sense of an old client's message missing a field the new schema added (backward compatibility). Proto3's "unknown fields are skipped, absent fields read as the zero value" design is what makes both directions hold simultaneously for every *safe* change above, and why the three breaking changes collapse one direction or the other.

## Package versioning: `shipping.routing.v1` to `v2`

Every safe change named so far is additive: new field, new RPC, wider type. Eventually a schema needs a change that isn't additive at all: `weight_kg` really should have been `weight_grams`, or `GetQuoteRequest` needs a shape no amount of careful addition can produce. That's what a new package version is for. `shipping.routing.v1` becomes `shipping.routing.v2` as a new `package` statement in a new file at a new path, `shipping/routing/v2/routing.proto` beside the untouched `v1/routing.proto`, not an edit to the v1 file in place. The two packages coexist on disk and at runtime: `RoutingServiceImpl` for v1 keeps serving `shipping.routing.v1.RoutingService` exactly as before, while a second implementation serves `shipping.routing.v2.RoutingService`, and existing v1 clients never notice v2 exists until someone migrates them, on their own schedule.

This is the second, more durable use for `reserved`: when v2 drops a field v1 carried (`legacy_notes`, say), carrying `reserved 4; reserved "legacy_notes";` forward into the v2 message costs nothing and buys the same protection v1 would have wanted. No tool requires it; it's the same discipline applied one version later, so a v3 can't reuse the number for something a long-lived v1-era payload might still carry through code that doesn't distinguish the packages carefully.

{% include excalidraw.html file="14-package-versioning-v2" alt="shipping.routing.v1 and shipping.routing.v2 coexisting during a rolling deploy. RoutingServiceImpl v1 keeps serving old clients still generated from the v1 package; a second RoutingServiceImpl v2, in a new file at shipping/routing/v2/routing.proto, serves new clients that have migrated. The v2 message reserves field 4 and the name legacy_notes, the same field v1 still carries, so a future v3 cannot reuse it. A dashed boundary around buf breaking shows the v1-against-baseline diff never crossing into the v2 file, because the two packages live at different paths and the tool only ever compares files at a matching path." caption="Figure 14.2: v1 and v2 coexist on disk and at runtime; old clients keep talking to v1 while new clients move to v2, and the new package path is invisible to buf breaking by construction." %}

## The `buf breaking` gate

Chapter 5 introduced `contracts/buf.yaml`'s three gates without spelling out what `buf breaking` actually enforces:

```yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD
breaking:
  use:
    - FILE
```

`breaking: use: [FILE]` picks one of several rule categories Buf ships, and the choice matters more than it looks. `FILE` means no field, message, enum, or RPC may ever be deleted from a file: reserving the field first changes nothing, because `FILE`'s `FIELD_NO_DELETE` rule doesn't check for a reservation before firing. Buf does ship a more permissive rule, `FIELD_NO_DELETE_UNLESS_NUMBER_RESERVED`, granting exactly the exception a reader might expect `reserved` to earn, but it lives in the `WIRE_JSON` category, not `FILE`. This book's contract chooses `FILE`, the stricter of the two: this gate never lets a field quietly disappear from an existing package. The only way to retire a field here is a new package, a new file, a new path `buf breaking` has nothing on the old side to compare against.

`examples/14-evolution/` proves all three outcomes with real `buf` output, against a standalone schema that never touches `contracts/`:

```protobuf
// candidate-safe/shipping/routing/v1/routing.proto
message GetQuoteRequest {
  reserved 10, 11;
  reserved "internal_only";

  string origin_un_locode = 1;
  string destination_un_locode = 2;
  double weight_kg = 3;
  string legacy_notes = 4;
  int32 cargo_count = 5;       // new field, unused number
}
```

```protobuf
// candidate-breaking/shipping/routing/v1/routing.proto
message GetQuoteRequest {
  string origin_un_locode = 1;
  int32 weight_kg = 3;         // destination_un_locode (2) and
}                               // legacy_notes (4) are simply gone;
                                // weight_kg changed double -> int32
```

`verify.sh` runs `buf breaking <candidate> --against baseline` against each, plus a fourth, `candidate-breaking-reserved/`, that reserves the same field it deletes, and a fifth, `v2-migration/`, that drops the same field inside a new `shipping.routing.v2` package:

```text
=== Step 2: SAFE candidate (add field, add RPC, defensive reserved) ===
ok — buf breaking candidate-safe --against baseline: exit 0 (no breaking changes)

=== Step 3: BREAKING candidate (delete fields, change a field's type) ===
ok — buf breaking candidate-breaking --against baseline: exit 100 (breaking changes found)
candidate-breaking/shipping/routing/v1/routing.proto:13:1:Previously present field "2" with name "destination_un_locode" on message "GetQuoteRequest" was deleted.
candidate-breaking/shipping/routing/v1/routing.proto:13:1:Previously present field "4" with name "legacy_notes" on message "GetQuoteRequest" was deleted.
candidate-breaking/shipping/routing/v1/routing.proto:15:3:Field "3" with name "weight_kg" on message "GetQuoteRequest" changed type from "double" to "int32".

=== Step 4: BREAKING-AND-RESERVED candidate (delete a field, reserve its number anyway) ===
ok — buf breaking candidate-breaking-reserved --against baseline: exit 100 (reserved field 4 still can't be deleted)
candidate-breaking-reserved/shipping/routing/v1/routing.proto:14:1:Previously present field "4" with name "legacy_notes" on message "GetQuoteRequest" was deleted.

=== Step 5: v2-migration (new package carries the retired field as reserved) ===
ok — buf breaking v2-migration --against baseline: exit 0 (shipping.routing.v2 is a new file; v1 is untouched)
```

Each line names the field, the message, and the exact violation, which is what turns a CI failure into something a reviewer can act on without re-deriving the diff by hand. The safe candidate's `reserved 10, 11` block passes because nothing on the baseline side ever used those numbers; the breaking candidate's deletions fail regardless of whether they'd been reserved first, and `candidate-breaking-reserved/` makes that claim self-demonstrating rather than asserted: it deletes `legacy_notes` *and* marks field 4 and its name `reserved` on the way out, and `buf breaking` reports the identical `FIELD_NO_DELETE`-style violation anyway, for the reason the `reserved` section above already gave. The v2 package's drop of field 4 passes for a different reason: `buf breaking` only ever diffs a file against the file at the *same path* on the other side, and `shipping/routing/v2/routing.proto` has no counterpart in `baseline/`. See `examples/14-evolution/README.md` for the full walkthrough.

{% include excalidraw.html file="14-buf-breaking-gate" alt="The buf breaking gate as verify.sh runs it: a safe candidate compared against baseline exits 0 and the candidate merges; a breaking candidate compared against the same baseline exits 100, naming destination_un_locode deleted and weight_kg retyped from double to int32; a third comparison shows the same deletion with the field marked reserved still exits 100, proving reservation does not excuse a deletion under the FILE breaking category." caption="Figure 14.3: the buf breaking gate: baseline compared against each candidate, safe passes at exit 0, breaking (reserved or not) fails at exit 100 naming the violation." %}

This example lives entirely outside `contracts/`: a proto built to fail `buf breaking` has no business near the module every stack in this book compiles against. To see the real consequence (the real `contracts.yml` CI job turning red against the real `shipping.routing.v1.routing.proto`), run the on-demand script `scripts/ch14-demo-breaking.sh`. It forks a throwaway branch off the current `main`, renumbers a real field in `routing.proto`, pushes the branch, and lets the reader watch the real `buf breaking --against main` job fail in GitHub Actions, on a contract that was never actually merged. The branch stays red: it exists to be watched failing, not to be fixed or merged, and `--cleanup` deletes both the local and the remote copy once the point has been made:

```bash
scripts/ch14-demo-breaking.sh              # fork, seed the break, push
scripts/ch14-demo-breaking.sh --cleanup    # delete the local and remote demo branch
```

The script refuses to run against a dirty working tree, re-derives the branch from `main` on every run so it can never go stale, and never checks out or merges anything into `main` itself; it only ever pushes a disposable sibling branch for CI to evaluate.

## The Buf Schema Registry: remote packages and generated SDKs

Every stack in this book so far generates its stubs from a local copy of `contracts/proto/`, fetched at build time by each `Containerfile`'s own `COPY`. That works well inside one repository with a handful of consuming services, because every consumer already has filesystem access to the same `contracts/` checkout. It stops working as cleanly once a schema has consumers outside that repository (a partner team, a different organization, a client SDK shipped to external developers), none of whom should clone this repository just to get `shipping.routing.v1`'s generated types.

The **Buf Schema Registry (BSR)** is Buf's hosted answer to that gap: `buf push` publishes a module to a registry, versioned and content-addressed, and consumers either `buf generate` against the published module directly or pull a BSR-hosted generated SDK: a package built from that module in a target language, versioned the same way, published to that language's normal package manager or to BSR's own plugin-generated artifacts. A Java consumer adds a BSR-backed Maven dependency; a Python consumer adds a BSR-backed PyPI dependency; neither touches `protoc` or clones `contracts/` to get there. `contracts/buf.gen.yaml` already uses BSR's remote plugins for local inspection (`buf.build/protocolbuffers/python` and `buf.build/grpc/python`), the same mechanism a hosted SDK pipeline runs on a schedule instead of on demand.

This book does not stand up a live BSR module for `shipping.routing.v1`: a real module needs a Buf account and a registry to push to, which a runnable, self-contained example in this repository cannot set up for a reader with nothing but a clone and a terminal. The mechanism above is accurate to how BSR works; it's described, not demonstrated live, the same boundary Chapter 20 draws around any managed service this book can name but can't run without an account somewhere.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>A monorepo with every consumer inside it (this book's own shape, one <code>contracts/</code> directory, a handful of services in the same checkout) gets nothing from the BSR that a <code>COPY</code> at build time doesn't already provide, and it avoids a dependency on an external registry's uptime for every build. The BSR earns its cost the moment a schema has a consumer outside that boundary: a partner integration, a public client SDK, a second repository that shouldn't need to clone this one to generate stubs. At that point, the registry's versioning and its hosted SDK generation replace what would otherwise be a brittle, manually-copied <code>.proto</code> file passed around over chat or committed into someone else's repository by hand: the exact failure mode contract-first was adopted in Chapter 5 to eliminate inside this repository, recurring one organizational boundary further out. Choose a local, filesystem-based contract for an internal multi-service repository; reach for the BSR the moment a consumer sits outside it.</p></div>

## Where this goes next

The gate this chapter wires stays in force for every later change to `routing.proto`, `types.proto`, `quote.proto`, and `tracking.proto`: any field Part 6's async methods add, any message Part 8's streaming chapters extend, passes through the same `buf breaking --against main` check before it reaches a stack that generates code from it. Chapter 5 already depended on this gate existing without spelling out its rules; this chapter is the one that makes the dependency precise. A reader who wants to watch the gate fail against the actual contract this book ships runs `scripts/ch14-demo-breaking.sh` and sees the CI run turn red, then deletes the branch it made and moves on, since that branch was never meant to merge.

## On the wire

A field renumber is the mistake `buf breaking` exists to catch before it ever reaches a generated stub. Here it is against the real contract, the same seeded edit `scripts/ch14-demo-breaking.sh` applies on its disposable branch:

```bash
cd contracts
# routing.proto, before:  repeated shipping.type.v1.Cargo cargo = 3;
# routing.proto, after:   repeated shipping.type.v1.Cargo cargo = 7;
buf breaking --against '.git#branch=main,subdir=contracts'
```

```text
proto/shipping/routing/v1/routing.proto:14:1:Previously present field "3" with name "cargo" on message "GetQuoteRequest" was deleted.
```

Field 3 didn't get a new type or a new name here: the same `cargo` field moved to a new number, which `buf breaking` reports identically to a deletion, because from an old reader's point of view that's exactly what happened. Whatever a new writer now sends at number 7, nothing at number 3 arrives anymore, and number 7 means nothing to code still compiled against the old file. The fix in a real schema is never "renumber it back" under time pressure; it's deciding, with the two compatibility directions from this chapter in mind, whether the change belongs in a new field at a new number or in a new package altogether.

## For deeper coverage

- [Protocol Buffers: Updating a message type](https://protobuf.dev/programming-guides/proto3/#updating): the official list of safe and unsafe schema edits this chapter's two lists are built from.
- Buf: breaking-change detection (`buf breaking`, the `FILE` vs. `WIRE_JSON` rule categories), the gate `contracts/buf.yaml` wires in.
- Cloud Native Design Patterns, Appendix B, "Versioning & Evolution": the same compatibility rules applied across REST, protobuf, and GraphQL.
- Clément Jean, *gRPC Go for Professionals*, Packt, 2023: schema evolution, covered as its own topic.
