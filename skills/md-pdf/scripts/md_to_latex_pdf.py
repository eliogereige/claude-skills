#!/usr/bin/env python3
"""
md_to_latex_pdf.py

Convert a Markdown file to LaTeX, then optionally compile it to PDF.

What it handles well:
- #, ##, ### headings
- paragraphs
- bullet lists (- and *)
- fenced code blocks ```
- inline math $...$
- display math $$...$$
- basic emphasis: **bold**, *italic*, `code`

What it does NOT fully parse:
- complex Markdown tables
- nested lists
- arbitrary HTML
- every edge case in Markdown

Usage:
    python md_to_latex_pdf.py input.md
    python md_to_latex_pdf.py input.md output.tex
    python md_to_latex_pdf.py input.md output.tex --pdf
    python md_to_latex_pdf.py input.md output.tex --pdf --engine pdflatex
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


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
\usepackage{xcolor}
\usepackage{listings}
\usepackage{upquote}
\usepackage{textcomp}
\usepackage{parskip}

\hypersetup{
  colorlinks=true,
  linkcolor=blue,
  urlcolor=blue,
  citecolor=blue
}

\setlist[itemize]{topsep=4pt,itemsep=2pt,parsep=0pt}
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
    """
    Split into (segment, is_math) pieces for inline math delimited by single $...$.
    Leaves $$...$$ to block-level parsing.
    """
    parts: list[tuple[str, bool]] = []
    i = 0
    buf = []
    in_math = False
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            buf.append(text[i:i+2])
            i += 2
            continue
        if ch == "$":
            # skip $$ here; handled at block level
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
    """
    Escape LaTeX special chars in normal text, but keep inline math untouched.
    """
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
    """
    Convert basic Markdown inline markup outside of math:
    - **bold**
    - *italic*
    - `code`
    """
    protected: list[str] = []

    def stash(pattern: str, s: str) -> str:
        def repl(m: re.Match[str]) -> str:
            protected.append(m.group(0))
            # No underscores in token — escape_latex_text must not turn _ into \_
            return f"MATHSNIP{len(protected) - 1}XY"
        return re.sub(pattern, repl, s)

    # Protect inline math first.
    text = stash(r'(?<!\$)\$(?!\$)(.+?)(?<!\\)\$(?!\$)', text)

    # Escape normal text first.
    text = escape_latex_text(text)

    # Inline code
    text = re.sub(r'`([^`]+)`', lambda m: r'\texttt{' + m.group(1).replace('{', r'\{').replace('}', r'\}') + '}', text)

    # Bold then italic
    text = re.sub(r'\*\*([^*]+)\*\*', r'\\textbf{\1}', text)
    text = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'\\textit{\1}', text)

    # Restore math
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
    out.append(convert_inline_markup(text) + "\n")


def md_to_latex(md_text: str, title: str | None = None) -> str:
    lines = md_text.splitlines()
    out: list[str] = [LATEX_PREAMBLE]

    if title:
        out.append(r"\title{" + escape_latex_text(title) + "}\n")
        out.append(r"\author{}" + "\n")
        out.append(r"\date{}" + "\n")
        out.append(r"\maketitle" + "\n\n")

    paragraph_lines: list[str] = []
    in_code = False
    code_lines: list[str] = []
    in_itemize = False
    in_display_math = False
    math_lines: list[str] = []

    def close_itemize() -> None:
        nonlocal in_itemize
        if in_itemize:
            out.append(r"\end{itemize}" + "\n\n")
            in_itemize = False

    for raw in lines:
        line = raw.rstrip("\n")
        stripped = line.strip()

        if in_code:
            if stripped.startswith("```"):
                out.append(r"\begin{lstlisting}" + "\n")
                out.extend(l + "\n" for l in code_lines)
                out.append(r"\end{lstlisting}" + "\n\n")
                code_lines.clear()
                in_code = False
            else:
                code_lines.append(line)
            continue

        if in_display_math:
            if stripped.endswith("$$"):
                tail = stripped[:-2]
                if tail:
                    math_lines.append(tail)
                out.append(r"\[" + "\n")
                out.extend(l + "\n" for l in math_lines)
                out.append(r"\]" + "\n\n")
                math_lines.clear()
                in_display_math = False
            else:
                math_lines.append(line)
            continue

        if stripped.startswith("```"):
            flush_paragraph(paragraph_lines, out)
            close_itemize()
            in_code = True
            code_lines = []
            continue

        # display math block
        if stripped.startswith("$$"):
            flush_paragraph(paragraph_lines, out)
            close_itemize()
            if stripped.endswith("$$") and len(stripped) > 4:
                eq = stripped[2:-2].strip()
                out.append(r"\[" + "\n" + eq + "\n" + r"\]" + "\n\n")
            else:
                in_display_math = True
                math_lines = []
                first = stripped[2:]
                if first:
                    math_lines.append(first)
            continue

        if not stripped:
            flush_paragraph(paragraph_lines, out)
            close_itemize()
            continue

        # headings
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            flush_paragraph(paragraph_lines, out)
            close_itemize()
            level = len(m.group(1))
            text = convert_inline_markup(m.group(2).strip())
            if level == 1:
                out.append(r"\section{" + text + "}\n\n")
            elif level == 2:
                out.append(r"\subsection{" + text + "}\n\n")
            elif level == 3:
                out.append(r"\subsubsection{" + text + "}\n\n")
            else:
                out.append(r"\paragraph{" + text + "}\n\n")
            continue

        # bullets
        m = re.match(r"^[-*]\s+(.*)$", stripped)
        if m:
            flush_paragraph(paragraph_lines, out)
            if not in_itemize:
                out.append(r"\begin{itemize}" + "\n")
                in_itemize = True
            item = convert_inline_markup(m.group(1).strip())
            out.append(r"\item " + item + "\n")
            continue

        # normal paragraph line
        paragraph_lines.append(line)

    flush_paragraph(paragraph_lines, out)
    close_itemize()

    if in_code:
        out.append(r"\begin{lstlisting}" + "\n")
        out.extend(l + "\n" for l in code_lines)
        out.append(r"\end{lstlisting}" + "\n\n")

    if in_display_math:
        out.append(r"\[" + "\n")
        out.extend(l + "\n" for l in math_lines)
        out.append(r"\]" + "\n\n")

    out.append(LATEX_END)
    return "".join(out)


def compile_pdf(tex_path: Path, engine: str = "pdflatex", runs: int = 2) -> Path:
    """pdfTeX often returns exit 1 for warnings; accept 0 and 1 if a PDF is produced."""
    tex_path = tex_path.resolve()
    out_dir = tex_path.parent
    pdf_path = tex_path.with_suffix(".pdf")

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
    return pdf_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_md", type=Path, help="Input markdown file")
    parser.add_argument("output_tex", type=Path, nargs="?", help="Output tex path (default: same stem as input)")
    parser.add_argument("--pdf", action="store_true", help="Compile the generated TeX to PDF")
    parser.add_argument("--engine", default="pdflatex", help="LaTeX engine (default: pdflatex)")
    parser.add_argument("--title", default=None, help="Document title")
    args = parser.parse_args()

    input_md = args.input_md.resolve()
    if not input_md.exists():
        raise FileNotFoundError(f"Input markdown not found: {input_md}")

    output_tex = args.output_tex.resolve() if args.output_tex else input_md.with_suffix(".tex")
    title = args.title if args.title is not None else input_md.stem.replace("_", " ")

    md_text = input_md.read_text(encoding="utf-8")
    tex = md_to_latex(md_text, title=title)
    output_tex.write_text(tex, encoding="utf-8")

    print(f"Wrote TeX: {output_tex}")

    if args.pdf:
        pdf_path = compile_pdf(output_tex, engine=args.engine)
        print(f"Wrote PDF: {pdf_path}")


if __name__ == "__main__":
    main()
