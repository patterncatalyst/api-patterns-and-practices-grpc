"""
dgen.py — Diagram generation engine for the REST deck.

Emits matched SVG + Excalidraw + PNG triples in a Red Hat-aligned visual style.
Used for diagrams unique to the REST deck (HATEOAS state machines, JSON Patch shapes,
custom-method URIs, idempotency-key flow, etc.). Existing diagrams from
diagram-sources-python.zip are reused as-is (rendered to PNG via soffice).

Visual conventions (matched to existing Python deck diagrams):
  - Palette:
      rest   #EE0000 (Red Hat red, primary action/resource)
      svc    #0066CC (calm blue, services)
      data   #6A1B9A (purple, data/state)
      platform #006E6E (teal, platform / infra)
      govern #B36B00 (amber, governance / policy)
      danger #B71C1C (deep red, anti-patterns / failures)
      neutral #4A4A4A (dark grey, generic)
      muted  #5A5A5A (caption grey)
      bg     #FFFFFF
      panel  #F4F4F4 (callout backgrounds)
      grid   #D2D2D2
  - Fonts: Overpass / Red Hat Text for labels; Red Hat Mono for monospace tokens.
  - Stroke: 1.5px default; rounded corners r=8.
  - All shapes get a tiny drop-shadow-free flat look — matches the existing SVGs.

Each scene produces:
  diagrams/<name>.svg
  diagrams/<name>.excalidraw   (a hand-drawable equivalent)
  png/<name>.png               (rendered via soffice batch in build_diagrams.py)

Canonical scene authoring:

    from dgen import Scene
    s = Scene("11-hateoas-state", width=1200, height=600)
    s.box(40, 40, 200, 80, "draft", ["status=draft"], "neutral")
    s.arrow(240, 80, 320, 80, "POST /submit")
    s.box(320, 40, 200, 80, "submitted", ["status=submitted"], "svc")
    s.write()
"""

import json
import os
import uuid

PALETTE = {
    "rest":     "#EE0000",
    "svc":      "#0066CC",
    "data":     "#6A1B9A",
    "platform": "#006E6E",
    "govern":   "#B36B00",
    "danger":   "#B71C1C",
    "neutral":  "#4A4A4A",
    "muted":    "#5A5A5A",
    "bg":       "#FFFFFF",
    "panel":    "#F4F4F4",
    "grid":     "#D2D2D2",
    "code":     "#151515",
    "code_fg":  "#E6E6E6",
}

# Excalidraw-equivalent color names (its palette is limited; we map to close hues)
EXCALI_STROKE = {
    "rest":     "#e03131",
    "svc":      "#1971c2",
    "data":     "#9c36b5",
    "platform": "#0c8599",
    "govern":   "#e8590c",
    "danger":   "#c92a2a",
    "neutral":  "#343a40",
    "muted":    "#495057",
    "panel":    "#868e96",
    "grid":     "#adb5bd",
}
EXCALI_FILL = {
    "rest":     "#ffe3e3",
    "svc":      "#d0ebff",
    "data":     "#f3d9fa",
    "platform": "#c5f6fa",
    "govern":   "#ffe8cc",
    "danger":   "#ffc9c9",
    "neutral":  "#dee2e6",
    "muted":    "#f1f3f5",
    "panel":    "#f8f9fa",
    "grid":     "#f8f9fa",
}

# ----- root output directories -----
DIAG_DIR = os.environ.get("DIAG_DIR", "./diagrams")
PNG_DIR = os.environ.get("PNG_DIR", "./png")


# =========================================================================
#  Scene
# =========================================================================
class Scene:
    """A drawing surface that accumulates SVG and Excalidraw primitives."""

    def __init__(self, name, width=1200, height=600, title=None, subtitle=None):
        self.name = name
        self.width = width
        self.height = height
        self.title = title
        self.subtitle = subtitle
        self._svg_parts = []
        self._excali_elements = []
        # Background
        self._svg_parts.append(
            f'<rect x="0" y="0" width="{width}" height="{height}" fill="{PALETTE["bg"]}"/>'
        )
        if title:
            self.text(width / 2, 36, title, size=22, weight="bold", anchor="middle")
        if subtitle:
            self.text(width / 2, 64, subtitle, size=14, color=PALETTE["muted"], anchor="middle")

    # -------- primitives --------
    def box(self, x, y, w, h, title="", lines=None, kind="neutral", mono=False, r=8):
        """A rounded rectangle with title + optional sub-lines.

        kind: palette key (rest/svc/data/platform/govern/danger/neutral)
        mono: render labels in monospace (for code-like tokens)
        """
        lines = lines or []
        stroke = PALETTE[kind]
        # Soft tint fill: lighten the stroke color. We just use white with stroke for clarity.
        fill = "#FFFFFF"
        self._svg_parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>'
        )
        # title
        if title:
            tx = x + w / 2
            ty = y + 24 if lines else y + h / 2 + 5
            font = "Red Hat Mono, Menlo, monospace" if mono else "Overpass, Red Hat Text, Arial, sans-serif"
            self._svg_parts.append(
                f'<text x="{tx}" y="{ty}" font-family="{font}" font-size="14" font-weight="600" '
                f'fill="{PALETTE["neutral"]}" text-anchor="middle">{_xml(title)}</text>'
            )
        # sub-lines
        if lines:
            line_h = 16
            base_y = y + 44
            for i, ln in enumerate(lines):
                self._svg_parts.append(
                    f'<text x="{x + w/2}" y="{base_y + i*line_h}" '
                    f'font-family="Red Hat Text, Arial, sans-serif" font-size="12" '
                    f'fill="{PALETTE["muted"]}" text-anchor="middle">{_xml(ln)}</text>'
                )
        # Excalidraw equivalent
        self._excali_elements.append(_excali_rect(x, y, w, h, kind))
        if title:
            self._excali_elements.append(
                _excali_text(x + w/2, y + (24 if lines else h/2 - 8), title, size=16, align="center", bold=True)
            )
        for i, ln in enumerate(lines or []):
            self._excali_elements.append(
                _excali_text(x + w/2, y + 44 + i*16, ln, size=12, align="center", color=EXCALI_STROKE["muted"])
            )

    def label(self, x, y, text, size=12, weight="normal", color=None, anchor="start", mono=False):
        """Standalone text label."""
        color = color or PALETTE["neutral"]
        font = "Red Hat Mono, Menlo, monospace" if mono else "Overpass, Red Hat Text, Arial, sans-serif"
        self._svg_parts.append(
            f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" font-weight="{weight}" '
            f'fill="{color}" text-anchor="{anchor}">{_xml(text)}</text>'
        )
        self._excali_elements.append(_excali_text(x, y - size, text, size=size, align=anchor, color=color))

    def text(self, x, y, text, size=12, weight="normal", color=None, anchor="start"):
        """Alias for label."""
        self.label(x, y, text, size=size, weight=weight, color=color, anchor=anchor)

    def arrow(self, x1, y1, x2, y2, label=None, kind="neutral", dashed=False, label_offset=-6):
        """Arrow with optional mid-label."""
        stroke = PALETTE[kind]
        dash = ' stroke-dasharray="6,4"' if dashed else ""
        marker = f'_arrow_{kind}_{1 if dashed else 0}'
        self._ensure_marker(marker, stroke)
        self._svg_parts.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="1.6"{dash} '
            f'marker-end="url(#{marker})"/>'
        )
        if label:
            mx = (x1 + x2) / 2
            my = (y1 + y2) / 2 + label_offset
            self._svg_parts.append(
                f'<text x="{mx}" y="{my}" font-family="Red Hat Text, Arial, sans-serif" font-size="11" '
                f'fill="{PALETTE["muted"]}" text-anchor="middle">{_xml(label)}</text>'
            )
        # Excalidraw arrow
        self._excali_elements.append(_excali_arrow(x1, y1, x2, y2, kind, dashed))
        if label:
            self._excali_elements.append(
                _excali_text((x1+x2)/2, (y1+y2)/2 + label_offset - 12, label, size=11, color=EXCALI_STROKE["muted"], align="center")
            )

    def divider(self, x1, y1, x2, y2, kind="grid"):
        """Light separator line."""
        stroke = PALETTE.get(kind, PALETTE["grid"])
        self._svg_parts.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="1" stroke-dasharray="3,4"/>'
        )

    def panel(self, x, y, w, h, fill=None, stroke=None, r=8):
        """Soft background callout panel."""
        fill = fill or PALETTE["panel"]
        stroke = stroke or PALETTE["grid"]
        self._svg_parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="1"/>'
        )
        self._excali_elements.append(_excali_rect(x, y, w, h, "panel"))

    def chip(self, x, y, label, kind="rest", w=None):
        """Pill-shaped chip (HTTP method, status code, etc.)."""
        # auto-size width from text
        if w is None:
            w = max(48, 10 + 8 * len(label))
        h = 22
        fill = PALETTE[kind]
        self._svg_parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="11" ry="11" fill="{fill}"/>'
        )
        self._svg_parts.append(
            f'<text x="{x + w/2}" y="{y + 15}" font-family="Red Hat Mono, Menlo, monospace" font-size="11" '
            f'font-weight="600" fill="#FFFFFF" text-anchor="middle">{_xml(label)}</text>'
        )
        self._excali_elements.append(_excali_rect(x, y, w, h, kind))
        self._excali_elements.append(_excali_text(x + w/2, y + 4, label, size=11, align="center", color="#FFFFFF", bold=True))

    def code_block(self, x, y, w, h, lines, lang="rest"):
        """Dark code block with monospace lines."""
        self._svg_parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" ry="6" fill="{PALETTE["code"]}"/>'
        )
        line_h = 16
        for i, ln in enumerate(lines):
            color = "#8FB98F" if ln.lstrip().startswith("#") or ln.lstrip().startswith("//") else PALETTE["code_fg"]
            self._svg_parts.append(
                f'<text x="{x + 12}" y="{y + 22 + i*line_h}" '
                f'font-family="Red Hat Mono, Menlo, monospace" font-size="11" '
                f'fill="{color}">{_xml(ln)}</text>'
            )
        self._excali_elements.append(_excali_rect(x, y, w, h, "neutral"))
        for i, ln in enumerate(lines):
            self._excali_elements.append(_excali_text(x + 12, y + 10 + i*16, ln, size=11, color=EXCALI_STROKE["neutral"]))

    # -------- markers (arrows) --------
    def _ensure_marker(self, key, color):
        if not hasattr(self, "_markers"):
            self._markers = {}
        self._markers[key] = color

    def _svg_defs(self):
        if not getattr(self, "_markers", None):
            return ""
        parts = ["<defs>"]
        for key, color in self._markers.items():
            parts.append(
                f'<marker id="{key}" viewBox="0 0 10 10" refX="9" refY="5" '
                f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
                f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{color}"/></marker>'
            )
        parts.append("</defs>")
        return "".join(parts)

    # -------- output --------
    def write(self):
        os.makedirs(DIAG_DIR, exist_ok=True)
        # SVG
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} {self.height}" '
            f'width="{self.width}" height="{self.height}">'
            + self._svg_defs()
            + "".join(self._svg_parts)
            + "</svg>"
        )
        with open(f"{DIAG_DIR}/{self.name}.svg", "w") as f:
            f.write(svg)
        # Excalidraw JSON
        excali = {
            "type": "excalidraw",
            "version": 2,
            "source": "dgen.py",
            "elements": self._excali_elements,
            "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None},
            "files": {},
        }
        with open(f"{DIAG_DIR}/{self.name}.excalidraw", "w") as f:
            json.dump(excali, f, indent=2)


# ---------------------------------------------------------------
# helpers
# ---------------------------------------------------------------
def _xml(s):
    """Escape text for SVG."""
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _excali_rect(x, y, w, h, kind):
    sk = EXCALI_STROKE.get(kind, EXCALI_STROKE["neutral"])
    fl = EXCALI_FILL.get(kind, EXCALI_FILL["neutral"])
    return {
        "id": str(uuid.uuid4()),
        "type": "rectangle",
        "x": x, "y": y, "width": w, "height": h,
        "angle": 0,
        "strokeColor": sk,
        "backgroundColor": fl,
        "fillStyle": "hachure" if kind == "panel" else "solid",
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "roundness": {"type": 3},
        "seed": 1,
        "version": 1,
        "versionNonce": 1,
        "isDeleted": False,
        "boundElements": None,
        "updated": 1,
        "link": None,
        "locked": False,
    }


def _excali_text(x, y, text, size=14, align="start", color=None, bold=False):
    color = color or EXCALI_STROKE["neutral"]
    text = str(text)
    width = max(20, int(size * 0.6 * len(text)))
    align_map = {"start": "left", "middle": "center", "center": "center", "end": "right"}
    return {
        "id": str(uuid.uuid4()),
        "type": "text",
        "x": x - (width / 2 if align in ("middle", "center") else 0),
        "y": y,
        "width": width,
        "height": size + 4,
        "angle": 0,
        "strokeColor": color,
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "seed": 1,
        "version": 1,
        "versionNonce": 1,
        "isDeleted": False,
        "boundElements": None,
        "updated": 1,
        "link": None,
        "locked": False,
        "fontSize": size,
        "fontFamily": 1,
        "text": text,
        "textAlign": align_map.get(align, "left"),
        "verticalAlign": "top",
        "containerId": None,
        "originalText": text,
        "lineHeight": 1.25,
        "baseline": size,
    }


def _excali_arrow(x1, y1, x2, y2, kind, dashed):
    sk = EXCALI_STROKE.get(kind, EXCALI_STROKE["neutral"])
    return {
        "id": str(uuid.uuid4()),
        "type": "arrow",
        "x": x1,
        "y": y1,
        "width": x2 - x1,
        "height": y2 - y1,
        "angle": 0,
        "strokeColor": sk,
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 1,
        "strokeStyle": "dashed" if dashed else "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "seed": 1,
        "version": 1,
        "versionNonce": 1,
        "isDeleted": False,
        "boundElements": None,
        "updated": 1,
        "link": None,
        "locked": False,
        "points": [[0, 0], [x2 - x1, y2 - y1]],
        "lastCommittedPoint": None,
        "startBinding": None,
        "endBinding": None,
        "startArrowhead": None,
        "endArrowhead": "arrow",
    }
