#!/usr/bin/env python3
"""
pdf_to_latex_md — PDF → Markdown (with optional LaTeX intermediate)

**Reality check:** a PDF is not the same as a hand-written ``.md``. Rounding through a
PDF **cannot** recover the source Markdown: math may be vector glyphs, equations
may be images, and heading levels are layout hints at best. If
``<same-name>.md`` already exists next to your ``.pdf``, that file is the
**source of truth**; this tool can copy it to the output (default) so you are
**not** fooled into editing a “fake” re-extract.

Pipelines
---------

1. **default — same-stem .md (if present, unless** ``--force-extract`` **):** copy
   the hand-edited file for a perfect match (best for your repo).

2. **default — layout extract (``--extract layout``):** `pdf_layout_md` — PyMuPDF
   bboxes, font size vs body, bold/italic, ``find_tables()`` for pipe tables, optional
   **URI links** and **embedded images** (``--image-dir``), aimed at a strong
   **PDF → MD →** ``md_to_power_pdf`` **→ PDF** round-trip (math may still need a pass).

3. **``--extract llm``:** `pymupdf4llm` when installed (optional alternative).

4. **``--via-latex`` — legacy:** plain text → LaTeX carrier → **Pandoc** (needs
   Pandoc).

Optional dependencies
----------------------
  - ``pip install pymupdf`` — default ``--extract layout`` (and ``--pages``).
  - ``pip install pymupdf4llm`` — for ``--extract llm`` ( ships with ``pymupdf``).
  - Pandoc on ``PATH`` — for ``--via-latex`` and layout fallbacks.

Usage
------
  python pdf_to_latex_md.py paper.pdf
  python pdf_to_latex_md.py paper.pdf -o out.md
  python pdf_to_latex_md.py paper.pdf --force-extract
  python pdf_to_latex_md.py paper.pdf --extract llm
  python pdf_to_latex_md.py paper.pdf --pages 0-5
  python pdf_to_latex_md.py paper.pdf --via-latex --keep-tex
  python pdf_to_latex_md.py paper.pdf --no-page-comments --yaml-meta
  python pdf_to_latex_md.py paper.pdf --image-dir _pdf_images
  python pdf_to_latex_md.py paper.pdf --info
  python pdf_to_latex_md.py paper.pdf -q -o out.md
  python pdf_to_latex_md.py --version

Exit codes: 0 on success, non-zero on errors.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

__version__ = "0.2.0"

LATEX_PREAMBLE = r"""\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\begin{document}
"""

LATEX_END = r"""
\end{document}
"""


def has_pandoc() -> bool:
    return shutil.which("pandoc") is not None


def _esc_yaml_str(s: str) -> str:
    s = s.replace("\r", "").replace("\n", " ")
    if s == "" or any(c in s for c in '":#&*[]%'):
        return json.dumps(s, ensure_ascii=False)
    return s


def _yaml_front_matter(
    input_pdf: Path,
    *,
    extract: str,
    pages_in_output: int,
    page_spec: str,
) -> str:
    from datetime import datetime, timezone

    st = (page_spec or "").strip()
    t = str(input_pdf.stem)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    gen = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        "---",
        f"title: {_esc_yaml_str(t)}",
        f"source: {_esc_yaml_str(str(input_pdf.resolve()))}",
        f"pages: {pages_in_output}",
        f"extract: {extract}",
    ]
    if st:
        lines.append(f"page_range: {_esc_yaml_str(st)}")
    lines.append(f"generated: {_esc_yaml_str(gen)}")
    lines.append("---\n")
    return "\n".join(lines) + "\n"


def escape_latex_plain(text: str) -> str:
    out: list[str] = []
    for ch in text:
        if ch in "{}\\#%&$^_~":
            out.append(
                {
                    "{": r"\{",
                    "}": r"\}",
                    "\\": r"\textbackslash{}",
                    "#": r"\#",
                    "%": r"\%",
                    "&": r"\&",
                    "$": r"\$",
                    "_": r"\_",
                    "^": r"\textasciicircum{}",
                    "~": r"\textasciitilde{}",
                }[ch]
            )
        else:
            out.append(ch)
    return "".join(out)


def normalize_extracted_text(raw: str) -> str:
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    chunks = re.split(r"\n\s*\n+", raw)
    out_paras: list[str] = []
    for c in chunks:
        inner = c.strip()
        if not inner:
            continue
        line = re.sub(r"\n+", " ", inner)
        line = re.sub(r" +", " ", line)
        out_paras.append(line)
    return "\n\n".join(out_paras)


def extract_text_pymupdf(pdf_path: Path) -> str:
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    try:
        page_texts: list[str] = []
        for i in range(len(doc)):
            t = (doc[i].get_text() or "").strip()
            if t:
                page_texts.append(t)
    finally:
        doc.close()
    return "\n\n".join(page_texts)


def extract_text_poppler(pdf_path: Path) -> str:
    exe = shutil.which("pdftotext")
    if not exe:
        raise FileNotFoundError("pdftotext not on PATH; install Poppler for Windows, or use --backend pymupdf")
    with tempfile.TemporaryDirectory(prefix="pdf2txt_") as td:
        out_txt = Path(td) / "out.txt"
        r = subprocess.run(
            [exe, "-enc", "UTF-8", "-layout", str(pdf_path), str(out_txt)],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0 or not out_txt.exists():
            err = (r.stderr or r.stdout or "").strip()
            raise RuntimeError(f"pdftotext failed (code {r.returncode}): {err}")
        return out_txt.read_text(encoding="utf-8", errors="replace")


def extract_markdown_pymupdf4llm(pdf_path: Path, pages: list[int] | None = None) -> str:
    import pymupdf4llm

    kw: dict[str, object] = {"show_progress": False, "force_text": True}
    if pages is not None:
        kw["pages"] = pages
    return pymupdf4llm.to_markdown(str(pdf_path), **kw)


def pdf_to_carrier_latex(
    text: str,
    *,
    title: str | None = None,
) -> str:
    body = normalize_extracted_text(text)
    if not body.strip():
        return LATEX_PREAMBLE + r"\paragraph{}\textit{(No extractable text.)}" + LATEX_END
    parts: list[str] = [LATEX_PREAMBLE]
    if title:
        parts.append(
            r"\title{" + escape_latex_plain(title) + "}" + "\n" + r"\date{}" + "\n" + r"\maketitle" + "\n\n"
        )
    for para in body.split("\n\n"):
        p = para.strip()
        if not p:
            continue
        parts.append(escape_latex_plain(p) + "\n\n")
    parts.append(LATEX_END)
    return "".join(parts)


def pandoc_latex_to_markdown(
    tex_path: Path,
    out_md: Path,
    *,
    to_format: str,
) -> None:
    if not has_pandoc():
        raise FileNotFoundError("pandoc not on PATH")
    out_md.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["pandoc", "-f", "latex", "-t", to_format, "-o", str(out_md), str(tex_path)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise RuntimeError(f"pandoc failed (exit {r.returncode}): {err}")


def _maybe_sibling_source_md(
    input_pdf: Path,
    out_md: Path,
    *,
    quiet: bool = False,
) -> int | None:
    """If a same-stem .md exists, copy to out_md and return 0; else return None (continue)."""
    sib = input_pdf.with_suffix(".md")
    if not sib.is_file():
        return None
    try:
        if sib.resolve() == out_md.resolve():
            if not quiet:
                print(
                    f"Output path is already the hand-authored file:\n  {sib}\n"
                    "Nothing to copy. Use --force-extract to build Markdown from the PDF."
                )
            return 0
    except OSError:
        pass
    out_md.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(sib, out_md)
    if not quiet:
        print(
            f"Copied hand-authored source:\n  {sib}\n  ->\n  {out_md}\n"
            "PDF re-extract would not match that file (headings, math, tables are lossy).\n"
            "To ignore this and re-process the PDF, use:  --force-extract\n"
            "To use the old plain-text -> LaTeX -> Pandoc path:  --via-latex --force-extract"
        )
    return 0


def run_plaintext_latex_pandoc(
    input_pdf: Path,
    out_md: Path,
    *,
    backend: str,
    keep_tex: bool,
    tex_out: Path | None,
    title: str | None,
    pandoc_to: str,
    quiet: bool = False,
) -> int:
    if not has_pandoc():
        print("pandoc not on PATH. Install from https://pandoc.org/installing.html", file=sys.stderr)
        return 1

    if title is None:
        title = input_pdf.stem.replace("_", " ")

    if backend == "pymupdf":
        try:
            raw = extract_text_pymupdf(input_pdf)
        except ModuleNotFoundError:
            print(
                "PyMuPDF not installed. Run:  pip install pymupdf  "
                "or use:  --backend poppler  (requires pdftotext on PATH).",
                file=sys.stderr,
            )
            return 1
    else:
        raw = extract_text_poppler(input_pdf)

    tex = pdf_to_carrier_latex(raw, title=title)
    if tex_out is not None:
        tex_path = tex_out.resolve()
        tex_path.write_text(tex, encoding="utf-8")
    elif keep_tex:
        tex_path = out_md.with_suffix(".tex")
        tex_path.write_text(tex, encoding="utf-8")
    else:
        fd, tmp = tempfile.mkstemp(suffix=".tex", prefix="pdf_carrier_")
        try:
            os.close(fd)
        except OSError:
            pass
        tex_path = Path(tmp)
        tex_path.write_text(tex, encoding="utf-8")

    try:
        try:
            pandoc_latex_to_markdown(tex_path, out_md, to_format=pandoc_to)
        finally:
            if tex_out is None and not keep_tex and tex_path.exists():
                try:
                    tex_path.unlink()
                except OSError:
                    pass
    except Exception as e:
        print(f"Pandoc step failed: {e}", file=sys.stderr)
        if tex_out is None and not keep_tex and tex_path.exists():
            try:
                tex_path.unlink()
            except OSError:
                pass
        return 1

    if not quiet:
        print(f"Wrote (via LaTeX + Pandoc): {out_md}")
        if tex_out is not None:
            print(f"Wrote TeX: {tex_out}")
        elif keep_tex and out_md.with_suffix(".tex").exists():
            print(f"Wrote TeX: {out_md.with_suffix('.tex')}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="PDF to Markdown: prefer same-stem .md, else --extract layout (default) or llm, or --via-latex."
    )
    ap.add_argument(
        "--version",
        action="version",
        version=f"pdf_to_latex_md {__version__}",
    )
    ap.add_argument(
        "-q",
        "--quiet",
        action="store_true",
        help="Suppress success messages (--info still prints its block)",
    )
    ap.add_argument(
        "--info",
        action="store_true",
        help="Print page count and PDF metadata, then exit",
    )
    ap.add_argument("input_pdf", type=Path, help="Input PDF file")
    ap.add_argument(
        "-o", "--output", type=Path, help="Output Markdown (default: stem of the PDF + .md)"
    )
    ap.add_argument(
        "--force-extract",
        action="store_true",
        help="Always extract from the PDF (do not copy a same-stem .md that sits next to the PDF)",
    )
    ap.add_argument(
        "--via-latex",
        action="store_true",
        help="Use plain text → LaTeX carrier → Pandoc (legacy; needs pandoc). Implies re-extract from the PDF.",
    )
    ap.add_argument(
        "--keep-tex", action="store_true", help="Keep the intermediate .tex (only for --via-latex)"
    )
    ap.add_argument(
        "--backend",
        choices=("pymupdf", "poppler"),
        default="pymupdf",
        help="Text backend for --via-latex (default: pymupdf / PyMuPDF)",
    )
    ap.add_argument(
        "--pandoc-to",
        default="gfm",
        help="Pandoc output for --via-latex (default: gfm). Examples: gfm+tex_math_dollars, markdown",
    )
    ap.add_argument(
        "--title",
        default=None,
        help="Title in the LaTeX wrapper (only for --via-latex; default: PDF stem)",
    )
    ap.add_argument(
        "--tex-out",
        type=Path,
        default=None,
        help="Write the intermediate .tex to this path (only for --via-latex; implies keep)",
    )
    ap.add_argument(
        "--extract",
        choices=("layout", "llm"),
        default="layout",
        help="layout: geometry+style Markdown (default, pip install pymupdf). "
        "llm: pymupdf4llm to_markdown (pip install pymupdf4llm).",
    )
    ap.add_argument(
        "--pages",
        type=str,
        default="",
        help="0-based page ranges for layout/llm extract, e.g. 0,1,5-10 (default: all pages)",
    )
    ap.add_argument(
        "--no-page-comments",
        action="store_true",
        help="Omit '<!-- page N -->' lines (layout extract only; cleaner for round-trip to PDF)",
    )
    ap.add_argument(
        "--yaml-meta",
        action="store_true",
        help="Prepend a small YAML block (title, source path, page count, extract mode, date)",
    )
    ap.add_argument(
        "--image-dir",
        type=Path,
        default=None,
        help="Layout only: write embedded images here and add ![](...) relative to -o (requires PyMuPDF)",
    )
    ap.add_argument(
        "--no-uri-links",
        action="store_true",
        help="Layout only: do not turn URI link regions into Markdown links",
    )
    args = ap.parse_args()
    quiet: bool = bool(getattr(args, "quiet", False))
    if args.via_latex and args.info:
        print("Use either --info or --via-latex, not both.", file=sys.stderr)
        return 2

    input_pdf: Path = args.input_pdf.resolve()
    if not input_pdf.is_file():
        print(f"Not found: {input_pdf}", file=sys.stderr)
        return 1
    if input_pdf.suffix.lower() != ".pdf":
        if not args.quiet:
            print("Warning: input file does not end in .pdf", file=sys.stderr)

    if args.info:
        try:
            import fitz  # type: ignore
        except ModuleNotFoundError:
            print("Install PyMuPDF:  pip install pymupdf", file=sys.stderr)
            return 1
        try:
            doc = fitz.open(str(input_pdf))
        except Exception as e:
            print(f"Open PDF failed: {e}", file=sys.stderr)
            return 1
        try:
            m = doc.metadata or {}
            print(f"path: {input_pdf}\npages: {len(doc)}")
            for key, label in (
                ("format", "format"),
                ("title", "title"),
                ("author", "author"),
                ("subject", "subject"),
                ("keywords", "keywords"),
                ("creationDate", "created"),
                ("modDate", "modified"),
            ):
                v = m.get(key) if m else None
                if v:
                    print(f"{label}: {v}")
        finally:
            doc.close()
        return 0

    out_md = (args.output or input_pdf.with_suffix(".md")).resolve()
    # --via-latex: always re-extract from PDF (sibling .md is for humans; this path is explicit)
    want_sibling = (not args.force_extract) and (not args.via_latex)
    if want_sibling:
        sib_code = _maybe_sibling_source_md(input_pdf, out_md, quiet=quiet)
        if sib_code is not None:
            return sib_code

    if args.via_latex:
        if input_pdf.with_suffix(".md").is_file() and (not args.quiet):
            print(
                "Note: a same-stem .md exists; --via-latex re-extracts from the PDF. "
                "Omit --via-latex to copy the hand-authored .md first.\n",
                file=sys.stderr,
            )
        return run_plaintext_latex_pandoc(
            input_pdf,
            out_md,
            backend=args.backend,
            keep_tex=args.keep_tex,
            tex_out=args.tex_out,
            title=args.title,
            pandoc_to=args.pandoc_to,
            quiet=quiet,
        )

    from pdf_layout_md import pages_arg_to_indices

    pidx: list[int] | None = None
    n_total: int = 0
    spec: str = (args.pages or "").strip()
    need_pymupdf: bool = bool(
        spec
        or (args.yaml_meta and args.extract in ("layout", "llm"))
        or args.extract == "layout"
        or args.image_dir is not None
    )
    if not args.via_latex and need_pymupdf:
        try:
            import fitz  # type: ignore
        except ModuleNotFoundError:
            if spec or args.yaml_meta or args.extract == "layout" or args.image_dir is not None:
                print("Install PyMuPDF:  pip install pymupdf", file=sys.stderr)
                return 1
        else:
            d = fitz.open(str(input_pdf))
            try:
                n_total = len(d)
                if spec:
                    pidx = pages_arg_to_indices(spec, n_total)
            finally:
                d.close()

    page_spec_for_yaml: str = spec

    pages_in_output: int = (len(pidx) if pidx is not None else n_total) if n_total or pidx is not None else 0

    if args.extract == "layout":
        from pdf_layout_md import document_to_markdown

        dmkw: dict[str, object] = {
            "page_comments": not args.no_page_comments,
            "apply_uri_links": not args.no_uri_links,
        }
        if args.image_dir is not None:
            dmkw["image_dir"] = args.image_dir
            dmkw["out_md"] = out_md

        try:
            md = document_to_markdown(
                input_pdf, pidx, **dmkw
            )
        except Exception as e:
            print(f"Layout extract failed: {e}\n", file=sys.stderr)
            if not has_pandoc():
                return 1
            print("Falling back to plain text -> LaTeX -> Pandoc.\n", file=sys.stderr)
            return run_plaintext_latex_pandoc(
                input_pdf,
                out_md,
                backend=args.backend,
                keep_tex=False,
                tex_out=None,
                title=args.title,
                pandoc_to=args.pandoc_to,
                quiet=quiet,
            )
    else:
        # --extract llm: pymupdf4llm
        if not args.quiet:
            if args.image_dir is not None:
                print(
                    "Note: --image-dir is layout-only; ignored for --extract llm.\n",
                    file=sys.stderr,
                )
            if args.no_uri_links:
                print("Note: --no-uri-links is layout-only; ignored for --extract llm.\n", file=sys.stderr)
            if args.no_page_comments:
                print("Note: --no-page-comments is layout-only; ignored for --extract llm.\n", file=sys.stderr)
        try:
            md = extract_markdown_pymupdf4llm(input_pdf, pidx)
        except ModuleNotFoundError:
            if has_pandoc():
                if not args.quiet:
                    print(
                        "pymupdf4llm not installed; use --extract layout, or: pip install pymupdf4llm, "
                        "or falling back to --via-latex (plain text)...\n",
                        file=sys.stderr,
                    )
                return run_plaintext_latex_pandoc(
                    input_pdf,
                    out_md,
                    backend=args.backend,
                    keep_tex=False,
                    tex_out=None,
                    title=args.title,
                    pandoc_to=args.pandoc_to,
                    quiet=quiet,
                )
            print(
                "pymupdf4llm is not installed. Use --extract layout, or: pip install pymupdf4llm\n"
                "Or: install pandoc and use:  --via-latex",
                file=sys.stderr,
            )
            return 1
        except Exception as e:
            print(
                f"pymupdf4llm extract failed: {e}\n",
                file=sys.stderr,
            )
            if not has_pandoc():
                return 1
            return run_plaintext_latex_pandoc(
                input_pdf,
                out_md,
                backend=args.backend,
                keep_tex=False,
                tex_out=None,
                title=args.title,
                pandoc_to=args.pandoc_to,
                quiet=quiet,
            )

    if args.yaml_meta:
        md = _yaml_front_matter(
            input_pdf,
            extract=args.extract,
            pages_in_output=pages_in_output,
            page_spec=page_spec_for_yaml,
        ) + md

    out_md.write_text(md, encoding="utf-8", newline="\n")
    if not quiet:
        print(
            f"Wrote: {out_md}\n"
            "This build targets md_to_power_pdf: headings, bold, pipe tables, rules, optional images/links. "
            "Review math and fine typography by hand; same-stem .md (if any) is still the gold copy.\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
