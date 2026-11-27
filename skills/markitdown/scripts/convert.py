"""Convert local documents to Markdown with Microsoft markitdown (local converters only).

Usage:
    python convert.py INPUT [--out DIR] [--recursive] [--force]

INPUT is a file or a folder. Originals are never modified. Outputs go to a
separate folder (default: a sibling of the source folder named
"<folder>_md"; for a single file, the folder that contains it). An index.md manifest lists every
file with its status and character count, so failures and empty conversions
(e.g. scanned PDFs with no text layer) are visible, never silent.

Only convert_local() is used: no URLs, no plugins, no LLM/Azure features,
so nothing leaves the machine.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

SUPPORTED = {
    ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".msg",
    ".html", ".htm", ".csv", ".json", ".xml", ".epub", ".ipynb", ".txt", ".md",
}
EMPTY_THRESHOLD = 20  # characters; below this the output is flagged as near-empty


def collect(inp: Path, recursive: bool) -> list[Path]:
    if inp.is_file():
        return [inp]
    pattern = "**/*" if recursive else "*"
    return sorted(
        p for p in inp.glob(pattern)
        if p.is_file() and p.suffix.lower() in SUPPORTED and not p.name.startswith("~$")
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path)
    ap.add_argument("--out", type=Path, default=None, help="output folder (must not be the input folder)")
    ap.add_argument("--recursive", action="store_true", help="include subfolders")
    ap.add_argument("--force", action="store_true", help="overwrite existing .md outputs")
    a = ap.parse_args()

    inp = a.input.expanduser().resolve()
    if not inp.exists():
        print(f"ERROR: input not found: {inp}", file=sys.stderr)
        return 2

    if a.out is not None:
        out = a.out.expanduser().resolve()
    else:  # sibling of the source folder, never inside it
        src_dir = inp if inp.is_dir() else inp.parent
        out = src_dir.parent / f"{src_dir.name}_md"
    base = inp if inp.is_dir() else inp.parent
    if out == base:
        print("ERROR: output folder must differ from the input folder", file=sys.stderr)
        return 2

    try:
        from markitdown import MarkItDown
    except ImportError:
        print("ERROR: markitdown not installed. Run: python -m pip install \"markitdown[pdf,docx,pptx,xlsx,xls,outlook]\"",
              file=sys.stderr)
        return 3

    files = collect(inp, a.recursive)
    if not files:
        print(f"No supported files in {inp} (recursive={a.recursive}).")
        return 1

    md = MarkItDown(enable_plugins=False)
    out.mkdir(parents=True, exist_ok=True)
    rows = []  # (relative source, relative output, status, chars)
    for src in files:
        rel = src.relative_to(base)
        dst = out / rel.with_suffix(rel.suffix + ".md")  # keep extension: a.pdf -> a.pdf.md (no name clashes)
        if out in src.parents:
            continue  # never re-convert our own outputs
        if dst.exists() and not a.force:
            rows.append((rel, dst.relative_to(out), "skipped (exists)",
                         len(dst.read_text(encoding="utf-8", errors="replace").strip())))
            continue
        try:
            text = md.convert_local(str(src)).text_content or ""
        except Exception as e:  # report every failure explicitly
            rows.append((rel, None, f"FAILED: {type(e).__name__}: {str(e)[:120]}", 0))
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(text, encoding="utf-8")
        n = len(text.strip())
        status = "ok" if n >= EMPTY_THRESHOLD else "NEAR-EMPTY (scan, image-only, corrupt or tiny: check it)"
        rows.append((rel, dst.relative_to(out), status, n))

    lines = [
        f"# markitdown conversion index",
        "",
        f"- Source: `{inp}`",
        f"- Date: {datetime.now():%Y-%m-%d %H:%M}",
        f"- Recursive: {a.recursive}",
        "",
        "| Source | Markdown | Status | Chars |",
        "| --- | --- | --- | --- |",
    ]
    for rel, dst, status, n in rows:
        link = f"[{dst.as_posix()}]({dst.as_posix().replace(' ', '%20')})" if dst else "-"
        lines.append(f"| {rel.as_posix()} | {link} | {status} | {n} |")
    (out / "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    counts: dict[str, int] = {}
    for *_, status, _n in rows:
        key = status.split(":")[0].split(" ")[0]
        counts[key] = counts.get(key, 0) + 1
    print(f"Output: {out}")
    print("Summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    for rel, _dst, status, n in rows:
        if status != "ok":
            print(f"  {status}  {rel.as_posix()}")
    return 0 if not any(s.startswith("FAILED") for *_, s, _ in rows) else 4


if __name__ == "__main__":
    sys.exit(main())
