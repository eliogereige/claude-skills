---
name: md-pdf
description: Turns math-heavy technical Markdown (LaTeX equations, Mermaid diagrams, long tables, figures) into a clean LaTeX-typeset PDF, and goes the other way, recovering editable Markdown or a full layout map (positions, fonts, colours as JSON plus HTML preview) from an existing PDF. Use when the user asks to "make a PDF of this .md", "compile my notes/model doc/technical write-up to PDF", "render the equations properly", "get the Markdown back from this PDF", or "extract the layout of this PDF". Do NOT use for brand-styled deliverables that have their own templates, for merging, splitting, filling or watermarking PDFs (use the pdf skill), for plain text dumps of office files (use markitdown), or for documents already written in LaTeX.
compatibility: Windows, Python 3.10+ with reportlab, matplotlib, pillow, pymupdf; MiKTeX or TeX Live (pdflatex on PATH) for the LaTeX route. Fully local, no network.
metadata:
  version: 1.0.0
  notes: preamble fix (literal backslash-n after author gave 4 LaTeX errors per build) in md_to_power_pdf.py and md_to_latex_pdf.py; LATEX_ERRORS log scan in md_to_power_pdf.py; build_pdf.py wrapper added.
---

# md-pdf: technical Markdown to PDF, and PDF back to Markdown

Scripts live in this skill's `scripts/` folder (`<this skill's base directory>/scripts/`, called `$S` below).

## Important
- Always run Python with `-X utf8` (the scripts print Unicode; the Windows console crashes on it otherwise).
- Always pass **absolute** input and output paths. Quote paths with spaces.
- Never overwrite the user's source file; outputs go next to it unless the user names another place.
- Brand-styled documents with their own templates are out of scope: stop and use those. Internal technical notes
  that the user explicitly wants as a plain PDF are fine, and stay local (nothing here uses the network).
- Always tell the user which ROUTE built the PDF. If it was not `LATEX`, say so plainly: math quality is lower.

## Mode A: Markdown to PDF (default)
```
python -X utf8 "$S/build_pdf.py" "C:/abs/path/doc.md" [-o "C:/abs/out.pdf"] [--keep-tex] [--strict] [--title "T"]
```
- Builds through pdflatex (amsmath math, booktabs/xltabular tables that break across pages, Mermaid flowcharts as
  PNG, `![alt](img)` figures). Falls back to ReportLab if LaTeX fails, unless `--strict`.
- Use `--strict` when the user cares about equation quality: a LaTeX failure is then an error to fix, not a silent
  downgrade. Use `--keep-tex` when they want to hand-edit the `.tex`.
- Output block: `ROUTE: LATEX | LATEX_WITH_ERRORS | REPORTLAB_FALLBACK | REPORTLAB_FORCED | REPORTLAB_NO_TEX | FAILED`,
  then PDF path, page count, size. Exit 0 = clean LaTeX, 11 = LaTeX recovered from errors, 10 = made by ReportLab,
  1 = failed, 2 = bad input.
- CRITICAL: exit 11 means pdflatex hit errors (listed as `! ...` lines) and still wrote a PDF with the broken parts
  mangled. `--strict` does not catch this. Never hand that PDF over as final: fix the Markdown and rebuild until
  exit 0, or show the user the error list.
- Pass `--title "..."`: without it the title page shows the file name (underscores become spaces).
- After a build, open one or two pages with the Read tool (`pages: "1-2"`) to check equations and tables render,
  before telling the user it is done.

### Writing Markdown that converts well
- Equations: `$...$` inline, `$$...$$` display, written in LaTeX. `\boxed{}` works for display math.
- Pipe tables: with two or more body rows, the first row becomes a repeating bold header.
- Mermaid: ` ```mermaid ` flowcharts only, and the first line must be `flowchart LR` or `flowchart TD`. A `graph LR`
  header is not recognised: it becomes a stray box labelled "LR" and the layout is wrong. Edges are drawn as lines
  without arrowheads.
- Not Pandoc: footnotes, nested lists deeper than two levels, HTML blocks and citations are not handled.

## Mode B: PDF to Markdown
```
python -X utf8 "$S/pdf_to_latex_md.py" "C:/abs/in.pdf" -o "C:/abs/out.md" [--force-extract] [--no-page-comments] [--image-dir "C:/abs/img"] [--pages 0-4]
```
- If a same-stem `.md` sits next to the PDF it is copied instead (that is the true source); pass `--force-extract`
  to extract anyway. Say which happened.
- Extraction is a best effort: equations come back as scattered italic glyphs (e.g. `*E* =* **mc**2*`), not
  LaTeX, and bold spans can come out as `**A**** ****B**`. Tell the user to check equations and formatting by hand.
- `--extract llm` needs `pymupdf4llm`; `--via-latex` needs pandoc. Neither is required by default.

## Mode C: PDF layout map
```
python -X utf8 "$S/universal_pdf_extract.py" "C:/abs/in.pdf" -o "C:/abs/out_base" [--pages 0,2-5] [--extract-images] [--chars]
```
- Writes `out_base.json` (blocks, lines, spans with bbox, font, size, colour, flags) and `out_base.html` (positioned
  preview). `--chars` gives per-glyph boxes and makes the JSON very large; use only when asked.

## Other scripts (rarely needed)
- `md_to_latex_pdf.py in.md [out.tex] --pdf`: minimal Markdown to .tex, for a clean hand-editable .tex.
- `md_to_pdf.py in.md out.pdf`: ReportLab only; use `build_pdf.py --reportlab` instead (absolute paths required:
  relative paths resolve against the skills folder).

- `markdown_convert_gui.py` / `launch_markdown_gui.cmd`: a small tkinter GUI for people who prefer clicking.
  For the user to click, not for Claude to run.

## Troubleshooting
- `UnicodeEncodeError: 'charmap'` → `-X utf8` was missing.
- `ROUTE: REPORTLAB_FALLBACK` → rerun with `--strict --keep-tex` and read the LaTeX error; usual causes are an
  unescaped `%`, `&`, `#` or `_` outside math, or an unsupported command in an equation. Fix the Markdown, rebuild.
- `ROUTE: LATEX_WITH_ERRORS` (exit 11) → read the `! ...` lines. `Undefined control sequence` = a command amsmath
  does not know (define it or rewrite); `Missing $ inserted` = math syntax outside `$...$`, or an unclosed brace or
  environment. Rerun with `--keep-tex` to see the generated .tex around the failing line.
- `existing output PDF was not updated` → the PDF is open in a viewer; ask the user to close it.
- MiKTeX asks to install a missing package on first use → let it (it is MiKTeX's own installer), then rerun.
- `ROUTE: REPORTLAB_NO_TEX` → pdflatex not on PATH (a per-user MiKTeX install is normally at
  `%LOCALAPPDATA%/Programs/MiKTeX/miktex/bin/x64`).
