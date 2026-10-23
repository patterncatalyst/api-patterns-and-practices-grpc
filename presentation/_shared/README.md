# Shared deck scaffold for API Patterns & Practices: gRPC

One Red Hat house-style scaffold, reused by all three decks in this series:

| Deck dir | What it is |
|---|---|
| `../api-patterns-grpc-100/` | 100-level **concepts**: the what & why of Protobuf & gRPC, stack-agnostic |
| `../api-patterns-grpc-quarkus/` | **Quarkus** implementation of the same patterns |
| `../api-patterns-grpc-python/` | **Python / grpcio** implementation of the same patterns |

## What lives here

- `deck-helpers.js`: the bundled Red Hat deck helper library (COLOR / FONT / W / H
  + `addContentTitle` / `addBullets` / `addTwoColBullets` / `addStatusTable` /
  `addCodeSlide` / `addDiagramSlide` / `addSectionDivider` / `addFooter` / `addNotes`).
  **Do not rewrite**, extend only. (Ported unchanged from the REST sibling and the
  `lgtm-presentation` skill; all three copies are identical.)
- `render_svgs.py`: renders the book's own figures (`../../assets/diagrams/*.svg`,
  72 paired SVG + Excalidraw figures covering every chapter and Appendix A) to PNG
  via `cairosvg`, at ~1400px width, into `png/`. This is the primary figure source
  for all three decks. Run it before building any deck:
  ```bash
  cd presentation/_shared
  python3 -I render_svgs.py
  ```
  Basenames match the book's figure names exactly, e.g. `03-protobuf-anatomy`,
  `22-grpc-lb-problem`, `27-final-project-architecture`. `addDiagramSlide(s, eyebrow,
  title, "<basename>", caption)` embeds by basename.
- `dgen.py`: the Scene diagram engine (SVG + Excalidraw emitters). Same engine as
  the REST sibling.
- `diagrams.py` / `build_diagrams.py`: a **fallback** engine, kept only in case a
  deck needs a figure the book's 72 don't cover (the book's figures are
  comprehensive, so none are expected). `diagrams.py` here is a minimal starter
  (not the REST book's domain-specific scenes, which don't apply to gRPC); author a
  new `Scene` and register it in `SCENES` only if needed:
  ```bash
  cd presentation/_shared
  python3 build_diagrams.py        # -> diagrams/*.svg + *.excalidraw, png/*.png
  ```
- `assets/`: brand assets (cover panel, section panel, Red Hat logos). REST's
  site-specific QR-code PNGs were not ported; they don't apply here.
- `png/`: rendered figure PNGs (what `addDiagramSlide` reads), both the book's 72
  figures from `render_svgs.py` and any fallback scenes from `build_diagrams.py`.
- `diagrams/`: `.svg` + `.excalidraw` sources for any fallback scenes (empty unless
  `build_diagrams.py` has been run).
- `node_modules/`: `pptxgenjs` (shared across decks; gitignored, installed via
  `npm install` from the checked-in `package.json`/`package-lock.json`).

## How each deck reuses this

A deck's `deck.js` points the helper's asset/PNG paths at `_shared/` before
requiring it, then requires the shared helpers:

```js
const path = require("path");
const SHARED = path.resolve(__dirname, "../_shared");
process.env.DECK_ASSETS = `${SHARED}/assets`;
process.env.DECK_PNG   = `${SHARED}/png`;
const H = require(`${SHARED}/deck-helpers.js`);
```

Run a deck with the shared `pptxgenjs` on the module path:

```bash
cd presentation/api-patterns-grpc-100     # or -quarkus / -python
export NODE_PATH="$(cd ../_shared/node_modules && pwd)"
node deck.js
```

To add the next implementation deck, copy an existing deck dir, keep the
`_shared` wiring above, and swap the slide content.
