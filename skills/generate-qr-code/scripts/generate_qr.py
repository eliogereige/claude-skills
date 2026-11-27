#!/usr/bin/env python3
"""Standalone stylized QR-code generator (headless, no GUI, no project deps).

Generates a QR code with themes, gradients, custom colors, an embedded logo
(centered or full-canvas "artistic"), custom finder "eyes", and an optional
transparent background, then writes PNG or WEBP.

Only third-party requirements:  qrcode[pil]  and  Pillow
(`validators` is used if present, otherwise a built-in URL heuristic is used).

Examples:
    python generate_qr.py "https://example.com" -o qr.png
    python generate_qr.py "example.com" -o brand.png --theme ocean --module rounded
    python generate_qr.py "example.com" -o logo_qr.png --logo logo.png --logo-background
    python generate_qr.py "WIFI:S:MyNet;T:WPA;P:secret;;" -o wifi.png --raw
    python generate_qr.py --list-themes
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H
    from qrcode.image.styledpil import StyledPilImage
    from qrcode.image.styles.colormasks import (
        SolidFillColorMask,
        RadialGradiantColorMask,
        HorizontalGradiantColorMask,
        VerticalGradiantColorMask,
        SquareGradiantColorMask,
    )
    from qrcode.image.styles.moduledrawers.pil import (
        SquareModuleDrawer,
        RoundedModuleDrawer,
        GappedSquareModuleDrawer,
        CircleModuleDrawer,
        HorizontalBarsDrawer,
        VerticalBarsDrawer,
    )
    from PIL import Image, ImageDraw, ImageChops
except ImportError as exc:  # pragma: no cover
    sys.exit(
        f"Missing dependency: {exc.name}. Install with:\n"
        '    pip install "qrcode[pil]" Pillow\n'
    )

try:
    import validators as _validators  # optional
except ImportError:
    _validators = None


# --------------------------------------------------------------------------- #
# Presets: named colour themes and module styles.
# --------------------------------------------------------------------------- #
GRADIENT_NONE, GRADIENT_RADIAL = "none", "radial"
GRADIENT_HORIZONTAL, GRADIENT_VERTICAL, GRADIENT_SQUARE = "horizontal", "vertical", "square"

MODULE_SQUARE, MODULE_ROUNDED, MODULE_DOTTED = "square", "rounded", "dotted"
MODULE_CIRCLE, MODULE_H_BARS, MODULE_V_BARS = "circle", "horizontal_bars", "vertical_bars"

THEME_PRESETS = {
    "branded":   {"name": "Branded (high-contrast black)", "gradient": GRADIENT_NONE,
                  "back_color": (255, 255, 255), "front_color": (0, 0, 0), "gradient_end": None},
    "gradient":  {"name": "Gradient (blue -> red)", "gradient": GRADIENT_RADIAL,
                  "back_color": (255, 255, 255), "front_color": (66, 133, 244), "gradient_end": (234, 67, 53)},
    "nature":    {"name": "Nature (green -> brown)", "gradient": GRADIENT_RADIAL,
                  "back_color": (255, 255, 250), "front_color": (34, 139, 34), "gradient_end": (139, 90, 43)},
    "geometric": {"name": "Geometric (blues)", "gradient": GRADIENT_SQUARE,
                  "back_color": (255, 255, 255), "front_color": (25, 25, 112), "gradient_end": (72, 61, 139)},
    "abstract":  {"name": "Abstract (indigo -> violet)", "gradient": GRADIENT_HORIZONTAL,
                  "back_color": (255, 250, 250), "front_color": (75, 0, 130), "gradient_end": (148, 0, 211)},
    "ocean":     {"name": "Ocean (deep -> sky blue)", "gradient": GRADIENT_RADIAL,
                  "back_color": (240, 248, 255), "front_color": (0, 105, 148), "gradient_end": (0, 191, 255)},
    "sunset":    {"name": "Sunset (orange -> red)", "gradient": GRADIENT_HORIZONTAL,
                  "back_color": (255, 248, 240), "front_color": (255, 140, 0), "gradient_end": (255, 69, 0)},
    "neon":      {"name": "Neon (cyan -> magenta on dark)", "gradient": GRADIENT_RADIAL,
                  "back_color": (15, 15, 25), "front_color": (0, 255, 255), "gradient_end": (255, 0, 255)},
    "vintage":   {"name": "Vintage (sepia)", "gradient": GRADIENT_NONE,
                  "back_color": (253, 245, 230), "front_color": (101, 67, 33), "gradient_end": None},
    "corporate": {"name": "Corporate (navy -> steel)", "gradient": GRADIENT_SQUARE,
                  "back_color": (255, 255, 255), "front_color": (0, 51, 102), "gradient_end": (0, 102, 153)},
    "berry":     {"name": "Berry (purple -> magenta)", "gradient": GRADIENT_RADIAL,
                  "back_color": (255, 240, 245), "front_color": (128, 0, 128), "gradient_end": (199, 21, 133)},
    "rainbow":   {"name": "Rainbow (red -> indigo)", "gradient": GRADIENT_RADIAL,
                  "back_color": (255, 255, 255), "front_color": (255, 0, 0), "gradient_end": (75, 0, 130)},
    "custom":    {"name": "Custom (black on white; override colors)", "gradient": GRADIENT_NONE,
                  "back_color": (255, 255, 255), "front_color": (0, 0, 0), "gradient_end": None},
}

MODULE_CHOICES = [MODULE_SQUARE, MODULE_ROUNDED, MODULE_DOTTED,
                  MODULE_CIRCLE, MODULE_H_BARS, MODULE_V_BARS]
GRADIENT_CHOICES = [GRADIENT_NONE, GRADIENT_RADIAL, GRADIENT_HORIZONTAL,
                    GRADIENT_VERTICAL, GRADIENT_SQUARE]

_ERROR_MAP = {"M": ERROR_CORRECT_M, "Q": ERROR_CORRECT_Q, "H": ERROR_CORRECT_H}
_MODULE_DRAWER_MAP = {
    MODULE_SQUARE: SquareModuleDrawer,
    MODULE_ROUNDED: RoundedModuleDrawer,
    MODULE_DOTTED: GappedSquareModuleDrawer,
    MODULE_CIRCLE: CircleModuleDrawer,
    MODULE_H_BARS: lambda: HorizontalBarsDrawer(vertical_shrink=0.8),
    MODULE_V_BARS: lambda: VerticalBarsDrawer(horizontal_shrink=0.8),
}


# --------------------------------------------------------------------------- #
# Color helpers + contrast safety net.
# --------------------------------------------------------------------------- #
def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        raise ValueError(hex_color)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _luminance(rgb) -> float:
    r, g, b = rgb[:3]
    return 0.299 * r + 0.587 * g + 0.114 * b


def _ensure_contrast(cfg: dict) -> dict:
    """Guarantee scannable contrast (dark-on-light or light-on-dark)."""
    cfg = dict(cfg)
    fl, bl = _luminance(cfg["front_color"]), _luminance(cfg["back_color"])
    if fl > 180 and bl > 180:                 # both light -> darken fg
        cfg["front_color"] = (0, 0, 0)
        ge = cfg.get("gradient_end")
        if ge and _luminance(ge) > 180:
            cfg["gradient_end"] = (60, 60, 60)
    elif fl < 80 and bl < 80:                 # both dark -> lighten bg
        cfg["back_color"] = (255, 255, 255)
    return cfg


def _style_config(theme, gradient, front, back, gradient_end) -> dict:
    cfg = THEME_PRESETS.get(theme, THEME_PRESETS["custom"]).copy()
    if gradient is not None:
        cfg["gradient"] = gradient
    if front is not None:
        cfg["front_color"] = front
    if back is not None:
        cfg["back_color"] = back
    if gradient_end is not None:
        cfg["gradient_end"] = gradient_end
    return cfg


def _color_mask(cfg: dict):
    back, front = cfg["back_color"], cfg["front_color"]
    end, grad = cfg.get("gradient_end"), cfg.get("gradient", GRADIENT_NONE)
    if grad == GRADIENT_NONE or end is None:
        return SolidFillColorMask(back_color=back, front_color=front)
    if grad == GRADIENT_RADIAL:
        return RadialGradiantColorMask(back_color=back, center_color=front, edge_color=end)
    if grad == GRADIENT_HORIZONTAL:
        return HorizontalGradiantColorMask(back_color=back, left_color=front, right_color=end)
    if grad == GRADIENT_VERTICAL:
        return VerticalGradiantColorMask(back_color=back, top_color=front, bottom_color=end)
    if grad == GRADIENT_SQUARE:
        return SquareGradiantColorMask(back_color=back, center_color=front, edge_color=end)
    return SolidFillColorMask(back_color=back, front_color=front)


# --------------------------------------------------------------------------- #
# Logo overlay (centered) — resizes logo to ~15% (max 18%) of QR size.
# --------------------------------------------------------------------------- #
def _apply_logo_overlay(qr_image, logo, backdrop_shape="rounded",
                        backdrop_color=(255, 255, 255, 255)):
    qr_size = min(qr_image.size)
    border_width = max(2, qr_size // 140)
    target = max(36, min(int(qr_size * 0.15), int(qr_size * 0.18)))
    padding = int(qr_size * 0.05)

    logo = logo.convert("RGBA")
    lw, lh = logo.size
    scale = min(target / lw, target / lh)
    logo_r = logo.resize((int(lw * scale), int(lh * scale)), Image.Resampling.LANCZOS)

    total = target + 2 * padding + 2 * border_width
    backdrop = Image.new("RGBA", (total, total), (0, 0, 0, 0))
    if backdrop_color is not None and backdrop_shape != "none":
        d = ImageDraw.Draw(backdrop)
        bbox = [0, 0, total - 1, total - 1]
        if backdrop_shape == "circle":
            d.ellipse(bbox, fill=backdrop_color)
        elif backdrop_shape == "rounded":
            d.rounded_rectangle(bbox, radius=max(6, total // 8), fill=backdrop_color)
        else:
            d.rectangle(bbox, fill=backdrop_color)
    nw, nh = logo_r.size
    backdrop.paste(logo_r, ((total - nw) // 2, (total - nh) // 2), logo_r)

    had_alpha = qr_image.mode == "RGBA"
    canvas = qr_image.convert("RGBA")
    off = (qr_size - total) // 2
    canvas.alpha_composite(backdrop, (off, off))
    return canvas if had_alpha else canvas.convert("RGB")


# --------------------------------------------------------------------------- #
# Artistic renderer — logo fills canvas; dark modules drawn on top.
# --------------------------------------------------------------------------- #
_OUTLINE = (30, 30, 30, 255)


def _is_light(rgb) -> bool:
    return _luminance(rgb) > 160


def _in_finder(row, col, n, margin=8) -> bool:
    return ((row < margin and col < margin)
            or (row < margin and col >= n - margin)
            or (row >= n - margin and col < margin))


def _render_artistic(modules, background, module_style, box_size, border,
                     front_color, back_color, transparent_background=False):
    n = len(modules)
    canvas = (n + 2 * border) * box_size
    base_alpha = 0 if transparent_background else 255
    base = Image.new("RGBA", (canvas, canvas), (*back_color, base_alpha))
    logo = background.resize((canvas, canvas), Image.Resampling.LANCZOS).convert("RGBA")
    bg = Image.alpha_composite(base, logo)

    overlay = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    r, g, b = front_color
    needs_outline = _is_light(front_color) and module_style != MODULE_SQUARE

    for row in range(n):
        for col in range(n):
            if not modules[row][col]:
                continue
            x0, y0 = (col + border) * box_size, (row + border) * box_size
            x1, y1 = x0 + box_size, y0 + box_size
            if _in_finder(row, col, n):
                draw.rectangle([x0, y0, x1, y1], fill=(r, g, b, 255))
            elif module_style in (MODULE_DOTTED, MODULE_CIRCLE):
                m = box_size * 0.13
                if needs_outline:
                    om = max(0, m - 1)
                    draw.ellipse([x0 + om, y0 + om, x1 - om, y1 - om], outline=_OUTLINE)
                draw.ellipse([x0 + m, y0 + m, x1 - m, y1 - m], fill=(r, g, b, 255))
            elif module_style == MODULE_ROUNDED:
                m, radius = box_size * 0.06, box_size * 0.38
                if needs_outline:
                    om = max(0, m - 1)
                    draw.rounded_rectangle([x0 + om, y0 + om, x1 - om, y1 - om],
                                           radius=radius + 1, outline=_OUTLINE)
                draw.rounded_rectangle([x0 + m, y0 + m, x1 - m, y1 - m],
                                       radius=radius, fill=(r, g, b, 255))
            else:
                draw.rectangle([x0, y0, x1, y1], fill=(r, g, b, 255))

    result = Image.alpha_composite(bg, overlay)
    return result if transparent_background else result.convert("RGB")


# --------------------------------------------------------------------------- #
# Finder-pattern ("eye") recoloring.
# --------------------------------------------------------------------------- #
def _finder_dark(r, c) -> bool:
    return r in (0, 6) or c in (0, 6) or (2 <= r <= 4 and 2 <= c <= 4)


def _apply_eye_overlay(img, box_size, border, n_modules, back_color,
                       eye_color=None, eyeball_color=None, transparent_background=False):
    if eye_color is None and eyeball_color is None:
        return img
    eye_c = eye_color or (26, 26, 26)
    eyeball_c = eyeball_color or (0, 0, 0)

    if transparent_background or img.mode == "RGBA":
        img = img.convert("RGBA")
        clear = (0, 0, 0, 0) if transparent_background else (*back_color, 255)
        def opq(c):  # noqa: E306
            return (*c, 255)
    else:
        img = img.convert("RGB")
        clear = back_color
        def opq(c):  # noqa: E306
            return c

    draw = ImageDraw.Draw(img)
    w, h = img.size
    finders = [(0, 0), (0, n_modules - 7), (n_modules - 7, 0)]
    for row_start, col_start in finders:
        left = max(0, min((col_start + border) * box_size, w - 1))
        top = max(0, min((row_start + border) * box_size, h - 1))
        right = max(left + 1, min(left + 7 * box_size, w))
        bottom = max(top + 1, min(top + 7 * box_size, h))
        draw.rectangle([left, top, right, bottom], fill=clear)
        for r in range(7):
            for c in range(7):
                if not _finder_dark(r, c):
                    continue
                x0, y0 = left + c * box_size, top + r * box_size
                fill = eyeball_c if (2 <= r <= 4 and 2 <= c <= 4) else eye_c
                draw.rectangle([x0, y0, x0 + box_size, y0 + box_size], fill=opq(fill))
    return img


def _apply_transparent_background(img, back_color, tolerance=20):
    rgba = img.convert("RGBA")
    r, g, b, a = rgba.split()
    br, bg, bb = back_color[:3]
    diff = ImageChops.lighter(
        ImageChops.lighter(
            ImageChops.difference(r, Image.new("L", rgba.size, br)),
            ImageChops.difference(g, Image.new("L", rgba.size, bg)),
        ),
        ImageChops.difference(b, Image.new("L", rgba.size, bb)),
    )
    keep = diff.point(lambda v: 255 if v > tolerance else 0)
    rgba.putalpha(ImageChops.multiply(a, keep))
    return rgba


# --------------------------------------------------------------------------- #
# Main generation orchestration.
# --------------------------------------------------------------------------- #
def generate(data, *, logo_path=None, theme="branded", gradient=None,
             front_color=None, back_color=None, gradient_end=None,
             module_style=MODULE_SQUARE, error_correction="H",
             logo_as_background=False, logo_backdrop_shape="rounded",
             eye_color=None, eyeball_color=None, transparent_background=False,
             box_size=12, border=4):
    cfg = _ensure_contrast(_style_config(theme, gradient, front_color, back_color, gradient_end))

    has_logo = bool(logo_path)
    ec = _ERROR_MAP.get(error_correction, ERROR_CORRECT_H)
    if has_logo and error_correction not in ("Q", "H"):
        ec = ERROR_CORRECT_H

    qr = qrcode.QRCode(version=None, error_correction=ec, box_size=box_size, border=border)
    qr.add_data(str(data).strip())
    qr.make(fit=True)

    use_artistic = has_logo and (
        logo_as_background
        or (theme == "branded" and cfg.get("gradient", GRADIENT_NONE) == GRADIENT_NONE)
    )
    if use_artistic:
        logo = Image.open(logo_path).convert("RGBA")
        img = _render_artistic(qr.modules, logo, module_style, box_size, border,
                               cfg["front_color"], cfg["back_color"], transparent_background)
        return _apply_eye_overlay(img, box_size, border, len(qr.modules), cfg["back_color"],
                                  eye_color, eyeball_color, transparent_background)

    img = qr.make_image(image_factory=StyledPilImage,
                        module_drawer=_MODULE_DRAWER_MAP.get(module_style, SquareModuleDrawer)(),
                        color_mask=_color_mask(cfg))
    if img.mode != "RGB":
        img = img.convert("RGB")
    if transparent_background:
        img = _apply_transparent_background(img, cfg["back_color"])

    if has_logo and error_correction in ("Q", "H"):
        logo = Image.open(logo_path).convert("RGBA")
        if transparent_background or logo_backdrop_shape == "none":
            backdrop = None
        else:
            backdrop = (255, 255, 255, 255)
        img = _apply_logo_overlay(img, logo, backdrop_shape=logo_backdrop_shape,
                                  backdrop_color=backdrop)

    return _apply_eye_overlay(img, box_size, border, len(qr.modules), cfg["back_color"],
                              eye_color, eyeball_color, transparent_background)


# --------------------------------------------------------------------------- #
# URL / data handling + export.
# --------------------------------------------------------------------------- #
def _resolve_data(raw: str, treat_raw: bool) -> str:
    if treat_raw:
        return raw
    t = raw.strip()
    candidate = t if t.startswith(("http://", "https://")) else "https://" + t
    if _validators is not None:
        looks_url = bool(_validators.url(candidate))
    else:  # lightweight heuristic
        host = candidate.split("://", 1)[1].split("/", 1)[0]
        looks_url = (" " not in t) and ("." in host) and len(host) > 3
    if looks_url:
        return candidate
    print(f"note: {raw!r} is not a URL — encoding it as raw text.", file=sys.stderr)
    return raw


def _export(image, filepath: Path, fmt: str) -> bool:
    try:
        filepath.parent.mkdir(parents=True, exist_ok=True)
        kwargs = {}
        if fmt == "WEBP":
            kwargs = {"quality": 90, "method": 6}
        elif fmt == "PNG":
            kwargs = {"optimize": True}
        image.save(str(filepath), fmt, **kwargs)
        return True
    except Exception as exc:  # pragma: no cover
        print(f"error: {exc}", file=sys.stderr)
        return False


# --------------------------------------------------------------------------- #
# CLI.
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="generate_qr.py",
        description="Generate a stylized QR code from a URL or text (headless).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("data", nargs="?", help="URL or text to encode (e.g. https://example.com).")
    p.add_argument("-o", "--output", default="qr.png", help="Output file path (.png or .webp).")
    p.add_argument("--theme", default="branded", choices=sorted(THEME_PRESETS), help="Style preset.")
    p.add_argument("--module", default=MODULE_SQUARE, choices=MODULE_CHOICES, help="Module (dot) shape.")
    p.add_argument("--error-correction", default="H", choices=["M", "Q", "H"],
                   help="Error correction (H/Q recommended with a logo).")
    p.add_argument("--front", type=_hex, help="Foreground color hex (#rrggbb).")
    p.add_argument("--back", type=_hex, help="Background color hex (#rrggbb).")
    p.add_argument("--gradient", choices=GRADIENT_CHOICES, help="Gradient type override.")
    p.add_argument("--gradient-end", type=_hex, help="Gradient end color hex (#rrggbb).")
    p.add_argument("--logo", help="Path to a logo image to embed.")
    p.add_argument("--logo-background", action="store_true",
                   help="Fill the canvas with the logo; draw modules on top (artistic).")
    p.add_argument("--logo-backdrop", default="rounded",
                   choices=["rounded", "circle", "square", "none"],
                   help="Shape of the patch behind a centered logo.")
    p.add_argument("--eye-color", type=_hex, help="Finder frame color hex (#rrggbb).")
    p.add_argument("--eyeball-color", type=_hex, help="Finder center color hex (#rrggbb).")
    p.add_argument("--transparent", action="store_true", help="Transparent background.")
    p.add_argument("--box-size", type=int, default=12, help="Pixels per module (resolution).")
    p.add_argument("--border", type=int, default=4, help="Quiet-zone width in modules (>=4).")
    p.add_argument("--format", choices=["PNG", "WEBP"], help="Force output format.")
    p.add_argument("--raw", action="store_true",
                   help="Encode data verbatim (skip URL normalization).")
    p.add_argument("--list-themes", action="store_true", help="List themes and exit.")
    return p


def _hex(value: str):
    try:
        return hex_to_rgb(value.strip())
    except (ValueError, IndexError):
        raise argparse.ArgumentTypeError(f"invalid hex color: {value!r} (expected #rrggbb)")


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.list_themes:
        width = max(len(k) for k in THEME_PRESETS)
        for key in sorted(THEME_PRESETS):
            print(f"  {key:<{width}}  {THEME_PRESETS[key]['name']}")
        return 0

    if not args.data:
        parser.error("the 'data' argument (URL or text) is required")

    data = _resolve_data(args.data, treat_raw=args.raw)
    image = generate(
        data,
        logo_path=args.logo,
        theme=args.theme,
        gradient=args.gradient,
        front_color=args.front,
        back_color=args.back,
        gradient_end=args.gradient_end,
        module_style=args.module,
        error_correction=args.error_correction,
        logo_as_background=args.logo_background,
        logo_backdrop_shape=args.logo_backdrop,
        eye_color=args.eye_color,
        eyeball_color=args.eyeball_color,
        transparent_background=args.transparent,
        box_size=args.box_size,
        border=args.border,
    )

    out = Path(args.output).expanduser()
    fmt = (args.format or ("WEBP" if out.suffix.lower() == ".webp" else "PNG")).upper()
    if _export(image, out, fmt):
        print(f"Saved {fmt} QR code -> {out.resolve()}  ({image.size[0]}x{image.size[1]} px)")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
