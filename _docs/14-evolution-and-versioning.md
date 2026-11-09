---
title: "Evolution and versioning"
order: 14
part: "Schema Evolution & the Living Contract"
description: "Field numbers as the contract, reserved, backward and forward compatibility, package versioning from shipping.routing.v1 to v2, the buf breaking gate, and the Buf Schema Registry."
duration: "17 min read"
---

## Learning objectives

By the end of this chapter you can:

- Explain why a field's number, not its name, is the part of a protobuf contract that can never move once a message ships.
- Classify a schema change as safe (add a field or RPC, widen a numeric type, rename) or breaking (renumber, reuse a number, retype, remove a field a reader needs).
- State what `reserved` does and does not buy: it blocks reuse of a retired number, and it does not make the deletion safe.
- Decide when an additive change is enough and when a change needs a new package version (`v1` to `v2`).
- Read a `buf breaking` failure and explain why the `FILE` category's `FIELD_NO_DELETE` rejects a deletion even when the field was `reserved` first.

## Why this matters

`shipping.routing.v1.GetQuoteRequest` has shipped, and clients are compiled against it. The wire format carries field numbers, not names, so a message means one thing only if every reader and writer agrees what each number stands for. A careless edit to `routing.proto` can change what field 3 means to a client built last week. The rules below cover which edits are safe, what `reserved` buys, and when a change needs a new package version. The `buf breaking` gate turns the discipline into a command that exits non-zero when someone gets it wrong.

## Field numbers are the contract

A message on the wire is a sequence of `(field number, wire type, value)` tuples. `shipping.type.v1.Money { currency = "USD"; amount = "1250.00" }` becomes "field 1, length-delimited, these 3 bytes" followed by "field 2, length-delimited, these 7 bytes." The names `currency` and `amount` live only in the `.proto` source and generated code. A reader built from a different `.proto` revision decodes the same bytes by number alone, which is what lets Quarkus and Python answer `GetQuote` identically and what a careless edit breaks.

So renaming a field is always safe and changing its number almost never is. Renaming `string origin_un_locode = 1;` to `string origin = 1;` changes no bytes. Renumbering it from `1` to `6` means an old binary still emits field 1 while a new one expects field 6, and during any rolling deploy both are running.

| Change | Verdict | Why |
| --- | --- | --- |
| Rename a field | Safe | The number is unchanged and names never reach the wire |
| Add a field at an unused number | Safe | An old reader skips unknown fields; proto3 doesn't reject the message |
| Add an RPC | Safe | An old client has no stub for it; a server that hasn't built it returns `UNIMPLEMENTED` |
| Widen a numeric type (`int32` to `int64`) | Safe | Both use the varint wire type, so the value decodes correctly as long as it fits |
| Reuse a field number for a different field | Breaking | The new bytes land where the old reader expects the old type, and it silently produces a wrong answer |
| Change a field's type to a different wire type (`double` to `string`) | Breaking | The old reader misreads the bytes; the same wire type with different meaning (`weight_kg` becoming `weight_lb`) breaks it silently |
| Remove a field a reader depends on | Breaking | The bytes stop arriving, and a reader that can't tell "unset" from zero draws a wrong conclusion |
| Renumber a field | Breaking | The old number stops arriving and the new one means nothing to old code |

{% include excalidraw.html file="14-evolution-compatibility" alt="A matrix of schema changes under buf breaking's FILE category. Safe: rename a field, add a field, add an RPC, widen a numeric type. Breaking: renumber a field, reuse a number, change a field's type, remove a field a reader needs. A dashed line connects rename to renumber: the number, not the name, can never move once a message ships." caption="Figure 14.1: Safe changes leave the meaning of every existing field number untouched. Breaking changes move, reuse, retype or remove one a reader still depends on." %}

## `reserved`: what it buys

`reserved` makes the compiler reject a field declaration that reuses a number or name:

```protobuf
message GetQuoteRequest {
  reserved 4;
  reserved "legacy_notes";

  string origin_un_locode = 1;
  string destination_un_locode = 2;
  double weight_kg = 3;
}
```

It does not make deleting a field safe. A field some reader needed is missing the moment it's removed, reserved or not. What `reserved` prevents is the second mistake: an engineer who doesn't remember what field 4 meant adds a field, takes the first free number, which is 4, and any service still on the pre-removal binary (a rolling deploy, or a client nobody redeployed in a year) decodes the new bytes as the old type. With the reservation that is a compile error rather than a production incident. A durable benefit, but not "this deletion is now safe."

## Backward and forward compatibility

**Backward compatibility** is what a new reader needs: it correctly reads a message built against the old schema. **Forward compatibility** is the reverse: an old reader correctly reads a message built against the new schema, by ignoring fields it doesn't recognize. A rolling deploy needs both, because old and new binaries serve side by side. An old server must tolerate a new client's extra field, and a new server must make sense of an old client's message that lacks a field the new schema added. Proto3's rules, unknown fields skipped and absent fields read as zero, make both directions hold for every safe change above. The breaking changes each collapse one of them.

## Pattern: Package Versioning

### The problem

Eventually a schema needs a change that isn't additive: `weight_kg` should have been `weight_grams`, or `GetQuoteRequest` needs a shape no addition can produce. Editing the file in place breaks every client compiled against it.

### The solution

**Publish the incompatible schema as a new package version at a new path, and keep serving the old one until its clients migrate.**

`shipping.routing.v2` is a new `package` statement in `shipping/routing/v2/routing.proto`, beside the untouched `v1/routing.proto`. Both packages coexist on disk and at runtime. The v1 implementation keeps serving `shipping.routing.v1.RoutingService` and v1 clients never notice v2 until they migrate, on their own schedule.

When v2 drops a field v1 carried, carry the reservation forward. No tool requires it, and it stops a later version reusing the number for something a long-lived v1-era payload might still carry:

{% include excalidraw.html file="14-package-versioning-v2" alt="shipping.routing.v1 and v2 coexisting during a rolling deploy. The v1 service keeps serving clients generated from v1. A second service from shipping/routing/v2/routing.proto serves migrated clients; its message reserves field 4 and legacy_notes. A dashed boundary shows buf breaking never crossing from the v1 diff into the v2 file, because it compares only files at a matching path." caption="Figure 14.2: v1 and v2 coexist on disk and at runtime. Old clients keep using v1 while new clients move to v2, and the new path is invisible to buf breaking by construction." %}

```protobuf
message GetQuoteRequest {
  reserved 4;
  reserved "legacy_notes";

  string origin_un_locode = 1;
  string destination_un_locode = 2;
  double weight_kg = 3;
  int32 cargo_count = 5;
}
```

### How Quarkus and Python model it

Each stack generates its stubs from the package it is built against, so a v2 service is a second implementation registered next to the first, with no change to either stack's v1 code.

## The `buf breaking` gate

The contract's `buf.yaml` selects one rule category:

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

`FILE` forbids deleting any field, message, enum or RPC from a file, and reserving the field first changes nothing: `FIELD_NO_DELETE` doesn't look for a reservation. Buf ships a more permissive rule, `FIELD_NO_DELETE_UNLESS_NUMBER_RESERVED`, that grants the exception a reader might expect `reserved` to earn, but it lives in the `WIRE_JSON` category, not `FILE`. The contract chooses `FILE`, the stricter, so a field never quietly disappears from an existing package. The way to retire a field is a new package at a new path, which `buf breaking` has nothing on the old side to compare against.

`examples/14-evolution/` runs `buf breaking <candidate> --against baseline` on a standalone schema that never touches `contracts/`. The safe candidate adds a field and an RPC and reserves numbers nothing has used:

```protobuf
message GetQuoteRequest {
  reserved 10, 11;
  reserved "internal_only";

  string origin_un_locode = 1;
  string destination_un_locode = 2;
  double weight_kg = 3;
  string legacy_notes = 4;
  int32 cargo_count = 5;
}
```

The breaking candidate deletes two fields and retypes a third:

```protobuf
message GetQuoteRequest {
  string origin_un_locode = 1;
  int32 weight_kg = 3;
}
```

```text
candidate-breaking/shipping/routing/v1/routing.proto:13:1:Previously present field "2" with name "destination_un_locode" on message "GetQuoteRequest" was deleted.
candidate-breaking/shipping/routing/v1/routing.proto:13:1:Previously present field "4" with name "legacy_notes" on message "GetQuoteRequest" was deleted.
candidate-breaking/shipping/routing/v1/routing.proto:15:3:Field "3" with name "weight_kg" on message "GetQuoteRequest" changed type from "double" to "int32".
```

| Candidate | Change | `buf breaking` |
| --- | --- | --- |
| Safe | Add `cargo_count`, add `ListRoutes`, reserve unused numbers | Exit 0 |
| Breaking | Delete fields 2 and 4, retype field 3 | Exit 100, one line per violation |
| Breaking and reserved | Delete field 4 and reserve its number and name | Exit 100, `FIELD_NO_DELETE` anyway |
| v2 migration | Drop field 4 inside `shipping.routing.v2` | Exit 0 |

Each line names the field, the message and the violation, so a reviewer can act on a CI failure without re-deriving the diff. The v2 drop passes because `buf breaking` diffs a file only against the file at the same path on the other side, and `shipping/routing/v2/routing.proto` has no counterpart in the baseline.

{% include excalidraw.html file="14-buf-breaking-gate" alt="The buf breaking gate: a safe candidate compared against baseline exits 0 and merges. A breaking candidate exits 100, naming destination_un_locode deleted and weight_kg retyped from double to int32. The same deletion with the field marked reserved still exits 100." caption="Figure 14.3: The buf breaking gate. Safe passes at exit 0, and breaking, reserved or not, fails at exit 100 naming the violation." %}

The standalone schema lives outside `contracts/` because a proto built to fail has no place in the module every stack compiles against. To watch the real gate fail, `scripts/ch14-demo-breaking.sh` forks a throwaway branch from `main`, renumbers a field in the real `routing.proto`, and pushes it so the real `buf breaking --against main` job in the `contracts.yml` workflow goes red. The branch exists to be watched failing, never to be fixed or merged:

```bash
scripts/ch14-demo-breaking.sh              # fork, seed the break, push
scripts/ch14-demo-breaking.sh --cleanup    # delete the local and remote demo branch
```

The script refuses a dirty working tree, re-derives the branch from `main` on every run so it never goes stale, and never checks out or merges anything into `main`.

## The Buf Schema Registry

Inside one repository every stack generates stubs from a local copy of `contracts/proto/`. That stops working once a schema has consumers outside the repository, such as a partner team or a client SDK for external developers, none of whom should clone it to get `shipping.routing.v1`.

The **Buf Schema Registry (BSR)** is Buf's hosted answer. `buf push` publishes a versioned, content-addressed module. Consumers run `buf generate` against it, or pull a BSR-hosted generated SDK: a Maven dependency for Java, a PyPI dependency for Python, with no `protoc` and no clone. `contracts/buf.gen.yaml` already uses BSR remote plugins (`buf.build/protocolbuffers/python`, `buf.build/grpc/python`) for local inspection. A live module needs a Buf account, so the mechanism is described here, not run.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>A monorepo with every consumer in it gets nothing from the BSR that a <code>COPY</code> at build time doesn't, and avoids depending on an external registry's uptime for every build. The BSR earns its cost when a consumer sits outside that boundary: a partner integration, a public client SDK, a second repository. There its versioning and hosted SDK generation replace a <code>.proto</code> file passed around by hand, the failure contract-first exists to eliminate, recurring one organizational boundary further out. Use a filesystem contract for internal services and the BSR once a consumer is outside.</p></div>

> **🤖 Explore with your agent**
>
> "In `examples/14-evolution`, review `candidate-safe` and `candidate-breaking` against the rule that a field's number never moves and a deletion is never safe under `buf breaking`'s `FILE` category. Then add a `candidate-rename` directory that renames `origin_un_locode` to `origin` at field 1 and nothing else, and report what `buf breaking candidate-rename --against baseline` returns."
>
> Check: `cd examples/14-evolution && buf breaking candidate-rename --against baseline; echo $?`. Judge the reply by the rule: a rename at an unchanged number should be reported as safe.

## Build, run, observe

`examples/14-evolution/verify.sh` needs no stack and no ports. It uses `buf` from `PATH` or downloads a pinned binary, lints and builds the baseline, then checks all four candidates against it and expects each exit code in the table above. The reserved candidate and the v2 package are the two lines worth reading:

```text
=== Step 4: BREAKING-AND-RESERVED candidate (delete a field, reserve its number anyway) ===
ok, buf breaking candidate-breaking-reserved --against baseline: exit 100 (reserved field 4 still can't be deleted)
candidate-breaking-reserved/shipping/routing/v1/routing.proto:14:1:Previously present field "4" with name "legacy_notes" on message "GetQuoteRequest" was deleted.
ok, found expected violation: name "legacy_notes" on message "GetQuoteRequest" was deleted

=== Step 5: v2-migration (new package carries the retired field as reserved) ===
ok, buf breaking v2-migration --against baseline: exit 0 (shipping.routing.v2 is a new file; v1 is untouched)
```

The mistake `buf breaking` exists to catch, against the real contract:

```bash
cd contracts
# routing.proto, before:  repeated shipping.type.v1.Cargo cargo = 3;
# routing.proto, after:   repeated shipping.type.v1.Cargo cargo = 7;
buf breaking --against '.git#branch=main,subdir=contracts'
```

```text
proto/shipping/routing/v1/routing.proto:14:1:Previously present field "3" with name "cargo" on message "GetQuoteRequest" was deleted.
```

A renumber reports as a deletion because that is what an old reader sees: nothing arrives at number 3, and number 7 means nothing to code built against the old file. The fix is never to renumber back under time pressure. Decide whether the change belongs in a new field at a new number or in a new package.

Experiments:

- Compare `candidate-breaking-reserved` with `candidate-breaking`: reserving field 4 on the way out changes nothing, and both exit 100.
- Compare `v2-migration` with the baseline: it drops field 4 too and exits 0, because the v2 path has no counterpart to diff against.
- Run `scripts/ch14-demo-breaking.sh` from a clean checkout and watch the `buf breaking` job fail on the pushed branch, then run it with `--cleanup`.

## For deeper coverage

- [Protocol Buffers: Updating a message type](https://protobuf.dev/programming-guides/proto3/#updating): the official list of safe and unsafe schema edits.
- Buf: breaking-change detection (`buf breaking`, the `FILE` and `WIRE_JSON` rule categories), as wired into `contracts/buf.yaml`.
- Cloud Native Design Patterns, Appendix B, "Versioning & Evolution": the same compatibility rules applied across REST, protobuf and GraphQL.
- Clément Jean, *gRPC Go for Professionals*, Packt, 2023: schema evolution, covered as its own topic.
