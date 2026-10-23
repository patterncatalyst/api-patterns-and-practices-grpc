"""
diagrams.py: fallback Scene-diagram engine for the "API Patterns & Practices:
gRPC" decks.

The book already ships 72 paired figures (assets/diagrams/*.svg +
*.excalidraw) covering every chapter topic; render_svgs.py converts those
directly to PNG for addDiagramSlide, so this file is NOT expected to be used.
It exists only as a fallback: if a deck needs a figure the book doesn't have,
author a Scene here (same dgen.py engine as the REST sibling), register it in
SCENES, and run `python3 build_diagrams.py` to emit diagrams/*.svg +
*.excalidraw + png/*.png alongside the book's rendered figures.

Paths (env, defaults): DIAG_DIR=./diagrams  PNG_DIR=./png
Color by role (dgen PALETTE):
  rest=API surface  svc=clients/services  data=stores/schema  platform=infra/runtime
  govern=policy/lifecycle  danger=failure/terminal  neutral/muted=text
"""
from dgen import Scene, PALETTE


def example_fallback_scene():
    """Placeholder scene: delete or replace once a real fallback figure is needed."""
    s = Scene("fallback-example", width=1240, height=560,
              title="Example: client -> stub -> channel -> service",
              subtitle="Swap this scene for a real one if a deck needs a figure the book lacks.")
    s.box(80, 200, 240, 90, "Client", ["calls the generated stub"], kind="svc")
    s.box(500, 200, 240, 90, "Channel", ["HTTP/2 connection", "handles framing"], kind="rest")
    s.box(920, 200, 240, 90, "Service", ["implements the RPC"], kind="platform")
    s.arrow(320, 245, 500, 245, kind="neutral", label="gRPC")
    s.arrow(740, 245, 920, 245, kind="neutral")
    s.panel(80, 360, 1080, 110)
    s.label(104, 395, "Use color by role: svc=clients/services, rest=the API surface,",
            size=13, color=PALETTE["neutral"])
    s.label(104, 420, "data=stores, platform=infra, govern=policy, danger=failure paths.",
            size=13, color=PALETTE["neutral"])
    s.write()


# Register every scene here. build_diagrams.py runs them all.
SCENES = [
    example_fallback_scene,
]


if __name__ == "__main__":
    for fn in SCENES:
        fn()
        print(f"  built {fn.__name__}")
