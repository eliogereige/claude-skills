#!/usr/bin/env python3
"""
Convert a Markdown file to PDF using ReportLab.

Usage:
    python scripts/md_to_pdf.py [input.md] [output.pdf]

Defaults:
    COMPLETE_METHODOLOGY_GUIDE.md -> COMPLETE_METHODOLOGY_GUIDE.pdf

Equation handling:
    - Display equations ($$...$$) are rendered as centered matplotlib images.
    - ``\\boxed{...}`` (display only, whole formula): inner math is rendered by
      matplotlib; a frame is drawn in PIL because mathtext does not support ``\\boxed``.
    - Inline equations ($...$) are converted to ReportLab XML markup with
      <i>, <sub>, <super>, and <font> tags so they stay inline in paragraph
      flow without requiring special Unicode codepoints.
    - Inline superscripts: ``^{...}``, numeric blocks like ``10^{-9}`` / ``^2``,
      and single-character ``^*`` (e.g. ``D^*``); braced forms are preferred in
      the Markdown for ambiguous cases.
"""

from __future__ import annotations

import html
import io
import re
import sys
import textwrap
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Polygon, Rectangle

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

# Register DejaVu Sans (ships with matplotlib) so we can render Greek/math Unicode
_DEJAVU_DIR = Path(matplotlib.__file__).parent / "mpl-data" / "fonts" / "ttf"
pdfmetrics.registerFont(TTFont("DejaVu", str(_DEJAVU_DIR / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(_DEJAVU_DIR / "DejaVuSans-Bold.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-Oblique", str(_DEJAVU_DIR / "DejaVuSans-Oblique.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-BoldOblique", str(_DEJAVU_DIR / "DejaVuSans-BoldOblique.ttf")))
from reportlab.lib.fonts import addMapping
addMapping("DejaVu", 0, 0, "DejaVu")
addMapping("DejaVu", 1, 0, "DejaVu-Bold")
addMapping("DejaVu", 0, 1, "DejaVu-Oblique")
addMapping("DejaVu", 1, 1, "DejaVu-BoldOblique")

FONT_NAME = "DejaVu"

# Page layout
PAGE_WIDTH, PAGE_HEIGHT = letter
MARGIN_LR = 0.85 * inch
AVAILABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN_LR


# ---------------------------------------------------------------------------
# LaTeX-to-ReportLab XML inline conversion
# ---------------------------------------------------------------------------
# Strategy: convert LaTeX to ReportLab Paragraph XML tags.
#   Greek letters -> <font name="Symbol">X</font>
#   subscripts    -> <sub>text</sub>    (ReportLab built-in)
#   superscripts  -> <super>text</super>
#   \frac{a}{b}   -> (a)/(b)
#   \text{...}    -> plain text
# This avoids Unicode codepoints that the default font can't render.

# Greek letters: LaTeX command -> Unicode character (DejaVu renders these)
_GREEK_MAP = {
    r"\alpha": "\u03b1", r"\beta": "\u03b2", r"\gamma": "\u03b3",
    r"\delta": "\u03b4", r"\epsilon": "\u03b5", r"\eta": "\u03b7",
    r"\theta": "\u03b8", r"\lambda": "\u03bb", r"\mu": "\u03bc",
    r"\pi": "\u03c0", r"\rho": "\u03c1", r"\sigma": "\u03c3",
    r"\phi": "\u03c6", r"\psi": "\u03c8", r"\omega": "\u03c9",
    r"\tau": "\u03c4", r"\nu": "\u03bd", r"\xi": "\u03be",
    r"\kappa": "\u03ba", r"\chi": "\u03c7", r"\zeta": "\u03b6",
    r"\Delta": "\u0394", r"\Phi": "\u03a6", r"\Omega": "\u03a9",
    r"\Sigma": "\u03a3", r"\Pi": "\u03a0", r"\Gamma": "\u0393",
    r"\Lambda": "\u039b", r"\Theta": "\u0398",
}

# Symbol replacements (Unicode, all in DejaVu)
_SIMPLE_SYMBOLS = {
    r"\cdot": "\u00b7",
    r"\times": "\u00d7",
    r"\pm": "\u00b1",
    r"\leq": "\u2264",
    r"\geq": "\u2265",
    r"\ll": "\u226a",
    r"\gg": "\u226b",
    r"\neq": "\u2260",
    r"\approx": "\u2248",
    r"\propto": "\u221d",
    r"\sim": "\u223c",
    r"\infty": "\u221e",
    r"\rightarrow": "\u2192",
    r"\leftarrow": "\u2190",
    r"\langle": "\u27e8",
    r"\rangle": "\u27e9",
    r"\nabla": "\u2207",
    r"\left": "",
    r"\right": "",
    r"\qquad": "    ",
    r"\quad": "  ",
    r"\,": " ",
    r"\;": " ",
    r"\!": "",
    r"\|": "\u2016",
}

# Function-name commands -> upright text
_FUNC_NAMES = {
    r"\ln": "ln", r"\log": "log", r"\exp": "exp",
    r"\sin": "sin", r"\cos": "cos", r"\tan": "tan",
    r"\min": "min", r"\max": "max", r"\lim": "lim",
    r"\sum": "\u2211", r"\prod": "\u220f", r"\sqrt": "\u221a",
    r"\int": "\u222b", r"\partial": "\u2202",
}


def _normalize_math_command_aliases(latex: str) -> str:
    """Normalize common LaTeX aliases to commands supported by matplotlib mathtext."""
    s = latex
    s = re.sub(r"\\le(?![A-Za-z])", r"\\leq", s)
    s = re.sub(r"\\ge(?![A-Za-z])", r"\\geq", s)
    return s


def _latex_to_rl_markup(latex: str) -> str:
    """Convert LaTeX math string to ReportLab Paragraph XML markup.

    The output is meant to be embedded inside a Paragraph that has already
    been html-escaped *around* the math region, so we produce raw XML tags.
    """
    s = _normalize_math_command_aliases(latex.strip())

    # --- \text{...} and \mathrm{...} -> plain text ---
    s = re.sub(r"\\(?:text|mathrm)\{([^}]*)\}", r"\1", s)

    # --- \bar{x} -> x-bar (overline via combining char) ---
    s = re.sub(r"\\bar\{([^}]*)\}", lambda m: m.group(1) + "\u0304", s)

    # --- \hat{y} -> y-hat (circumflex via combining char) ---
    s = re.sub(r"\\hat\{([^}]*)\}", lambda m: m.group(1) + "\u0302", s)

    # --- \dot{x} or \dot x -> x-dot (combining dot above) ---
    s = re.sub(r"\\dot\{([^}]*)\}", lambda m: m.group(1) + "\u0307", s)
    s = re.sub(r"\\dot\s*([A-Za-z])", lambda m: m.group(1) + "\u0307", s)

    # --- \tilde{x} -> x-tilde (combining tilde) ---
    s = re.sub(r"\\tilde\{([^}]*)\}", lambda m: m.group(1) + "\u0303", s)

    # --- \mathbf{x} -> bold text ---
    s = re.sub(r"\\mathbf\{([^}]*)\}", r"<b>\1</b>", s)

    # --- \boldsymbol{x} -> bold text ---
    s = re.sub(r"\\boldsymbol\{([^}]*)\}", r"<b>\1</b>", s)

    # --- \tilde\omega_o -> combining form without braces ---
    s = re.sub(r"\\tilde\s*([A-Za-z])", lambda m: m.group(1) + "\u0303", s)

    # --- \frac{a}{b} -> (a)/(b) ---
    # Handle nested fracs by doing multiple passes
    for _ in range(3):
        s = re.sub(r"\\frac\{([^}]*)\}\{([^}]*)\}", r"(\1)/(\2)", s)

    # --- Greek letters -> direct Unicode (rendered by DejaVu font) ---
    for cmd in sorted(_GREEK_MAP, key=len, reverse=True):
        s = s.replace(cmd, _GREEK_MAP[cmd])

    # --- Function names -> upright ---
    for cmd in sorted(_FUNC_NAMES, key=len, reverse=True):
        s = s.replace(cmd, _FUNC_NAMES[cmd])

    # --- Simple symbols ---
    for cmd, repl in _SIMPLE_SYMBOLS.items():
        s = s.replace(cmd, repl)

    # --- Subscripts: _{...} or _x ---
    def _sub_repl(m: re.Match) -> str:
        inner = m.group(1) or m.group(2)
        return f"<sub>{inner}</sub>"
    s = re.sub(r"_\{([^}]*)\}|_([A-Za-z0-9])", _sub_repl, s)

    # --- Superscripts (order matters): ^{...}, ^{-9}, ^10, ^* , ^2, etc. ---
    # ReportLab inline path cannot use matplotlib; bare ^ must become <super>.
    def _sup_braced(m: re.Match) -> str:
        return f"<super>{m.group(1)}</super>"

    s = re.sub(r"\^\{([^}]*)\}", _sup_braced, s)
    # Numeric superscripts without braces: 10^-9, 10^9, x^-2
    s = re.sub(r"\^(-?\d+)", lambda m: f"<super>{m.group(1)}</super>", s)
    # Single-character superscripts (variables, *, prime-like symbols)
    s = re.sub(
        r"\^([A-Za-z0-9*])",
        lambda m: f"<super>{m.group(1)}</super>",
        s,
    )

    # --- Remove remaining backslash commands we didn't handle ---
    s = re.sub(r"\\[a-zA-Z]+", "", s)

    # --- Clean up braces ---
    s = s.replace("{", "").replace("}", "")

    # --- Collapse whitespace ---
    s = re.sub(r"\s+", " ", s).strip()

    return s


def _unwrap_outer_boxed(latex_str: str) -> tuple[str, bool]:
    """If the whole expression is ``\\boxed{...}``, return inner LaTeX and True.

    Matplotlib mathtext does not implement ``\\boxed`` (parse fails). We render
    the inner expression and draw the frame in :func:`_add_box_border_around_png`.
    """
    t = latex_str.strip()
    m = re.match(r"^\\boxed\s*\{", t)
    if not m:
        return latex_str, False
    open_idx = m.end() - 1
    if open_idx >= len(t) or t[open_idx] != "{":
        return latex_str, False
    depth = 1
    i = open_idx + 1
    while i < len(t):
        if t[i] == "{":
            depth += 1
        elif t[i] == "}":
            depth -= 1
            if depth == 0:
                inner = t[open_idx + 1 : i]
                rest = t[i + 1 :].strip()
                if not rest:
                    return inner, True
                return latex_str, False
        i += 1
    return latex_str, False


def _add_box_border_around_png(buf: io.BytesIO, pad: int = 5, outline_width: int = 2) -> io.BytesIO:
    """Draw a tight rectangle around a rendered equation image (``\\boxed`` substitute)."""
    from PIL import Image, ImageDraw

    buf.seek(0)
    im = Image.open(buf).convert("RGB")
    w, h = im.size
    out = Image.new("RGB", (w + 2 * pad, h + 2 * pad), "white")
    out.paste(im, (pad, pad))
    dr = ImageDraw.Draw(out)
    dr.rectangle(
        [0, 0, w + 2 * pad - 1, h + 2 * pad - 1],
        outline="black",
        width=outline_width,
    )
    out_buf = io.BytesIO()
    out.save(out_buf, format="PNG")
    out_buf.seek(0)
    return out_buf


# ---------------------------------------------------------------------------
# Display equation rendering (matplotlib)
# ---------------------------------------------------------------------------

def _render_display_equation(latex_str: str, dpi: int = 150, fontsize: int = 13) -> io.BytesIO | None:
    """Render a display equation to a tight PNG buffer using matplotlib."""
    latex_str = _normalize_math_command_aliases(latex_str.strip())
    latex_str = latex_str.replace(r"\text{", r"\mathrm{")
    latex_str, outer_boxed = _unwrap_outer_boxed(latex_str)

    fig = plt.figure(figsize=(8, 0.6))
    fig.patch.set_alpha(0.0)

    try:
        t = fig.text(0.5, 0.5, f"${latex_str}$", fontsize=fontsize,
                     ha="center", va="center")
        fig.canvas.draw()

        bbox = t.get_window_extent(renderer=fig.canvas.get_renderer())
        w_in = max(bbox.width / fig.dpi + 0.3, 0.8)
        h_in = max(bbox.height / fig.dpi + 0.15, 0.35)
        fig.set_size_inches(w_in, h_in)

        fig.texts.clear()
        fig.text(0.5, 0.5, f"${latex_str}$", fontsize=fontsize,
                 ha="center", va="center")

        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight",
                    pad_inches=0.08, facecolor="white")
        buf.seek(0)
        plt.close(fig)
        if outer_boxed:
            buf = _add_box_border_around_png(buf)
        return buf
    except Exception:
        plt.close(fig)
        return None


# ---------------------------------------------------------------------------
# Markdown inline markup (bold, code, inline math)
# ---------------------------------------------------------------------------

def _process_inline_math_to_rl(text: str) -> str:
    """Replace $...$ in *raw* markdown text with ReportLab XML markup.

    Must be called BEFORE html.escape() on the surrounding text.
    We use sentinel markers so we can escape the non-math parts safely
    and then restore the XML tags afterward.
    """
    parts = []
    last = 0
    for m in re.finditer(r"(?<!\$)\$(?!\$)(.+?)\$(?!\$)", text):
        # Escape the plain text before this match
        parts.append(html.escape(text[last:m.start()], quote=False))
        # Convert LaTeX to RL markup (already contains XML tags, don't escape)
        rl = _latex_to_rl_markup(m.group(1))
        parts.append(f"<i>{rl}</i>")
        last = m.end()
    parts.append(html.escape(text[last:], quote=False))
    return "".join(parts)


def _inline_md_to_rl_markup(text: str) -> str:
    """Convert markdown inline syntax into ReportLab XML markup."""
    # Step 1: process inline math (produces RL XML tags + html-escapes the rest)
    escaped = _process_inline_math_to_rl(text)

    # Step 2: inline code: `code`
    escaped = re.sub(
        r"`([^`]+)`",
        r"<font face='Courier'>\1</font>",
        escaped,
    )

    # Step 3: Bold: **text**
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", escaped)

    # Step 4: Italic: *text* (single asterisk, not **)
    # Skip when content is just "." or crosses tag boundaries (e.g. *.csv in paths)
    def _italic_repl(m: re.Match) -> str:
        inner = m.group(1).strip()
        if not inner or re.match(r"^\.+$", inner) or "<" in m.group(1) or ">" in m.group(1):
            return m.group(0)
        return f"<i>{m.group(1)}</i>"
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", _italic_repl, escaped)

    # Step 5: Restore <sub>/<super> so ReportLab can render scripts (if escaped earlier)
    escaped = escaped.replace("&lt;sub&gt;", "<sub>").replace("&lt;/sub&gt;", "</sub>")
    escaped = escaped.replace("&lt;super&gt;", "<super>").replace("&lt;/super&gt;", "</super>")

    return escaped


# ---------------------------------------------------------------------------
# Table helpers
# ---------------------------------------------------------------------------

def _is_table_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", c.strip()) for c in cells)


def _split_md_table_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


# ---------------------------------------------------------------------------
# Mermaid flowchart rendering (for visual diagrams in PDF output)
# ---------------------------------------------------------------------------

def _normalize_mermaid_label(label: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", label, flags=re.IGNORECASE)
    s = html.unescape(s)
    return s.strip()


def _parse_mermaid_node_token(token: str) -> tuple[str, str, str] | None:
    """Parse node token like A[Label] or Start([Label])."""
    token = token.strip()
    if not token:
        return None
    m = re.match(r"^([A-Za-z0-9_]+)\s*(.*)$", token)
    if not m:
        return None

    node_id = m.group(1)
    remainder = m.group(2).strip()
    if not remainder:
        return node_id, node_id, "rect"

    shape_markers = [
        ("([", "])", "round"),
        ("[[", "]]", "rect"),
        ("((", "))", "round"),
        ("{", "}", "diamond"),
        ("[", "]", "rect"),
        ("(", ")", "round"),
    ]
    for opener, closer, shape in shape_markers:
        if remainder.startswith(opener) and remainder.endswith(closer):
            inner = remainder[len(opener): len(remainder) - len(closer)]
            return node_id, _normalize_mermaid_label(inner), shape

    return node_id, _normalize_mermaid_label(remainder), "rect"


def _parse_mermaid_edge(line: str) -> tuple[str, str, str] | None:
    """Parse simple Mermaid edge forms:
       src --> dst
       src -->|label| dst
    """
    m = re.match(r"^(.*?)\s*-->\s*(?:\|([^|]+)\|\s*)?(.*)$", line)
    if not m:
        return None
    src = m.group(1).strip()
    edge_label = (m.group(2) or "").strip()
    dst = m.group(3).strip()
    if not src or not dst:
        return None
    return src, dst, edge_label


def _wrap_mermaid_label(label: str, width: int = 20) -> list[str]:
    lines: list[str] = []
    for raw in label.splitlines() or [label]:
        wrapped = textwrap.wrap(raw, width=width) if raw else [""]
        lines.extend(wrapped or [""])
    return lines or [""]


def _render_mermaid_flowchart(
    mermaid_code: str,
    dpi: int = 200,
    profile: str = "default",
) -> io.BytesIO | None:
    """Render a Mermaid flowchart block to PNG buffer using matplotlib."""
    lines = [ln.rstrip() for ln in mermaid_code.splitlines() if ln.strip()]
    if not lines:
        return None

    cfg = {
        "label_wrap_width": 20,
        "box_scale": 1.2,
        "major_spacing_lr": 3.8,
        "minor_spacing_lr": 2.6,
        "major_spacing_td": 3.0,
        "minor_spacing_td": 3.4,
        "node_gap_minor": 0.28,
        "node_fontsize": 10.2,
        "edge_fontsize": 9.0,
        "group_fontsize": 12.0,
        "arrow_mutation_scale": 13.0,
        "fig_pad_w": 2.6,
        "fig_pad_h": 2.2,
        "axis_pad_x": 1.0,
        "axis_pad_y": 0.9,
    }
    if profile == "section_11":
        # Make section 11/11.1 diagrams easier to read while keeping them compact.
        cfg.update({
            "label_wrap_width": 22,
            "box_scale": 1.45,
            "major_spacing_lr": 3.2,
            "minor_spacing_lr": 2.4,
            "major_spacing_td": 2.2,
            "minor_spacing_td": 3.0,
            "node_gap_minor": 0.22,
            "node_fontsize": 13.2,
            "edge_fontsize": 10.1,
            "group_fontsize": 13.0,
            "arrow_mutation_scale": 14.0,
            "fig_pad_w": 2.2,
            "fig_pad_h": 1.6,
            "axis_pad_x": 0.8,
            "axis_pad_y": 0.7,
        })

    orientation = "TD"
    nodes: dict[str, dict[str, str]] = {}
    node_order: list[str] = []
    edges: list[tuple[str, str, str]] = []
    node_groups: dict[str, str] = {}
    group_order: list[str] = []
    node_fill_style: dict[str, str] = {}
    group_stack: list[str] = []

    def _active_group() -> str | None:
        return group_stack[-1] if group_stack else None

    def _remember_group(group_name: str) -> None:
        if group_name and group_name not in group_order:
            group_order.append(group_name)

    def _upsert_node(token: str, group_name: str | None) -> str | None:
        parsed = _parse_mermaid_node_token(token)
        if not parsed:
            return None
        node_id, label, shape = parsed
        if node_id not in nodes:
            nodes[node_id] = {"label": label, "shape": shape}
            node_order.append(node_id)
        else:
            existing = nodes[node_id]
            if existing["label"] == node_id and label != node_id:
                existing["label"] = label
            if existing["shape"] == "rect" and shape != "rect":
                existing["shape"] = shape
        if group_name and node_id not in node_groups:
            node_groups[node_id] = group_name
            _remember_group(group_name)
        return node_id

    for raw in lines:
        t = raw.strip()
        if not t or t.startswith("%%"):
            continue

        if t.lower().startswith("flowchart"):
            parts = t.split()
            if len(parts) >= 2:
                orientation = parts[1].upper()
            continue

        if t.lower().startswith("subgraph "):
            group_name = t[len("subgraph "):].strip()
            if group_name:
                group_stack.append(group_name)
                _remember_group(group_name)
            continue

        if t == "end":
            if group_stack:
                group_stack.pop()
            continue

        if t.lower().startswith("style "):
            sm = re.match(r"^style\s+([A-Za-z0-9_]+)\s+(.+)$", t, flags=re.IGNORECASE)
            if sm:
                node_id = sm.group(1)
                attrs = sm.group(2)
                fm = re.search(r"fill\s*:\s*([#A-Za-z0-9]+)", attrs, flags=re.IGNORECASE)
                if fm:
                    node_fill_style[node_id] = fm.group(1)
            continue

        edge_parts = _parse_mermaid_edge(t)
        if edge_parts:
            src_tok, dst_tok, edge_label = edge_parts
            src_id = _upsert_node(src_tok, _active_group())
            dst_id = _upsert_node(dst_tok, _active_group())
            if src_id and dst_id:
                edges.append((src_id, dst_id, edge_label))
            continue

        # Standalone node definitions inside a subgraph.
        _upsert_node(t, _active_group())

    if not nodes:
        return None

    # Orientation aliases supported by Mermaid.
    orientation = {
        "TB": "TD",
        "BT": "BT",
        "LR": "LR",
        "RL": "RL",
        "TD": "TD",
    }.get(orientation, "TD")

    order_idx = {node: i for i, node in enumerate(node_order)}

    # For ranking, prefer forward edges according to declaration order.
    forward_edges = [
        (s, d, lbl)
        for s, d, lbl in edges
        if order_idx.get(d, 0) > order_idx.get(s, 0)
    ]
    if not forward_edges:
        forward_edges = edges[:]

    preds: dict[str, list[str]] = defaultdict(list)
    for s, d, _ in forward_edges:
        preds[d].append(s)

    level: dict[str, int] = {}
    for n in node_order:
        p = preds.get(n, [])
        level[n] = (max(level.get(pp, 0) for pp in p) + 1) if p else 0

    max_level = max(level.values()) if level else 0

    # Reverse direction for RL/BT so visual flow remains intuitive.
    if orientation in {"RL", "BT"}:
        level = {n: max_level - lv for n, lv in level.items()}
        max_level = max(level.values()) if level else 0

    nodes_by_level: dict[int, list[str]] = defaultdict(list)
    for n in node_order:
        nodes_by_level[level[n]].append(n)

    labels_wrapped: dict[str, list[str]] = {}
    node_w: dict[str, float] = {}
    node_h: dict[str, float] = {}
    # Keep labels readable while fitting diagrams on a single page.
    box_scale = cfg["box_scale"]
    for n in node_order:
        wrapped = _wrap_mermaid_label(nodes[n]["label"], width=cfg["label_wrap_width"])
        labels_wrapped[n] = wrapped
        longest = max(len(line) for line in wrapped) if wrapped else 1
        node_w[n] = box_scale * min(max(1.4, 0.095 * longest + 0.7), 4.8)
        node_h[n] = box_scale * min(max(0.68, 0.31 * len(wrapped) + 0.32), 3.2)

    if orientation in {"LR", "RL"}:
        major_spacing = cfg["major_spacing_lr"]  # level-to-level spacing (x)
        minor_spacing = cfg["minor_spacing_lr"]  # node spacing within level (y)
        minor_size_map = node_h
    else:
        major_spacing = cfg["major_spacing_td"]  # level-to-level spacing (y)
        minor_spacing = cfg["minor_spacing_td"]  # node spacing within level (x)
        minor_size_map = node_w

    def _layout_level_offsets(row_nodes: list[str]) -> dict[str, float]:
        """Place nodes on the minor axis without overlap, centered on zero."""
        count = len(row_nodes)
        if count == 0:
            return {}
        if count == 1:
            return {row_nodes[0]: 0.0}

        centers = [(i - (count - 1) / 2.0) * minor_spacing for i in range(count)]
        for i in range(1, count):
            prev = row_nodes[i - 1]
            cur = row_nodes[i]
            min_dist = (minor_size_map[prev] + minor_size_map[cur]) / 2.0 + cfg["node_gap_minor"]
            if centers[i] - centers[i - 1] < min_dist:
                centers[i] = centers[i - 1] + min_dist

        mid = (centers[0] + centers[-1]) / 2.0
        return {n: c - mid for n, c in zip(row_nodes, centers)}

    pos: dict[str, tuple[float, float]] = {}
    for lv in range(max_level + 1):
        row = nodes_by_level.get(lv, [])
        count = len(row)
        if count == 0:
            continue
        offsets = _layout_level_offsets(row)
        for n in row:
            centered = offsets[n]
            if orientation in {"LR", "RL"}:
                x = lv * major_spacing
                y = -centered
            else:
                x = centered
                y = -lv * major_spacing
            pos[n] = (x, y)

    min_x = min(pos[n][0] - node_w[n] / 2 for n in node_order)
    max_x = max(pos[n][0] + node_w[n] / 2 for n in node_order)
    min_y = min(pos[n][1] - node_h[n] / 2 for n in node_order)
    max_y = max(pos[n][1] + node_h[n] / 2 for n in node_order)

    fig_w = max(8.5, (max_x - min_x) + cfg["fig_pad_w"])
    fig_h = max(4.8, (max_y - min_y) + cfg["fig_pad_h"])
    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=dpi)
    ax.set_facecolor("white")

    # Draw subgraph containers behind nodes/edges.
    for group_name in group_order:
        g_nodes = [n for n in node_order if node_groups.get(n) == group_name]
        if not g_nodes:
            continue
        gx0 = min(pos[n][0] - node_w[n] / 2 for n in g_nodes) - 0.45
        gx1 = max(pos[n][0] + node_w[n] / 2 for n in g_nodes) + 0.45
        gy0 = min(pos[n][1] - node_h[n] / 2 for n in g_nodes) - 0.35
        gy1 = max(pos[n][1] + node_h[n] / 2 for n in g_nodes) + 0.55
        rect = Rectangle(
            (gx0, gy0),
            gx1 - gx0,
            gy1 - gy0,
            linewidth=1.1,
            edgecolor="#c9d2df",
            facecolor="#f7fafc",
            zorder=0,
        )
        ax.add_patch(rect)
        ax.text(
            gx0 + 0.12,
            gy1 - 0.14,
            group_name,
            fontsize=cfg["group_fontsize"],
            fontweight="bold",
            ha="left",
            va="top",
            color="#334155",
            zorder=1,
        )

    # Draw edges first, then nodes.
    for src, dst, edge_label in edges:
        if src not in pos or dst not in pos:
            continue
        x1, y1 = pos[src]
        x2, y2 = pos[dst]
        is_back_edge = level.get(dst, 0) <= level.get(src, 0)
        rad = 0.18 if is_back_edge else 0.0
        arrow = FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle="-|>",
            mutation_scale=cfg["arrow_mutation_scale"],
            linewidth=1.2,
            color="#546173",
            connectionstyle=f"arc3,rad={rad}",
            shrinkA=18,
            shrinkB=18,
            zorder=2,
        )
        ax.add_patch(arrow)

        if edge_label:
            mx = (x1 + x2) / 2.0
            my = (y1 + y2) / 2.0 + (0.28 if is_back_edge else 0.0)
            ax.text(
                mx,
                my,
                edge_label,
                fontsize=cfg["edge_fontsize"],
                ha="center",
                va="center",
                color="#374151",
                bbox={
                    "boxstyle": "round,pad=0.15",
                    "facecolor": "white",
                    "edgecolor": "#d1d5db",
                },
                zorder=3,
            )

    def _node_fill(n: str) -> str:
        if n in node_fill_style:
            return node_fill_style[n]
        shape = nodes[n]["shape"]
        if shape == "diamond":
            return "#fff4d6"
        if shape == "round":
            return "#eaf4ff"
        return "#f5f7fb"

    for n in node_order:
        x, y = pos[n]
        w = node_w[n]
        h = node_h[n]
        shape = nodes[n]["shape"]
        fill = _node_fill(n)

        if shape == "diamond":
            diamond = Polygon(
                [
                    (x, y + h / 2),
                    (x + w / 2, y),
                    (x, y - h / 2),
                    (x - w / 2, y),
                ],
                closed=True,
                linewidth=1.2,
                edgecolor="#3d4b60",
                facecolor=fill,
                zorder=4,
            )
            ax.add_patch(diamond)
        else:
            rounding = 0.16 if shape == "round" else 0.05
            box = FancyBboxPatch(
                (x - w / 2, y - h / 2),
                w,
                h,
                boxstyle=f"round,pad=0.03,rounding_size={rounding}",
                linewidth=1.2,
                edgecolor="#3d4b60",
                facecolor=fill,
                zorder=4,
            )
            ax.add_patch(box)

        ax.text(
            x,
            y,
            "\n".join(labels_wrapped[n]),
            fontsize=cfg["node_fontsize"],
            ha="center",
            va="center",
            color="#0f172a",
            zorder=5,
        )

    ax.set_xlim(min_x - cfg["axis_pad_x"], max_x + cfg["axis_pad_x"])
    ax.set_ylim(min_y - cfg["axis_pad_y"], max_y + cfg["axis_pad_y"])
    ax.axis("off")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight", facecolor="white")
    buf.seek(0)
    plt.close(fig)
    return buf


# ---------------------------------------------------------------------------
# Main converter
# ---------------------------------------------------------------------------

def markdown_to_pdf(input_path: Path, output_path: Path) -> None:
    styles = getSampleStyleSheet()

    body_style = ParagraphStyle(
        "Body", parent=styles["BodyText"],
        fontName=FONT_NAME, fontSize=10, leading=16, wordWrap="CJK",
    )
    bullet_style = ParagraphStyle(
        "Bullet", parent=body_style,
        leftIndent=16, spaceBefore=2, spaceAfter=2,
    )
    sub_bullet_style = ParagraphStyle(
        "SubBullet", parent=bullet_style,
        leftIndent=32, spaceBefore=1, spaceAfter=1,
    )
    code_style = ParagraphStyle(
        "CodeLine", parent=styles["Code"],
        fontName="Courier", fontSize=7, leading=9,
        leftIndent=4, rightIndent=4, wordWrap="CJK",
    )
    table_cell_style = ParagraphStyle(
        "TableCell", parent=body_style,
        fontName=FONT_NAME, fontSize=8, leading=10, wordWrap="CJK",
    )
    h1_style = ParagraphStyle(
        "H1", parent=styles["Heading1"], fontName=FONT_NAME,
    )
    h2_style = ParagraphStyle(
        "H2", parent=styles["Heading2"], fontName=FONT_NAME,
    )
    h3_style = ParagraphStyle(
        "H3", parent=styles["Heading3"], fontName=FONT_NAME,
    )
    h_styles = {1: h1_style, 2: h2_style, 3: h3_style}
    h4_style = ParagraphStyle(
        "Heading4", parent=h3_style,
        fontSize=12, spaceBefore=10, spaceAfter=6,
    )

    source_lines = input_path.read_text(encoding="utf-8").splitlines()

    story: list = []
    para_buf: list[str] = []
    idx = 0
    in_code = False
    code_buf: list[str] = []
    code_lang = ""
    code_section_id: str | None = None
    current_section_id: str | None = None

    # ------------------------------------------------------------------

    def _add_display_equation(latex: str) -> None:
        buf = _render_display_equation(latex)
        if buf:
            from PIL import Image as PILImage
            buf.seek(0)
            pil = PILImage.open(buf)
            w_px, h_px = pil.size
            dpi = 150
            w_pt = w_px / dpi * 72
            h_pt = h_px / dpi * 72
            max_w = AVAILABLE_WIDTH * 0.92
            if w_pt > max_w:
                scale = max_w / w_pt
                w_pt *= scale
                h_pt *= scale
            buf.seek(0)
            img = Image(buf, width=w_pt, height=h_pt)
            story.append(Spacer(1, 0.08 * inch))
            story.append(img)
            story.append(Spacer(1, 0.08 * inch))
        else:
            story.append(Paragraph(
                f"<font face='Courier'>{html.escape(latex)}</font>",
                body_style,
            ))

    def _add_text(text: str, style: ParagraphStyle) -> None:
        story.append(Paragraph(_inline_md_to_rl_markup(text), style))

    def _extract_section_id(heading_raw: str) -> str | None:
        m = re.match(r"^(\d+(?:\.\d+)*)(?:[.)])?(?:\s|$)", heading_raw.strip())
        return m.group(1) if m else None

    def _add_mermaid_diagram(code_text: str, section_id: str | None) -> None:
        render_profile = "section_11" if section_id in {"11", "11.1"} else "default"
        buf = _render_mermaid_flowchart(code_text, profile=render_profile)
        if not buf:
            # Fallback to raw code if parsing/rendering fails.
            for cl in (code_text.splitlines() or [" "]):
                escaped = html.escape(cl, quote=False)
                story.append(Paragraph(
                    f"<font face='Courier' size='7'>{escaped}</font>",
                    code_style,
                ))
            story.append(Spacer(1, 0.1 * inch))
            return

        from PIL import Image as PILImage
        buf.seek(0)
        pil = PILImage.open(buf)
        w_px, h_px = pil.size
        dpi_img = 200
        w_pt = w_px / dpi_img * 72
        h_pt = h_px / dpi_img * 72

        max_w = AVAILABLE_WIDTH * 0.98
        max_h = PAGE_HEIGHT * (0.70 if render_profile == "section_11" else 0.66)
        scale = min(max_w / w_pt, max_h / h_pt, 1.0)
        scaled_w_pt = w_pt * scale
        scaled_h_pt = h_pt * scale

        buf.seek(0)
        img = Image(buf, width=scaled_w_pt, height=scaled_h_pt)
        story.append(Spacer(1, 0.08 * inch))
        story.append(img)
        story.append(Spacer(1, 0.12 * inch))

    def flush_paragraph() -> None:
        if not para_buf:
            return
        text = " ".join(s.strip() for s in para_buf if s.strip())
        para_buf.clear()
        if not text:
            return

        # Whole paragraph is a display equation
        disp = re.fullmatch(r"\$\$(.+?)\$\$", text, re.DOTALL)
        if disp:
            _add_display_equation(disp.group(1))
            return

        # Mixed: split on embedded display equations
        parts = re.split(r"(\$\$.+?\$\$)", text)
        for part in parts:
            dm = re.fullmatch(r"\$\$(.+?)\$\$", part)
            if dm:
                _add_display_equation(dm.group(1))
            elif part.strip():
                _add_text(part, body_style)
                story.append(Spacer(1, 0.08 * inch))

    # ------------------------------------------------------------------

    while idx < len(source_lines):
        line = source_lines[idx]
        stripped = line.rstrip()
        t = stripped.strip()

        # --- Code blocks ---
        if in_code:
            if t.startswith("```"):
                code_text = "\n".join(code_buf) if code_buf else " "
                if code_lang == "mermaid":
                    _add_mermaid_diagram(code_text, code_section_id)
                else:
                    for cl in code_text.splitlines():
                        escaped = html.escape(cl, quote=False)
                        story.append(Paragraph(
                            f"<font face='Courier' size='7'>{escaped}</font>",
                            code_style,
                        ))
                    story.append(Spacer(1, 0.1 * inch))
                code_buf.clear()
                in_code = False
                code_lang = ""
                code_section_id = None
            else:
                code_buf.append(stripped)
            idx += 1
            continue

        if t.startswith("```"):
            flush_paragraph()
            in_code = True
            code_lang = (t[3:].strip().split()[0].lower() if t[3:].strip() else "")
            code_section_id = current_section_id
            idx += 1
            continue

        # --- Blank line ---
        if not t:
            flush_paragraph()
            story.append(Spacer(1, 0.10 * inch))
            idx += 1
            continue

        # --- Horizontal rule ---
        if re.fullmatch(r"-{3,}", t):
            flush_paragraph()
            story.append(Spacer(1, 0.15 * inch))
            idx += 1
            continue

        # --- Headings ---
        heading_match = re.match(r"^(#{1,6})\s+(.*)$", t)
        if heading_match:
            flush_paragraph()
            level = len(heading_match.group(1))
            heading_raw = heading_match.group(2)
            current_section_id = _extract_section_id(heading_raw)
            heading_text = _inline_md_to_rl_markup(heading_raw)
            style = h_styles.get(level, h4_style)
            story.append(Paragraph(heading_text, style))
            story.append(Spacer(1, 0.04 * inch))
            idx += 1
            continue

        # --- Display equation on its own line(s) ---
        if t.startswith("$$"):
            flush_paragraph()
            if t.endswith("$$") and len(t) > 4:
                _add_display_equation(t[2:-2])
                idx += 1
                continue
            eq_lines = [t[2:]]
            idx += 1
            while idx < len(source_lines):
                nl = source_lines[idx].strip()
                if nl.endswith("$$"):
                    eq_lines.append(nl[:-2])
                    idx += 1
                    break
                eq_lines.append(nl)
                idx += 1
            _add_display_equation(" ".join(eq_lines))
            continue

        # --- Tables ---
        if t.startswith("|") and t.endswith("|"):
            flush_paragraph()
            raw_rows: list[list[str]] = []
            while idx < len(source_lines):
                candidate = source_lines[idx].strip()
                if candidate.startswith("|") and candidate.endswith("|"):
                    raw_rows.append(_split_md_table_row(candidate))
                    idx += 1
                    continue
                break
            rows = [r for r in raw_rows if not _is_table_separator_row(r)]
            if rows:
                col_count = max(len(r) for r in rows)
                col_max_len = [0] * col_count
                for r in rows:
                    for ci, cell in enumerate(r[:col_count]):
                        col_max_len[ci] = max(col_max_len[ci], len(cell.strip()))
                total_chars = max(sum(col_max_len), 1)
                col_widths = [
                    max(0.5 * inch, AVAILABLE_WIDTH * (cl / total_chars))
                    for cl in col_max_len
                ]
                total_w = sum(col_widths)
                if total_w > AVAILABLE_WIDTH:
                    scale = AVAILABLE_WIDTH / total_w
                    col_widths = [w * scale for w in col_widths]
                normalized = []
                for r in rows:
                    padded = r + [""] * (col_count - len(r))
                    normalized.append([
                        Paragraph(_inline_md_to_rl_markup(c), table_cell_style)
                        for c in padded
                    ])
                table = Table(normalized, colWidths=col_widths, repeatRows=1)
                table.setStyle(TableStyle([
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EFEFEF")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]))
                story.append(table)
                story.append(Spacer(1, 0.1 * inch))
            continue

        # --- Bullet items ---
        bullet_match = re.match(r"^[-*]\s+(.*)$", t)
        if bullet_match:
            flush_paragraph()
            content = bullet_match.group(1)
            dm = re.fullmatch(r"\$\$(.+?)\$\$", content)
            if dm:
                _add_display_equation(dm.group(1))
            else:
                _add_text("\u2022 " + content, bullet_style)
            idx += 1
            continue

        # --- Numbered items ---
        number_match = re.match(r"^(\d+)\.\s+(.*)$", t)
        if number_match:
            flush_paragraph()
            n = number_match.group(1)
            content = number_match.group(2)
            _add_text(f"{n}. {content}", bullet_style)
            idx += 1
            continue

        # --- Indented sub-bullets ---
        sub_match = re.match(r"^\s+[-*]\s+(.*)$", stripped)
        if sub_match:
            flush_paragraph()
            content = sub_match.group(1)
            _add_text("\u2022 " + content, sub_bullet_style)
            idx += 1
            continue

        # --- Markdown images  ![alt](path) ---
        img_match = re.fullmatch(r"!\[([^\]]*)\]\(([^)]+)\)", t)
        if img_match:
            flush_paragraph()
            alt_text = img_match.group(1)
            img_path_str = img_match.group(2)
            # Resolve relative to the markdown file's directory
            img_path = input_path.parent / img_path_str
            if img_path.exists():
                from PIL import Image as PILImage
                pil = PILImage.open(str(img_path))
                w_px, h_px = pil.size
                # Use the image's DPI if available, default 150
                img_dpi = pil.info.get("dpi", (150, 150))[0] or 150
                w_pt = w_px / img_dpi * 72
                h_pt = h_px / img_dpi * 72
                max_w = AVAILABLE_WIDTH * 0.95
                max_h = PAGE_HEIGHT * 0.55
                scale = min(max_w / w_pt, max_h / h_pt, 1.0)
                w_pt *= scale
                h_pt *= scale
                img_obj = Image(str(img_path), width=w_pt, height=h_pt)
                story.append(Spacer(1, 0.08 * inch))
                story.append(img_obj)
                if alt_text:
                    caption_style = ParagraphStyle(
                        "ImageCaption", parent=body_style,
                        fontSize=8, leading=10, alignment=1,
                        textColor=colors.HexColor("#555555"),
                        spaceBefore=2, spaceAfter=4,
                    )
                    story.append(Paragraph(
                        f"<i>{html.escape(alt_text)}</i>", caption_style,
                    ))
                story.append(Spacer(1, 0.08 * inch))
            else:
                # Image not found — render alt text as placeholder
                story.append(Paragraph(
                    f"[Image not found: {html.escape(img_path_str)}]",
                    body_style,
                ))
            idx += 1
            continue

        # --- Regular text ---
        para_buf.append(stripped)
        idx += 1

    flush_paragraph()
    if in_code:
        code_text = "\n".join(code_buf) if code_buf else " "
        if code_lang == "mermaid":
            _add_mermaid_diagram(code_text, code_section_id)
        else:
            for cl in code_text.splitlines():
                escaped = html.escape(cl, quote=False)
                story.append(Paragraph(
                    f"<font face='Courier' size='7'>{escaped}</font>",
                    code_style,
                ))

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=letter,
        topMargin=0.8 * inch,
        bottomMargin=0.8 * inch,
        leftMargin=MARGIN_LR,
        rightMargin=MARGIN_LR,
        title=input_path.stem,
    )

    def _add_page_number(canvas, doc):
        canvas.saveState()
        canvas.setFont(FONT_NAME, 9)
        page_num = canvas.getPageNumber()
        canvas.drawCentredString(PAGE_WIDTH / 2.0, 0.5 * inch, f"Page {page_num}")
        canvas.restoreState()

    doc.build(story, onFirstPage=_add_page_number, onLaterPages=_add_page_number)


# ---------------------------------------------------------------------------

def main() -> None:
    root = Path(__file__).resolve().parent.parent
    input_path = (
        Path(sys.argv[1]) if len(sys.argv) > 1
        else root / "COMPLETE_METHODOLOGY_GUIDE.md"
    )
    output_path = (
        Path(sys.argv[2]) if len(sys.argv) > 2
        else input_path.with_suffix(".pdf")
    )
    if not input_path.is_absolute():
        input_path = (root / input_path).resolve()
    if not output_path.is_absolute():
        output_path = (root / output_path).resolve()

    markdown_to_pdf(input_path, output_path)
    print(f"Wrote: {output_path}")


if __name__ == "__main__":
    main()
