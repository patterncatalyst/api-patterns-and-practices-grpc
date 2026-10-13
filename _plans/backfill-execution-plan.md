---
title: "Backfill Execution Plan — figures + Ch4/Ch9 depth"
layout: plan
render_with_liquid: false
---

# Backfill Execution Plan — concept-driven figures (Ch0–Ch12) + Ch4/Ch9 depth

Relay on branch `docs/backfill-figures-depth`. Brings the shipped chapters up to the
multi-figure convention (one focused figure per major concept, ≥2 for a full-length
chapter) and fills two genuine depth gaps. Concept-first, never quota-first: each new
figure depicts a genuinely uncovered, genuinely visual concept, generated via
`scripts/generate_diagram.py`'s `emit()` (amber `#e8870c` house style).

## Scope
- **13 new figures**, one per chapter Ch0–Ch12 (Ch13/Ch14 already have three each — exemplars, untouched).
- **Ch4 + Ch9 depth** — prose-only additions that add real value and clear the 2000-word floor by honest count.
- **Honest word-count metric flip** — `scripts/wordcount.sh` stops counting `{% include %}` lines; sequenced AFTER Ch4/Ch9 depth lands (it's only safe once they clear the floor).

## Per-chapter figures (numbered in document order; "RENUMBER" = bump the existing caption digit)
| Ch | New figure — name / depicts | Number | Existing |
|---|---|---|---|
| 0 | `00-shipping-domain-model` — ER of the domain nouns (Booking/Location/Cargo/Money/Route/Leg) | 0.2 | 0.1 stays |
| 1 | `01-stub-to-stub-path` — proto → stub+skeleton; typed-in/wire/typed-out; why curl can't call | 1.2 | 1.1 stays |
| 2 | `02-four-rpc-shapes` — 2×2 request×response cardinality → the four contract methods | 2.1 | RENUMBER → 2.2 |
| 3 | `03-field-shapes` — repeated vs map vs oneof semantics | 3.1 | RENUMBER → 3.2 |
| 4 | `04-wellknown-catalog` — WKTs grouped by problem, each tied to its contract field | 4.1 | RENUMBER → 4.2 |
| 5 | `05-buf-three-gates` — lint → build → breaking | 5.1 | RENUMBER → 5.2 |
| 6 | `06-nested-message-bytes` — GetQuoteResponse on the wire, nesting/recursion | 6.2 | 6.1 stays |
| 7 | `07-channel-decides-call-style` — blocking vs async lives in the channel, not the stub | 7.1 | RENUMBER → 7.2 |
| 8 | `08-polling-vs-streaming` — repeated unary poll vs one server-stream | 8.1 | RENUMBER → 8.2 |
| 9 | `09-half-close-sequence` — HTTP/2 half-close mechanics (END_STREAM) | 9.1 | RENUMBER → 9.2 |
| 10 | `10-cancellation-propagation` — deadline → cancel → cancellable work torn down vs blocked sleep | 10.2 | 10.1 stays |
| 11 | `11-status-code-taxonomy` — canonical codes grouped by meaning; don't collapse to INTERNAL | 11.1 | RENUMBER → 11.2 |
| 12 | `12-metadata-headers-trailers` — headers before, trailers after; what each carries | 12.2 | 12.1 stays |

Net: 13 new figures, 8 caption renumbers (Ch2,3,4,5,7,8,9,11), 5 no-renumber (Ch0,1,6,10,12).

## Ch4 depth (honest 1991 → ~2280), prose-only
1. **Default values & what proto3 JSON omits** (~150–180w) — scalar zero-values dropped from JSON; `optional`/wrapper restores present-vs-absent; opt-in to emit defaults. Ties forward to Ch13 FieldMask zero-value behavior. (Verify encoder option names, or phrase behavior-first.)
2. **`Any`'s unpack contract + failure mode** (~110–140w) — receiver resolves type URL against a descriptor/registry; unknown URL is a runtime unpack failure, not a parse failure. The mechanism Ch11 rich-error details ride on.

## Ch9 depth (honest 1984 → ~2320), prose-only commentary on existing code
1. **Server-side early termination** (~150–180w) — server erroring/responding before the client half-closes; remaining client sends then fail. A real failure mode for bulk-ingest/negotiation.
2. **`collect().asList()` unbounded-buffer caveat + incremental-fold alternative** (~150–200w) — Quarkus buffers the whole inbound stream; Python folds incrementally. Flag the memory footgun; point to Ch17 for full backpressure.

## Metric flip (sequenced)
1. Land Ch4 & Ch9 depth; confirm each >2000 by honest count.
2. Add to `prose_wordcount()` in `scripts/wordcount.sh`: `/^[[:space:]]*{%/ { next }` (skip Liquid include lines).
3. `GATE=1 scripts/wordcount.sh` — all draft/verified ≥2000 (lowest other = Ch8 2060).

## Waves (one chapter = one Sonnet executor; disjoint files, collision-free)
- **Wave A (5):** Ch0, Ch1, Ch2, Ch3, Ch4 *(+depth)*
- **Wave B (4):** Ch5, Ch6, Ch7, Ch8
- **Wave C (4):** Ch9 *(+depth)*, Ch10, Ch11, Ch12
- **Wrap (Opus):** confirm Ch4/Ch9 honest >2000 → flip wordcount.sh → GATE run → validate.py + jekyll + voice across edited prose → per-chapter checkpoint commits → PR.

Each executor touches ONLY its `_docs/NN-*.md` + its new `assets/diagrams/NN-*.{svg,excalidraw}`. No executor touches `examples/`, `contracts/`, `_plans/*`, `coverage-matrix.md`, or any code/command/recorded output.

## Acceptance
validate.py green (diagram-pairs + chapter-diagram); each new figure paired + referenced once; captions sequential in document order (`grep -n 'caption="Figure'`); `GATE=1 wordcount` green with honest metric (Ch4/Ch9 >2000); 0 voice ban-tier across edited prose + new alt-text/captions; jekyll green; diff scoped to `_docs/*.md` + `assets/diagrams/*` + `scripts/wordcount.sh`; no both-stack re-run needed (examples untouched).

## Risks
Editing verified chapters (append-style; Opus accuracy + voice + diff review) · figure house-style drift (must come from `emit()`; validate.py pairs + visual spot-check) · numbering incoherence (per-file sequential-order grep; 8 RENUMBERs enumerated) · metric flip before floor cleared (hard sequencing) · cross-chapter figure redundancy (Ch1 vs Ch7, Ch3 vs Ch6 — scoped to distinct angles; wrap-step review).
