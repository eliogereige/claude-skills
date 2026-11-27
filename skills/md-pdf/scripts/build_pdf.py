#!/usr/bin/env python3
"""
build_pdf.py - run md_to_power_pdf.py and report, deterministically, which route
produced the PDF and whether the PDF is real and fresh.

Usage:
    python -X utf8 build_pdf.py INPUT.md [-o OUT.pdf] [--keep-tex] [--strict] [--reportlab] [--title T]

--strict   = pass --no-fallback (fail instead of silently using ReportLab).

Prints a final block:
    ROUTE: LATEX | REPORTLAB_FALLBACK | REPORTLAB_FORCED | REPORTLAB_NO_TEX | FAILED
    PDF: <absolute path>   PAGES: <n>   SIZE_KB: <n>
Exit codes: 0 = LaTeX PDF, 10 = PDF made by ReportLab (lower math quality; tell the user),
            1 = failed / no fresh PDF, 2 = bad input.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    ap = argparse.ArgumentParser(description="Markdown to PDF with route report")
    ap.add_argument("input_md", type=Path)
    ap.add_argument("-o", "--output", type=Path)
    ap.add_argument("--keep-tex", action="store_true")
    ap.add_argument("--strict", action="store_true", help="no ReportLab fallback")
    ap.add_argument("--reportlab", action="store_true", help="force ReportLab only")
    ap.add_argument("--title")
    a = ap.parse_args()

    src = a.input_md.resolve()
    if not src.is_file() or src.suffix.lower() not in {".md", ".markdown"}:
        print(f"ROUTE: FAILED\nBad input (not an existing .md file): {src}")
        return 2
    out = (a.output or src.with_suffix(".pdf")).resolve()

    cmd = [sys.executable, "-X", "utf8", str(HERE / "md_to_power_pdf.py"), str(src), "-o", str(out)]
    if a.keep_tex:
        cmd.append("--keep-tex")
    if a.strict:
        cmd.append("--no-fallback")
    if a.reportlab:
        cmd.append("--reportlab")
    if a.title:
        cmd += ["--title", a.title]

    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    log = (p.stdout or "") + (p.stderr or "")
    tail = "\n".join(log.strip().splitlines()[-25:])
    print(tail)
    print("-" * 60)

    if "Wrote (LaTeX)" in p.stdout:
        route = "LATEX"
    elif "Wrote (ReportLab fallback)" in p.stdout:
        route = "REPORTLAB_FALLBACK"
    elif "pdflatex not on PATH" in p.stdout:
        route = "REPORTLAB_NO_TEX"
    elif "Wrote (ReportLab)" in p.stdout:
        route = "REPORTLAB_FORCED"
    else:
        route = "FAILED"

    fresh = out.is_file() and out.stat().st_mtime >= t0 - 1
    if p.returncode != 0 or not fresh:
        print(f"ROUTE: FAILED (exit {p.returncode}, fresh PDF: {fresh})\nPDF: {out}")
        return 1

    pages = "?"
    try:
        import fitz  # PyMuPDF

        with fitz.open(out) as d:
            pages = d.page_count
    except Exception as e:  # report, do not hide
        pages = f"? (could not open: {e})"

    n_err = 0
    for ln in p.stdout.splitlines():
        if ln.startswith("LATEX_ERRORS:"):
            n_err = int(ln.split(":")[1])
    if route == "LATEX" and n_err:
        route = "LATEX_WITH_ERRORS"

    print(f"ROUTE: {route}")
    print(f"PDF: {out}   PAGES: {pages}   SIZE_KB: {out.stat().st_size // 1024}")
    if route == "LATEX_WITH_ERRORS":
        print(f"NOTE: pdflatex hit {n_err} error(s) and recovered; the PDF exists but the affected parts are wrong. "
              "Fix the Markdown and rebuild; do not hand this PDF over as final.")
        return 11
    if route != "LATEX":
        print("NOTE: not built with LaTeX; display math is matplotlib-rendered and inline math approximated.")
        return 10
    return 0


if __name__ == "__main__":
    sys.exit(main())
