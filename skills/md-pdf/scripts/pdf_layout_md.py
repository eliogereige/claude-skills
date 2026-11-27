"""
pdf_layout_md — PyMuPDF block/line/span layout to Markdown for ``md_to_power_pdf`` round-trips.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

from universal_pdf_extract import build_page_payload, parse_page_spec

# PyMuPDF link kind for external URIs
_LINK_URI = 2


def _href_for_md(href: str) -> str:
    """Escape a URL for safe use inside Markdown `(...)` link targets."""
    h = href.strip()
    if re.fullmatch(r"[A-Za-z0-9_\-./:?#%&+=~@!$'()*;,\[\]]+", h) and " " not in h:
        return f"({h})"
    return f"({quote(h, safe='/:#?&=%+~@!$&()*+,;=[]-')})"


def _line_center(bb: list[float] | None) -> tuple[float, float] | None:
    if not bb or len(bb) < 4:
        return None
    return 0.5 * (bb[0] + bb[2]), 0.5 * (bb[1] + bb[3])


def _load_uri_links(page: Any) -> list[tuple[list[float], str]]:
    """(link_rect, uri) for external http(s) and mailto: links; PyMuPDF rect order x0 y0 x1 y1."""
    out: list[tuple[list[float], str]] = []
    try:
        for link in page.get_links() or []:
            if not isinstance(link, dict):
                continue
            u = (link.get("uri") or "").strip()
            if not u or u in ("#",) or u.startswith("javascript:"):
                continue
            k = link.get("kind")
            if k is not None and k != _LINK_URI:
                continue
            r = link.get("from")
            if r is None:
                continue
            try:
                rect = [float(r.x0), float(r.y0), float(r.x1), float(r.y1)]
            except Exception:
                try:
                    rect = [float(r[i]) for i in range(4)]  # type: ignore[index]
                except Exception:
                    continue
            out.append((rect, u))
    except Exception:
        pass
    return out


def _point_in_rect(x: float, y: float, r: list[float] | None) -> bool:
    if not r or len(r) < 4:
        return False
    return r[0] <= x <= r[2] and r[1] <= y <= r[3]


def _uri_for_line_center(
    bb: list[float] | None, links: list[tuple[list[float], str]]
) -> str | None:
    c = _line_center(bb)
    if not c:
        return None
    cx, cy = c
    for rect, uri in links:
        if _point_in_rect(cx, cy, rect):
            return uri
    return None


def _apply_link_to_line(content: str, uri: str | None) -> str:
    if not uri:
        return content
    t = content.rstrip("\n")
    st = t.lstrip()
    if st.startswith("#") or st.startswith("| ") or re.match(
        r"^[\s\n]*---[\s\n]*$", t
    ):
        return content
    if "](" in t:
        return content
    return f"[{t}]{_href_for_md(uri)}\n"


def _sort_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def k(b: dict[str, Any]) -> tuple[float, float]:
        bb = b.get("bbox") or [0, 0, 0, 0]
        if isinstance(bb, (list, tuple)) and len(bb) >= 2:
            return (float(bb[1]), float(bb[0]))
        return (0.0, 0.0)

    return sorted((b for b in blocks if b.get("type") == 0), key=k)


def _all_span_sizes(blocks: list[dict[str, Any]]) -> list[float]:
    s: list[float] = []
    for b in blocks:
        for li in b.get("lines", []):
            for sp in li.get("spans", []):
                z = sp.get("size", 0)
                if isinstance(z, (int, float)) and z > 0.5:
                    s.append(float(z))
    return s


def _median(sizes: list[float], d: float = 10.0) -> float:
    if not sizes:
        return d
    t = sorted(sizes)
    m = len(t) // 2
    return t[m] if len(t) % 2 else 0.5 * (t[m - 1] + t[m])


def _line_metrics(line: dict[str, Any]) -> tuple[float, bool]:
    mx, bold = 0.0, False
    for sp in line.get("spans", []):
        s = sp.get("size", 0)
        if isinstance(s, (int, float)):
            mx = max(mx, float(s))
        st = sp.get("style_inferred") or {}
        if st.get("bold"):
            bold = True
    return mx, bold


def _spans_inline_gfm(spans: list[dict[str, Any]]) -> str:
    p: list[str] = []
    for sp in spans:
        t = str(sp.get("text", ""))
        st = sp.get("style_inferred") or {}
        b, it, m = st.get("bold"), st.get("italic"), st.get("monospaced")
        if m:
            t = t.replace("`", "′")
            t = f"`{t}`"
        elif b and it:
            t = f"***{t}***"
        elif b:
            t = f"**{t}**"
        elif it:
            t = f"*{t}*"
        p.append(t)
    return "".join(p).strip()


def _plain_line(spans: list[dict[str, Any]]) -> str:
    s = " ".join(str(s.get("text", "")) for s in spans)
    return s.replace("\n", " ").strip()


def _in_table(line_bb: list[float] | None, trects: list[list[float]]) -> bool:
    if not line_bb or len(line_bb) < 4 or not trects:
        return False
    cx, cy = 0.5 * (line_bb[0] + line_bb[2]), 0.5 * (line_bb[1] + line_bb[3])
    for r in trects:
        if r and len(r) >= 4 and r[0] <= cx <= r[2] and r[1] <= cy <= r[3]:
            return True
    return False


def _gfm_table(data: list[list[str | None]]) -> str:
    if not data:
        return ""
    w = max(len(r) for r in data)

    def c(x: str | None) -> str:
        s = ("" if x is None else str(x)).replace("\n", " ").replace("|", "¦")
        return s.strip()

    def pad(r: list[str | None]) -> list[str]:
        r = r + [None] * (w - len(r))
        return [c(cel) for cel in r]

    rows = [pad(r) for r in data if r is not None]
    if not rows or not any(x.strip() for r in rows for x in r):
        return ""
    h, sep, body = rows[0], ["---"] * w, rows[1:]
    lines = [h, sep] + body
    return "\n".join("| " + " | ".join(row) + " |" for row in lines) + "\n\n"


def _table_parts(page: Any) -> list[tuple[float, str, list[float]]]:
    o: list[tuple[float, str, list[float]]] = []
    try:
        finder = page.find_tables()
    except Exception:
        return o
    for tab in getattr(finder, "tables", []) or []:
        try:
            bb = tab.bbox
            rect: list[float] = [float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])] if bb else [0, 0, 0, 0]
        except Exception:
            rect = [0, 0, 0, 0]
        y = float(rect[1]) if rect else 0.0
        try:
            data = tab.extract() or []
        except Exception:
            data = []
        g = _gfm_table(data)
        if g.strip():
            o.append((y, g, rect))
    o.sort(key=lambda x: x[0])
    return o


def _line_to_md(
    line: dict[str, Any], body: float, ph: float, y0: float, pno: int
) -> str:
    sp = line.get("spans", [])
    if not sp:
        return ""
    g, plain = _spans_inline_gfm(sp), _plain_line(sp)
    t = (g or plain).strip()
    if not t:
        return ""
    bsz = max(5.0, body)
    mx, bold = _line_metrics(line)
    ratio = mx / bsz

    tnop = t.replace(" ", "")
    if len(t) <= 60 and len(tnop) >= 3 and tnop and set(tnop) <= {"-", "_"} and "-" in t:
        return "\n---\n\n"

    u = t.lstrip()
    if u and u[0] == "•" and (len(u) == 1 or u[1:2] == " "):
        return f"- {u[1:].lstrip()}\n"
    if u.startswith("- ") and not t.startswith("**--"):
        r2 = u[2:].lstrip()
        if r2:
            return f"- {r2}\n"

    short = len(plain) < 200
    if pno == 0 and y0 < ph * 0.3 and ratio >= 1.25 and short:
        if not re.match(r"^[\d.]+$", t) and t[0:1] not in (".", ","):
            return f"# {g or plain}\n\n"
    if re.match(r"^(\d+(?:\.\d+)+[.)]?\s+).+", t) and short and (ratio > 1.0 or bold):
        if t[0:1] not in (".", ",") and t[0:1] != "•":
            return f"## {g or plain}\n\n"
    if ratio >= 1.2 and short and t[0:1] not in (".", ","):
        return f"## {g or plain}\n\n" if t[0:1] != "•" else (g or plain) + "\n"
    if ratio >= 1.1 and short and t[0:1] not in (".", ",") and t[0:1] != "•":
        return f"### {g or plain}\n\n" if (bold or ratio > 1.2) else (g or plain) + "\n"
    if ratio >= 1.06 and bold and len(plain) < 100 and t[0:1] not in (".", ",") and t[0:1] != "•":
        return f"#### {g or plain}\n\n"
    return (g or plain) + "\n"


def _extract_page_images(
    page: Any,
    doc: Any,
    pno: int,
    image_dir: Path,
    out_md: Path,
) -> str:
    """Write embedded images to ``image_dir``; return GFM for ``out_md`` relative paths."""
    seen: set[int] = set()
    parts: list[str] = []
    for item in page.get_images() or ():
        try:
            xref = int(item[0])
        except Exception:
            continue
        if xref in seen:
            continue
        seen.add(xref)
        try:
            info = doc.extract_image(xref)
        except Exception:
            continue
        if not info or "image" not in info:
            continue
        ext = str(info.get("ext") or "png").lstrip(".")
        if not ext or len(ext) > 8:
            ext = "png"
        fn = f"p{pno}_x{xref}.{ext}"
        dest = (image_dir / fn).resolve()
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(info["image"])
        except OSError:
            continue
        rel = os.path.relpath(dest, start=out_md.parent.resolve())
        rel = rel.replace("\\", "/")
        parts.append(f"![p{pno}]({rel})\n\n")
    return "".join(parts)


def page_to_markdown(
    page: Any,
    pno: int,
    pl: dict[str, Any],
    *,
    apply_uri_links: bool = True,
) -> str:
    links = _load_uri_links(page) if apply_uri_links else []
    blocks = _sort_blocks(list(pl.get("blocks", [])))
    ph = float(pl.get("height_pt", 600) or 600.0)
    body = _median(_all_span_sizes(blocks), 10.0)
    tabs = _table_parts(page)
    trects = [r[2] for r in tabs]
    segs: list[tuple[float, str]] = []
    for b in blocks:
        for li in b.get("lines", []):
            bbx = li.get("bbox")
            bb4 = [float(bbx[i]) for i in range(4)] if isinstance(bbx, (list, tuple)) and len(bbx) >= 4 else None
            y0 = bb4[1] if bb4 else 0.0
            if trects and _in_table(bb4, trects):
                continue
            s = _line_to_md(li, body, ph, y0, pno)
            if links and bb4 and apply_uri_links:
                uu = _uri_for_line_center(bb4, links)
                if uu:
                    s = _apply_link_to_line(s, uu)
            if s.strip():
                segs.append((y0, s))
    for y, gfm, _ in tabs:
        if gfm.strip():
            segs.append((y, gfm))
    segs.sort(key=lambda x: x[0])
    return "\n".join(s for _, s in segs).strip() + "\n\n"


def document_to_markdown(
    pdf_path: str | Path,
    page_indices: list[int] | None = None,
    *,
    page_comments: bool = True,
    image_dir: Path | str | None = None,
    out_md: Path | str | None = None,
    apply_uri_links: bool = True,
) -> str:
    """Layout-driven Markdown. If ``image_dir`` is set, ``out_md`` is required (for relative image paths)."""
    import fitz  # type: ignore

    pdf_p = Path(pdf_path)
    if image_dir is not None and not out_md:
        raise ValueError("document_to_markdown: out_md is required when image_dir is set")

    img_resolved: Path | None = None
    out_resolved: Path | None = None
    if image_dir is not None and out_md is not None:
        out_resolved = Path(out_md).resolve()
        tmp = Path(image_dir)
        img_resolved = tmp.resolve() if tmp.is_absolute() else (out_resolved.parent / tmp).resolve()

    doc = fitz.open(pdf_p)
    try:
        n = len(doc)
        pnos: list[int] = list(page_indices) if page_indices is not None else list(range(n))
        pnos = [i for i in pnos if 0 <= i < n]
        out: list[str] = []
        for i in pnos:
            p = doc[i]
            pl = build_page_payload(p, i, text_mode="dict")
            block: list[str] = []
            if page_comments:
                block.append(f"<!-- page {i} -->\n")
            block.append(
                page_to_markdown(p, i, pl, apply_uri_links=apply_uri_links)
            )
            if img_resolved is not None and out_resolved is not None:
                block.append(
                    _extract_page_images(
                        p, doc, i, img_resolved, out_resolved
                    )
                )
            out.append("".join(block))
        return "\n\n".join(out).rstrip() + "\n"
    finally:
        doc.close()


def pages_arg_to_indices(pages: str, page_count: int) -> list[int] | None:
    if not (pages and str(pages).strip()):
        return None
    return parse_page_spec(pages, page_count)