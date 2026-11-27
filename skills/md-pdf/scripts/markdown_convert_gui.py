#!/usr/bin/env python3
"""
Document conversion — project converters in one small GUI:

  • LaTeX (.tex)     — md_to_latex_pdf.py  (MD → .tex, optional PDF)
  • PDF (LaTeX)      — md_to_power_pdf.py  (MD → TeX-quality PDF, ReportLab fallback)
  • PDF (legacy)     — md_to_pdf.py        (MD → ReportLab PDF, no TeX)
  • PDF → Markdown   — pdf_to_latex_md.py  (optional same-stem .md, else layout extract or llm; optional --pages)
  • PDF layout       — universal_pdf_extract.py  (JSON: boxes, fonts, colors, flags; + HTML preview)

Run:  python markdown_convert_gui.py
Or:   double-click (if .py is associated with Python)
"""

from __future__ import annotations

import queue
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk, scrolledtext

# Folder that contains the converter scripts
RES: Path = Path(__file__).resolve().parent
# Folder above the scripts — used as cwd for path resolution
ROOT: Path = RES.parent

SCRIPTS = {
    "latex": RES / "md_to_latex_pdf.py",
    "power": RES / "md_to_power_pdf.py",
    "legacy": RES / "md_to_pdf.py",
    "pdf2md": RES / "pdf_to_latex_md.py",
    "layout": RES / "universal_pdf_extract.py",
}


def output_paths_to_be_written(
    mode: str,
    output: Path,
    compile_pdf: bool,
    keep_tex: bool,
) -> list[Path]:
    """Primary files the current settings would create/overwrite (same rules as run_convert)."""
    output = output.resolve()
    out: list[Path] = []
    if mode == "latex":
        out_tex = output if output.suffix.lower() == ".tex" else output.with_suffix(".tex")
        out.append(out_tex)
        if compile_pdf:
            out.append(out_tex.with_suffix(".pdf"))
    elif mode == "power":
        out_pdf = output if output.suffix.lower() == ".pdf" else output.with_suffix(".pdf")
        out.append(out_pdf)
        if keep_tex:
            out.append(out_pdf.with_suffix(".tex"))
    elif mode == "pdf2md":
        out_md = output if output.suffix.lower() == ".md" else output.with_suffix(".md")
        out.append(out_md)
        if keep_tex:  # caller sets keep_tex only when LaTeX path may emit .tex
            out.append(out_md.with_suffix(".tex"))
    elif mode == "layout":
        out_j = output if output.suffix.lower() == ".json" else output.with_suffix(".json")
        out.append(out_j)
        out.append(out_j.with_suffix(".html"))
    else:
        out_pdf = output if output.suffix.lower() == ".pdf" else output.with_suffix(".pdf")
        out.append(out_pdf)
    return out


def _existing_files(paths: list[Path]) -> list[Path]:
    return [p for p in paths if p.is_file()]


def run_convert(
    mode: str,
    input_path: Path,
    output: Path,
    compile_pdf: bool,
    keep_tex: bool,
    log_q: queue.Queue,
    *,
    pdf2md_force_extract: bool = False,
    pdf2md_via_latex: bool = False,
    pdf2md_extract: str = "layout",
    pdf2md_pages: str = "",
    pdf2md_yaml: bool = False,
    pdf2md_no_page_comments: bool = False,
    pdf2md_no_uri_links: bool = False,
    pdf2md_image_dir: str = "",
) -> int:
    """Build subprocess argv; return exit code. Log lines sent to log_q."""
    input_path = input_path.resolve()
    output = output.resolve()
    ex = sys.executable

    script = SCRIPTS.get(mode)
    if script is None or not script.is_file():
        log_q.put(f"ERROR: Missing script: {script}\n")
        return 127

    if mode == "latex":
        out_tex = output if output.suffix.lower() == ".tex" else output.with_suffix(".tex")
        out_final = out_tex
        cmd = [str(ex), str(script), str(input_path), str(out_tex)]
        if compile_pdf:
            cmd.append("--pdf")
    elif mode == "power":
        out_pdf = output if output.suffix.lower() == ".pdf" else output.with_suffix(".pdf")
        out_final = out_pdf
        cmd = [str(ex), str(script), str(input_path), "-o", str(out_pdf)]
        if keep_tex:
            cmd.append("--keep-tex")
    elif mode == "pdf2md":
        out_md = output if output.suffix.lower() == ".md" else output.with_suffix(".md")
        out_final = out_md
        cmd = [str(ex), str(script), str(input_path), "-o", str(out_md)]
        if pdf2md_force_extract:
            cmd.append("--force-extract")
        if pdf2md_via_latex:
            cmd.append("--via-latex")
        else:
            eng = (pdf2md_extract or "layout").strip().lower()
            if eng == "llm":
                cmd.extend(["--extract", "llm"])
            ps = (pdf2md_pages or "").strip()
            if ps:
                cmd.extend(["--pages", ps])
            if pdf2md_yaml:
                cmd.append("--yaml-meta")
            if eng == "layout":
                if pdf2md_no_page_comments:
                    cmd.append("--no-page-comments")
                if pdf2md_no_uri_links:
                    cmd.append("--no-uri-links")
                imgd = (pdf2md_image_dir or "").strip()
                if imgd:
                    cmd.extend(["--image-dir", imgd])
        if keep_tex:
            cmd.append("--keep-tex")
    elif mode == "layout":
        out_j = output if output.suffix.lower() == ".json" else output.with_suffix(".json")
        out_final = out_j
        cmd = [str(ex), str(script), str(input_path), "-o", str(out_j)]
    else:  # legacy
        out_pdf = output if output.suffix.lower() == ".pdf" else output.with_suffix(".pdf")
        out_final = out_pdf
        cmd = [str(ex), str(script), str(input_path), str(out_pdf)]

    log_q.put("Command:\n  " + subprocess.list2cmdline(cmd) + "\n\n")
    log_q.put(f"cwd: {ROOT}\n\n")

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as e:
        log_q.put(f"ERROR: {e}\n")
        return 1

    if proc.stdout:
        log_q.put(proc.stdout)
    if proc.stderr:
        log_q.put("--- stderr ---\n" + proc.stderr)
    if proc.returncode == 0:
        log_q.put(f"\nDone (exit 0). Primary output: {out_final}\n")
    else:
        log_q.put(f"\nExit code: {proc.returncode}\n")
    return proc.returncode


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Markdown / PDF conversion")
        self.minsize(640, 480)
        self._queue: queue.Queue = queue.Queue()
        self._build()
        self.after(200, self._pump_log)

    def _build(self) -> None:
        pad = {"padx": 10, "pady": 6}
        f = ttk.Frame(self, padding=12)
        f.pack(fill=tk.BOTH, expand=True)

        self.input_path = tk.StringVar()
        self.output_path = tk.StringVar()
        self.mode = tk.StringVar(value="power")
        self.compile_latex_pdf = tk.BooleanVar(value=True)
        self.keep_tex = tk.BooleanVar(value=False)

        self.input_label = ttk.Label(f, text="Input Markdown", font=("", 9, "bold"))
        self.input_label.grid(row=0, column=0, sticky="w", **pad)
        row0 = ttk.Frame(f)
        row0.grid(row=1, column=0, columnspan=3, sticky="ew", **pad)
        ttk.Entry(row0, textvariable=self.input_path, width=64).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(row0, text="Browse…", command=self._browse_input).pack(side=tk.LEFT, padx=(8, 0))

        ttk.Label(f, text="Output", font=("", 9, "bold")).grid(row=2, column=0, sticky="w", **pad)
        ttk.Label(
            f,
            text="(path updates when you change mode or input)",
            font=("", 8),
            foreground="gray",
        ).grid(row=2, column=1, columnspan=2, sticky="w", **pad)
        row1 = ttk.Frame(f)
        row1.grid(row=3, column=0, columnspan=3, sticky="ew", **pad)
        ttk.Entry(row1, textvariable=self.output_path, width=64).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(row1, text="Browse…", command=self._browse_output).pack(side=tk.LEFT, padx=(8, 0))

        ttk.Label(f, text="Mode", font=("", 9, "bold")).grid(row=4, column=0, sticky="nw", **pad)
        mode_fr = ttk.Frame(f)
        mode_fr.grid(row=4, column=1, columnspan=2, sticky="w", **pad)
        ttk.Radiobutton(
            mode_fr,
            text="LaTeX — write .tex (md_to_latex_pdf: simple Markdown, best for hand-editing .tex)",
            variable=self.mode,
            value="latex",
            command=self._on_mode,
        ).pack(anchor="w")
        ttk.Radiobutton(
            mode_fr,
            text="PDF (LaTeX style) — md_to_power_pdf: full TeX math, tables, mermaid; needs pdflatex",
            variable=self.mode,
            value="power",
            command=self._on_mode,
        ).pack(anchor="w")
        ttk.Radiobutton(
            mode_fr,
            text="PDF (legacy) — md_to_pdf: ReportLab only, no TeX",
            variable=self.mode,
            value="legacy",
            command=self._on_mode,
        ).pack(anchor="w")
        ttk.Radiobutton(
            mode_fr,
            text="PDF to Markdown — pdf_to_latex_md: same-stem .md copy if present, else layout extract (md_to_power round-trip) or pymupdf4llm; optional legacy (LaTeX+Pandoc)",
            variable=self.mode,
            value="pdf2md",
            command=self._on_mode,
        ).pack(anchor="w")
        ttk.Radiobutton(
            mode_fr,
            text="PDF layout (JSON+HTML) — universal_pdf_extract: bboxes, fonts, colors, bold/italic, optional per-char (--chars) via CLI",
            variable=self.mode,
            value="layout",
            command=self._on_mode,
        ).pack(anchor="w")

        self.pdf2md_force = tk.BooleanVar(value=False)
        self.pdf2md_latex = tk.BooleanVar(value=False)
        self.chk_p2_force = ttk.Checkbutton(
            f,
            text="Force re-extract from PDF (if unchecked, an existing .md with the same stem is copied; exact text match to hand-authored source).",
            variable=self.pdf2md_force,
        )
        self.chk_p2_force.grid(row=5, column=1, columnspan=2, sticky="w", **pad)
        self.pdf2md_extract = tk.StringVar(value="layout")
        self.pdf2md_pages = tk.StringVar(value="")
        p2e_fr = ttk.Frame(f)
        p2e_fr.grid(row=6, column=1, columnspan=2, sticky="w", **pad)
        ttk.Label(p2e_fr, text="PDF extract (not legacy): ").pack(side=tk.LEFT)
        self.cmb_p2_extract = ttk.Combobox(
            p2e_fr,
            textvariable=self.pdf2md_extract,
            values=("layout", "llm"),
            state="readonly",
            width=10,
        )
        self.cmb_p2_extract.pack(side=tk.LEFT, padx=(0, 8))
        ttk.Label(p2e_fr, text="Pages (optional, 0-based):").pack(side=tk.LEFT)
        self.ent_p2_pages = ttk.Entry(p2e_fr, textvariable=self.pdf2md_pages, width=20)
        self.ent_p2_pages.pack(side=tk.LEFT, padx=(4, 0))

        self.pdf2md_yaml = tk.BooleanVar(value=False)
        self.pdf2md_no_page = tk.BooleanVar(value=False)
        self.pdf2md_nouri = tk.BooleanVar(value=False)
        p2o_fr = ttk.Frame(f)
        p2o_fr.grid(row=7, column=1, columnspan=2, sticky="w", **pad)
        self.chk_p2_yaml = ttk.Checkbutton(
            p2o_fr, text="YAML front matter", variable=self.pdf2md_yaml
        )
        self.chk_p2_yaml.pack(side=tk.LEFT, padx=(0, 8))
        self.chk_p2_nopage = ttk.Checkbutton(
            p2o_fr, text="No page comments", variable=self.pdf2md_no_page
        )
        self.chk_p2_nopage.pack(side=tk.LEFT, padx=(0, 8))
        self.chk_p2_nouri = ttk.Checkbutton(
            p2o_fr, text="No URI links", variable=self.pdf2md_nouri
        )
        self.chk_p2_nouri.pack(side=tk.LEFT, padx=(0, 0))
        p2img_fr = ttk.Frame(f)
        p2img_fr.grid(row=8, column=1, columnspan=2, sticky="ew", **pad)
        ttk.Label(p2img_fr, text="Image folder (layout only, relative to output .md ok):").pack(
            side=tk.LEFT
        )
        self.pdf2md_image_dir = tk.StringVar(value="")
        self.ent_p2_imgdir = ttk.Entry(p2img_fr, textvariable=self.pdf2md_image_dir, width=40)
        self.ent_p2_imgdir.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(6, 0))
        self.cmb_p2_extract.bind("<<ComboboxSelected>>", self._on_mode)

        self.chk_p2_latex = ttk.Checkbutton(
            f,
            text="Use legacy: plain text -> LaTeX -> Pandoc (needs Pandoc; slower, flatter; optional .tex with Keep below).",
            variable=self.pdf2md_latex,
            command=self._on_mode,
        )
        self.chk_p2_latex.grid(row=9, column=1, columnspan=2, sticky="w", **pad)

        self.chk_compile = ttk.Checkbutton(
            f,
            text="Also compile PDF (runs pdflatex on the .tex — LaTeX mode only)",
            variable=self.compile_latex_pdf,
        )
        self.chk_compile.grid(row=10, column=1, columnspan=2, sticky="w", **pad)
        self.chk_keep = ttk.Checkbutton(
            f,
            text="Keep intermediate .tex (LaTeX-style PDF, or PDF to Markdown in legacy mode only)",
            variable=self.keep_tex,
        )
        self.chk_keep.grid(row=11, column=1, columnspan=2, sticky="w", **pad)

        btn_row = ttk.Frame(f)
        btn_row.grid(row=12, column=0, columnspan=3, pady=12)
        ttk.Button(btn_row, text="Convert", command=self._convert).pack(side=tk.LEFT, padx=4)
        ttk.Button(btn_row, text="Quit", command=self.destroy).pack(side=tk.LEFT, padx=4)

        ttk.Label(f, text="Log", font=("", 9, "bold")).grid(row=13, column=0, sticky="w", **pad)
        self.log = scrolledtext.ScrolledText(f, height=16, width=80, state=tk.DISABLED, wrap=tk.WORD, font=("Consolas", 9))
        self.log.grid(row=14, column=0, columnspan=3, sticky="nsew", **pad)
        f.rowconfigure(14, weight=1)
        f.columnconfigure(0, weight=1)
        f.columnconfigure(1, weight=1)
        f.columnconfigure(2, weight=1)

        self._on_mode()

    def _on_mode(self, *args) -> None:
        m = self.mode.get()
        if m == "latex":
            self.chk_compile.config(state=tk.NORMAL)
        else:
            self.chk_compile.config(state=tk.DISABLED)
        if m == "power" or (m == "pdf2md" and self.pdf2md_latex.get()):
            self.chk_keep.config(state=tk.NORMAL)
        else:
            self.chk_keep.config(state=tk.DISABLED)
        if m in ("pdf2md", "layout"):
            self.input_label.config(text="Input PDF")
        else:
            self.input_label.config(text="Input Markdown")
        if m == "pdf2md":
            self.chk_p2_force.config(state=tk.NORMAL)
            self.chk_p2_latex.config(state=tk.NORMAL)
            p2e = not self.pdf2md_latex.get()
            self.cmb_p2_extract.config(state=tk.NORMAL if p2e else tk.DISABLED)
            self.ent_p2_pages.config(state=tk.NORMAL if p2e else tk.DISABLED)
            lay = p2e and (self.pdf2md_extract.get() or "layout") == "layout"
            self.chk_p2_yaml.config(state=tk.NORMAL if p2e else tk.DISABLED)
            self.chk_p2_nopage.config(state=tk.NORMAL if lay else tk.DISABLED)
            self.chk_p2_nouri.config(state=tk.NORMAL if lay else tk.DISABLED)
            self.ent_p2_imgdir.config(state=tk.NORMAL if lay else tk.DISABLED)
        else:
            self.chk_p2_force.config(state=tk.DISABLED)
            self.chk_p2_latex.config(state=tk.DISABLED)
            self.cmb_p2_extract.config(state=tk.DISABLED)
            self.ent_p2_pages.config(state=tk.DISABLED)
            self.chk_p2_yaml.config(state=tk.DISABLED)
            self.chk_p2_nopage.config(state=tk.DISABLED)
            self.chk_p2_nouri.config(state=tk.DISABLED)
            self.ent_p2_imgdir.config(state=tk.DISABLED)
        self._default_output_path()

    def _default_output_path(self) -> None:
        raw = self.input_path.get().strip()
        if not raw:
            return
        p = Path(raw)
        m = self.mode.get()
        if m == "latex":
            self.output_path.set(str(p.with_suffix(".tex")))
        elif m == "pdf2md":
            self.output_path.set(str(p.with_suffix(".md")))
        elif m == "layout":
            self.output_path.set(str(p.parent / f"{p.stem}_layout.json"))
        else:
            self.output_path.set(str(p.with_suffix(".pdf")))

    def _browse_input(self) -> None:
        m = self.mode.get()
        if m in ("pdf2md", "layout"):
            p = filedialog.askopenfilename(
                parent=self,
                title="Choose PDF file",
                initialdir=ROOT,
                filetypes=[("PDF", "*.pdf"), ("All", "*.*")],
            )
        else:
            p = filedialog.askopenfilename(
                parent=self,
                title="Choose Markdown file",
                initialdir=ROOT,
                filetypes=[("Markdown", "*.md"), ("Text", "*.txt"), ("All", "*.*")],
            )
        if p:
            self.input_path.set(p)
            self._default_output_path()

    def _browse_output(self) -> None:
        m = self.mode.get()
        if m == "latex":
            p = filedialog.asksaveasfilename(
                parent=self,
                title="Output .tex file",
                initialdir=ROOT,
                defaultextension=".tex",
                filetypes=[("TeX", "*.tex"), ("All", "*.*")],
            )
        elif m == "pdf2md":
            p = filedialog.asksaveasfilename(
                parent=self,
                title="Output Markdown",
                initialdir=ROOT,
                defaultextension=".md",
                filetypes=[("Markdown", "*.md"), ("All", "*.*")],
            )
        elif m == "layout":
            p = filedialog.asksaveasfilename(
                parent=self,
                title="Output base JSON (HTML will be the same name with .html)",
                initialdir=ROOT,
                defaultextension=".json",
                filetypes=[("JSON", "*.json"), ("All", "*.*")],
            )
        else:
            p = filedialog.asksaveasfilename(
                parent=self,
                title="Output PDF",
                initialdir=ROOT,
                defaultextension=".pdf",
                filetypes=[("PDF", "*.pdf"), ("All", "*.*")],
            )
        if p:
            self.output_path.set(p)

    def _append_log(self, text: str) -> None:
        self.log.configure(state=tk.NORMAL)
        self.log.insert(tk.END, text)
        self.log.see(tk.END)
        self.log.configure(state=tk.DISABLED)

    def _pump_log(self) -> None:
        try:
            while True:
                self._append_log(self._queue.get_nowait())
        except queue.Empty:
            pass
        self.after(200, self._pump_log)

    def _convert(self) -> None:
        m = self.mode.get()
        inp = self.input_path.get().strip()
        out = self.output_path.get().strip()
        if not inp:
            label = "PDF" if m in ("pdf2md", "layout") else "Markdown"
            messagebox.showwarning("Input", f"Choose an input {label} file.", parent=self)
            return
        p_in = Path(inp)
        if not p_in.is_file():
            messagebox.showerror("Input", f"File not found:\n{p_in}", parent=self)
            return
        if not out:
            self._default_output_path()
            out = self.output_path.get().strip()
        p_out = Path(out)

        compile_pdf = m == "latex" and self.compile_latex_pdf.get()
        p2f = m == "pdf2md" and self.pdf2md_force.get()
        p2l = m == "pdf2md" and self.pdf2md_latex.get()
        keep_tex = (m == "power" and self.keep_tex.get()) or (
            m == "pdf2md" and p2l and self.keep_tex.get()
        )
        will_write = output_paths_to_be_written(m, p_out, compile_pdf, keep_tex)
        existing = _existing_files(will_write)
        if existing:
            lines = "\n".join(f"  • {p}" for p in existing)
            if not messagebox.askokcancel(
                "File already exists",
                "The following file(s) already exist and will be overwritten:\n\n"
                f"{lines}\n\n"
                "Click OK to replace them, or Cancel to stop.",
                parent=self,
            ):
                return

        self._append_log("—\n")

        def work() -> None:
            def qlog(msg: str) -> None:
                self._queue.put(msg)

            rc = run_convert(
                m,
                p_in,
                p_out,
                compile_pdf=compile_pdf,
                keep_tex=keep_tex,
                log_q=self._queue,
                pdf2md_force_extract=p2f,
                pdf2md_via_latex=p2l,
                pdf2md_extract=self.pdf2md_extract.get(),
                pdf2md_pages=self.pdf2md_pages.get(),
                pdf2md_yaml=self.pdf2md_yaml.get(),
                pdf2md_no_page_comments=self.pdf2md_no_page.get(),
                pdf2md_no_uri_links=self.pdf2md_nouri.get(),
                pdf2md_image_dir=self.pdf2md_image_dir.get(),
            )
            if rc == 0:
                self._queue.put("SUCCESS\n")
            else:
                self._queue.put(f"FAILED (exit {rc})\n")
            # Must show message on main thread
            if rc == 0:
                self.after(0, lambda: messagebox.showinfo("Done", "Conversion finished successfully.", parent=self))
            else:
                self.after(
                    0,
                    lambda: messagebox.showerror("Failed", f"See log (exit {rc}).", parent=self),
                )

        self._queue.put("Starting…\n")
        threading.Thread(target=work, daemon=True).start()


def main() -> None:
    try:
        from ctypes import windll
        # Sharper on Windows
        try:
            windll.shcore.SetProcessDpiAwareness(1)  # type: ignore
        except Exception:
            pass
    except Exception:
        pass
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
