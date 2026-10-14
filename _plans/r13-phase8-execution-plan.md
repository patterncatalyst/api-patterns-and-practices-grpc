---
title: "Phase 8 Execution Plan — decks + release"
layout: plan
render_with_liquid: false
---

# Phase 8 — Decks + Release Polish

Branch `docs/r13-phase8-decks`. Book content is complete + verified (Ch0–27 + Appendix A, 27 examples).
This phase: three slide decks + release polish. NO new chapters/examples. Decks are AUDIENCE-FACING, so the
no-planning-language rule applies in full (no "capstone" → "Final Project"; no rNN/Phase N/iteration/coverage
matrix/build plan/wave/deck-map in any deck).

## Accelerator
The REST sibling `/home/rsedor/Dev/api-patterns-and-practices-rest/presentation/` already ships this exact
three-deck pattern — PORT its `_shared/` layout wholesale. This repo is ALREADY wired: `.gitignore` excludes
`presentation/_shared/node_modules/`, `presentation/**/{__pycache__,qa}/`, `.deck-src/`; `_config.yml` excludes
`presentation/`. Dir name is fixed as `presentation/` (not `decks/`). Toolchain present (Node 22, cairosvg,
soffice, Red Hat fonts) EXCEPT global pptxgenjs — copy the REST sibling's `_shared/node_modules` or `npm install`.

## Three decks (16:9 .pptx, Red Hat house style, committed artifacts ~2.7 MB each, NO deck CI)
- `presentation/api-patterns-grpc-100/` — "Protobuf & gRPC" concepts, stack-agnostic. Wire-level snippets only
  (.proto, buf, grpcurl, wire bytes, proto3↔JSON, google.rpc.Status). No Java/Python. Covers every T-topic conceptually.
- `presentation/api-patterns-grpc-quarkus/` — 201, same spine, every "how" is Quarkus code from examples/*/quarkus/.
- `presentation/api-patterns-grpc-python/` — 201, same spine, Python code from examples/*/python/.
Together they cover every coverage-matrix topic (T1–T27 + R1–R3) — verified by a coverage cross-check sheet.
Each: cover → agenda → section dividers → content (diagrams + code) → appendix slides for overflow; speaker notes
on every slide. Artifacts `…-r1.0.pptx` (artifact revision marker only; the one small cover revision chip).

## Reuse real assets (no invented figures / no fake code)
- Figures: `presentation/_shared/render_svgs.py` (cairosvg, ~1400px) renders the book's `assets/diagrams/*.svg`
  (36 paired figures) → `_shared/png/<name>.png`; `addDiagramSlide(s, "<name>", caption)` embeds by name.
  `diagrams.py`/`dgen.py` kept only as a fallback engine if a topic needs a figure the book lacks (none expected).
- Code: `addCodeSlide` with REAL excerpts from `examples/*` (proto, grpcurl output, Java/Python impl); overflow →
  appendix slides (fontSize 10). Never a whole file — excerpt the load-bearing lines.
- Ch22's "Phase 1/2" are LB-demo step labels in the chapter (acceptable there) but MUST become
  "pinned-pod baseline" / "headless+round-robin fix" in deck text — never "Phase N".

## Build / verify
`cd presentation/_shared && npm install` (or copy REST node_modules); `python3 -I render_svgs.py`; per deck:
`cd presentation/<deck> && export NODE_PATH="$(cd ../_shared/node_modules && pwd)" && node deck.js`. QA each:
`soffice --headless --convert-to pdf --outdir qa <out>.pptx` + `pdftoppm -jpeg` eyeball. Commit the small `png/`
(track, like REST) + the 3 pptx; `node_modules`/`qa`/`__pycache__` stay gitignored. `du -sh presentation/` <15 MB.

## Waves
- **Wave 0 (serial):** scaffold `presentation/_shared/` (port from REST sibling + skill), write `render_svgs.py`,
  install/copy pptxgenjs, render PNGs, port `_shared/README.md`. Blocks everything.
- **Wave 1 (3 parallel):** one executor per deck (100, quarkus, python) — each writes only its own deck dir + builds
  its own pptx. Restate house conventions + the no-planning-language rule (subagents don't inherit skills). Mine
  content ONLY from chapters + coverage-matrix + figures + example code — NOT the execution plans. Hand the 201
  executors the finished 100 deck.js as the section skeleton.
- **Wave 2 (serial validation):** voice pass (lgtm-professional-voice over decks + site), the planning-language grep
  gate (`grep -riE 'capstone|\br[0-9][0-9]\b|phase [0-9]|iteration|coverage matrix|build plan|deck-map|wave [0-9]' presentation/*/deck.js` → nothing), QA-render each deck, coverage cross-check (T1–27 + R1–3 present), idiomatic review on showcased code, full release gate sweep (validate.py, wordcount, buf, jekyll, example matrix). Fix + rebuild.
- **Wave 3 (serial, on user go):** PR → main, merge, tag + GitHub release via lgtm-github.

## Release polish
Re-run all gates green; voice over `_docs/` + README + decks (0 ban-tier); README gains a one-line "Presentations"
pointer to `presentation/`; bibliography lists the 6 reference books; conventional-commit `docs(decks)` scope.

## OUT-OF-REPO follow-up (not done on this branch)
Hub repo `patterncatalyst-workshops-tutorials-list`: hand-add the gRPC site to `_data/sites.yml` NEXT TO the REST
entry, and the books to `_data/books.yml`. NEVER run `gen-books.py` (clobbers). Then the user reviews. (See the
series continues with GraphQL then WebSockets.)

## Acceptance
3 pptx build clean + QA-render without defects + notes on every slide; together cover T1–27 + R1–3 (cross-check);
ZERO planning/capstone language (grep + voice clean); 0 voice ban-tier decks+site; diagrams AND code with appendix
overflow, all from real assets; site + all gates green; `presentation/` <15 MB, no node_modules/qa/pycache tracked.

## Risks
pptxgenjs missing → Wave 0 installs/copies, trial-require before build · planning-language leakage → mine chapters
not plans, grep+voice gate, rework Ch22 "Phase N" · figure/code mismatch → render_svgs logs; deck errors loudly on
missing png; diff excerpts vs source · binary bloat → du + git status pre-commit, cap png width · toolchain in a
fresh sandbox → restate install · coverage gap → cross-check detector, author via diagrams.py only if truly needed.
