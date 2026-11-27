---
name: markitdown
description: Batch-converts a local file or a whole folder of documents (PDF, Word, PowerPoint, Excel, Outlook .msg, HTML, EPUB, CSV) to Markdown with Microsoft markitdown, locally, into a separate output folder with an index. Called by hand only, as /markitdown followed by a path.
disable-model-invocation: true
argument-hint: "path to a file or folder [--recursive] [--out DIR] [--force]"
compatibility: Windows, Python 3.10+ with markitdown[pdf,docx,pptx,xlsx,xls,outlook] installed; no network needed
metadata:
  version: 1.0.0
  source: https://github.com/microsoft/markitdown
---

# markitdown: documents to Markdown

Arguments given: `$ARGUMENTS`

## Important
- Run the bundled script; do not call markitdown by hand or write a new converter.
- Never use URLs, the MCP server, plugins, OCR, audio/YouTube transcription or Azure options: they send content off the
  machine, and the documents may be confidential. The script only uses `convert_local()`.
- Never write into or modify the source folder. The script writes to a separate `_md` folder.
- If no path was given, ask for one. Paths with spaces must be quoted.

## Step 1: Convert
```
python "<this skill's base directory>/scripts/convert.py" "PATH" [--recursive] [--out "DIR"] [--force]
```
- Folder `X` → outputs in sibling `X_md/`; file `X/a.pdf` → `X_md/a.pdf.md`. Subfolder structure is kept.
- NEAR-EMPTY means under 20 characters of text: a scan, image-only page, corrupt file or genuinely tiny file.
- Existing outputs are skipped unless `--force`. Office lock files (`~$...`) are ignored.
- Exit codes: 0 ok, 1 nothing to convert, 2 bad path, 3 markitdown missing, 4 one or more files failed.

## Step 2: Report
- Read the printed summary and `index.md` in the output folder. Tell the user: output folder, counts, and each file that
  FAILED or is NEAR-EMPTY.
- NEAR-EMPTY PDFs are usually scans with no text layer. Do not run cloud OCR; offer a local option instead
  (such as Tesseract, if installed), or reading the PDF directly with the Read tool.
- Then do what the user asked with the Markdown (search, summarise, compare), citing the source file names.

## Known limits
- Word tables: the first row comes out as a body row under an empty header row.
- Excel: one `## SheetName` section per sheet, values only (no formulas, no cell coordinates). For edits, use the xlsx skill.
- PDF: text only; layout, equations and figures are lost. For a single paper you want to read closely, the Read tool on
  the PDF is better.

## Troubleshooting
- `markitdown not installed` → `python -m pip install "markitdown[pdf,docx,pptx,xlsx,xls,outlook]"` (never `[all]`).
- `FAILED: ...MissingDependencyException` → install only the extra named for that format.
- OneDrive "files on demand" not downloaded → the file must be available offline first; report it, do not retry in a loop.
