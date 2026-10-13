#!/usr/bin/env python3
"""Static validation for the API Patterns and Practices: gRPC Jekyll site.

Stdlib-only (no PyYAML, no Jekyll). Intended to run as:

    python3 -I scripts/validate.py

Checks:
  1. Front matter: every _docs/*.md and _parts/*.md file has a parseable
     front-matter block with the required keys.
  2. Part linkage: every _docs `part:` value matches some _parts `part_name`.
  3. No unguarded Liquid in prose (outside raw blocks / fenced code / a
     bare {% include %} line).
  4. Codetab integrity: fenced code block count immediately following a
     codetabs.html include matches its `langs="A|B|C"` count.
  5. Diagram pairs: every excalidraw.html include has a matching .svg and
     .excalidraw file under assets/diagrams/.
  6. `bash -n` is clean on every *.sh file in the repo.
  7. Coverage: every chapter row in _plans/coverage-matrix.md whose Status is
     not `planned` has its _docs file on disk (guards against a silent
     coverage gap once a chapter is claimed).
  8. Chapter diagram: every such non-`planned` chapter embeds >=1 paired
     SVG+.excalidraw diagram (the depth standard).

Exits 0 when every check passes; exits 1 and prints a per-check failure
report otherwise.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOCS_DIR = REPO_ROOT / "_docs"
PARTS_DIR = REPO_ROOT / "_parts"
COVERAGE_MATRIX = REPO_ROOT / "_plans" / "coverage-matrix.md"

REQUIRED_KEYS = {
    "docs": ["title", "order", "part", "description"],
    "parts": ["title", "order", "part_name", "blurb"],
}

FENCE_RE = re.compile(r"^\s*(```|~~~)")
RAW_OPEN_RE = re.compile(r"\{%-?\s*raw\s*-?%\}")
RAW_CLOSE_RE = re.compile(r"\{%-?\s*endraw\s*-?%\}")
INCLUDE_LINE_RE = re.compile(r"^\{%-?\s*include\b.*%\}-?\s*$")
LIQUID_TOKEN_RE = re.compile(r"\{\{|\{%")

CODETAB_INCLUDE_RE = re.compile(
    r'\{%-?\s*include\s+codetabs\.html\b[^%]*langs="([^"]*)"[^%]*%\}-?'
)
EXCALIDRAW_INCLUDE_RE = re.compile(
    r'\{%-?\s*include\s+excalidraw\.html\b[^%]*file="([^"]*)"[^%]*%\}-?'
)

# Status values in the coverage matrix that mean "the chapter is claimed" and so
# must have a file on disk (and a diagram).
CLAIMED_STATUSES = {"draft", "verified"}

# Cluster-tier example dirs: these require a live cluster and must never carry
# a verify.sh, or the clusterless CI examples matrix would auto-discover and
# fail on them. See .github/workflows/contracts.yml's k8s-manifests job for
# their (cluster-free, static) validation instead.
CLUSTER_TIER_DIRS = ["examples/22-mesh-loadbalancing", "examples/99-appendix-a-openshift-crc"]


class Failure:
    def __init__(self, check: str, message: str) -> None:
        self.check = check
        self.message = message

    def __str__(self) -> str:
        return f"[{self.check}] {self.message}"


def split_front_matter(path: Path) -> tuple[dict | None, str, str | None]:
    """Return (front_matter_dict, body, error). error is None on success."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, text, "missing opening '---' front matter delimiter"

    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return None, text, "missing closing '---' front matter delimiter"

    fm_lines = lines[1:end_idx]
    body = "\n".join(lines[end_idx + 1 :])

    data: dict = {}
    for lineno, raw_line in enumerate(fm_lines, start=2):
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if raw_line[0].isspace():
            return None, text, f"line {lineno}: nested/indented YAML not supported by this validator"
        m = re.match(r"^([A-Za-z0-9_\-]+):\s*(.*)$", raw_line)
        if not m:
            return None, text, f"line {lineno}: cannot parse '{raw_line}'"
        key, value = m.group(1), m.group(2).strip()
        data[key] = _parse_scalar(value)

    return data, body, None


def _parse_scalar(value: str):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if value.lower() in ("true", "false"):
        return value.lower() == "true"
    if value.lower() in ("null", "~", ""):
        return None
    return value


def check_front_matter(
    paths: list[Path], collection: str, failures: list[Failure]
) -> dict[Path, tuple[dict, str]]:
    parsed: dict[Path, tuple[dict, str]] = {}
    required = REQUIRED_KEYS[collection]
    for path in paths:
        fm, body, error = split_front_matter(path)
        rel = path.relative_to(REPO_ROOT)
        if error is not None:
            failures.append(Failure("front-matter", f"{rel}: {error}"))
            continue
        missing = [k for k in required if k not in fm or fm[k] in (None, "")]
        if missing:
            failures.append(
                Failure(
                    "front-matter",
                    f"{rel}: missing required key(s): {', '.join(missing)}",
                )
            )
            continue
        parsed[path] = (fm, body)
    return parsed


def check_part_linkage(
    docs: dict[Path, tuple[dict, str]],
    parts: dict[Path, tuple[dict, str]],
    failures: list[Failure],
) -> None:
    part_names = {fm["part_name"] for fm, _ in parts.values() if "part_name" in fm}
    for path, (fm, _body) in docs.items():
        rel = path.relative_to(REPO_ROOT)
        part_value = fm.get("part")
        if part_value is None:
            continue  # already reported as a missing-key failure
        if part_value not in part_names:
            failures.append(
                Failure(
                    "part-linkage",
                    f"{rel}: part '{part_value}' does not match any _parts part_name "
                    f"({sorted(part_names)})",
                )
            )


def check_unguarded_liquid(
    all_parsed: dict[Path, tuple[dict, str]], failures: list[Failure]
) -> None:
    for path, (_fm, body) in all_parsed.items():
        rel = path.relative_to(REPO_ROOT)
        in_fence = False
        in_raw = False
        for lineno, line in enumerate(body.splitlines(), start=1):
            if FENCE_RE.match(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            if RAW_OPEN_RE.search(line):
                in_raw = True
                continue
            if in_raw:
                if RAW_CLOSE_RE.search(line):
                    in_raw = False
                continue
            if INCLUDE_LINE_RE.match(line.strip()):
                continue
            if LIQUID_TOKEN_RE.search(line):
                failures.append(
                    Failure(
                        "unguarded-liquid",
                        f"{rel}:~{lineno}: unguarded '{{{{' or '{{%' in prose: {line.strip()!r}",
                    )
                )


def check_codetabs(
    all_parsed: dict[Path, tuple[dict, str]], failures: list[Failure]
) -> None:
    for path, (_fm, body) in all_parsed.items():
        rel = path.relative_to(REPO_ROOT)
        lines = body.splitlines()
        for idx, line in enumerate(lines):
            m = CODETAB_INCLUDE_RE.search(line)
            if not m:
                continue
            expected = len([lang for lang in m.group(1).split("|") if lang.strip()])
            count, _next_idx = _count_following_fences(lines, idx + 1)
            if count != expected:
                failures.append(
                    Failure(
                        "codetab-integrity",
                        f"{rel}:~{idx + 1}: codetabs include declares {expected} "
                        f"lang(s) ({m.group(1)}) but {count} fenced code block(s) follow",
                    )
                )


def _count_following_fences(lines: list[str], start: int) -> tuple[int, int]:
    i = start
    count = 0
    n = len(lines)
    while i < n:
        while i < n and not lines[i].strip():
            i += 1
        if i >= n or not FENCE_RE.match(lines[i]):
            break
        fence_marker = lines[i].strip()[:3]
        i += 1
        while i < n and not lines[i].strip().startswith(fence_marker):
            i += 1
        if i < n:
            i += 1  # consume the closing fence
        count += 1
    return count, i


def check_diagram_pairs(
    all_parsed: dict[Path, tuple[dict, str]], failures: list[Failure]
) -> None:
    diagrams_dir = REPO_ROOT / "assets" / "diagrams"
    for path, (_fm, body) in all_parsed.items():
        rel = path.relative_to(REPO_ROOT)
        for m in EXCALIDRAW_INCLUDE_RE.finditer(body):
            name = m.group(1)
            svg_path = diagrams_dir / f"{name}.svg"
            src_path = diagrams_dir / f"{name}.excalidraw"
            missing = []
            if not svg_path.exists():
                missing.append(str(svg_path.relative_to(REPO_ROOT)))
            if not src_path.exists():
                missing.append(str(src_path.relative_to(REPO_ROOT)))
            if missing:
                failures.append(
                    Failure(
                        "diagram-pairs",
                        f"{rel}: excalidraw include 'file=\"{name}\"' missing: "
                        f"{', '.join(missing)}",
                    )
                )


def check_shell_syntax(failures: list[Failure]) -> None:
    skip_dirs = {".git", "_site", ".jekyll-cache", "vendor", "node_modules", ".bundle"}
    sh_files = [
        p
        for p in REPO_ROOT.rglob("*.sh")
        if not any(part in skip_dirs for part in p.relative_to(REPO_ROOT).parts)
    ]
    for sh_file in sorted(sh_files):
        rel = sh_file.relative_to(REPO_ROOT)
        result = subprocess.run(
            ["bash", "-n", str(sh_file)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            failures.append(
                Failure("bash-syntax", f"{rel}: {result.stderr.strip()}")
            )


def _parse_coverage_rows() -> list[tuple[str, str]]:
    """Return (file, status) for each chapter row in the Full chapter inventory
    table of the coverage matrix. File cells are backticked paths."""
    if not COVERAGE_MATRIX.is_file():
        return []
    rows: list[tuple[str, str]] = []
    in_inventory = False
    for line in COVERAGE_MATRIX.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_inventory = stripped.lower().startswith("## full chapter inventory")
            continue
        if not in_inventory or not stripped.startswith("|"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 4:
            continue
        file_cell = cells[1].strip("`").strip()
        status = cells[3].strip().lower()
        if not file_cell.startswith("_docs/"):
            continue  # header/separator row
        rows.append((file_cell, status))
    return rows


def check_coverage(failures: list[Failure]) -> None:
    if not COVERAGE_MATRIX.is_file():
        failures.append(Failure("coverage", "_plans/coverage-matrix.md is missing"))
        return
    for file_cell, status in _parse_coverage_rows():
        if status not in CLAIMED_STATUSES:
            continue
        path = REPO_ROOT / file_cell
        if not path.is_file():
            failures.append(
                Failure(
                    "coverage",
                    f"coverage-matrix status '{status}' but file missing: {file_cell}",
                )
            )
            continue
        body = path.read_text(encoding="utf-8")
        if not EXCALIDRAW_INCLUDE_RE.search(body):
            failures.append(
                Failure(
                    "chapter-diagram",
                    f"{file_cell}: status '{status}' but no paired diagram "
                    "(>=1 excalidraw include required)",
                )
            )


def check_cluster_dir_no_verify(failures: list[Failure]) -> None:
    for rel_dir in CLUSTER_TIER_DIRS:
        dir_path = REPO_ROOT / rel_dir
        if not dir_path.is_dir():
            continue
        for hit in sorted(dir_path.rglob("verify.sh")):
            failures.append(
                Failure(
                    "cluster-dir-no-verify",
                    f"{hit.relative_to(REPO_ROOT)}: cluster-tier dir must not have a "
                    "verify.sh (would be auto-discovered by the clusterless examples "
                    "matrix); validate via the k8s-manifests CI job instead",
                )
            )


def main() -> int:
    failures: list[Failure] = []

    doc_paths = sorted(DOCS_DIR.glob("*.md")) if DOCS_DIR.is_dir() else []
    part_paths = sorted(PARTS_DIR.glob("*.md")) if PARTS_DIR.is_dir() else []

    docs = check_front_matter(doc_paths, "docs", failures)
    parts = check_front_matter(part_paths, "parts", failures)

    check_part_linkage(docs, parts, failures)

    all_parsed = {**docs, **parts}
    check_unguarded_liquid(all_parsed, failures)
    check_codetabs(all_parsed, failures)
    check_diagram_pairs(all_parsed, failures)
    check_shell_syntax(failures)
    check_coverage(failures)
    check_cluster_dir_no_verify(failures)

    checks = [
        "front-matter",
        "part-linkage",
        "unguarded-liquid",
        "codetab-integrity",
        "diagram-pairs",
        "bash-syntax",
        "coverage",
        "chapter-diagram",
        "cluster-dir-no-verify",
    ]
    print(f"Validated {len(doc_paths)} _docs file(s) and {len(part_paths)} _parts file(s).")
    for check in checks:
        check_failures = [f for f in failures if f.check == check]
        status = "FAIL" if check_failures else "ok"
        print(f"  [{status}] {check} ({len(check_failures)} issue(s))")

    if failures:
        print("\nFailures:")
        for f in failures:
            print(f"  - {f}")
        print(f"\n{len(failures)} failure(s).")
        return 1

    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
