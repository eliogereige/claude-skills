#!/usr/bin/env python3
"""
universal_pdf_extract — layout-faithful PDF → structured data (and optional HTML)

What this is
------------
Plain “PDF to text” throws away **where** things are and **how** they look. This
tool keeps (as much as PyMuPDF / MuPDF exposes):

  • Page size and per-page coordinate system (origin top-left, points)
  • Text **blocks** → **lines** → **spans** with bounding boxes
  • Per span: **font** name, **size**, **color**, **flags** (bold / italic / …)
  • Line **direction** and **writing mode** where available
  • Optional: **per-character** boxes and origins (``--chars``; large files)
  • Optional: **embedded images** rasterized to PNG next to the output (``--extract-images``)

Outputs
-------
  • **JSON** — machine-friendly; good for custom pipelines, search, or LLMs with structure
  • **HTML** — one page per “slide”, CSS **position: absolute** from PDF coordinates so
    layout is visually traceable to the source (not a Word replacement, but a faithful
    *geometric* view)

This is still not “recover the author’s original Word/LaTeX file”: a PDF is a
**final-form** print stream. You get **geometry + styling hints**, not semantic
``<h1>`` or editable equations unless you add your own heuristics on top of the JSON.

Dependencies: ``pip install pymupdf`` (PyMuPDF).

Usage
-----
  python universal_pdf_extract.py document.pdf
  python universal_pdf_extract.py document.pdf -o out/base
  python universal_pdf_extract.py document.pdf --no-html
  python universal_pdf_extract.py document.pdf --pages 0-2,5 --chars --extract-images
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------


def _tuple_to_list(obj: Any) -> Any:
    if isinstance(obj, tuple):
        return [_tuple_to_list(x) for x in obj]
    if isinstance(obj, list):
        return [_tuple_to_list(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _tuple_to_list(v) for k, v in obj.items()}
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)


def color_to_hex(c: int | None) -> str:
    if c is None or c < 0:
        return "#000000"
    r = (c >> 16) & 0xFF
    g = (c >> 8) & 0xFF
    b = c & 0xFF
    return f"#{r:02x}{g:02x}{b:02x}"


def interpret_span_flags(flags: int) -> dict[str, bool]:
    """Bit semantics from PyMuPDF span flags (see fitz / MuPDF text span docs)."""
    return {
        "superscript": bool(flags & 1),
        "italic": bool(flags & 2),
        "serif": bool(flags & 4),
        "monospaced": bool(flags & 8),
        "bold": bool(flags & 16),
    }


def enrich_text_dict(d: dict[str, Any]) -> None:
    """In-place: add color_hex, style, and (for spans) char_count."""
    for b in d.get("blocks", []):
        if b.get("type") != 0:
            continue
        for li in b.get("lines", []):
            for sp in li.get("spans", []):
                c = sp.get("color", 0)
                sp["color_hex"] = color_to_hex(c if isinstance(c, int) else 0)
                f = sp.get("flags", 0)
                sp["style_inferred"] = interpret_span_flags(
                    f if isinstance(f, int) else 0
                )
                t = sp.get("text", "")
                sp["char_count"] = len(t)
                for k in (
                    "origin",
                    "bbox",
                ):
                    if k in sp and isinstance(sp[k], (tuple, list)):
                        sp[k] = [float(x) for x in sp[k]]
            bxy = li.get("bbox")
            if isinstance(bxy, (tuple, list)):
                li["bbox"] = [float(x) for x in bxy]
        bb = b.get("bbox")
        if isinstance(bb, (tuple, list)):
            b["bbox"] = [float(x) for x in bb]


def parse_page_spec(spec: str, page_count: int) -> list[int]:
    """Parse e.g. '0-2,5,7-7' into sorted unique 0-based page indices in range."""
    if not spec.strip():
        return list(range(page_count))
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(\d+)\s*-\s*(\d+)$", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a > b:
                a, b = b, a
            for p in range(a, b + 1):
                if 0 <= p < page_count:
                    out.add(p)
        elif part.isdigit():
            p = int(part)
            if 0 <= p < page_count:
                out.add(p)
    if not out:
        raise ValueError(f"No valid page indices in {spec!r} (document has {page_count} pages)")
    return sorted(out)


def build_page_payload(
    page: Any,
    pno: int,
    *,
    text_mode: str,
) -> dict[str, Any]:
    t = page.get_text(text_mode)
    t = _tuple_to_list(t)
    enrich_text_dict(t)  # mutates blocks/lines/spans in page dict
    w, h = float(t.get("width", 0)), float(t.get("height", 0))
    blocks = t.get("blocks", [])
    out: dict[str, Any] = {
        "page_index": pno,
        "width_pt": w,
        "height_pt": h,
        "rect": [0.0, 0.0, w, h],
        "text_mode": text_mode,
        "blocks": blocks,
    }
    return out


# ---------------------------------------------------------------------------
# Image extraction
# ---------------------------------------------------------------------------


def export_page_images(
    doc: Any,
    page: Any,
    pno: int,
    out_dir: Path,
) -> list[dict[str, Any]]:
    """Write image bytes per xref; return manifest with optional ``rect_on_page`` per instance."""
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []
    seen: set[int] = set()
    for info in page.get_images(full=True) or ():
        xref = info[0]
        if xref in seen:
            continue
        seen.add(xref)
        try:
            dimg = doc.extract_image(xref)
        except Exception:
            continue
        if not dimg or not dimg.get("image"):
            continue
        ext = (dimg.get("ext") or "png").lower()
        fname = f"p{pno:04d}_x{xref}.{ext}"
        fpath = out_dir / fname
        fpath.write_bytes(dimg["image"])
        try:
            rlist = list(page.get_image_rects(xref))
        except Exception:
            rlist = []
        if not rlist:
            manifest.append(
                {
                    "file": fname,
                    "path": str(fpath.as_posix()),
                    "xref": xref,
                    "width": dimg.get("width"),
                    "height": dimg.get("height"),
                }
            )
        else:
            for r in rlist:
                entry: dict[str, Any] = {
                    "file": fname,
                    "path": str(fpath.as_posix()),
                    "xref": xref,
                    "width": dimg.get("width"),
                    "height": dimg.get("height"),
                }
                try:
                    entry["rect_on_page"] = [float(r.x0), float(r.y0), float(r.x1), float(r.y1)]
                except Exception:
                    pass
                manifest.append(entry)
    return manifest


# ---------------------------------------------------------------------------
# HTML (absolute positioning from PDF coords)
# ---------------------------------------------------------------------------


def span_to_div_style(sp: dict[str, Any]) -> str:
    """Map span bbox to CSS; PDF y is top-left origin (same as our HTML container)."""
    bb = sp.get("bbox", [0, 0, 0, 0])
    if len(bb) < 4:
        return "display:none;"
    x0, y0, x1, y1 = bb[0], bb[1], bb[2], bb[3]
    w = max(x1 - x0, 0.1)
    h = max(y1 - y0, 0.1)
    size = sp.get("size", 10)
    col = sp.get("color_hex", "#000000")
    st = sp.get("style_inferred", {})
    font = str(sp.get("font", "sans-serif"))
    if any(c in font for c in " ,;"):
        font = font.replace('"', "'")
    fw = "700" if st.get("bold") else "400"
    fsy = "italic" if st.get("italic") else "normal"
    return (
        f"position:absolute;left:{x0:.3f}pt;top:{y0:.3f}pt;width:{w:.3f}pt;min-height:{h:.3f}pt;"
        f"font-size:{float(size):.2f}pt;font-family:'{html.escape(font)}',serif;"
        f"color:{html.escape(col)};font-weight:{fw};font-style:{fsy};"
        f"line-height:1.05;white-space:pre;overflow:visible;"
    )


def build_html(
    document: dict[str, Any],
) -> str:
    """Single-file HTML: one section per page, positioned spans."""
    pages = document.get("pages", [])
    title = html.escape(document.get("meta", {}).get("source", "PDF"))
    parts: list[str] = [
        "<!DOCTYPE html><html><head><meta charset='utf-8'/>"
        f"<title>{title} — layout extract</title><style>"
        "body{background:#2d2d2d;margin:16px;font-family:system-ui,sans-serif;}"
        "section.page{background:#fff;position:relative;margin:0 auto 24px auto;box-shadow:0 1px 8px #0003;}"
        "h2.page-label{margin:0 0 8px 0;font-size:12px;font-weight:600;color:#333;}"
        "span.s{box-sizing:border-box;}"
        "</style></head><body>",
    ]
    for p in pages:
        pno = p.get("page_index", 0)
        w, h = float(p.get("width_pt", 0)), float(p.get("height_pt", 0))
        parts.append(
            f'<section class="page" data-page="{pno}" style="width:{w:.2f}pt;height:{h:.2f}pt">'
        )
        parts.append(
            f'<div class="plabel" style="position:absolute;right:6pt;top:4pt;z-index:2;font:9pt/1.2 system-ui;'
            f'color:#888;">Page {pno} | {w:.0f} x {h:.0f} pt</div>'
        )
        for b in p.get("blocks", []):
            btype = b.get("type", 0)
            if btype == 0:
                for li in b.get("lines", []):
                    for sp in li.get("spans", []):
                        text = str(sp.get("text", ""))
                        if not text and not sp.get("bbox"):
                            continue
                        esc = html.escape(text)
                        sty = span_to_div_style(sp)
                        parts.append(f'<span class="s" style="{sty}">{esc}</span>')
            # type 1 = image in some versions — skip in HTML unless we have manifest cross-ref
        parts.append("</section>")
    parts.append("</body></html>")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(
    pdf_path: Path,
    out_base: Path,
    *,
    pages_spec: str,
    text_mode: str,
    write_json: bool,
    write_html: bool,
    extract_images: bool,
) -> int:
    try:
        import fitz
    except ModuleNotFoundError:
        print("Install PyMuPDF:  pip install pymupdf", file=sys.stderr)
        return 1

    doc = fitz.open(pdf_path)
    try:
        n = len(doc)
        pnos = parse_page_spec(pages_spec, n)
        meta = {
            "source": str(pdf_path.as_posix()),
            "source_name": pdf_path.name,
            "page_count": n,
            "pages_exported": pnos,
            "text_mode": text_mode,
            "format_version": 1,
        }
        pages: list[dict[str, Any]] = []
        img_dir = out_base.parent / (out_base.stem + "_images")
        all_img: list[dict[str, Any]] = []

        for pno in pnos:
            page = doc[pno]
            pl = build_page_payload(page, pno, text_mode=text_mode)
            if extract_images:
                imgs = export_page_images(doc, page, pno, img_dir)
                pl["images"] = imgs
                all_img.extend(imgs)
            pages.append(pl)

        document: dict[str, Any] = {"meta": meta, "pages": pages}
        if extract_images and all_img:
            document["meta"]["image_export_dir"] = str(img_dir.as_posix())
            document["images_summary"] = all_img

        out_base.parent.mkdir(parents=True, exist_ok=True)
        if write_json:
            jpath = out_base.with_suffix(".json") if out_base.suffix.lower() != ".json" else out_base
            jpath.write_text(
                json.dumps(document, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"Wrote JSON: {jpath} ({jpath.stat().st_size} bytes)")

        if write_html:
            hpath = out_base.with_suffix(".html")
            hpath.write_text(build_html(document), encoding="utf-8")
            print(f"Wrote HTML: {hpath} ({hpath.stat().st_size} bytes)")

    finally:
        doc.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Export PDF text layout: geometry, fonts, colors, flags → JSON and/or HTML."
    )
    ap.add_argument("input_pdf", type=Path, help="Input PDF")
    ap.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output file base (without extension), e.g. /path/report_rich  -> report_rich.json, .html",
    )
    ap.add_argument(
        "--pages",
        type=str,
        default="",
        help="0-based page indices, e.g. 0,1,5-10 (default: all pages)",
    )
    ap.add_argument(
        "--mode",
        choices=("dict", "rawdict"),
        default="dict",
        help="dict: spans/lines/blocks. rawdict: + per-character geometry (very large) — same as --chars",
    )
    ap.add_argument(
        "--chars",
        action="store_true",
        help="Alias for --mode rawdict (per-character bboxes in JSON)",
    )
    ap.add_argument(
        "--no-json",
        action="store_true",
        help="Skip JSON output",
    )
    ap.add_argument(
        "--no-html",
        action="store_true",
        help="Skip HTML output",
    )
    ap.add_argument(
        "--extract-images",
        action="store_true",
        help="Rasterize embedded images to PNG in <base>_images/ and list rects in JSON",
    )
    args = ap.parse_args()
    src = args.input_pdf.resolve()
    if not src.is_file():
        print(f"Not found: {src}", file=sys.stderr)
        return 1
    out_base = args.output
    if out_base is None:
        out_base = src.with_name(src.stem + "_layout_extract")
    else:
        out_base = out_base.resolve()

    text_mode = "rawdict" if (args.chars or args.mode == "rawdict") else "dict"
    if text_mode == "rawdict" and not args.chars and args.mode == "rawdict":
        pass  # user chose rawdict explicitly
    if args.chars:
        text_mode = "rawdict"

    if args.no_json and args.no_html:
        print("Nothing to do: use JSON and/or HTML (or remove --no-* flags).", file=sys.stderr)
        return 1

    return run(
        src,
        out_base,
        pages_spec=args.pages,
        text_mode=text_mode,
        write_json=not args.no_json,
        write_html=not args.no_html,
        extract_images=bool(args.extract_images),
    )


if __name__ == "__main__":
    sys.exit(main())
