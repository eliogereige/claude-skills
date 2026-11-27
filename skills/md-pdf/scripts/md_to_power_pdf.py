#!/usr/bin/env python3
"""
md_to_power_pdf — combine LaTeX-quality math (pdflatex) with extras from md_to_pdf:
  - Pipe Markdown tables  → booktabs + xltabular (page breaks; no footer overflow)
  - ```mermaid blocks     → PNG via matplotlib (same as md_to_pdf)
  - ![alt](path)          → includegraphics, relative to the .md file
  - Numbered lists (1. …)
  - Horizontal rules (---)
  - ` ```lang ` fences     → optional listings language
  - If pdflatex is missing or fails, optional ReportLab fallback (md_to_pdf)

Usage:
  python md_to_power_pdf.py INPUT.md
  python md_to_power_pdf.py INPUT.md -o out.pdf
  python md_to_power_pdf.py INPUT.md -o out.pdf --keep-tex
  python md_to_power_pdf.py INPUT.md -o out.pdf --no-fallback
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

# Same-directory imports (this scripts folder)
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))


class OutputPdfUnchangedError(RuntimeError):
    """pdflatex could not update the target PDF; common cause: the file is open/locked."""


LATEX_PREAMBLE = r"""
\documentclass[11pt]{article}
\usepackage[margin=0.75in]{geometry}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage{microtype}
\usepackage{amsmath,amssymb,mathtools}
\usepackage{enumitem}
\usepackage{hyperref}
\usepackage[table]{xcolor}
% [table] enables \rowcolor in tabular / xltabular (used for pipe-table header highlight)
\usepackage{listings}
\usepackage{upquote}
\usepackage{textcomp}
\usepackage{parskip}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{array}
\usepackage{ragged2e}
\usepackage{xltabular}
% xltabular loads tabularx + longtable: tables can break across pages (no overflow into footer)

\hypersetup{
  colorlinks=true,
  linkcolor=blue,
  urlcolor=blue,
  citecolor=blue
}

\setlist[itemize]{topsep=4pt,itemsep=2pt,parsep=0pt}
\setlist[enumerate]{topsep=4pt,itemsep=2pt,parsep=0pt}
\lstset{
  basicstyle=\ttfamily\small,
  breaklines=true,
  columns=fullflexible,
  keepspaces=true,
  frame=single
}

\begin{document}
"""

LATEX_END = r"""
\end{document}
"""


def split_inline_math(text: str) -> list[tuple[str, bool]]:
    parts: list[tuple[str, bool]] = []
    i = 0
    buf: list[str] = []
    in_math = False
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            buf.append(text[i : i + 2])
            i += 2
            continue
        if ch == "$":
            if i + 1 < len(text) and text[i + 1] == "$":
                buf.append("$$")
                i += 2
                continue
            parts.append(("".join(buf), in_math))
            buf = []
            in_math = not in_math
            i += 1
            continue
        buf.append(ch)
        i += 1
    parts.append(("".join(buf), in_math))
    return parts


def escape_latex_text(text: str) -> str:
    parts = split_inline_math(text)
    out: list[str] = []
    for seg, is_math in parts:
        if is_math:
            out.append(f"${seg}$")
        else:
            seg = seg.replace("\\", r"\textbackslash{}")
            replacements = {
                "&": r"\&",
                "%": r"\%",
                "#": r"\#",
                "_": r"\_",
                "{": r"\{",
                "}": r"\}",
                "~": r"\textasciitilde{}",
                "^": r"\textasciicircum{}",
            }
            for k, v in replacements.items():
                seg = seg.replace(k, v)
            out.append(seg)
    return "".join(out)


def convert_inline_markup(text: str) -> str:
    """Stash inline math before escape_latex_text (underscores in tokens must not become \\_)."""
    protected: list[str] = []

    def stash(pattern: str, s: str) -> str:
        def repl(m: re.Match[str]) -> str:
            protected.append(m.group(0))
            # Use only letters in placeholder so escape_latex_text never mangles it
            return f"MATHSNIP{len(protected) - 1}XY"

        return re.sub(pattern, repl, s)

    text = stash(r"(?<!\$)\$(?!\$)(.+?)(?<!\\)\$(?!\$)", text)
    text = escape_latex_text(text)
    text = re.sub(
        r"`([^`]+)`",
        lambda m: r"\texttt{"
        + m.group(1).replace("{", r"\{").replace("}", r"\}")
        + "}",
        text,
    )
    text = re.sub(r"\*\*([^*]+)\*\*", r"\\textbf{\1}", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\\textit{\1}", text)
    for idx, val in enumerate(protected):
        text = text.replace(f"MATHSNIP{idx}XY", val)
    return text


def flush_paragraph(paragraph_lines: list[str], out: list[str]) -> None:
    if not paragraph_lines:
        return
    text = " ".join(line.strip() for line in paragraph_lines if line.strip())
    paragraph_lines.clear()
    if not text:
        return
    out.append(convert_inline_markup(text) + "\n\n")


# --- Tables (subset of GitHub-style pipe tables) ---

def _split_md_table_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def _is_table_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", c.strip()) is not None for c in cells)


def extract_table_block(lines: list[str], start: int) -> tuple[str, int]:
    """Return (LaTeX fragment, index after last table line) or ("", start) if not a table."""
    if start >= len(lines) or not lines[start].strip().startswith("|"):
        return "", start
    raw_rows: list[list[str]] = []
    j = start
    while j < len(lines):
        candidate = lines[j].strip()
        if not candidate:
            break
        if not candidate.startswith("|"):
            break
        raw_rows.append(_split_md_table_row(candidate))
        j += 1
    if not raw_rows:
        return "", start
    rows = [r for r in raw_rows if not _is_table_separator_row(r)]
    if not rows:
        return "", start
    n = max(len(r) for r in rows)

    def pad(r: list[str]) -> list[str]:
        r = r[:n]
        return r + [""] * (n - len(r))

    def header_cell_latex(raw: str) -> str:
        t = convert_inline_markup(raw).strip() if raw else ""
        if not t:
            return t
        return r"{\bfseries " + t + "}"

    # xltabular: like tabularx (X columns wrap) but can split across pages (longtable).
    # A plain table+tabularx will overflow the page and cover the page number in the footer.
    xcol = r">{\RaggedRight\arraybackslash}X"
    colspec = "@{} " + " ".join([xcol] * n) + " @{}"
    out_lines = [
        r"\setlength{\LTpre}{4pt}",
        r"\setlength{\LTpost}{4pt}",
        r"\setlength{\tabcolsep}{5pt}",
        r"\small",
        r"\begin{xltabular}{\linewidth}{" + colspec + "}",
    ]
    # Header row: fill + bold so it reads as a title bar (repeated on each page w/ \endhead)
    _row_head = r"\rowcolor[gray]{0.86}"
    if len(rows) == 1:
        out_lines.append(r"\toprule")
        out_lines.append(_row_head)
        r0 = rows[0]
        cells0 = [header_cell_latex(pad(r0)[k]) for k in range(n)]
        out_lines.append(" & ".join(cells0) + r" \\")
        out_lines.append(r"\bottomrule")
    else:
        # First markdown row = header: repeat on each continuation page
        out_lines.append(r"\toprule")
        out_lines.append(_row_head)
        cells0 = [header_cell_latex(pad(rows[0])[k]) for k in range(n)]
        out_lines.append(" & ".join(cells0) + r" \\")
        out_lines.append(r"\midrule")
        out_lines.append(r"\endhead")
        body = rows[1:]
        for i, r in enumerate(body):
            cells = [convert_inline_markup(pad(r)[k].strip()) for k in range(n)]
            out_lines.append(" & ".join(cells) + r" \\")
            # Horizontal rule between body rows (readability); none after the last row
            if i < len(body) - 1:
                out_lines.append(r"\midrule")
        out_lines.append(r"\bottomrule")
    out_lines.extend([r"\end{xltabular}", ""])
    return "\n".join(out_lines) + "\n", j


def extract_heading_section_id(heading_text: str) -> str | None:
    m = re.match(r"^(\d+(?:\.\d+)*)(?:[.)])?(?:\s|$)", heading_text.strip())
    return m.group(1) if m else None


def _latex_safe_asset_path(p: Path) -> str:
    """Return a path pdflatex can use; copy to TEMP if the path has spaces or TeX-unsafe chars."""
    p = p.resolve()
    s = p.as_posix()
    if not any(ch in s for ch in " %#"):
        return s
    ext = p.suffix if p.suffix else ".bin"
    fd, tmp = tempfile.mkstemp(suffix=ext, prefix="mdasset_")
    try:
        os.close(fd)
    except OSError:
        pass
    shutil.copy2(p, tmp)
    return Path(tmp).as_posix()


def mermaid_to_tex_include(mermaid_code: str, section_id: str | None) -> str:
    from md_to_pdf import _render_mermaid_flowchart

    profile = "section_11" if section_id in {"11", "11.1"} else "default"
    buf = _render_mermaid_flowchart(mermaid_code, profile=profile)
    if not buf:
        return (
            r"\begin{lstlisting}" + "\n"
            + mermaid_code
            + "\n"
            + r"\end{lstlisting}" + "\n\n"
        )
    fd, path = tempfile.mkstemp(suffix=".png", prefix="mermaid_")
    try:
        os.close(fd)
    except OSError:
        pass
    Path(path).write_bytes(buf.getvalue())
    # path is short ASCII; still escape for \includegraphics
    safe = Path(path).as_posix()
    return (
        r"\begin{figure}[htbp]"
        + "\n\\centering\n"
        + rf"\includegraphics[width=0.98\linewidth]{{{safe}}}" + "\n"
        + r"\end{figure}" + "\n\n"
    )


def has_pdflatex() -> bool:
    return shutil.which("pdflatex") is not None


# listings package: language= must match a known identifier (approximate)
_LST_MAP = {
    "py": "Python",
    "python": "Python",
    "r": "R",
    "sh": "bash",
    "bash": "bash",
    "yml": "XML",
    "yaml": "XML",
    "js": "Java",
    "ts": "Java",
    "json": "Java",
}


def _listings_open(lang: str) -> str:
    """Return \\begin{lstlisting}... line for a ``` fence language tag."""
    lang = (lang or "").strip().lower()
    if not lang or lang in ("md", "markdown", "text", "plain"):
        return r"\begin{lstlisting}" + "\n"
    name = _LST_MAP.get(lang, lang)
    if not re.match(r"^[A-Za-z][A-Za-z0-9#+\-]*$", name):
        return r"\begin{lstlisting}" + "\n"
    return rf"\begin{{lstlisting}}[language={name}]" + "\n"


def compile_pdf_tex(tex_path: Path, engine: str = "pdflatex", runs: int = 2) -> Path:
    """Run the LaTeX engine.

    pdflatex often exits with code 1 (warnings, rerun hints) even when a valid PDF
    is written, especially on the second pass; only exit codes 0 and 1 are treated
    as non-fatal, then we require the output PDF to exist.
    If the target PDF could not be overwritten (e.g. open in a viewer on Windows),
    the file is often left unchanged: we raise OutputPdfUnchangedError.
    """
    tex_path = tex_path.resolve()
    out_dir = tex_path.parent
    pdf_path = tex_path.with_suffix(".pdf")
    st_before: tuple[int, int] | None
    if pdf_path.exists():
        s0 = pdf_path.stat()
        st_before = (s0.st_mtime_ns, s0.st_size)
    else:
        st_before = None
    cmd = [engine, "-interaction=nonstopmode", f"-output-directory={out_dir}", str(tex_path)]
    last_proc: subprocess.CompletedProcess[str] | None = None
    for _ in range(runs):
        last_proc = subprocess.run(
            cmd, capture_output=True, text=True, cwd=str(out_dir)
        )
        if last_proc.returncode not in (0, 1):
            sys.stderr.write(
                (last_proc.stdout or "") + "\n" + (last_proc.stderr or "")
            )
            raise RuntimeError(
                f"{engine} failed (exit {last_proc.returncode}) for {tex_path.name}"
            )
    if not pdf_path.exists() or pdf_path.stat().st_size < 1:
        if last_proc is not None:
            sys.stderr.write(
                (last_proc.stdout or "") + "\n" + (last_proc.stderr or "")
            )
        raise FileNotFoundError(
            f"Expected PDF missing or empty after {runs} {engine} run(s): {pdf_path}"
        )
    s1 = pdf_path.stat()
    if st_before is not None and s1.st_mtime_ns == st_before[0] and s1.st_size == st_before[1]:
        if last_proc is not None:
            sys.stderr.write(
                (last_proc.stdout or "") + "\n" + (last_proc.stderr or "")
            )
        raise OutputPdfUnchangedError(
            f"The PDF was not updated: {pdf_path.name}\n"
            "If this file is open in a PDF viewer, close it and run again (Windows file lock)."
        )
    return pdf_path


def md_to_power_latex(
    md_path: Path,
    md_text: str,
    title: str | None,
) -> str:
    lines = md_text.splitlines()
    out: list[str] = [LATEX_PREAMBLE]
    if title is not None:
        out.append(r"\title{" + escape_latex_text(title) + "}\n")
        out.append(r"\author{}" + "\n" + r"\date{}" + "\n" + r"\maketitle" + "\n\n")

    paragraph_lines: list[str] = []
    in_code = False
    code_lines: list[str] = []
    code_lang = ""
    in_itemize = False
    in_enumerate = False
    in_display_math = False
    math_lines: list[str] = []
    current_section_id: str | None = None
    code_mermaid_section: str | None = None

    def close_itemize() -> None:
        nonlocal in_itemize
        if in_itemize:
            out.append(r"\end{itemize}" + "\n\n")
            in_itemize = False

    def close_enumerate() -> None:
        nonlocal in_enumerate
        if in_enumerate:
            out.append(r"\end{enumerate}" + "\n\n")
            in_enumerate = False

    def close_all_lists() -> None:
        close_itemize()
        close_enumerate()

    i = 0
    n_lines = len(lines)
    while i < n_lines:
        line = lines[i]
        stripped = line.strip()

        if in_code:
            if stripped.startswith("```"):
                code_text = "\n".join(code_lines) if code_lines else " "
                if code_lang == "mermaid":
                    out.append(
                        mermaid_to_tex_include(code_text, code_mermaid_section)
                    )
                else:
                    out.append(_listings_open(code_lang))
                    out.append(code_text + "\n")
                    out.append(r"\end{lstlisting}" + "\n\n")
                code_lines.clear()
                in_code = False
                code_lang = ""
                code_mermaid_section = None
            else:
                code_lines.append(line)
            i += 1
            continue

        if in_display_math:
            if stripped.endswith("$$"):
                tail = stripped[:-2]
                if tail:
                    math_lines.append(tail)
                out.append(r"\[" + "\n")
                out.extend(ln + "\n" for ln in math_lines)
                out.append(r"\]" + "\n\n")
                math_lines.clear()
                in_display_math = False
            else:
                math_lines.append(line)
            i += 1
            continue

        if stripped.startswith("```"):
            flush_paragraph(paragraph_lines, out)
            close_all_lists()
            in_code = True
            code_lines = []
            rest = stripped[3:].strip()
            code_lang = rest.split()[0].lower() if rest else ""
            if code_lang in ("", "md", "markdown"):
                code_lang = ""
            code_mermaid_section = current_section_id
            i += 1
            continue

        if stripped.startswith("$$"):
            flush_paragraph(paragraph_lines, out)
            close_all_lists()
            if stripped.endswith("$$") and len(stripped) > 4:
                eq = stripped[2:-2].strip()
                out.append(r"\[" + "\n" + eq + "\n" + r"\]" + "\n\n")
            else:
                in_display_math = True
                math_lines = []
                first = stripped[2:]
                if first:
                    math_lines.append(first)
            i += 1
            continue

        # Pipe table: line starts with |
        if stripped.startswith("|"):
            tbl, j = extract_table_block(lines, i)
            if tbl and j > i:
                flush_paragraph(paragraph_lines, out)
                close_all_lists()
                out.append(tbl)
                i = j
                continue

        if not stripped:
            flush_paragraph(paragraph_lines, out)
            close_all_lists()
            i += 1
            continue

        if re.fullmatch(r"-{3,}\s*", stripped):
            flush_paragraph(paragraph_lines, out)
            close_all_lists()
            out.append(r"\begin{center}\rule{0.4\linewidth}{0.4pt}\end{center}" + "\n\n")
            i += 1
            continue

        img_match = re.fullmatch(r"!\[([^\]]*)\]\(([^)]+)\)", stripped)
        if img_match:
            flush_paragraph(paragraph_lines, out)
            close_all_lists()
            alt, rel = img_match.group(1), img_match.group(2)
            p = (md_path.parent / rel).resolve()
            if p.exists():
                ip = _latex_safe_asset_path(p)
                out.append(r"\begin{figure}[htbp]" + "\n\\centering\n")
                out.append(
                    rf"\includegraphics[width=0.95\linewidth]{{{ip}}}" + "\n"
                )
                if alt.strip():
                    out.append(
                        r"\caption{"
                        + escape_latex_text(alt.strip())
                        + "}"
                    )
                out.append(r"\end{figure}" + "\n\n")
            else:
                out.append(
                    r"\fbox{\parbox{0.9\linewidth}{Image not found: \texttt{"
                    + escape_latex_text(rel)
                    + "}}}"
                )
                out.append("\n\n")
            i += 1
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            flush_paragraph(paragraph_lines, out)
            close_all_lists()
            h_raw = m.group(2).strip()
            current_section_id = extract_heading_section_id(h_raw)
            text = convert_inline_markup(h_raw)
            level = len(m.group(1))
            if level == 1:
                out.append(r"\section{" + text + "}\n\n")
            elif level == 2:
                out.append(r"\subsection{" + text + "}\n\n")
            elif level == 3:
                out.append(r"\subsubsection{" + text + "}\n\n")
            else:
                out.append(r"\paragraph{" + text + "}\n\n")
            i += 1
            continue

        mnum = re.match(r"^(\d+)\.\s+(.+)$", stripped)
        if mnum:
            flush_paragraph(paragraph_lines, out)
            close_itemize()
            if not in_enumerate:
                out.append(r"\begin{enumerate}" + "\n")
                in_enumerate = True
            out.append(
                r"\item " + convert_inline_markup(mnum.group(2).strip()) + "\n"
            )
            i += 1
            continue

        m = re.match(r"^[-*]\s+(.*)$", stripped)
        if m:
            flush_paragraph(paragraph_lines, out)
            close_enumerate()
            if not in_itemize:
                out.append(r"\begin{itemize}" + "\n")
                in_itemize = True
            out.append(r"\item " + convert_inline_markup(m.group(1).strip()) + "\n")
            i += 1
            continue

        subm = re.match(r"^\s+[-*]\s+(.*)$", line)
        if subm:
            flush_paragraph(paragraph_lines, out)
            close_enumerate()
            if not in_itemize:
                out.append(r"\begin{itemize}" + "\n")
                in_itemize = True
            out.append(
                r"\item \quad "
                + convert_inline_markup(subm.group(1).strip())
                + "\n"
            )
            i += 1
            continue

        paragraph_lines.append(line)
        i += 1

    flush_paragraph(paragraph_lines, out)
    close_all_lists()
    if in_code:
        code_text = "\n".join(code_lines) if code_lines else " "
        if code_lang == "mermaid":
            out.append(
                mermaid_to_tex_include(code_text, current_section_id)
            )
        else:
            out.append(_listings_open(code_lang))
            out.append(code_text + "\n" + r"\end{lstlisting}" + "\n\n")
    if in_display_math:
        out.append(r"\[" + "\n")
        out.extend(ln + "\n" for ln in math_lines)
        out.append(r"\]" + "\n\n")

    out.append(LATEX_END)
    return "".join(out)


def run_reportlab_fallback(md_path: Path, pdf_path: Path) -> None:
    from md_to_pdf import markdown_to_pdf

    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_to_pdf(md_path, pdf_path)


def _cleanup_latex_artifacts(out_tex: Path, *, keep_tex: bool) -> None:
    # md-pdf skill addition: nonstopmode recovers from errors and still writes a PDF,
    # so report "! ..." error lines from the log before deleting it.
    log = out_tex.with_suffix(".log")
    if log.exists():
        try:
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
            errs = [ln for ln in lines if ln.startswith("! ")]
            print(f"LATEX_ERRORS: {len(errs)}")
            for ln in errs[:10]:
                print(f"  {ln}")
        except OSError:
            pass
    for ext in (".aux", ".log", ".out"):
        p = out_tex.with_suffix(ext)
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass
    if not keep_tex and out_tex.exists():
        try:
            out_tex.unlink()
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Markdown → LaTeX → PDF (with tables/mermaid), or ReportLab fallback."
    )
    ap.add_argument("input_md", type=Path, help="Input Markdown file")
    ap.add_argument(
        "-o", "--output", type=Path, help="Output PDF (default: stem of input .md)"
    )
    ap.add_argument(
        "--keep-tex", action="store_true", help="Keep the intermediate .tex next to the PDF"
    )
    ap.add_argument(
        "--no-fallback",
        action="store_true",
        help="Do not use ReportLab if pdflatex fails or is missing",
    )
    ap.add_argument("--engine", default="pdflatex", help="LaTeX engine")
    ap.add_argument(
        "--title", default=None, help="Document title (default: derived from filename)"
    )
    ap.add_argument(
        "--reportlab",
        action="store_true",
        help="Use ReportLab (md_to_pdf) only, skip LaTeX",
    )
    args = ap.parse_args()

    input_md: Path = args.input_md.resolve()
    if not input_md.exists():
        print(f"Not found: {input_md}", file=sys.stderr)
        return 1

    out_pdf = (args.output or input_md.with_suffix(".pdf")).resolve()
    out_tex = out_pdf.with_suffix(".tex")
    title = args.title
    if title is None:
        title = input_md.stem.replace("_", " ")

    md_text = input_md.read_text(encoding="utf-8")

    if args.reportlab:
        try:
            run_reportlab_fallback(input_md, out_pdf)
        except Exception as e:
            print("ReportLab conversion failed:", e, file=sys.stderr)
            traceback.print_exc()
            return 1
        print(f"Wrote (ReportLab): {out_pdf}")
        return 0

    if not has_pdflatex():
        if args.no_fallback:
            print("pdflatex not found. Install MiKTeX/TeX Live or use --reportlab", file=sys.stderr)
            return 1
        run_reportlab_fallback(input_md, out_pdf)
        print(f"pdflatex not on PATH; Wrote (ReportLab): {out_pdf}")
        return 0

    tex = md_to_power_latex(input_md, md_text, title=title)
    out_tex.write_text(tex, encoding="utf-8")

    st_out_before: tuple[int, int] | None
    if out_pdf.exists():
        s0b = out_pdf.stat()
        st_out_before = (s0b.st_mtime_ns, s0b.st_size)
    else:
        st_out_before = None

    def _out_pdf_looks_stale() -> bool:
        if st_out_before is None or not out_pdf.exists():
            return False
        s2 = out_pdf.stat()
        return s2.st_mtime_ns == st_out_before[0] and s2.st_size == st_out_before[1]

    try:
        compile_pdf_tex(out_tex, engine=args.engine)
    except OutputPdfUnchangedError as e:
        print(str(e), file=sys.stderr)
        return 1
    except (RuntimeError, OSError) as e:
        if _out_pdf_looks_stale() and not isinstance(e, FileNotFoundError):
            print(
                f"LaTeX build failed: {e}\n"
                f"The existing output PDF was not updated: {out_pdf}\n"
                "If it is open in a viewer, close the file and run again.",
                file=sys.stderr,
            )
            return 1
        if out_pdf.exists() and out_pdf.stat().st_size > 2000 and not _out_pdf_looks_stale():
            print(
                f"LaTeX step raised ({e!s}), but a new PDF was written; "
                "keeping it (not overwriting with ReportLab).",
                file=sys.stderr,
            )
            _cleanup_latex_artifacts(out_tex, keep_tex=args.keep_tex)
            if args.keep_tex:
                print(f"Wrote TeX: {out_tex}")
            print(f"Wrote (LaTeX): {out_pdf}")
            return 0
        print(f"LaTeX build failed: {e}", file=sys.stderr)
        if args.no_fallback:
            return 1
        try:
            run_reportlab_fallback(input_md, out_pdf)
            _cleanup_latex_artifacts(out_tex, keep_tex=args.keep_tex)
            print(f"Wrote (ReportLab fallback): {out_pdf}")
            return 0
        except Exception as fe:
            print(f"Fallback failed: {fe}", file=sys.stderr)
            traceback.print_exc()
            return 1

    _cleanup_latex_artifacts(out_tex, keep_tex=args.keep_tex)
    if args.keep_tex:
        print(f"Wrote TeX: {out_tex}")
    print(f"Wrote (LaTeX): {out_pdf}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
