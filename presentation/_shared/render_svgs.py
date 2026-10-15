"""
render_svgs.py — render the book's figures (assets/diagrams/*.svg) to PNG for
deck embedding via addDiagramSlide.

The book ships every figure as a paired .svg + .excalidraw under
assets/diagrams/. This script renders just the .svg half to PNG at ~1400px
width (via cairosvg) into presentation/_shared/png/, so the three decks can
embed the book's real figures instead of inventing new ones.

Run with the isolation flag (no project-local interpreter shadowing):
    cd presentation/_shared && python3 -I render_svgs.py

Paths are resolved relative to this file, not the current working directory,
so it also works from the repo root.
"""
import os
import sys
import glob
import site

# Run with `python3 -I` for isolation from CWD/PYTHONPATH (this script only
# ever reads the book's own trusted assets/diagrams/*.svg, never arbitrary
# input). -I also disables the user site-packages dir, which is where
# cairosvg is typically installed (`pip install --user cairosvg`); add it
# back explicitly rather than relaxing isolation.
_user_site = site.getusersitepackages()
if _user_site not in sys.path and os.path.isdir(_user_site):
    sys.path.append(_user_site)

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIAGRAMS = os.path.normpath(os.path.join(HERE, "..", "..", "assets", "diagrams"))
PNG_DIR = os.path.join(HERE, "png")

OUTPUT_WIDTH = 1400


def main():
    if not os.path.isdir(ASSETS_DIAGRAMS):
        print(f"ERROR: book figures dir not found: {ASSETS_DIAGRAMS}", file=sys.stderr)
        print("Expected the book's assets/diagrams/ two levels up from _shared/.", file=sys.stderr)
        sys.exit(1)

    svgs = sorted(glob.glob(os.path.join(ASSETS_DIAGRAMS, "*.svg")))
    if not svgs:
        print(f"ERROR: no .svg files found in {ASSETS_DIAGRAMS}", file=sys.stderr)
        sys.exit(1)

    try:
        import cairosvg
    except ImportError:
        print("ERROR: cairosvg is not installed. Install it with: pip install cairosvg", file=sys.stderr)
        sys.exit(1)

    os.makedirs(PNG_DIR, exist_ok=True)

    print(f"Rendering {len(svgs)} book figures from {ASSETS_DIAGRAMS}")
    print(f"  -> {PNG_DIR}  (width={OUTPUT_WIDTH}px)")

    failures = []
    for svg_path in svgs:
        base = os.path.splitext(os.path.basename(svg_path))[0]
        png_path = os.path.join(PNG_DIR, f"{base}.png")
        try:
            cairosvg.svg2png(
                url=svg_path,
                write_to=png_path,
                output_width=OUTPUT_WIDTH,
                background_color="white",
            )
            print(f"  converted {base}.svg -> {base}.png")
        except Exception as exc:  # noqa: BLE001 - log every failure, keep going, fail loudly at the end
            print(f"  ERROR converting {base}.svg: {exc}", file=sys.stderr)
            failures.append(base)

    rendered = sorted(glob.glob(os.path.join(PNG_DIR, "*.png")))
    print(f"\nDone: {len(rendered)} PNGs in {PNG_DIR}")

    if failures:
        print(f"\nERROR: {len(failures)} file(s) failed to convert: {', '.join(failures)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
